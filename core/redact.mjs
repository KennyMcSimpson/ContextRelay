// Deterministic secret & credential redaction (zero external dependencies, ReDoS-safe).

const REDACTED_MARKER_RE = /^\[REDACTED:[A-Z0-9_]+\]$/;
const PLACEHOLDER_WORD_RE =
  /(?:YOUR_|EXAMPLE|REDACTED|PLACEHOLDER|CHANGEME|CHANGE_ME|REPLACE_ME|INSERT_HERE|DUMMY_KEY|DUMMY_TOKEN|FAKE_KEY|FAKE_TOKEN|SAMPLE_KEY|TEST_KEY_HERE)/i;
const ANGLE_PLACEHOLDER_RE = /^<[^>]+>$|<[A-Za-z0-9_\-\s]{2,}>/;
const ASTERISK_MASK_RE = /\*{3,}/;
const KNOWN_TOKEN_PREFIX_RE =
  /^(?:sk-proj-|sk-ant-api\d+-|sk-live-|sk-test-|sk-|github_pat_|(?:ghp|gho|ghu|ghs|ghr)_|AIza|AKIA|xox[baprs]-|(?:hf|npm)_)/;
const ONLY_MASK_CHARS_RE = /^[xX*._\-]+$/;
const DELIMITED_XXX_RE = /(?:^|[-_./])x{3,}(?:$|[-_./])/i;
const LONG_XXX_RE = /x{5,}/i;
const REPEATED_CHAR_RE = /^(.)\1{7,}$/;
const LITERAL_NON_SECRET_RE = /^(?:true|false|null|undefined|none|empty|required|optional)$/i;
const TEMPLATE_EXPR_RE = /^\$?\{\{[\s\S]{1,128}\}\}$/;
const CODE_PROP_REF_RE = /^[a-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;
const CODE_CALL_REF_RE = /^[A-Za-z_][A-Za-z0-9_.]*\([^()\r\n]{0,64}\)$/;
const CJK_PROSE_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/;

/**
 * Determine whether a matched candidate looks like a documentation placeholder
 * or an already-redacted marker rather than a real credential.
 */
function isPlaceholder(value, type) {
  if (!value || typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed) return true;

  if (REDACTED_MARKER_RE.test(trimmed)) return true;
  if (ASTERISK_MASK_RE.test(trimmed)) return true;
  if (ANGLE_PLACEHOLDER_RE.test(trimmed)) return true;
  if (PLACEHOLDER_WORD_RE.test(trimmed)) return true;
  if (TEMPLATE_EXPR_RE.test(trimmed)) return true;

  if (type === 'PEM_PRIVATE_KEY') {
    const inner = trimmed
      .replace(/^-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/, '')
      .replace(/-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----$/, '')
      .replace(/[^A-Za-z0-9+/=]/g, '');
    return inner.length < 10;
  }

  const body = trimmed.replace(KNOWN_TOKEN_PREFIX_RE, '');
  if (!body) return true;
  if (ONLY_MASK_CHARS_RE.test(body)) return true;
  if (DELIMITED_XXX_RE.test(body)) return true;
  if (LONG_XXX_RE.test(body)) return true;
  if (REPEATED_CHAR_RE.test(body)) return true;

  return false;
}

/**
 * Check if an assignment value is a variable/env reference, code expression, or literal.
 */
function isNonSecretEnvReference(value, isQuoted = false) {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (LITERAL_NON_SECRET_RE.test(trimmed)) return true;
  if (/^(?:process\.env\.|import\.meta\.env\.|os\.environ\b|os\.getenv\b|Deno\.env\b)/i.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith('$')) return true;
  if (/^%[A-Za-z0-9_]+%$/.test(trimmed)) return true;
  if (TEMPLATE_EXPR_RE.test(trimmed)) return true;
  if (!isQuoted) {
    if (CODE_PROP_REF_RE.test(trimmed)) return true;
    if (CODE_CALL_REF_RE.test(trimmed)) return true;
    if (CJK_PROSE_RE.test(trimmed)) return true;
  }
  return false;
}

/**
 * Trim trailing unquoted statement delimiters (e.g. ';' or ',') so shell/JSON
 * punctuation stays intact while verifying the secret still meets minLen.
 */
function splitUnquotedTrailingDelimiter(prefix, value, minLen) {
  const isQuoted = /['"]$/.test(prefix);
  if (isQuoted) {
    return { core: value, trailing: '' };
  }
  const match = value.match(/([;,)\]}]+)$/);
  if (!match) {
    return { core: value, trailing: '' };
  }
  const trailing = match[1];
  const core = value.slice(0, value.length - trailing.length);
  if (core.length < minLen) {
    return null;
  }
  return { core, trailing };
}

