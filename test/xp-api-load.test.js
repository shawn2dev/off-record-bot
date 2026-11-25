import { expect } from 'chai';
import { describe, it } from 'mocha';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

describe('Isolated API overload budget', () => {
  it('stays under the VM memory cap and remains responsive while shedding excess requests', function () {
    this.timeout(30000);
    const apiUrl = new URL('../src/xp-api.js', import.meta.url).href;
    const storeUrl = new URL('../src/xp-store.js', import.meta.url).href;
    const script = `
      import { startXpApi, readXpApiConfig } from ${JSON.stringify(apiUrl)};
      import { XpStore } from ${JSON.stringify(storeUrl)};
      import { createHash, randomBytes } from 'node:crypto';
      import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
      import process from 'node:process';
      const user = '123456789012345678';
      const guild = '234567890123456789';
      const now = Date.now();
      const config = {
        ...readXpApiConfig({
          XP_API_ENABLED: 'true', XP_API_ORIGIN: 'https://api.off-record.test',
          XP_DASHBOARD_URL: 'https://dashboard.off-record.test/dashboard',
          XP_OAUTH_CLIENT_SECRET: 'private-test-client-secret',
        }, { applicationId: '345678901234567890', guildId: guild }),
        port: 0,
      };
      const store = new XpStore(':memory:');
      store.activate(guild, user, now);
      const originalError = console.error;
      console.error = () => {};
      const server = await startXpApi({
        store, config,
        discord: { async member(id) {
          await new Promise(resolve => setTimeout(resolve, 8));
          return { userId: id, roleIds: [], bot: false, displayName: '회원' };
        } },
        economy: { async execute() { throw new Error('Unexpected mutation'); } },
      });
      const rawToken = randomBytes(32).toString('base64url');
      const hash = value => createHash('sha256').update(value).digest('hex');
      const sessionHash = hash('isolated-load-session');
      store.database.prepare('INSERT INTO xp_auth_sessions VALUES (?, ?, ?, ?, 0, ?, ?)')
        .run(sessionHash, guild, user, JSON.stringify({ id: user, displayName: '회원', avatar: null }),
          now, now + 600000);
      store.database.prepare('INSERT INTO xp_auth_tokens VALUES (?, ?, 0, ?)')
        .run(hash(rawToken), sessionHash, now + 600000);
      const latency = monitorEventLoopDelay({ resolution: 10 });
      latency.enable();
      let peakRss = process.memoryUsage().rss;
      let maxResponseMs = 0;
      const statuses = {};
      const origin = new URL(config.dashboardUrl).origin;
      const url = 'http://127.0.0.1:' + server.address.port + '/api/me';
      async function one() {
        const start = performance.now();
        const response = await fetch(url, { headers: { Origin: origin, Authorization: 'Bearer ' + rawToken } });
        await response.json();
        maxResponseMs = Math.max(maxResponseMs, performance.now() - start);
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }
      try {
        await Promise.all(Array.from({ length: 96 }, one));
        for (let index = 96; index < 1000; index += 16) {
          await Promise.all(Array.from({ length: Math.min(16, 1000 - index) }, one));
        }
        latency.disable();
        console.log(JSON.stringify({ statuses, peakRss, maxResponseMs,
          maxLoopDelayMs: latency.max / 1e6, cacheKeys: server.api.limits.entries.size,
          active: server.api.gate.active, queued: server.api.gate.waiters.length }));
      } finally {
        await server.close();
        store.close();
        console.error = originalError;
      }
    `;
    const result = spawnSync(
      process.execPath,
      ['--max-old-space-size=192', '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 25000, maxBuffer: 1048576 },
    );
    expect(result.error, result.stderr).to.equal(undefined);
    expect(result.status, result.stderr).to.equal(0);
    const metrics = JSON.parse(result.stdout.trim());
    expect(metrics.statuses[200]).to.be.greaterThan(0);
    expect(metrics.statuses[429]).to.be.greaterThan(0);
    expect(metrics.statuses[503]).to.be.greaterThan(0);
    expect(metrics.statuses[500] ?? 0).to.equal(0);
    expect(
      Object.values(metrics.statuses).reduce(
        (total, count) => total + count,
        0,
      ),
    ).to.equal(1000);
    expect(metrics.peakRss).to.be.lessThan(320 * 1024 * 1024);
    expect(metrics.maxResponseMs).to.be.lessThan(3000);
    expect(metrics.maxLoopDelayMs).to.be.lessThan(3000);
    expect(metrics.cacheKeys).to.be.at.most(10000);
    expect(metrics).to.include({ active: 0, queued: 0 });
  });
});
