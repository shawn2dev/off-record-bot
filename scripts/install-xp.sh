#!/usr/bin/env bash
set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  printf '%s\n' 'Run this installer with sudo -n on the Ubuntu VM.' >&2
  exit 1
fi
if [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 24 ]]; then
  printf '%s\n' 'Node.js 24 or later is required.' >&2
  exit 1
fi
if systemctl is-active --quiet off-record-xp.service; then
  printf '%s\n' 'Stop off-record-xp.service before upgrading.' >&2
  exit 1
fi
project="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
application=/opt/off-record-xp
if ! id -u off-record-xp >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/off-record-xp --shell /usr/sbin/nologin off-record-xp
fi
install -d -m 755 "$application/src" /usr/local/lib/off-record-xp
install -d -m 700 -o off-record-xp -g off-record-xp /var/lib/off-record-xp
install_dependencies=true
if cmp -s "$project/deploy/xp/package.json" "$application/package.json" &&
  cmp -s "$project/deploy/xp/package-lock.json" "$application/package-lock.json" &&
  [[ -f "$application/node_modules/discord.js/package.json" ]]; then
  install_dependencies=false
fi
install -m 644 "$project"/src/xp*.js "$application/src/"
install -m 644 "$project"/deploy/xp/package.json "$project"/deploy/xp/package-lock.json "$application/"
if [[ "$install_dependencies" == true ]]; then
  npm ci --prefix "$application" --omit=dev --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org
else
  printf '%s\n' 'Runtime dependency manifests unchanged; preserving installed dependencies.'
fi
install -m 755 "$project/scripts/backup-xp.sh" /usr/local/lib/off-record-xp/backup-xp.sh
install -m 644 "$project"/deploy/xp/off-record-xp*.service "$project"/deploy/xp/off-record-xp*.timer /etc/systemd/system/
if [[ ! -f /etc/off-record-xp.env ]]; then
  install -m 600 "$project/.env.example" /etc/off-record-xp.env
fi
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/off-record-xp.service /etc/systemd/system/off-record-xp-backup.service /etc/systemd/system/off-record-xp-backup.timer
systemctl enable --now off-record-xp-backup.timer
printf '%s\n' 'XP runtime installed. Configure /etc/off-record-xp.env before enabling the bot service.'