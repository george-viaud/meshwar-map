'use strict';

const ngeohash = require('ngeohash');

function shardPrefix(hash) {
  return hash.substring(0, 3);
}

function ageInDays(timestamp) {
  return Math.floor((Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60 * 24));
}

function decayFactor(timestamp) {
  const age = ageInDays(timestamp);
  if (age > 90) return 0.2;
  if (age > 30) return 0.5;
  if (age > 14) return 0.7;
  if (age > 7)  return 0.85;
  return 1.0;
}

function computeSampleId(sample) {
  if (sample.id) return String(sample.id);
  const lat = sample.latitude ?? sample.lat;
  const lng = sample.longitude ?? sample.lng;
  const key = `${lat?.toFixed?.(6)}|${lng?.toFixed?.(6)}|${sample.timestamp || ''}|${sample.nodeId || ''}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) - h) + key.charCodeAt(i);
    h |= 0;
  }
  return `h${Math.abs(h)}`;
}

// pingSuccess is authoritative.
// nodeId is only used as a fallback when pingSuccess is null/undefined.
function aggregateSamples(samples) {
  const coverage = {};
  const now = new Date().toISOString();

  for (const sample of samples) {
    const lat = sample.latitude ?? sample.lat;
    const lng = sample.longitude ?? sample.lng;
    if (!lat || !lng) continue;

    const hash = ngeohash.encode(lat, lng, 7);

    const success = sample.pingSuccess === true ||
                    (sample.pingSuccess == null && sample.nodeId && sample.nodeId !== 'Unknown');
    const failed  = sample.pingSuccess === false ||
                    (sample.pingSuccess == null && sample.nodeId === 'Unknown');

    if (!coverage[hash]) {
      coverage[hash] = {
        received: 0, lost: 0, samples: 0,
        repeaters: {},
        firstSeen:  sample.timestamp || now,
        lastUpdate: sample.timestamp || now,
        appVersion: sample.appVersion || 'unknown',
      };
    }

    const cell = coverage[hash];

    if (success) {
      cell.received += 1;
      if (sample.nodeId && sample.nodeId !== 'Unknown') {
        const t = new Date(sample.timestamp || now).getTime();
        if (!cell.repeaters[sample.nodeId] ||
            new Date(cell.repeaters[sample.nodeId].lastSeen).getTime() < t) {
          cell.repeaters[sample.nodeId] = {
            name: sample.repeaterName || sample.nodeId,
            rssi: sample.rssi ?? null,
            snr:  sample.snr  ?? null,
            lastSeen: sample.timestamp || now,
          };
        }
      }
    } else if (failed) {
      cell.lost += 1;
    }

    cell.samples += 1;
    if ((sample.timestamp || '') > cell.lastUpdate) cell.lastUpdate = sample.timestamp;
    if (sample.appVersion && sample.appVersion !== 'unknown') cell.appVersion = sample.appVersion;
  }

  return coverage;
}

module.exports = { shardPrefix, ageInDays, decayFactor, computeSampleId, aggregateSamples };
