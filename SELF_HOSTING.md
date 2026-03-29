# Self-Hosting with Docker

Runs as three containers: **app** (Node.js/Express), **postgres** (PostgreSQL 16), **redis** (Redis 7).
Secrets are passed as environment variables — no secrets files in the repo or the image.

## Prerequisites

- Docker + Docker Compose on the host
- A reverse proxy (e.g. Nginx Proxy Manager) pointing a subdomain at port 3000

## Deploy on your server

### 1. Set secrets in the system environment

```bash
sudo sh -c 'echo "PG_PASSWORD=your_strong_password" >> /etc/environment'
sudo sh -c 'echo "ADMIN_TOKEN=your_admin_token"     >> /etc/environment'
source /etc/environment
```

`PG_PASSWORD` — PostgreSQL password for the `wardrive` database user.
`ADMIN_TOKEN` — Bearer token required for `DELETE /api/samples` (data wipe).

### 2. Clone and start

```bash
git clone https://github.com/george-viaud/meshwar-map
cd meshwar-map
docker compose up -d
```

The PostgreSQL schema is created automatically on first start via `db/init.sql`.

### 3. Nginx Proxy Manager

Add a proxy host:
- **Domain**: `wardrive.inwmesh.org`
- **Forward hostname**: `localhost` (or the Docker host IP)
- **Forward port**: `3001`
- Enable SSL via Let's Encrypt

### 4. Update the Android app

In the app settings, set the upload URL to:
```
https://wardrive.inwmesh.org/api/samples
```

---

## Updating

```bash
cd meshwar-map
git pull
docker compose up -d --build
```

## Useful commands

```bash
# View logs
docker compose logs -f app

# Stop everything
docker compose down

# Wipe all coverage data (requires ADMIN_TOKEN)
curl -X DELETE https://wardrive.inwmesh.org/api/samples \
  -H "Authorization: Bearer your_admin_token"

# Connect to the database directly
docker compose exec postgres psql -U wardrive -d wardrive
```

## Architecture

```
Nginx Proxy Manager → app:3000 (Node.js)
                          ├── GET  /api/samples        — shard index or shard data
                          ├── GET  /api/samples?prefixes=xyz,abc  — specific shards
                          ├── POST /api/samples        — upload wardrive samples
                          ├── DELETE /api/samples      — wipe data (admin token required)
                          └── /*                       — static map frontend
                      postgres:5432 (coverage data, persistent)
                      redis:6379    (deduplication TTLs, API response cache)
```

## Data persistence

PostgreSQL data lives in the `postgres_data` Docker volume.
Redis data (dedup keys + cache) lives in the `redis_data` Docker volume.
Both survive container restarts and `docker compose down`.
To fully wipe data including volumes: `docker compose down -v` (destructive).
