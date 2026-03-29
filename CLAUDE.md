# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Run locally
node server.js

# Run with hot reload (Node 18+)
node --watch server.js
```

All environment variables must be set before running — see Deployment below.

## Deployment

The app runs on **apollo** at `wardrive.inwmesh.org`, deployed via Docker Compose.

```bash
# After pushing changes — rebuild and redeploy on apollo
ssh apollo "cd ~/docker/meshwar-map && git pull && source /etc/environment && docker compose up -d --build app"

# View logs
ssh apollo "docker compose -f ~/docker/meshwar-map/docker-compose.yml logs -f app"

# Wipe all coverage data
curl -X DELETE https://wardrive.inwmesh.org/api/samples \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

Secrets (`PG_PASSWORD`, `ADMIN_TOKEN`) are set in `/etc/environment` on apollo — not in any file in this repo.

Full deployment instructions: `SELF_HOSTING.md`

## Architecture

**Stack:** Node.js/Express (`server.js`) + PostgreSQL 16 + Redis 7, all in `docker-compose.yml`.

The app serves two things from a single port (3001 on apollo → 3000 inside container):
- **Static frontend** — `index.html`, `js/app.js`, `css/style.css` (Leaflet map)
- **REST API** — `GET/POST/DELETE /api/samples`

### API behaviour

| Method | Behaviour |
|--------|-----------|
| `GET /api/samples` | Returns shard index (prefix → metadata). Redis-cached for 10s with ETag support. |
| `GET /api/samples?prefixes=xyz,abc` | Returns full coverage cell data for requested shards. Per-shard Redis cache. |
| `POST /api/samples` | Deduplicates via Redis (`seen:{id}` keys, 90-day TTL), aggregates into geohash-7 cells, upserts PostgreSQL, invalidates cache. |
| `DELETE /api/samples` | Requires `Authorization: Bearer <ADMIN_TOKEN>`. Wipes all data. |

### Data model

Coverage is stored at **geohash precision 7** (~153m × 153m cells) in PostgreSQL, sharded by the first 3 characters of the geohash (~156km × 156km areas). The frontend fetches only shards visible in the current map viewport.

**`coverage_cells`** — one row per geohash-7 cell:
- `received`, `lost` — weighted counts (decay applied on each POST)
- `repeaters` — JSONB `{ nodeId: { name, rssi, snr, lastSeen } }`
- `shard_prefix` — first 3 chars, indexed for shard queries

**`shard_index`** — one row per shard prefix with `cells`, `samples`, `version` (bumped on every write, used for ETag)

**`global_version`** — single-row counter, drives the top-level ETag

### Time decay

On every POST, existing cells for affected shards are fetched and their `received`/`lost` counts are multiplied by a decay factor before merging new data:

| Age | Factor |
|-----|--------|
| < 7 days | 1.0 |
| 7–14 days | 0.85 |
| 14–30 days | 0.7 |
| 30–90 days | 0.5 |
| > 90 days | 0.2 |

Cells older than 90 days are pruned on each POST.

### Redis usage

- `seen:{sampleId}` — deduplication, 90-day TTL
- `shard:{prefix}` — cached shard data, 10s TTL, invalidated on write
- `index` — cached shard index response, 10s TTL, invalidated on write
- `global_version` — cached version counter

### Frontend

`js/app.js` fetches the shard index on load, then lazily fetches shard data as the user pans/zooms. It re-aggregates precision-7 cells client-side to coarser precisions (5 or 6) for display at lower zoom levels. The `functions/` directory is legacy Cloudflare Pages Functions — not used by the self-hosted server.
