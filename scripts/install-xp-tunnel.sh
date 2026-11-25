#!/usr/bin/env bash
set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  printf '%s\n' 'Run this installer with sudo -n on the Ubuntu VM.' >&2
  exit 1
fi
if [[ ! -x /usr/bin/cloudflared ]]; then
  printf '%s\n' 'Install the official cloudflared package before configuring the Tunnel.' >&2
  exit 1
fi
project="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if ! id -u off-record-tunnel >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin off-record-tunnel
fi
install -d -m 750 -o root -g off-record-tunnel /etc/cloudflared
if [[ ! -f /etc/cloudflared/off-record.yml ]]; then
  install -m 640 -o root -g off-record-tunnel \
    "$project/deploy/xp/cloudflared.example.yml" /etc/cloudflared/off-record.yml
fi
install -m 644 "$project/deploy/xp/off-record-cloudflared.service" /etc/systemd/system/
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/off-record-cloudflared.service
printf '%s\n' \
  'Tunnel unit installed but not enabled.' \
  'Configure the named Tunnel ID, credentials and hostname in /etc/cloudflared/off-record.yml.' \
  'Keep /etc/cloudflared/off-record.json root-owned, group off-record-tunnel, mode 640.' \
  'After configuring DNS and API OAuth, enable off-record-cloudflared.service explicitly.'
