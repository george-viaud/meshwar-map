#!/usr/bin/env bash
# deploy.sh — snapshot database, pull latest code, rebuild and restart app.
#
# Usage (run from this directory on apollo):
#   ./deploy.sh
#
# To restore from a backup:
#   gunzip -c backups/wardrive_YYYYMMDD_HHMMSS.sql.gz \
#     | docker compose exec -T postgres psql -U wardrive wardrive
#
# Options:
#   KEEP_BACKUPS=N  — number of backups to retain (default: 10)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
BACKUP_DIR="$SCRIPT_DIR/backups"
KEEP_BACKUPS="${KEEP_BACKUPS:-10}"

# ── 1. Pre-flight ─────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     MeshCore Wardrive — Deploy           ║"
echo "╚══════════════════════════════════════════╝"
echo ""

if ! docker compose -f "$COMPOSE_FILE" ps postgres --status running | grep -q postgres; then
  echo "✗ PostgreSQL container is not running — cannot snapshot. Aborting."
  exit 1
fi

# ── 2. Snapshot database ──────────────────────────────────────────────────────

mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/wardrive_${TIMESTAMP}.sql.gz"

echo "→ Snapshotting database..."
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U wardrive wardrive | gzip > "$BACKUP_FILE"
SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
echo "  Saved: $(basename "$BACKUP_FILE") ($SIZE)"

# ── 3. Rotate old backups ─────────────────────────────────────────────────────

BACKUP_COUNT=$(ls "$BACKUP_DIR"/wardrive_*.sql.gz 2>/dev/null | wc -l)
if [ "$BACKUP_COUNT" -gt "$KEEP_BACKUPS" ]; then
  DELETE_COUNT=$(( BACKUP_COUNT - KEEP_BACKUPS ))
  echo "→ Rotating backups (removing $DELETE_COUNT oldest, keeping $KEEP_BACKUPS)..."
  ls -t "$BACKUP_DIR"/wardrive_*.sql.gz | tail -n "$DELETE_COUNT" | xargs rm --
fi
echo "  Backups retained: $(ls "$BACKUP_DIR"/wardrive_*.sql.gz | wc -l)"

# ── 4. Pull latest code ───────────────────────────────────────────────────────

echo "→ Pulling latest code..."
cd "$SCRIPT_DIR"
git pull

# ── 5. Rebuild and restart ────────────────────────────────────────────────────

echo "→ Rebuilding and restarting app..."
source /etc/environment
docker compose -f "$COMPOSE_FILE" up -d --build app

# ── 6. Confirm startup ────────────────────────────────────────────────────────

echo "→ Waiting for app to start..."
sleep 4
docker compose -f "$COMPOSE_FILE" logs --tail=25 app

echo ""
echo "✓ Deploy complete."
echo "  Backup: $BACKUP_FILE"
echo ""
