#!/usr/bin/env bash
set -euo pipefail
umask 077

host="${XP_SSH_HOST:-ubuntu@129.225.144.206}"
key="${XP_SSH_KEY:-$HOME/.ssh/ssh-key-2026-11-24.key}"
directory="${XP_LOCAL_BACKUP_DIRECTORY:-$HOME/Backups/off-record-xp}"
mkdir -p "$directory"
destination="$directory/xp-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
temporary="$(mktemp "$directory/.xp-backup.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
ssh -i "$key" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 "$host" \
  'sudo -n -u off-record-xp /usr/local/lib/off-record-xp/backup-xp.sh >/dev/null && sudo -n -u off-record-xp tar -czf - -C /var/lib/off-record-xp backups' > "$temporary"
tar -tzf "$temporary" >/dev/null
mv "$temporary" "$destination"
find "$directory" -type f -name 'xp-*.tar.gz' -mtime +13 -delete
printf 'XP backups downloaded to %s\n' "$destination"