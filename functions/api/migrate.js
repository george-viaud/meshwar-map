// One-time migration: monolithic 'coverage' key → sharded 'shard:XXX' keys
// Run once after deploying KV sharding, then never again.
// Usage: POST /api/migrate with Authorization: Bearer <ADMIN_TOKEN>

const SHARD_PREFIX_LEN = 3;
const EXPIRY_DAYS = 90;

function ageInDays(timestamp) {
  return Math.floor((new Date() - new Date(timestamp)) / (1000 * 60 * 60 * 24));
}

export async function onRequestPost(context) {
  try {
    // --- Auth ---
    const authHeader = context.request.headers.get('Authorization');
    const adminToken = context.env.ADMIN_TOKEN;

    if (!authHeader || authHeader !== `Bearer ${adminToken}`) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // --- Read monolithic coverage ---
    const coverageJson = await context.env.WARDRIVE_DATA.get('coverage');
    if (!coverageJson) {
      // Check if already migrated
      const existingIndex = await context.env.WARDRIVE_DATA.get('shard_index');
      if (existingIndex) {
        const idx = JSON.parse(existingIndex);
        return new Response(JSON.stringify({
          message: 'Already migrated (no legacy key found)',
          shardCount: Object.keys(idx).length,
        }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
      return new Response(JSON.stringify({ error: 'No coverage data to migrate' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const coverage = JSON.parse(coverageJson);
    const totalBefore = Object.keys(coverage).length;

    // --- Split into shards, pruning expired cells ---
    const shards = {};
    let prunedCount = 0;

    Object.entries(coverage).forEach(([hash, cell]) => {
      // Prune cells older than EXPIRY_DAYS
      if (ageInDays(cell.lastUpdate) > EXPIRY_DAYS) {
        prunedCount++;
        return;
      }
      const prefix = hash.substring(0, SHARD_PREFIX_LEN);
      if (!shards[prefix]) shards[prefix] = {};
      shards[prefix][hash] = cell;
    });

    // --- Merge with any existing shards (in case some POSTs already went to shards) ---
    const existingIndexJson = await context.env.WARDRIVE_DATA.get('shard_index');
    const existingIndex = existingIndexJson ? JSON.parse(existingIndexJson) : {};

    const prefixes = Object.keys(shards);
    const existingShardData = await Promise.all(
      prefixes.map(p => context.env.WARDRIVE_DATA.get(`shard:${p}`))
    );

    const shardIndex = { ...existingIndex };
    const writes = [];
    const shardSizes = [];

    prefixes.forEach((prefix, i) => {
      const legacyData = shards[prefix];
      let merged = existingShardData[i] ? JSON.parse(existingShardData[i]) : {};

      // Legacy data goes under existing shard data (existing wins on conflict)
      Object.entries(legacyData).forEach(([hash, cell]) => {
        if (!merged[hash]) {
          merged[hash] = cell;
        }
      });

      const cells = Object.keys(merged).length;
      const samples = Object.values(merged).reduce((sum, c) => sum + (c.samples || 0), 0);
      const lastUpdate = Object.values(merged).reduce(
        (latest, c) => (c.lastUpdate > latest ? c.lastUpdate : latest), ''
      );

      shardIndex[prefix] = {
        cells,
        samples,
        lastUpdate,
        version: (shardIndex[prefix]?.version || 0) + 1,
      };

      const json = JSON.stringify(merged);
      shardSizes.push({ prefix, cells, bytes: json.length });
      writes.push(context.env.WARDRIVE_DATA.put(`shard:${prefix}`, json));
    });

    // Write shard index + bump version
    writes.push(context.env.WARDRIVE_DATA.put('shard_index', JSON.stringify(shardIndex)));
    const currentVersion = parseInt(await context.env.WARDRIVE_DATA.get('coverage_version') || '0');
    writes.push(context.env.WARDRIVE_DATA.put('coverage_version', String(currentVersion + 1)));

    await Promise.all(writes);

    // Delete old monolithic key
    await context.env.WARDRIVE_DATA.delete('coverage');

    const totalAfter = Object.values(shardIndex).reduce((sum, m) => sum + m.cells, 0);
    const totalSamples = Object.values(shardIndex).reduce((sum, m) => sum + m.samples, 0);

    return new Response(JSON.stringify({
      success: true,
      cellsBefore: totalBefore,
      cellsPruned: prunedCount,
      cellsAfter: totalAfter,
      totalSamples,
      shardsCreated: prefixes.length,
      shardSizes: shardSizes.sort((a, b) => b.bytes - a.bytes),
    }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
