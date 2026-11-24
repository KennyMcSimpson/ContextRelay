import { createRelayStore } from '../../core/store.mjs';

async function main() {
  try {
    const store = createRelayStore();
    const hostConvId = (process.env.ANTIGRAVITY_CONVERSATION_ID || '').trim();
    const syncRes = store.syncAll({ force: false });
    const enrichRes = await store.enrichProjectsAsync({
      limit: 20,
      targetSessionIds: hostConvId ? [hostConvId] : [],
    });

    const updated = syncRes?.updated ?? 0;
    const skipped = syncRes?.skipped ?? 0;
    const total = syncRes?.totalSources ?? 0;
    const enrichSummary = enrichRes?.skipped
      ? `enrichSkipped=${enrichRes.reason || 'unavailable'}`
      : `enriched=${enrichRes?.enriched ?? 0} projects=${enrichRes?.totalProjects ?? store.listProjects().length}`;

    console.log(
      `[context-relay] headless warmup done: dataDir=${store.getDataDir()} total=${total} updated=${updated} skipped=${skipped} ${enrichSummary}`,
    );
  } catch (err) {
    console.error('[context-relay] headless warmup error:', err?.message || err);
  } finally {
    process.exit(0);
  }
}

main();
