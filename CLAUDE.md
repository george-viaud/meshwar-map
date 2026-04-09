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

# Run all tests
npm test

# Run a single test file
npx jest tests/aggregation.test.js

# Run tests matching a description
npx jest --testNamePattern "decayFactor"
```

All environment variables must be set before running — see Deployment below.

### Required environment variables

| Variable | Default | Notes |
|----------|---------|-------|
| `PG_PASSWORD` | — | Required |
| `ADMIN_TOKEN` | — | Used for `DELETE /api/samples` and initial admin bootstrap |
| `JWT_SECRET` | — | Required for login/session tokens |
| `PG_HOST` | `postgres` | |
| `PG_PORT` | `5432` | |
| `PG_DB` | `wardrive` | |
| `PG_USER` | `wardrive` | |
| `REDIS_HOST` | `redis` | |
| `REDIS_PORT` | `6379` | |
| `PORT` | `3000` | |

## Deployment

The app runs on **apollo** at `wardrive.inwmesh.org`, deployed via Docker Compose.

```bash
# After pushing changes — deploy on apollo (snapshots DB first, then rebuilds)
ssh apollo "cd ~/docker/meshwar-map && ./deploy.sh"

# View logs
ssh apollo "docker compose -f ~/docker/meshwar-map/docker-compose.yml logs -f app"

# Wipe all coverage data
curl -X DELETE https://wardrive.inwmesh.org/api/samples \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

`deploy.sh` automatically:
1. Snapshots the database to `backups/wardrive_YYYYMMDD_HHMMSS.sql.gz` (aborts if this fails)
2. Rotates old backups, keeping the last 10
3. Pulls latest code (`git pull`)
4. Rebuilds and restarts the app container
5. Tails logs to confirm startup

**To restore from a backup:**
```bash
ssh apollo
gunzip -c ~/docker/meshwar-map/backups/wardrive_YYYYMMDD_HHMMSS.sql.gz \
  | docker compose -f ~/docker/meshwar-map/docker-compose.yml exec -T postgres \
    psql -U wardrive wardrive
```

Secrets (`PG_PASSWORD`, `ADMIN_TOKEN`) are set in `/etc/environment` on apollo — not in any file in this repo.

Full deployment instructions: `SELF_HOSTING.md`

## Architecture

**Stack:** Node.js/Express (`server.js`) + PostgreSQL 16 + Redis 7, all in `docker-compose.yml`.

The app serves two things from a single port (3001 on apollo → 3000 inside container):
- **Static frontend** — `index.html`, `js/app.js`, `css/style.css` (Leaflet map)
- **REST API** — `GET/POST/DELETE /api/samples`

### API routes

**Coverage data** (`routes/samples.js`):
| Method | Endpoint | Auth | Behaviour |
|--------|----------|------|-----------|
| `GET` | `/api/samples` | none | Shard index (prefix → metadata). ETag + 10s Redis cache. |
| `GET` | `/api/samples?prefixes=xyz,abc` | none | Full cell data for requested shards. Per-shard Redis cache. |
| `GET` | `/api/samples/:key/validate` | contributor token | Validates a contributor token. |
| `POST` | `/api/samples/:key` | contributor token | Deduplicates, aggregates, upserts. Token is the 8-char uppercase key in the path. |
| `DELETE` | `/api/samples` | `Bearer ADMIN_TOKEN` | Wipes all coverage data. |

**Auth & users** (`routes/auth.js`, `routes/me.js`, `routes/tokens.js`, `routes/admin.js`):
| Method | Endpoint | Auth | Behaviour |
|--------|----------|------|-----------|
| `POST` | `/api/auth/login` | none | Returns JWT (24h). Rate-limited 10/min per IP. |
| `GET` | `/api/me` | JWT | Own user info. |
| `GET/POST/DELETE` | `/api/me/token` | JWT | Manage own contributor token. |
| `GET/POST/PATCH/DELETE` | `/api/admin/users` | JWT admin | User management. |
| `GET/PATCH` | `/api/admin/contributors` | JWT admin/viewer | Contributor list. |
| `GET` | `/api/admin/token-search` | JWT admin/viewer | Look up a contributor token. |
| `GET/POST/DELETE` | `/api/admin/invites` | JWT admin | Invite link management. |
| `GET/PUT/DELETE` | `/api/admin/geofence` | JWT admin/viewer | Server geofence polygon. |

**Invite flow** (`routes/invite.js`):
| Method | Endpoint | Behaviour |
|--------|----------|-----------|
| `GET` | `/api/invite/:code` | Validate invite link. |
| `POST` | `/api/invite/:code` | Register account + get contributor token. |

**Other:**
- `GET /api/geofence` — public geofence read (for frontend display)
- `GET /api/contributions/:key` — list geohashes contributed by a token

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

### User roles

- `admin` — full access, user/invite management, geofence config
- `viewer` — read-only admin UI (contributors, token search, geofence read)
- `contributor` — uploads coverage data via token-in-path API

On first startup with no users in `admin_users`, a user `admin` is bootstrapped with password equal to `ADMIN_TOKEN`.

### Server modules (`lib/`)

- `lib/db.js` — pg Pool, configured via `PG_*` env vars
- `lib/redis.js` — ioredis client, configured via `REDIS_*` env vars
- `lib/auth.js` — `requireAuth(req, res, roles[])` JWT middleware, `generateKey()` (8-char contributor token), `generateInviteCode()` (24-char), `internalError()`
- `lib/aggregation.js` — `aggregateSamples()`, `decayFactor()`, `computeSampleId()`, `shardPrefix()`
- `lib/rateLimit.js` — Redis-backed sliding window rate limiter

### Database schema

Managed via SQL migration files in `db/migrations/` (applied automatically at startup in filename order). The `schema_migrations` table tracks what's been applied.

**`admin_users`** — accounts with `role` (admin/viewer/contributor), `password_hash`, `enabled`, `invite_id`

**`contributor_tokens`** — 8-char uppercase keys linked to a user; used in POST path (`/api/samples/:key`)

**`invite_links`** — single-use or multi-use invite codes with `uses_remaining` counter; registering via `/api/invite/:code` atomically decrements the counter

**`user_contributions`** — tracks which geohash-7 cells each contributor has uploaded to

**`server_config`** — key/value store for server settings (currently only `geofence`)

### Frontend

`js/app.js` fetches the shard index on load, then lazily fetches shard data as the user pans/zooms. It re-aggregates precision-7 cells client-side to coarser precisions (5 or 6) for display at lower zoom levels. The `functions/` directory is legacy Cloudflare Pages Functions — not used by the self-hosted server.
