import { expect } from 'chai';
import { describe, it } from 'mocha';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { XpStore } from '../src/xp-store.js';

describe('Persistent attendance summaries', () => {
  it('handles out-of-order inserts, historical reads, edits and deletion without losing raw history', () => {
    const store = new XpStore(':memory:');
    const at = (date) => Date.parse(`${date}T03:00:00Z`);
    const summary = () =>
      store.database
        .prepare(
          'SELECT total, last_day AS lastDay, last_streak AS streak FROM xp_attendance_summary',
        )
        .get();
    try {
      store.attendance('guild', 'user', at('2026-11-24'));
      store.attendance('guild', 'user', at('2026-11-22'));
      expect(summary()).to.deep.equal({
        total: 2,
        lastDay: '2026-11-24',
        streak: 1,
      });
      store.attendance('guild', 'user', at('2026-11-23'));
      expect(summary()).to.deep.equal({
        total: 3,
        lastDay: '2026-11-24',
        streak: 3,
      });
      expect(
        store.attendanceProfile('guild', 'user', at('2026-11-22')).total,
      ).to.equal(1);
      expect(
        store.attendanceProfile('guild', 'user', at('2026-11-24')).streak,
      ).to.equal(3);
      store.database.exec(
        "UPDATE xp_attendance SET day = '2026-11-20' WHERE day = '2026-11-23'",
      );
      expect(summary()).to.deep.equal({
        total: 3,
        lastDay: '2026-11-24',
        streak: 1,
      });
      store.database.exec("DELETE FROM xp_attendance WHERE day = '2026-11-24'");
      expect(summary()).to.deep.equal({
        total: 2,
        lastDay: '2026-11-22',
        streak: 1,
      });
      store.database.exec('DELETE FROM xp_attendance');
      expect(summary()).to.equal(undefined);
      expect(
        store.attendanceProfile('guild', 'user', at('2026-11-25')).total,
      ).to.equal(0);
    } finally {
      store.close();
    }
  });

  it('migrates a year of history and processes a 100-member check-in burst within resource limits', function () {
    this.timeout(30000);
    const storeUrl = new URL('../src/xp-store.js', import.meta.url).href;
    const script = `
      import { XpStore } from ${JSON.stringify(storeUrl)};
      import { mkdtempSync, rmSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { performance } from 'node:perf_hooks';
      import process from 'node:process';
      const directory = mkdtempSync(join(tmpdir(), 'offrecord-attendance-load-'));
      let store;
      try {
        const path = join(directory, 'xp.sqlite');
        store = new XpStore(path);
        store.database.exec(\`
          DROP TRIGGER xp_attendance_insert_summary;
          DROP TRIGGER xp_attendance_delete_summary;
          DROP TRIGGER xp_attendance_update_summary;
          DROP TABLE xp_attendance_summary;
          DROP TABLE xp_member_names;
          PRAGMA user_version = 2;
          WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<999)
          INSERT INTO xp_members(guild_id,user_id) SELECT 'load', 'member-' || i FROM n;
          WITH RECURSIVE d(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM d WHERE i<365)
          INSERT INTO xp_attendance(guild_id,user_id,day)
          SELECT guild_id,user_id,date('2026-11-25','-' || d.i || ' days')
            FROM xp_members CROSS JOIN d;
        \`);
        store.close();
        store = undefined;
        const migrationStart = performance.now();
        store = new XpStore(path);
        const migrationMs = performance.now() - migrationStart;
        const now = Date.parse('2026-11-25T10:00:00Z');
        const start = performance.now();
        const initial = store.attendanceProfile('load', 'member-0', now);
        for (let index = 0; index < 100; index += 1) {
          store.checkIn('load', 'member-' + index, now);
        }
        console.log(JSON.stringify({
          migrationMs, burstMs: performance.now() - start,
          rss: process.memoryUsage().rss, initial,
          checked: store.attendanceProfile('load', 'member-0', now),
          remaining: store.attendanceProfile('load', 'member-999', now),
          records: store.database.prepare('SELECT COUNT(*) AS n FROM xp_attendance').get().n,
        }));
      } finally {
        store?.close();
        rmSync(directory, { recursive: true, force: true });
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
    expect(metrics.migrationMs).to.be.lessThan(3000);
    expect(metrics.burstMs).to.be.lessThan(3000);
    expect(metrics.rss).to.be.lessThan(320 * 1024 * 1024);
    expect(metrics.initial).to.include({
      total: 365,
      streak: 365,
      totalRank: 1,
    });
    expect(metrics.checked).to.include({
      total: 366,
      streak: 366,
      totalRank: 1,
    });
    expect(metrics.remaining).to.include({
      total: 365,
      streak: 365,
      totalRank: 101,
    });
    expect(metrics.records).to.equal(365100);
  });
});
