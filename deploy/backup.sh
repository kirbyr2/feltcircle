#!/bin/sh
# Snapshot the FeltCircle SQLite database and keep the newest $KEEP copies.
# Safe while the server is running. Usage:
#   systemd:  /opt/feltcircle/backup.sh
#   Docker:   docker compose exec feltcircle node server.mjs backup
#             (backups land in the data volume under /data/backups)
set -eu
DATA_DIR="${DATA_DIR:-/var/lib/feltcircle}"
SERVER="${SERVER:-/opt/feltcircle/server.mjs}"
KEEP="${KEEP:-14}"
BACKUP_DIR="$DATA_DIR/backups"

mkdir -p "$BACKUP_DIR"
DATA_DIR="$DATA_DIR" node --disable-warning=ExperimentalWarning "$SERVER" backup \
  "$BACKUP_DIR/feltcircle-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
ls -1t "$BACKUP_DIR"/feltcircle-*.sqlite 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
