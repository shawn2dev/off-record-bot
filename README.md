# Shawny Bot

Shawny Bot is a Discord bot hosted on Cloudflare Workers, with slash commands and an owner-managed user approval list stored in Cloudflare KV.

## Resources used

- [Discord Interactions API](https://discord.com/developers/docs/interactions/receiving-and-responding)
- [Cloudflare Workers](https://workers.cloudflare.com/) for hosting

---

## Project structure

Below is a basic overview of the project structure:

```
├── .github/workflows/ci.yaml -> Github Action configuration
├── src
│   ├── commands.js           -> JSON payloads for commands
│   ├── register.js           -> Sets up commands with the Discord API
│   ├── server.js             -> Discord app logic and routing
├── test
|   ├── test.js               -> Tests for app
├── wrangler.toml             -> Configuration for Cloudflare workers
├── package.json
├── README.md
├── .eslintrc.json
├── .prettierignore
├── .prettierrc.json
└── .gitignore
```

## Configuring project

Before starting, you'll need a [Discord app](https://discord.com/developers/applications) with the following permissions:

- `bot` with the `Send Messages` and `Use Slash Command` permissions
- `applications.commands` scope

> ⚙️ Permissions can be configured by clicking on the `OAuth2` tab and using the `URL Generator`. After a URL is generated, you can install the app by pasting that URL into your browser and following the installation flow.

## Creating your Cloudflare worker

Next, you'll need to create a Cloudflare Worker.

- Visit the [Cloudflare dashboard](https://dash.cloudflare.com/)
- Click on the `Workers` tab, and create a new service using the same name as your Discord bot

## Running locally

First clone the project:

```
git clone https://github.com/discord/cloudflare-sample-app.git
```

Then navigate to its directory and install dependencies:

```
cd cloudflare-sample-app
npm install
```

> ⚙️ The dependencies in this project require at least v18 of [Node.js](https://nodejs.org/en/)

### Local configuration

> 💡 More information about generating and fetching credentials can be found [in the tutorial](https://discord.com/developers/docs/tutorials/hosting-on-cloudflare-workers#storing-secrets)

Rename `example.dev.vars` to `.dev.vars`, and make sure to set each variable.

**`.dev.vars` contains sensitive data so make sure it does not get checked into git**.

### Register commands

The following command only needs to be run once:

```
$ npm run register
```

### Run app

Now you should be ready to start your server:

```
$ npm start
```

### Setting up ngrok

When a user types a slash command, Discord will send an HTTP request to a given endpoint. During local development this can be a little challenging, so we're going to use a tool called `ngrok` to create an HTTP tunnel.

```
$ npm run ngrok
```

![forwarding](https://user-images.githubusercontent.com/534619/157511497-19c8cef7-c349-40ec-a9d3-4bc0147909b0.png)

This is going to bounce requests off of an external endpoint, and forward them to your machine. Copy the HTTPS link provided by the tool. It should look something like `https://8098-24-22-245-250.ngrok.io`. Now head back to the Discord Developer Dashboard, and update the "Interactions Endpoint URL" for your bot:

![interactions-endpoint](https://user-images.githubusercontent.com/534619/157510959-6cf0327a-052a-432c-855b-c662824f15ce.png)

This is the process we'll use for local testing and development. When you've published your bot to Cloudflare, you will _want to update this field to use your Cloudflare Worker URL._

## Deploying app

This repository is set up to automatically deploy to Cloudflare Workers when new changes land on the `main` branch. To deploy manually, run `npm run publish`, which uses the `wrangler publish` command under the hood. Publishing via a GitHub Action requires obtaining an [API Token and your Account ID from Cloudflare](https://developers.cloudflare.com/workers/wrangler/cli-wrangler/authentication/#generate-tokens). These are stored [as secrets in the GitHub repository](https://docs.github.com/en/actions/security-guides/encrypted-secrets#creating-encrypted-secrets-for-a-repository), making them available to GitHub Actions. The following configuration in `.github/workflows/ci.yaml` demonstrates how to tie it all together:

```yaml
release:
  if: github.ref == 'refs/heads/main'
  runs-on: ubuntu-latest
  needs: [test, lint]
  steps:
    - uses: actions/checkout@v3
    - uses: actions/setup-node@v3
      with:
        node-version: 18
    - run: npm install
    - run: npm run publish
      env:
        CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
        CF_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
```

### Storing secrets

The credentials in `.dev.vars` are only applied locally. The production service needs access to credentials from your app:

```
$ wrangler secret put DISCORD_TOKEN
$ wrangler secret put DISCORD_PUBLIC_KEY
$ wrangler secret put DISCORD_APPLICATION_ID
```

## XP Gateway Bot

The XP bot uses a separate Discord application and a persistent Node.js 24
Gateway process. The existing Cloudflare Worker, its application and command
registration remain unchanged. The static dashboard is served by AEM; only
the Gateway, optional loopback JSON API and durable workers run on the XP VM.
No browser, Chromium or crawler runs there. The minimal deployment manifest is
in `deploy/xp`.

### XP Rules

| Activity | XP |
| --- | --- |
| Message | 4, with a 1-second per-user award cooldown |
| Voice | 20 per completed 5-minute interval |
| Attendance | 500 by default, once per Korean calendar day (UTC+9) |
| Self mute or self deafen | 50% voice XP, applied once |
| Server mute or server deafen | No reduction |

Cumulative level threshold: `max(0, floor(((10 * level)^2 - 5) / 3 + 1))`.
The entire `10 * level` term is squared, and fractional thresholds are rounded
down to match the reference table: levels 1-5 require cumulative XP of
32, 132, 299, 532 and 832. Therefore, 520 XP is level 3 and 588 XP is level 4.
Level numbering starts at 0. Fractional XP is stored in milli-XP; displayed XP
is rounded down. All distinct messages count in statistics, including messages
inside the award cooldown. Bots and webhooks are ignored.

Voice XP requires at least two human members in a channel. The server AFK
channel and explicitly excluded channels earn no XP. State changes weight the
elapsed parts of each interval: 2 minutes unmuted plus 3 minutes self-muted
earns 14 XP. Moving channels preserves interval progress; disconnecting from
voice discards an incomplete interval. Voice statistics include connected time,
even when the user is solo or in an excluded channel. XP is booked on the day
it is settled; voice duration is split at Korean midnight.

Leaving the server removes the member from ranking. XP reset is enabled by
default: leaving and rejoining reset the balance to zero. Disabling
`lifecycle.resetOnLeave` preserves the inactive balance and restores access to
it on rejoin. Enabling reset while a member is absent resets that preserved
balance on rejoin. Previously reset XP is never restored by disabling reset.
Historical activity and attendance records remain, preventing same-day
leave/rejoin attendance farming. Tied XP balances share a rank.

Attendance replies include cumulative attendance, the current streak and both
personal ranks, even when today's reward has already been claimed. Streaks
remain current through the following Korean calendar day and expire after a
missed day. Attendance and XP ranking buttons show up to ten active members,
sharing tied ranks, plus the requesting member's own rank outside the list.
Members with no current streak do not receive a streak rank.
Schema version 3 backfills persistent per-member attendance summaries. SQLite
triggers keep summaries consistent with inserts, edits, deletes and rollbacks.
Normal ranking refreshes scan member summaries, not every historical check-in;
historical-date reads retain their exact original semantics.

### Persistence, Permissions and Economy

The store applies a versioned SQLite migration on startup. Back up the database
before the first upgrade. Existing balances become opening ledger entries;
historical transactions are not fabricated, and attendance history is reused.
Unsafe legacy balances and schemas newer than this application are rejected.
An older application is not a supported rollback path for the upgraded database;
restore a matching code/database backup together.

Message, voice and attendance credits, adjustments, gifts, purchases, games,
raffles, resets and refunds use the same transactional ledger path.
Balance, ledger and level-change job writes
commit together. Replayed transaction keys return the original result, while
different request contents under the same key are rejected. Membership
generations cancel stale work; reset versions prevent a late refund from
recreating reset XP. A forfeited refund records a zero-value ledger entry.
With reset disabled, a valid refund can credit a preserved inactive balance
without reactivating the member.

Versioned settings cover attendance, lifecycle, access, gifts, nicknames,
shop availability, all four games and raffle limits. Updates require the
expected version and save an audit record atomically. Owner
`851312069915574332` alone controls delegation; delegated roles receive only
explicitly selected capabilities, combined across their current roles.
Discord Administrator permission alone does not grant application access.
The owner may explicitly delegate an existing high/Administrator role; sale-role
safety restrictions are not incorrectly applied to this trusted decision.
Any role referenced by a product is rejected for delegation, and delegated
roles cannot be sold. Purchase role IDs come from fresh Discord membership,
never browser input. Reward changes affect only future check-ins.

Gifts charge the sender the requested amount; the receiver gets that amount
minus `floor(amount * feePercent / 100)`. The default fee is 15%, configurable
from 0-100%. Deliberately splitting small transfers to avoid rounded fees is
allowed. Gifts cannot target self, bots or inactive/nonmembers.

Role products have versioned titles, descriptions, prices and permanent role
entitlements. Discord uses a native scrollable select menu, grouped beyond
25 options, followed by an explicit confirmation. Web and bot purchases use
the same service. Existing roles are never charged again; a completed purchase
remains purchased after role removal, departure or product replacement.
Any order permanently locks its product's role, even after refund.
Dangerous, managed, above-bot and delegated administrator roles cannot be sold.
Role delivery is attempted immediately after the charge commits, with bounded
transient retries and explicit review for ambiguous outcomes. There is no
one-second delivery guarantee and no blind refund. Administrators can retry,
confirm or refund review orders with an audit trail.

Slots, wheel, odd/even and dice default to 94% gross return to player, not a
94% win chance. Validated integer-weight tables, milli-XP payouts, role/channel
restrictions, betting limits and cooldowns are configurable per game. Invalid
or unrepresentable probability/payout configurations are rejected, not silently
clipped. Raffles preview an expiring candidate snapshot, then revalidate
membership and settle unique winners atomically on explicit confirmation.

Level nickname prefixes are disabled by default and require an explicit opt-in
in dashboard settings. When enabled, the one-second durable worker updates
prefixes on both level increases and decreases, including spending.
The default template is `[lv.{레벨}]`; template and
excluded roles are configurable. Original names are preserved, and disabling
or excluding restores only a bot-applied nickname. Full-server synchronization
queues 50 members per batch and automatically continues a persisted sweep;
clients must not loop over the sync endpoint. Role and nickname jobs have
leases, stale-worker fencing, bounded retries and visible review states.

For an operational pause without changing any current nicknames, set
`XP_NICKNAME_PAUSED=true` in the private bot environment and restart the bot.
This freezes nickname job processing and automatic sweep advancement, including
name restoration; XP tracking, commands and role delivery remain available.
Pending jobs are preserved. Set it back to `false` and restart to resume.
Unlike this pause, disabling nicknames in dashboard settings restores names.

### Discord Setup

Create a **new** Discord application. Enable **Server Members Intent** in its
Bot settings. Message Content and Presence intents are not needed. Leave
**Interactions Endpoint URL empty** for this application: commands are received
through the Gateway. Invite it with `bot` and `applications.commands` scopes;
include both scopes in **Installation > Guild Install > Default Install
Settings** as well. An `applications.commands`-only installation does not add
the bot member to the server.
`View Channels` is required for the message channels being tracked. Grant
`Manage Roles` for shop delivery and `Manage Nicknames` for level prefixes.
Place the bot above the roles it sells and members it renames. Discord
prevents renaming the guild owner or members above the bot; these become
visible review/exclusion cases rather than repeated invisible failures.
Administrator and permission to connect to voice channels are not required.

Set `XP_DISCORD_TOKEN`, `XP_APPLICATION_ID` and `XP_GUILD_ID` in a private `.env`
file for local use. Optional `XP_EXCLUDED_CHANNEL_IDS` is a comma-separated list.
For local development, set `XP_DATABASE_PATH=storage/xp.sqlite`. Never send the
token through chat or commit it. Commands are guild-scoped and replace only
the command list for the specified XP application and guild.

The temporary test guild is `858648961811873824`; the production guild is
`1448354755012333713`. `XP_GUILD_ID` selects the one active guild for both the
bot and dashboard API. Keep the database when switching: guild-scoped XP,
attendance, products and settings remain separate. Register commands for the
new guild and remove this XP application's obsolete guild commands from the
previous guild; invalidate authentication when switching guilds. In the test
guild, leave nickname settings OFF and use `XP_NICKNAME_PAUSED=false` so an
explicit ON setting can be tested. Do not resume the production guild without
checking its nickname settings.

```sh
npm run xp:check
npm run xp:register
npm run xp:start
```

Commands: `/랭크 [대상]`, `/순위`, `/통계 [기간] [대상]`, `/출석`,
`/상점`, `/내구매`, `/경험치선물`, `/경험치추가`, `/경험치제거`,
`/경험치추첨`, `/구매관리`, `/별명동기화`, `/슬롯`, `/돌림판`, `/홀짝`,
`/주사위`. Administrative commands require their current application
capabilities. Stats accepts 1-30 Korean calendar days including today; its
default is 7 days for the server. Command responses, including errors, are public
in the channel where the command is invoked, not direct messages.

Command names, descriptions, options and visible responses are Korean for every
client locale. Display text is maintained in `src/xp-locale-ko.js`; identifiers,
operational logs and test descriptions remain English. New Off Record bot and
dashboard features must follow the language rules in [AGENTS.md](AGENTS.md).
Run `npm run xp:register` to replace previously registered English guild commands
with the Korean command list for this application and guild.

### Dashboard API and Discord Login

The optional dashboard API shares the Gateway process and SQLite store. It is
disabled by default and binds only to `127.0.0.1` or `::1`. Do not expose its
port through the Oracle firewall. The AEM site remains the frontend. The
dedicated `off-record-xp-api` Worker provides a fixed `workers.dev` HTTPS origin;
a VPC Service connects it to Oracle through a private named Cloudflare Tunnel.

Configure these values privately in `/etc/off-record-xp.env`:

| Variable | Purpose |
| --- | --- |
| `XP_API_ENABLED=true` | Enable the local listener |
| `XP_API_ORIGIN` | Your fixed public HTTPS API origin, with no path |
| `XP_DASHBOARD_URL` | Exact published AEM app URL, normally ending in `/dashboard` |
| `XP_API_ALLOWED_SITE_ORIGINS` | Exact comma-separated frontend origins, no wildcards |
| `XP_OAUTH_CLIENT_ID` | Discord application ID; defaults to `XP_APPLICATION_ID` |
| `XP_OAUTH_CLIENT_SECRET` | Private OAuth secret; never place it in the site |
| `XP_API_HOST`, `XP_API_PORT` | Loopback listener, default `127.0.0.1:8080` |
| `XP_API_TRUST_TUNNEL` | Trust `CF-Connecting-IP` only after configuring the exclusive loopback Tunnel |
| `XP_ACCESS_TTL_SECONDS` | Access lifetime, default 300, supported 60–900 seconds |
| `XP_SESSION_TTL_HOURS` | Host-session lifetime, default 168, supported 1–720 hours |

Register exactly `XP_API_ORIGIN/auth/callback` in the Discord application's
OAuth redirect list. The login requests only `identify`; current membership
and roles come from the bot, not untrusted browser claims. Configure only the
public API origin in the site's public configuration, following its README.
Keep development and preview origins separate from production. HTTP is accepted
only for explicitly enabled loopback development via `XP_API_ALLOW_HTTP_LOCAL`.

Login uses top-level navigation to `/auth/start`, Discord and `/auth/callback`.
The API host keeps a `__Host-` session cookie with `HttpOnly; Secure;
SameSite=Lax; Path=/`, no `Domain`, and a separate temporary OAuth binding
cookie. An application code expires after 60 seconds and is exchanged once at
`POST /auth/exchange`, requiring both the original browser attempt and S256
PKCE verifier. OAuth state, sessions, codes and bearer tokens are stored hashed;
Discord provider tokens are not persisted.

Discord's RFC 9207 callback `iss` parameter is accepted only when it exactly
matches `https://discord.com`, the issuer published in its
[authorization-server metadata](https://discord.com/.well-known/oauth-authorization-server).
Legacy callbacks without `iss` remain supported; unexpected or duplicate
parameters are rejected. Issuer validation precedes state consumption and any
provider token request.

General API requests use a short-lived bearer token in page memory, never
third-party cookies or local storage. Reload and expiry restoration use a
bounded top-level navigation through the API session. Cookie-only requests to
member APIs are rejected. `POST /auth/logout` revokes the session, outstanding
codes and all its bearer tokens even if the browser blocks third-party cookie
deletion. Access-policy changes invalidate already issued tokens; restoring
the session cannot revive those old tokens.

All member routes require an exact allowed Origin and a valid token, then
verify current Discord membership. Settings/actions also validate current
delegated permissions; Discord Administrator alone does not grant access.
Authenticated GETs share five-second Discord member/role snapshots, bounded
to 256 entries per adapter. Concurrent identical lookups share one provider
request. Gateway member/role changes, reconnect/bootstrap, shutdown and
role/nickname mutation attempts invalidate the snapshots; lookups invalidated
while in flight fail rather than returning stale authorization metadata.
Disconnected clients cannot use cached entries. Missing members and provider
failures are not cached. OAuth, mutations and their subsequent authorization
rechecks always fetch fresh Discord membership/roles.
Token expiry, session revocation, access-policy versions, XP balances and
financial/history queries are checked live, not stored in this metadata cache.
Without a received Gateway event, read-only membership/role changes may take
up to five seconds to appear; write authorization never uses that grace period.
Responses use `Cache-Control: private, no-store`, restrictive security headers
and Korean structured errors. Configure Cloudflare cache bypass for the
entire API hostname; never add a cache-everything rule to authenticated routes.
Do not enable request-URL/query/body logging for OAuth routes.

| API group | Routes |
| --- | --- |
| Identity and rankings | `GET /api/me`, `/api/rankings?kind=xp`, `/api/ledger` |
| Member display names | `GET /api/members?ids=id1,id2` (up to 50 IDs) |
| Settings and roles | `GET /api/settings`, `GET/PUT /api/settings/:section`, `GET /api/roles` |
| Shop and orders | `GET /api/shop`, `POST /api/purchases`, `GET /api/orders` |
| Product/order management | `POST /api/products`, `PUT /api/products/:id`, `POST /api/orders/:id/action` |
| XP operations | `POST /api/xp/adjust`, `/api/gifts`, `/api/games/:game` |
| Raffles | `POST /api/raffles/preview`, `/api/raffles` |
| Nickname jobs | `GET /api/jobs`, `POST /api/jobs/sync` |
| Administration | `GET /api/admin/summary`, `GET /api/audit` |
| Liveness | `GET /health` (no member/configuration data) |

Financial mutations require a stable `key`; preserve the original key and
body after a timeout and inspect transaction/order state before retrying.
Settings use `{ version, patch }`; stale updates return `409` rather than
overwriting another administrator. Product edits and purchases also carry the
displayed product version.

User-facing bot messages and dashboard records use guild nicknames, falling
back to Discord display names when no nickname exists. Schema v4 stores the
last confirmed name per guild/user, independently of XP resets and departures.
Startup member synchronization, Gateway joins/updates and trusted Discord
reads update these names; older lookups cannot overwrite newer observations.
Existing nickname records seed historical names during migration.
Read responses add `displayName` beside `userId` and `actorDisplayName` beside
`actorId`, including nested audit/raffle data. Unknown historical names are
`null` and the UI labels them as departed users. IDs and financial snapshots
remain unchanged; name decoration uses indexed SQLite lookups, not per-row
Discord requests. The dashboard keeps ID input but resolves names before
confirmation and renders names in display-only request details.

HTTP protection is independent of Cloudflare paid features:

- JSON bodies at most 32 KiB, headers 8 KiB, list pages at most 50.
- Per-user reads 60/minute and writes 10/minute; IP reads 120/minute and writes
  30/minute; login/code exchange 10/minute per route/IP.
- Global read/write/auth budgets, bounded rate-cache keys, at most eight active
  and 32 waiting requests, bounded waiting/body/header/response times.
- Full-membership raffle previews and execution share a one-at-a-time admission gate
  and user/global bulk limits.
- Excess rate returns `429`; overload returns `503`, both with retry guidance.
  Expired authentication is cleaned in batches of at most 200 rows per table.
  Financial history and idempotency records are not expired with login data.

#### workers.dev gateway (current deployment)

The public API origin is
`https://off-record-xp-api.cbycdy2.workers.dev`. Register
`https://off-record-xp-api.cbycdy2.workers.dev/auth/callback` in Discord.
The existing Workers are separate applications and must not be overwritten.

1. Install the official `cloudflared` package on Oracle and create a named
   Tunnel. Store its private credentials on Oracle only.
2. Run `sudo -n bash scripts/install-xp-tunnel.sh --vpc`. Configure its Tunnel
   UUID using `deploy/xp/cloudflared-vpc.example.yml`; retain the public
   `http_status:404` catch-all, and keep both configuration
   and credentials root-owned, group `off-record-tunnel`, mode 640.
3. Create an HTTP VPC Service in the same Cloudflare account, bound only to
   that Tunnel's `127.0.0.1:8080`. No DNS zone or public hostname route is needed.
4. Configure the service ID and exact public API/site origins in
   `deploy/xp/wrangler.toml`, then deploy from this repository:

   ```sh
   npx --no-install wrangler deploy --config deploy/xp/wrangler.toml
   ```

   Do not use `npm run publish` for this gateway: it deploys the separate
   legacy `shawnybot` Worker.
5. Configure the Oracle API origin, OAuth secret, dashboard return URL and
   `XP_API_TRUST_TUNNEL=true`; enable the bot/API and the dedicated Tunnel
   service. Verify public `/health`, denied Origins, redirects/cookies and
   real browser login/logout.

The gateway streams requests to its bound service, never arbitrary upstreams.
It preserves the public Host, Cloudflare client IP, authentication headers and
separate cookies, strips unrelated proxy headers, and never follows OAuth
redirects, caches responses or retries mutations. The Oracle API remains
responsible for body/header limits, authentication, rate limits and admission.
Upstream failures return explicit non-cacheable Korean `503` errors.
Do not enable request URL/query/body logging on the Worker.

[Workers VPC](https://developers.cloudflare.com/workers-vpc/) is currently beta
and free during beta; its APIs and pricing can change. Workers Free has a
shared account-wide limit of 100,000 requests/day. Exhaustion can interrupt this
API and other Workers in the account, even though the Oracle Gateway bot
continues running. Plan changes require explicit operator approval.

#### Custom-domain Tunnel alternative

Tunnel setup is deliberately separate from bot installation. If replacing
Workers VPC with a directly published hostname:

1. Install the official `cloudflared` package on Oracle and create a named
   Tunnel in the Cloudflare account controlling the API domain.
2. Run `sudo -n bash scripts/install-xp-tunnel.sh`. It installs a dedicated,
   hardened service but does **not** enable an unconfigured Tunnel.
3. Configure the Tunnel UUID, real API hostname and loopback target in
   `/etc/cloudflared/off-record.yml`. Put the private named-Tunnel credentials
   at `/etc/cloudflared/off-record.json`, owner root, group
   `off-record-tunnel`, mode 640. Never commit either credentials or OAuth
   secrets. The checked-in YAML contains intentionally unusable placeholders.
4. Route the hostname to that named Tunnel using Cloudflare DNS. Keep the final
   `http_status:404` catch-all. Do not use a temporary Quick Tunnel for OAuth.
5. Validate configuration with `cloudflared tunnel --config
   /etc/cloudflared/off-record.yml ingress validate`. Check that the actual
   hostname resolves to the intended loopback ingress.
6. Enable the configured bot/API and then `off-record-cloudflared.service`.
   Check local `/health`, the external HTTPS `/health`, denied Origins,
   registration of the exact callback, real browser login and logout.

Forwarded client IPs are trusted only when explicitly enabled, the socket is
loopback, the Host is the configured public API host and the Cloudflare IP
header is a valid IP address. `X-Forwarded-For` is never trusted. Keep the origin
loopback endpoint exclusive to the Tunnel/local operators and verify this
assumption before enabling forwarding trust.

### Ubuntu Service

Transfer `src/xp*.js`, `deploy/xp`, `.env.example`, and `scripts/*-xp.sh` to
the VM, preserving their relative paths. Run `sudo -n bash scripts/install-xp.sh`.
The installer installs only Discord runtime dependencies without lifecycle
scripts. It prepares a dedicated non-login service user, a persistent database
directory, and a daily backup timer. It deliberately does not start the bot
before credentials are configured.

Edit `/etc/off-record-xp.env` directly on the VM using `sudo -n nano`; keep it
root-owned with mode 600. Do not print or upload the configured file. Then:

```sh
sudo -n /usr/local/bin/node --env-file=/etc/off-record-xp.env /opt/off-record-xp/src/xp-bot.js --check-config
sudo -n /usr/local/bin/node --env-file=/etc/off-record-xp.env /opt/off-record-xp/src/xp-bot.js --register
sudo -n systemctl enable --now off-record-xp.service
sudo -n systemctl status off-record-xp.service --no-pager
sudo -n journalctl -u off-record-xp.service -n 30 --no-pager
```

The process restarts after crashes and reboots, with a 320 MiB memory limit
and a 45-second graceful shutdown budget for active HTTP/Discord operations.
SQLite checkpoints run every minute and at graceful shutdown. Startup and
detected Gateway disconnects discard live voice sessions, never carrying their
timers across downtime. Reconnection fetches members and applies the configured
leave policy to tracked members who are now absent. Stored Discord join
timestamps detect offline leave/rejoin cycles after the first membership
baseline, applying the same reset policy. An older join snapshot cannot
overwrite a newer recorded join. Before the initial baseline, an offline
leave/rejoin cannot be inferred. Activity during outages is not guaranteed to
be recovered.
Disconnect detection is not instantaneous, and the last incomplete interval
can be lost. Always Free compute can be reclaimed and has no uptime guarantee;
systemd cannot restore a deleted VM. No paid resources are provisioned by these
scripts.

### Backups

The timer runs daily around 03:00 UTC. It uses SQLite online `.backup` and an
integrity check, retaining seven days under `/var/lib/off-record-xp/backups`.
Do not copy just an active WAL-mode database file. On the Mac, run
`bash scripts/fetch-xp-backup.sh` to create a fresh backup and download the
retained snapshots to `~/Backups/off-record-xp`, retaining fourteen days of
download archives. SSH host-key checking remains enabled. This download is
manual, not a scheduled off-VM backup; choose an independent scheduled backup
destination before relying on the VM for long-term data retention.

To restore, stop the service, verify `PRAGMA integrity_check` on a backup,
replace `xp.sqlite` with that snapshot, remove stale `xp.sqlite-wal` and
`xp.sqlite-shm` sidecars, restore service ownership and mode 600, then start
the service. Keep a copy of the previous files before replacement.

After restoring an upgraded database, keep the service stopped and invalidate
all restored authentication before admitting traffic:

```sh
sudo -n -u off-record-xp /usr/local/bin/node /opt/off-record-xp/src/xp-api-maintenance.js \
  --database /var/lib/off-record-xp/xp.sqlite --invalidate-auth --verify-ledger
```

The offline verifier checks each intermediate ledger balance and the final
member balance using exact integers, reports mismatches and exits unsuccessfully
when reconciliation fails. It never silently repairs balances. Keep the service
stopped if it reports an error. Reconcile current Discord membership/join times,
actual purchased roles, pending/review orders and any backup-loss interval
before resuming XP collection and economic actions. Restoring SQLite does not
undo roles already granted on Discord; do not blindly refund an ambiguous
order. Preserve financial and entitlement history, and audit manual corrections.

Tests: `npx --no-install mocha 'test/xp*.test.js'`. The repository-wide suite
remains `npm test`. The XP tests include real HTTP/OAuth/service integration,
1,000-request overload shedding, 365,000-record attendance migration and a
100-member check-in burst with explicit three-second/320 MiB budgets.

Production rollout still requires a real API hostname, private OAuth
credentials and redirect registration, configured Tunnel, AEM publication,
guild command registration and live Discord acceptance tests. Local mocked
Discord tests do not prove external role delivery, nickname hierarchy or
browser cookie behavior against the real production hosts.

## Questions?

Feel free to post an issue here, or reach out to [@justinbeckwith](https://twitter.com/JustinBeckwith)!
