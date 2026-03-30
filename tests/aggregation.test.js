'use strict';

const { shardPrefix, ageInDays, decayFactor, computeSampleId, aggregateSamples } = require('../lib/aggregation');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSample(overrides = {}) {
  return {
    latitude: 47.6588,
    longitude: -117.4260,
    timestamp: new Date().toISOString(),
    nodeId: 'ABC12345',
    pingSuccess: true,
    rssi: -95,
    snr: 8,
    appVersion: '1.0.25',
    ...overrides,
  };
}

// ── shardPrefix ───────────────────────────────────────────────────────────────

describe('shardPrefix', () => {
  test('returns first 3 chars of geohash', () => {
    expect(shardPrefix('c23nb2q2')).toBe('c23');
  });

  test('handles short geohash', () => {
    expect(shardPrefix('c23')).toBe('c23');
  });
});

// ── decayFactor ───────────────────────────────────────────────────────────────

describe('decayFactor', () => {
  function daysAgo(n) {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  }

  test('fresh data (0 days) → 1.0', () => {
    expect(decayFactor(daysAgo(0))).toBe(1.0);
  });

  test('8 days old → 0.85', () => {
    expect(decayFactor(daysAgo(8))).toBe(0.85);
  });

  test('15 days old → 0.7', () => {
    expect(decayFactor(daysAgo(15))).toBe(0.7);
  });

  test('31 days old → 0.5', () => {
    expect(decayFactor(daysAgo(31))).toBe(0.5);
  });

  test('91 days old → 0.2', () => {
    expect(decayFactor(daysAgo(91))).toBe(0.2);
  });
});

// ── computeSampleId ───────────────────────────────────────────────────────────

describe('computeSampleId', () => {
  test('uses sample.id when present', () => {
    expect(computeSampleId({ id: 'abc123' })).toBe('abc123');
  });

  test('generates stable hash from lat/lng/timestamp/nodeId', () => {
    const s = makeSample({ id: undefined });
    const id1 = computeSampleId(s);
    const id2 = computeSampleId(s);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^h\d+$/);
  });

  test('different coords produce different ids', () => {
    const a = computeSampleId(makeSample({ id: undefined, latitude: 47.0 }));
    const b = computeSampleId(makeSample({ id: undefined, latitude: 48.0 }));
    expect(a).not.toBe(b);
  });
});

// ── aggregateSamples — ping classification ────────────────────────────────────

describe('aggregateSamples — ping classification', () => {
  // Case 1: pingSuccess=true, nodeId known → success only
  test('pingSuccess=true, nodeId known → received++, lost unchanged', () => {
    const result = aggregateSamples([makeSample({ pingSuccess: true, nodeId: 'ABC12345' })]);
    const cell = Object.values(result)[0];
    expect(cell.received).toBe(1);
    expect(cell.lost).toBe(0);
    expect(cell.samples).toBe(1);
  });

  // Case 2: pingSuccess=false, nodeId known → failed only
  test('pingSuccess=false, nodeId known → lost++, received unchanged', () => {
    const result = aggregateSamples([makeSample({ pingSuccess: false, nodeId: 'ABC12345' })]);
    const cell = Object.values(result)[0];
    expect(cell.received).toBe(0);
    expect(cell.lost).toBe(1);
    expect(cell.samples).toBe(1);
  });

  // Case 3 (THE BUG): pingSuccess=true, nodeId='Unknown' → success only, NOT double-counted
  test('pingSuccess=true, nodeId=Unknown → received++, lost unchanged (not double-counted)', () => {
    const result = aggregateSamples([makeSample({ pingSuccess: true, nodeId: 'Unknown' })]);
    const cell = Object.values(result)[0];
    expect(cell.received).toBe(1);
    expect(cell.lost).toBe(0);
    expect(cell.samples).toBe(1);
  });

  // Case 4: pingSuccess=false, nodeId='Unknown' → failed only
  test('pingSuccess=false, nodeId=Unknown → lost++, received unchanged', () => {
    const result = aggregateSamples([makeSample({ pingSuccess: false, nodeId: 'Unknown' })]);
    const cell = Object.values(result)[0];
    expect(cell.received).toBe(0);
    expect(cell.lost).toBe(1);
    expect(cell.samples).toBe(1);
  });

  // pingSuccess=null, nodeId known → treated as success (fallback)
  test('pingSuccess=null, nodeId known → received++ (fallback to nodeId)', () => {
    const result = aggregateSamples([makeSample({ pingSuccess: null, nodeId: 'ABC12345' })]);
    const cell = Object.values(result)[0];
    expect(cell.received).toBe(1);
    expect(cell.lost).toBe(0);
  });

  // pingSuccess=null, nodeId=Unknown → treated as failed (fallback)
  test('pingSuccess=null, nodeId=Unknown → lost++ (fallback to nodeId)', () => {
    const result = aggregateSamples([makeSample({ pingSuccess: null, nodeId: 'Unknown' })]);
    const cell = Object.values(result)[0];
    expect(cell.received).toBe(0);
    expect(cell.lost).toBe(1);
  });

  // GPS-only: pingSuccess=null, no nodeId → neither success nor failed, samples++ only
  test('pingSuccess=null, no nodeId → samples++ only (GPS-only point)', () => {
    const result = aggregateSamples([makeSample({ pingSuccess: null, nodeId: undefined })]);
    const cell = Object.values(result)[0];
    expect(cell.received).toBe(0);
    expect(cell.lost).toBe(0);
    expect(cell.samples).toBe(1);
  });
});

// ── aggregateSamples — general behaviour ─────────────────────────────────────

describe('aggregateSamples — general', () => {
  test('empty input → empty result', () => {
    expect(aggregateSamples([])).toEqual({});
  });

  test('skips samples missing lat/lng', () => {
    const result = aggregateSamples([{ timestamp: new Date().toISOString(), pingSuccess: true }]);
    expect(Object.keys(result)).toHaveLength(0);
  });

  test('two successes at same location → received=2', () => {
    const s = makeSample();
    const result = aggregateSamples([s, s]);
    const cell = Object.values(result)[0];
    expect(cell.received).toBe(2);
    expect(cell.samples).toBe(2);
  });

  test('repeater recorded only on success with known nodeId', () => {
    const result = aggregateSamples([makeSample({ pingSuccess: true, nodeId: 'NODE01' })]);
    const cell = Object.values(result)[0];
    expect(cell.repeaters['NODE01']).toBeDefined();
    expect(cell.repeaters['NODE01'].rssi).toBe(-95);
  });

  test('repeater NOT recorded when pingSuccess=false', () => {
    const result = aggregateSamples([makeSample({ pingSuccess: false, nodeId: 'NODE01' })]);
    const cell = Object.values(result)[0];
    expect(cell.repeaters['NODE01']).toBeUndefined();
  });

  test('repeater NOT recorded when nodeId=Unknown', () => {
    const result = aggregateSamples([makeSample({ pingSuccess: true, nodeId: 'Unknown' })]);
    const cell = Object.values(result)[0];
    expect(Object.keys(cell.repeaters)).toHaveLength(0);
  });

  test('latest repeater entry wins when same nodeId seen twice', () => {
    const older = makeSample({ timestamp: '2025-01-01T00:00:00Z', nodeId: 'NODE01', rssi: -110 });
    const newer = makeSample({ timestamp: '2025-06-01T00:00:00Z', nodeId: 'NODE01', rssi: -80 });
    const result = aggregateSamples([older, newer]);
    const cell = Object.values(result)[0];
    expect(cell.repeaters['NODE01'].rssi).toBe(-80);
  });
});
