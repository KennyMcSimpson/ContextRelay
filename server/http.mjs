import { createServer } from 'node:http';
import { createApiController } from './api.mjs';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const HARD_ABORT_BYTES = 16 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const ALLOWED_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const HTML_CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'";

function normalizeBindHostname(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
}

/**
 * Strictly validate HTTP Host header (hostname + exact listening port) to mitigate DNS rebinding.
 * Only allows `127.0.0.1`, `localhost`, or `[::1]` with the exact bound port
 * (omitted port is only allowed when the server listens on port 80).
 */
function parseAndValidateHostHeader(rawHost, expectedPort) {
  if (typeof rawHost !== 'string') return null;
  const trimmed = rawHost.trim().toLowerCase();
  if (!trimmed || /[\s/@\\?#]/.test(trimmed)) return null;
  const match = trimmed.match(/^(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/);
  if (!match) return null;
  const hostname = match[1];
  const portStr = match[2] || '';
  if (portStr) {
    const portNum = Number(portStr);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return null;
    if (String(portNum) !== String(expectedPort)) return null;
    return { hostname, port: String(portNum) };
  }
  if (Number(expectedPort) !== 80) return null;
  return { hostname, port: '80' };
}

/**
 * Strictly validate Origin header against same-origin loopback origins for this server's port.
 * Rejects empty strings, `null`, non-http schemes, foreign hosts, and mismatched ports.
 */
function isAllowedOrigin(origin, serverPort) {
  if (typeof origin !== 'string') return false;
  const trimmed = origin.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return false;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
  if (trimmed !== `${parsed.protocol}//${parsed.host}`) return false;

  const hostLower = parsed.hostname.toLowerCase();
  if (!ALLOWED_ORIGIN_HOSTS.has(hostLower)) return false;

  const effectivePort = parsed.port || '80';
  return effectivePort === String(serverPort);
}

function isJsonContentType(rawContentType) {
  if (typeof rawContentType !== 'string') return false;
  return /^application\/json(?:\s*;|$)/i.test(rawContentType.trim());
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length']);
    const preOversized = Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES;
    const chunks = [];
    let total = 0;
    let tooLarge = preOversized;
    let settled = false;

    const fail = (message, statusCode) => {
      if (settled) return;
      settled = true;
      const err = new Error(message);
      err.statusCode = statusCode;
      reject(err);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        if (total > HARD_ABORT_BYTES) {
          req.pause();
          fail('Request body too large', 413);
        }
        return;
      }
      if (!tooLarge) {
        chunks.push(chunk);
      }
    });

    req.on('end', () => {
      if (settled) return;
      if (tooLarge) {
        fail('Request body too large', 413);
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        settled = true;
        resolve({});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        fail('Invalid JSON body', 400);
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail('JSON body must be an object', 400);
        return;
      }
      settled = true;
      resolve(parsed);
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function sendApiResult(res, result) {
  const httpStatus =
    result &&
    typeof result === 'object' &&
    typeof result.status === 'number' &&
    result.status >= 100 &&
    result.status <= 599
      ? result.status
      : 200;
  sendJson(res, httpStatus, result);
}

const KNOWN_API_METHODS = new Map([
  ['/api/state', 'GET'],
  ['/api/sessions', 'GET'],
  ['/api/session', 'GET'],
  ['/api/step-full', 'GET'],
  ['/api/preview', 'POST'],
  ['/api/export', 'POST'],
  ['/api/launch', 'POST'],
  ['/api/lineage', 'GET'],
  ['/api/archive', 'GET'],
  ['/api/sync', 'POST'],
  ['/api/workspace', 'POST'],
]);

/**
 * Start the local loopback-only HTTP server for Context Relay.
 * Enforces strict loopback binding, Host validation (anti-DNS-rebinding),
 * same-origin POST Origin validation, 2 MiB JSON body limit, and security headers.
 */
export function startHttpServer({
  port = 3477,
  host = '127.0.0.1',
  dataDir,
  api: providedApi,
} = {}) {
  const normalizedHost = normalizeBindHostname(host || '127.0.0.1');
  if (!LOOPBACK_HOSTS.has(normalizedHost)) {
    return Promise.reject(
      new Error(`Refusing to bind Context Relay HTTP server to non-loopback host: ${host}`),
    );
  }
  const bindHost = normalizedHost === 'localhost' ? '127.0.0.1' : normalizedHost;

  const api = providedApi || createApiController({ dataDir });
  let actualPort = Number(port) || 0;

  const server = createServer(async (req, res) => {
    try {
      // 1. Host header validation (anti-DNS-rebinding: exact loopback host + listening port)
      const parsedHost = parseAndValidateHostHeader(req.headers.host, actualPort);
      if (!parsedHost) {
        sendJson(res, 403, { ok: false, error: 'Forbidden Host header' });
        return;
      }

      const method = (req.method || 'GET').toUpperCase();

      // 2. Origin / CSRF validation
      const origin = req.headers.origin;
      if (origin !== undefined) {
        if (!isAllowedOrigin(origin, actualPort)) {
          sendJson(res, 403, { ok: false, error: 'Forbidden cross-origin request' });
          return;
        }
      } else if (method === 'POST') {
        const customHeader = String(req.headers['x-context-relay'] || '').trim();
        if (customHeader !== '1') {
          sendJson(res, 403, {
            ok: false,
            error: 'Forbidden: POST requests require a same-origin Origin header or X-Context-Relay: 1 header',
          });
          return;
        }
      }

      // 3. Enforce application/json Content-Type on all POST requests (blocks simple form POST CSRF)
      if (method === 'POST' && !isJsonContentType(req.headers['content-type'])) {
        sendJson(res, 415, {
          ok: false,
          error: 'Unsupported Media Type: POST requests must use Content-Type: application/json',
        });
        return;
      }

      // 4. Parse URL safely
      let url;
      try {
        url = new URL(req.url || '/', `http://${parsedHost.hostname}:${actualPort}`);
      } catch {
        sendJson(res, 400, { ok: false, error: 'Malformed request URL' });
        return;
      }

      const pathname = url.pathname;
      const params = Object.fromEntries(url.searchParams.entries());

      // Static frontend assets
      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': HTML_CSP,
        });
        res.end(api.getHtml({ injectPreload: false }));
        return;
      }

      if (method === 'GET' && pathname === '/styles.css') {
        res.writeHead(200, {
          'Content-Type': 'text/css; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(api.getCss());
        return;
      }

      if (method === 'GET' && pathname === '/app.js') {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(api.getJs());
        return;
      }

      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, {
          ok: true,
          status: typeof api.getStatus === 'function' ? api.getStatus() : {},
        });
        return;
      }

      // API routes
      if (method === 'GET' && pathname === '/api/state') {
        sendApiResult(res, await api.handleState(params, ''));
        return;
      }

      if (method === 'GET' && pathname === '/api/sessions') {
        sendApiResult(res, await api.handleSessions(params));
        return;
      }

      if (method === 'GET' && pathname === '/api/session') {
        sendApiResult(res, await api.handleSessionDetail(params));
        return;
      }

      if (method === 'GET' && pathname === '/api/step-full') {
        sendApiResult(res, await api.handleStepFull(params));
        return;
      }

      if (method === 'POST' && pathname === '/api/preview') {
        const body = await readJsonBody(req);
        sendApiResult(res, await api.handlePreview(body));
        return;
      }

      if (method === 'POST' && pathname === '/api/export') {
        const body = await readJsonBody(req);
        sendApiResult(res, await api.handleExport(body));
        return;
      }

      if (method === 'POST' && pathname === '/api/launch') {
        const body = await readJsonBody(req);
        sendApiResult(res, await api.handleLaunch(body));
        return;
      }

      if (method === 'GET' && pathname === '/api/lineage') {
        sendApiResult(res, await api.handleLineage(params));
        return;
      }

      if (method === 'GET' && pathname === '/api/archive') {
        sendApiResult(res, await api.handleArchiveRead(params));
        return;
      }

      if (method === 'POST' && pathname === '/api/sync') {
        const body = await readJsonBody(req);
        sendApiResult(res, await api.handleSync(body));
        return;
      }

      if (method === 'POST' && pathname === '/api/workspace') {
        const body = await readJsonBody(req);
        sendApiResult(res, await api.handleRegisterWorkspace(body));
        return;
      }

      if (KNOWN_API_METHODS.has(pathname)) {
        sendJson(
          res,
          405,
          { ok: false, error: 'Method Not Allowed' },
          { Allow: KNOWN_API_METHODS.get(pathname) },
        );
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Not found' });
    } catch (err) {
      const status =
        typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600
          ? err.statusCode
          : 500;
      const extraHeaders = status === 413 ? { Connection: 'close' } : {};
      sendJson(
        res,
        status,
        { ok: false, error: err?.message || 'Internal server error' },
        extraHeaders,
      );
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bindHost, () => {
      server.removeListener('error', reject);
      const addr = server.address();
      actualPort = typeof addr === 'object' && addr ? addr.port : Number(port) || 3477;
      const hostDisplay = bindHost.includes(':') ? `[${bindHost}]` : bindHost;
      resolve({
        server,
        url: `http://${hostDisplay}:${actualPort}`,
        port: actualPort,
        host: bindHost,
        api,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
