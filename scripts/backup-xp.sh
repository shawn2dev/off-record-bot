#!/usr/bin/env bash
set -euo pipefail
umask 077

database="${XP_DATABASE_PATH:-/var/lib/off-record-xp/xp.sqlite}"
directory="${XP_BACKUP_DIRECTORY:-/var/lib/off-record-xp/backups}"
if [[ ! -f "$database" ]]; then exit 0; fi
mkdir -p "$directory"
destination="$directory/xp-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
sqlite3 "$database" '.timeout 5000' ".backup '$destination'"
if [[ "$(sqlite3 "$destination" 'PRAGMA integrity_check;')" != 'ok' ]]; then
  printf '%s\n' 'XP backup integrity check failed.' >&2
  exit 1
fi
cd "$directory"
find . -type f -name 'xp-*.sqlite' -mtime +6 -delete
printf '%s\n' 'XP database backup verified.'