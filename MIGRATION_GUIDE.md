# Migration to Geohash-Based Aggregated Storage

## What Changed?

The map backend has been upgraded from raw sample storage to geohash-based aggregated coverage with time decay.

### Before (Raw Samples)
```json
{
  "samples": [
    {"lat": 47.6097, "lng": -122.3421, "pingSuccess": true, ...},
    {"lat": 47.6098, "lng": -122.3419, "pingSuccess": true, ...},
    // ... 100,000 samples (~20 MB)
  ]
}
```

### After (Aggregated Coverage)
```json
{
  "coverage": {
    "c23nb62": {
      "received": 15.3,
      "lost": 2.1,
      "samples": 18,
      "nodes": ["AB", "CD"],
      "firstSeen": "2026-01-16T...",
      "lastUpdate": "2026-01-16T..."
    }
    // ... ~10,000 geohash cells (~2 MB)
  }
}
```

## Key Benefits

1. **90% storage reduction**: 100k samples → ~10k coverage cells
2. **Preserves all contributions**: Everyone's work aggregated, not replaced
3. **Time decay**: Old data gradually loses weight but never disappears
4. **Scales globally**: Can handle millions of samples
5. **Visual freshness indicators**: Users see if data is "Live" or "Last Known"

## New Features

### Visual Indicators

**Solid Borders (Fresh Data)**
- 🟢 Live Coverage (<7 days old): Full opacity, solid border
- 🟡 Recent Coverage (7-30 days): 80% opacity, solid border

**Dashed Borders (Old Data)**
- ⚪ Last Known Coverage (>30 days): 60% opacity, dashed border

### Time Decay Schedule

| Age | Weight | Description |
|-----|--------|-------------|
| <7 days | 100% | Fresh - full weight |
| 7-14 days | 85% | Slightly aged |
| 14-30 days | 70% | Moderately aged |
| 30-90 days | 50% | Old but relevant |
| 90+ days | 20% | Very old, minimal weight |

### Merge Logic

When new data arrives for an existing coverage square:
1. **Apply decay** to existing data based on age
2. **Add new samples** at full weight
3. **Update timestamp** to mark as fresh
4. **Merge repeater lists**

**Example:**
```
Existing square "c23nb62" (45 days old):
  received: 10, lost: 2  → Apply 50% decay → received: 5, lost: 1

New data arrives:
  3 successful pings, 1 failed ping

Final result:
  received: 8 (5 + 3), lost: 2 (1 + 1)
  lastUpdate: "2026-01-16..." (now fresh!)
  Border: Solid, Opacity: 100%
```

## Testing

### 1. Test with Sample Data

Create a test upload:
```bash
curl -X POST https://wardrive.inwmesh.org/api/samples \
  -H "Content-Type: application/json" \
  -d '{
    "samples": [
      {
        "latitude": 47.6062,
        "longitude": -122.3321,
        "pingSuccess": true,
        "nodeId": "ABCD1234",
        "timestamp": "2026-01-16T00:00:00Z"
      }
    ]
  }'
```

Expected response:
```json
{
  "success": true,
  "samplesReceived": 1,
  "cellsUpdated": 0,
  "cellsCreated": 1,
  "totalCells": 1
}
```

### 2. Verify on Map

Visit https://wardrive.inwmesh.org and check:
- ✅ Coverage squares appear
- ✅ Clicking square shows "🟢 Live Coverage"
- ✅ Success rate displays correctly
- ✅ Repeater IDs shown (first 2 chars)
- ✅ Fresh data has solid borders

### 3. Test Time Decay

Upload old data:
```bash
curl -X POST https://wardrive.inwmesh.org/api/samples \
  -H "Content-Type: application/json" \
  -d '{
    "samples": [
      {
        "latitude": 47.6062,
        "longitude": -122.3321,
        "pingSuccess": false,
        "timestamp": "2025-11-01T00:00:00Z"
      }
    ]
  }'
```

Check map shows:
- ⚪ "Last Known Coverage (76 days ago)"
- Dashed border
- Faded opacity

## Deployment

### Deploy

```bash
cd meshwar-map
git add .
git commit -m "Migrate to geohash-based aggregated storage"
git push origin main
ssh apollo "cd ~/docker/meshwar-map && git pull && docker compose up -d --build app"
```

## Migration Notes

### Data Compatibility

**Old data will NOT automatically migrate.** The new system expects coverage format, not raw samples.

**Options:**

1. **Start Fresh** (Recommended for testing)
   - Clear old data with DELETE request
   - Users re-upload with new format

2. **Dual Storage** (Transition period)
   - Keep old 'samples' key temporarily
   - Store new data in 'coverage' key
   - Remove 'samples' after 30 days

3. **Migration Script** (Advanced)
   - Read old samples from KV
   - Aggregate into coverage format
   - Write back as coverage
   - Delete old samples key

### Android App Compatibility

The Android app will continue to upload raw samples. The backend API automatically:
1. Receives raw samples
2. Aggregates them by geohash
3. Merges with existing coverage (with decay)
4. Stores only aggregated coverage

**No app changes required!** The app upload format stays the same.

## Rollback Plan

If issues arise, revert by:

```bash
cd meshwar-map
git revert HEAD
git push origin main
```

Then restore old samples data from backup (if needed).

## Storage Estimates

| Users | Samples/User | Old Size | New Size | Savings |
|-------|--------------|----------|----------|---------|
| 10 | 1,000 | 200 KB | 20 KB | 90% |
| 100 | 10,000 | 20 MB | 2 MB | 90% |
| 1,000 | 100,000 | 200 MB | 20 MB | 90% |

## Questions?

- Check the API response for errors
- Inspect browser console for frontend issues
- Check logs with `ssh apollo "docker compose -f ~/docker/meshwar-map/docker-compose.yml logs -f app"`

## Next Steps

1. ✅ Deploy to wardrive.inwmesh.org
2. ✅ Test with sample uploads
3. ✅ Monitor for 24 hours
4. ✅ Ask users to test
5. ✅ Update documentation