const RULES = [
  {
    type: 'PEM_PRIVATE_KEY',
    regex:
      /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]{10,8192}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g,
    replace(match, bump) {
      if (isPlaceholder(match, 'PEM_PRIVATE_KEY')) return match;
      bump();
      return '[REDACTED:PEM_PRIVATE_KEY]';
    },
  },
  {
    type: 'GOOGLE_API_KEY',
    regex: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
    replace(match, bump) {
      if (isPlaceholder(match, 'GOOGLE_API_KEY')) return match;
      bump();
      return '[REDACTED:GOOGLE_API_KEY]';
    },
  },
  {
    type: 'PROVIDER_SK_KEY',
    regex: /\bsk-(?:proj-|ant-api\d+-|live-|test-)?[A-Za-z0-9\-_]{20,}\b/g,
    replace(match, bump) {
      if (isPlaceholder(match, 'PROVIDER_SK_KEY')) return match;
      bump();
      return '[REDACTED:PROVIDER_SK_KEY]';
    },
  },
  {
    type: 'GITHUB_TOKEN',
    regex: /\b(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g,
    replace(match, bump) {
      if (isPlaceholder(match, 'GITHUB_TOKEN')) return match;
      bump();
      return '[REDACTED:GITHUB_TOKEN]';
    },
  },
  {
    type: 'AWS_ACCESS_KEY',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    replace(match, bump) {
      if (isPlaceholder(match, 'AWS_ACCESS_KEY')) return match;
      bump();
      return '[REDACTED:AWS_ACCESS_KEY]';
    },
  },
  {
    type: 'SLACK_TOKEN',
    regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
    replace(match, bump) {
      if (isPlaceholder(match, 'SLACK_TOKEN')) return match;
      bump();
      return '[REDACTED:SLACK_TOKEN]';
    },
  },
  {
    type: 'HF_NPM_TOKEN',
    regex: /\b(?:hf|npm)_[A-Za-z0-9]{20,}\b/g,
    replace(match, bump) {
      if (isPlaceholder(match, 'HF_NPM_TOKEN')) return match;
      bump();
      return '[REDACTED:HF_NPM_TOKEN]';
    },
  },
  {
    type: 'BEARER_TOKEN',
    regex: /(\bAuthorization[ \t]*:[ \t]*Bearer[ \t]+)([A-Za-z0-9._~+/=-]{16,})/gi,
    replace(match, bump, prefix, token) {
      if (isPlaceholder(token, 'BEARER_TOKEN')) return match;
      bump();
      return `${prefix}[REDACTED:BEARER_TOKEN]`;
    },
  },
  {
    type: 'BASIC_AUTH',
    regex: /(\bAuthorization[ \t]*:[ \t]*Basic[ \t]+)([A-Za-z0-9+/=]{12,})/gi,
    replace(match, bump, prefix, token) {
      if (isPlaceholder(token, 'BASIC_AUTH')) return match;
      bump();
      return `${prefix}[REDACTED:BASIC_AUTH]`;
    },
  },
  {
    type: 'JWT_TOKEN',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{12,}\b/g,
    replace(match, bump) {
      if (isPlaceholder(match, 'JWT_TOKEN')) return match;
      bump();
      return '[REDACTED:JWT_TOKEN]';
    },
  },
  {
    type: 'HEADER_TOKEN',
    regex: /(\b(?:x-codeium-csrf-token|x-sidecar-token|x-api-key)['"]?[ \t]*:[ \t]*['"]?)([^\s"'`]{12,})/gi,
    replace(match, bump, prefix, rawVal) {
      const split = splitUnquotedTrailingDelimiter(prefix, rawVal, 12);
      if (!split) return match;
      const { core, trailing } = split;
      if (isNonSecretEnvReference(core, /['"]$/.test(prefix)) || isPlaceholder(core, 'HEADER_TOKEN')) {
        return match;
      }
      bump();
      return `${prefix}[REDACTED:HEADER_TOKEN]${trailing}`;
    },
  },
  {
    type: 'URL_CREDENTIAL',
    regex:
      /((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqp|https?|ftp):\/\/[^/\s:@'"\[\]]{0,64}:)([^/\s@'"?#]{4,128})(@[^\s'"]+)/gi,
    replace(match, bump, prefix, password, suffix) {
      if (match.includes('[REDACTED:')) return match;
      if (isNonSecretEnvReference(password, true) || isPlaceholder(password, 'URL_CREDENTIAL')) {
        return match;
      }
      bump();
      return `${prefix}[REDACTED:URL_CREDENTIAL]${suffix}`;
    },
  },
  {
    type: 'ENV_SECRET',
    regex:
      /((?:^|[\s;,{\[("'`])(?:[A-Za-z0-9_]{0,48}?(?:api_?key|secret(?:_?access)?_?key|access_?token|refresh_?token|auth_?token|private_?key|client_?secret|db_?password|password|passwd|hf_?token|github_?token))['"]?[ \t]*[:=][ \t]*)(?:"([^"\r\n]{8,256})"|'([^'\r\n]{8,256})'|([^\s'"`;,)\]}]{8,256}))/gim,
    replace(match, bump, prefix, dqVal, sqVal, unquotedVal) {
      if (dqVal !== undefined) {
        if (isNonSecretEnvReference(dqVal, true) || isPlaceholder(dqVal, 'ENV_SECRET')) {
          return match;
        }
        bump();
        return `${prefix}"[REDACTED:ENV_SECRET]"`;
      }
      if (sqVal !== undefined) {
        if (isNonSecretEnvReference(sqVal, true) || isPlaceholder(sqVal, 'ENV_SECRET')) {
          return match;
        }
        bump();
        return `${prefix}'[REDACTED:ENV_SECRET]'`;
      }
      const split = splitUnquotedTrailingDelimiter(prefix, unquotedVal || '', 8);
      if (!split) return match;
      const { core, trailing } = split;
      if (isNonSecretEnvReference(core, false) || isPlaceholder(core, 'ENV_SECRET')) {
        return match;
      }
      bump();
      return `${prefix}[REDACTED:ENV_SECRET]${trailing}`;
    },
  },
];

/**
 * Redact sensitive secrets and credentials deterministically.
 *
 * @param {string} text
 * @param {{ enabled?: boolean }} [options]
 * @returns {{ text: string, count: number, findings: Array<{ type: string, count: number }> }}
 */
export function redactSensitive(text, options = { enabled: true }) {
  if (typeof text !== 'string' || options?.enabled === false) {
    return {
      text: String(text ?? ''),
      count: 0,
      findings: [],
    };
  }

  if (text.length === 0) {
    return {
      text: '',
      count: 0,
      findings: [],
    };
  }

  let current = text;
  let totalCount = 0;
  const findings = [];

  for (const rule of RULES) {
    let ruleCount = 0;
    const bump = () => {
      ruleCount += 1;
    };

    rule.regex.lastIndex = 0;
    current = current.replace(rule.regex, (match, ...args) => {
      // Last two args of String.prototype.replace callback are offset and whole string
      const groups = args.slice(0, -2);
      return rule.replace(match, bump, ...groups);
    });

    if (ruleCount > 0) {
      totalCount += ruleCount;
      findings.push({ type: rule.type, count: ruleCount });
    }
  }

  return {
    text: current,
    count: totalCount,
    findings,
  };
}
