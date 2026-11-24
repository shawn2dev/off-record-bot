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
registration remain unchanged. No web dashboard, browser, Chromium or crawler
runs on the XP VM. The minimal deployment manifest is in `deploy/xp`.

### XP Rules

| Activity | XP |
| --- | --- |
| Message | 4, with a 1-second per-user award cooldown |
| Voice | 20 per completed 5-minute interval |
| Attendance | 500 once per Korean calendar day (UTC+9) |
| Self mute or self deafen | 50% voice XP, applied once |
| Server mute or server deafen | No reduction |

Cumulative level threshold: `max(0, ceil((10 * level^2 - 5) / 3 + 1))`.
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

Leaving the server resets XP and removes the member from ranking. Historical
activity and attendance records remain, preventing same-day leave/rejoin
attendance farming. Tied XP balances share a rank.

### Discord Setup

Create a **new** Discord application. Enable **Server Members Intent** in its
Bot settings. Message Content and Presence intents are not needed. Leave
**Interactions Endpoint URL empty** for this application: commands are received
through the Gateway. Invite it with `bot` and `applications.commands` scopes;
`View Channels` is required for the message channels being tracked. Administrator
and permission to connect to voice channels are not required.

Set `XP_DISCORD_TOKEN`, `XP_APPLICATION_ID` and `XP_GUILD_ID` in a private `.env`
file for local use. Optional `XP_EXCLUDED_CHANNEL_IDS` is a comma-separated list.
For local development, set `XP_DATABASE_PATH=storage/xp.sqlite`. Never send the
token through chat or commit it. Commands are guild-scoped and replace only
the command list for the specified XP application and guild.

```sh
npm run xp:check
npm run xp:register
npm run xp:start
```

Commands: `/rank [member]`, `/leaderboard`, `/stats [days] [member]`,
`/attendance`. Stats accepts 1-30 Korean calendar days including today; its
default is 7 days for the server. Responses are ephemeral, not direct messages.
There is no gift command.

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

The process restarts after crashes and reboots, with a 320 MiB memory limit.
SQLite checkpoints run every minute and at graceful shutdown. Startup and
detected Gateway disconnects discard live voice sessions, never carrying their
timers across downtime. Reconnection fetches members and resets XP for tracked
members who are now absent. Activity during outages is not guaranteed to be
recovered; a leave followed by rejoin entirely during an outage cannot be detected.
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

Tests: `npx mocha test/xp.test.js`. The repository-wide suite remains `npm test`.

## Questions?

Feel free to post an issue here, or reach out to [@justinbeckwith](https://twitter.com/JustinBeckwith)!
