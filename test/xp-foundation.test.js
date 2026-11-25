import { expect } from 'chai';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XpStore } from '../src/xp-store.js';
import { XpTracker } from '../src/xp-tracker.js';
import { migrateXpDatabase } from '../src/xp-migrations.js';
import { XP_OWNER_ID } from '../src/xp-settings.js';
import { XP_KO } from '../src/xp-locale-ko.js';
import { handleXpInteraction, xpRankingReply, xpReply } from '../src/xp-bot.js';

const owner = { userId: XP_OWNER_ID, roleIds: [] };
const day = (value) => Date.parse(`${value}T03:00:00Z`);

function ledgerTotal(store, guildId = 'guild', userId = 'user') {
  return store.database
    .prepare(
      `
    SELECT COALESCE(SUM(delta_milli), 0) AS total FROM xp_ledger
    WHERE guild_id = ? AND user_id = ?
  `,
    )
    .get(guildId, userId).total;
}

describe('XP settings, ledger and lifecycle', () => {
  let store;
  beforeEach(() => {
    store = new XpStore(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  it('uses isolated defaults without inserting settings on reads', () => {
    const settings = store.settings('guild', 'attendance');
    expect(settings).to.deep.equal({ version: 0, value: { rewardXp: 500 } });
    settings.value.rewardXp = 1;
    expect(store.settings('guild', 'attendance').value.rewardXp).to.equal(500);
    expect(
      store.database.prepare('SELECT COUNT(*) AS n FROM xp_settings').get().n,
    ).to.equal(0);
    expect(() => store.settings('guild', 'constructor')).to.throw(
      'INVALID_SETTINGS',
    );
  });

  it('rolls back a settings change when its audit cannot be saved', () => {
    store.database.exec(`
      CREATE TRIGGER reject_xp_audit BEFORE INSERT ON xp_audit
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;
    `);
    expect(() =>
      store.updateSettings('guild', 'attendance', { rewardXp: 1 }, 0, owner, 0),
    ).to.throw('audit unavailable');
    expect(store.settings('guild', 'attendance')).to.deep.equal({
      version: 0,
      value: { rewardXp: 500 },
    });
  });

  it('rolls back an award if its durable level-change job cannot be persisted', () => {
    store.database.exec(`
      CREATE TRIGGER reject_xp_jobs BEFORE INSERT ON xp_jobs
      BEGIN SELECT RAISE(ABORT, 'job unavailable'); END;
    `);
    expect(() => store.checkIn('guild', 'user', 0)).to.throw('job unavailable');
    for (const table of [
      'xp_members',
      'xp_ledger',
      'xp_attendance',
      'xp_daily',
    ]) {
      expect(
        store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
      ).to.equal(0);
    }
  });

  it('keeps duplicate transaction response shapes identical to the original response', () => {
    store.activate('guild', 'user', 0);
    const first = store.refundXp('guild', 'user', 1000, 'same-refund', 0, 0);
    const duplicate = store.refundXp(
      'guild',
      'user',
      1000,
      'same-refund',
      0,
      1,
    );
    expect(duplicate).to.deep.equal({ ...first, duplicate: true });
    expect(ledgerTotal(store)).to.equal(1000);
  });

  it('rejects stale reset versions and membership generations before awarding XP', () => {
    store.activate('guild', 'user', 0);
    store.leave('guild', 'user', 1);
    store.activate('guild', 'user', 2);
    for (const options of [
      { expectedGeneration: 1 },
      { expectedResetVersion: 0 },
    ]) {
      expect(() =>
        store.transaction(() =>
          store.applyXp('guild', 'user', 1000, {
            key: 'late-award',
            kind: 'voice',
            timestamp: 3,
            ...options,
          }),
        ),
      ).to.throw('STALE_MEMBER');
    }
    expect(ledgerTotal(store)).to.equal(0);
  });

  it('does not regress a known join timestamp or reactivate stale membership snapshots', () => {
    store.activate('guild', 'user', 100, 100);
    store.attendance('guild', 'user', 100);
    store.activate('guild', 'user', 101, 50);
    expect(store.member('guild', 'user').joined_at).to.equal(100);
    store.activate('guild', 'user', 102, 100);
    expect(store.profile('guild', 'user').xp).to.equal(500);
    store.leave('guild', 'user', 103);
    expect(() => store.activate('guild', 'user', 104, 100)).to.throw(
      'STALE_MEMBER',
    );
    expect(store.member('guild', 'user').active).to.equal(0);
  });

  it('returns the persisted job lease and stops reclaiming after three crashed workers', () => {
    store.activate('guild', 'user', 0);
    for (let timestamp = 0; timestamp < 3; timestamp += 1) {
      const job = store.claimJob('guild', timestamp, 1);
      expect(job.claimed_until).to.equal(timestamp + 1);
      expect(job.attempts).to.equal(timestamp + 1);
    }
    expect(store.claimJob('guild', 3)).to.equal(null);
    expect(
      store.database.prepare('SELECT state FROM xp_jobs').get().state,
    ).to.equal('review');
    expect(() => store.claimJob('guild', Number.MAX_SAFE_INTEGER, 1)).to.throw(
      'INVALID_JOB',
    );
  });

  it('atomically versions settings and audits without overwriting concurrent changes', () => {
    store.updateSettings('guild', 'attendance', { rewardXp: 750 }, 0, owner, 1);
    expect(() =>
      store.updateSettings(
        'guild',
        'attendance',
        { rewardXp: 100 },
        0,
        owner,
        2,
      ),
    ).to.throw('SETTINGS_CONFLICT');
    expect(store.settings('guild', 'attendance')).to.deep.equal({
      version: 1,
      value: { rewardXp: 750 },
    });
    expect(store.settings('other', 'attendance').value.rewardXp).to.equal(500);
    const audit = store.database.prepare('SELECT * FROM xp_audit').all();
    expect(audit).to.have.length(1);
    expect(JSON.parse(audit[0].details_json)).to.include({
      section: 'attendance',
      version: 1,
    });
  });

  it('rejects invalid settings without partial updates or audit records', () => {
    for (const patch of [
      { rewardXp: -1 },
      { rewardXp: 0.1 },
      { rewardXp: '500' },
      { rewardXp: Number.MAX_SAFE_INTEGER },
      { unknown: 5 },
      {},
      null,
      [],
    ]) {
      expect(() =>
        store.updateSettings('guild', 'attendance', patch, 0, owner, 1),
      ).to.throw('INVALID_SETTINGS');
    }
    expect(() =>
      store.updateSettings(
        'guild',
        'lifecycle',
        { resetOnLeave: 1 },
        0,
        owner,
        1,
      ),
    ).to.throw('INVALID_SETTINGS');
    expect(
      store.database.prepare('SELECT COUNT(*) AS n FROM xp_audit').get().n,
    ).to.equal(0);
  });

  it('allows only the owner to delegate and unions allowed role permissions', () => {
    const first = '123456789012345678';
    const second = '234567890123456789';
    const actor = { userId: 'admin', roleIds: [first, second] };
    expect(() =>
      store.updateSettings('guild', 'attendance', { rewardXp: 1 }, 0, actor, 0),
    ).to.throw('FORBIDDEN');
    store.updateSettings(
      'guild',
      'access',
      {
        adminRoles: {
          [first]: ['attendance.manage'],
          [second]: ['lifecycle.manage'],
        },
      },
      0,
      owner,
      1,
    );
    store.updateSettings('guild', 'attendance', { rewardXp: 1 }, 0, actor, 2);
    store.updateSettings(
      'guild',
      'lifecycle',
      { resetOnLeave: false },
      0,
      actor,
      3,
    );
    expect(() =>
      store.updateSettings('guild', 'access', { adminRoles: {} }, 1, actor, 4),
    ).to.throw('FORBIDDEN');
    store.updateSettings('guild', 'access', { adminRoles: {} }, 1, owner, 5);
    expect(() =>
      store.updateSettings('guild', 'attendance', { rewardXp: 2 }, 1, actor, 6),
    ).to.throw('FORBIDDEN');
    expect(() =>
      store.updateSettings(
        'guild',
        'access',
        {
          adminRoles: { [first]: ['access.manage'] },
        },
        2,
        owner,
        7,
      ),
    ).to.throw('INVALID_SETTINGS');
  });

  it('records message, attendance and weighted voice XP without changing activity meaning', () => {
    store.message('guild', 'user', 'message', 0);
    store.attendance('guild', 'user', 0);
    store.voice('guild', 'user', 'channel', 0.5, 0);
    store.checkpoint(300000);
    expect(store.profile('guild', 'user').xp).to.equal(514);
    expect(ledgerTotal(store)).to.equal(514000);
    expect(
      store.database
        .prepare('SELECT kind FROM xp_ledger ORDER BY id')
        .all()
        .map((entry) => entry.kind),
    ).to.deep.equal(['message', 'attendance', 'voice']);
    expect(
      store.database.prepare('SELECT COUNT(*) AS n FROM xp_jobs').get().n,
    ).to.equal(1);
  });

  it('rolls back balances, activity and jobs when ledger persistence fails', () => {
    store.database.exec(`
      CREATE TRIGGER reject_xp_ledger BEFORE INSERT ON xp_ledger
      BEGIN SELECT RAISE(ABORT, 'ledger unavailable'); END;
    `);
    expect(() => store.attendance('guild', 'user', 0)).to.throw(
      'ledger unavailable',
    );
    for (const table of [
      'xp_members',
      'xp_attendance',
      'xp_daily',
      'xp_jobs',
    ]) {
      expect(
        store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
      ).to.equal(0);
    }
  });

  it('uses safe nested transactions and rejects asynchronous transaction results', () => {
    store.transaction(() => {
      store.message('guild', 'user', 'first', 0);
      expect(() =>
        store.transaction(() => {
          store.attendance('guild', 'user', 0);
          throw new Error('inner failure');
        }),
      ).to.throw('inner failure');
      store.message('guild', 'user', 'second', 1000);
    });
    expect(store.profile('guild', 'user').xp).to.equal(8);
    expect(ledgerTotal(store)).to.equal(8000);
    expect(() =>
      store.transaction(() => {
        store.message('guild', 'user', 'third', 2000);
        return Promise.resolve();
      }),
    ).to.throw('synchronous');
    expect(store.profile('guild', 'user').xp).to.equal(8);
    expect(() => store.applyXp('guild', 'user', 1, {})).to.throw('transaction');
  });

  it('resets on leave and rejoin and forfeits refunds belonging to the previous balance', () => {
    store.activate('guild', 'user', 0, 0);
    store.attendance('guild', 'user', 0);
    const version = store.member('guild', 'user').reset_version;
    store.leave('guild', 'user', 1);
    store.activate('guild', 'user', 2, 2);
    const refund = store.refundXp(
      'guild',
      'user',
      500000,
      'refund:old',
      version,
      3,
    );
    expect(refund).to.include({ kind: 'refund_forfeited', delta_milli: 0 });
    expect(store.profile('guild', 'user').xp).to.equal(0);
    expect(ledgerTotal(store)).to.equal(0);
    expect(store.member('guild', 'user').generation).to.equal(2);
    expect(
      store.refundXp('guild', 'user', 500000, 'refund:old', version, 4)
        .duplicate,
    ).to.equal(true);
    expect(() =>
      store.refundXp('guild', 'user', 1, 'refund:old', version, 5),
    ).to.throw('TRANSACTION_CONFLICT');
  });

  it('preserves XP with reset disabled and refunds inactive members without activating them', () => {
    store.updateSettings(
      'guild',
      'lifecycle',
      { resetOnLeave: false },
      0,
      owner,
      0,
    );
    store.attendance('guild', 'user', 0);
    const version = store.member('guild', 'user').reset_version;
    store.leave('guild', 'user', 1);
    store.refundXp('guild', 'user', 1000, 'refund:retained', version, 2);
    expect(store.profile('guild', 'user')).to.include({ xp: 501, rank: null });
    expect(store.member('guild', 'user').active).to.equal(0);
    expect(store.message('guild', 'user', 'late-message', 3)).to.equal(0);
    store.activate('guild', 'user', 4);
    expect(store.profile('guild', 'user').xp).to.equal(501);
    expect(ledgerTotal(store)).to.equal(501000);
    expect(store.stats('guild', 'user', 1, 4).earnedXp).to.equal(500);
  });

  it('applies reset toggled while absent and never restores previously reset XP', () => {
    store.updateSettings(
      'guild',
      'lifecycle',
      { resetOnLeave: false },
      0,
      owner,
      0,
    );
    store.attendance('guild', 'user', 0);
    const version = store.member('guild', 'user').reset_version;
    store.leave('guild', 'user', 1);
    store.updateSettings(
      'guild',
      'lifecycle',
      { resetOnLeave: true },
      1,
      owner,
      2,
    );
    store.activate('guild', 'user', 3);
    store.refundXp('guild', 'user', 1000, 'old', version, 4);
    expect(store.profile('guild', 'user').xp).to.equal(0);
    store.updateSettings(
      'guild',
      'lifecycle',
      { resetOnLeave: false },
      2,
      owner,
      5,
    );
    store.leave('guild', 'user', 6);
    store.activate('guild', 'user', 7);
    expect(store.profile('guild', 'user').xp).to.equal(0);
    expect(ledgerTotal(store)).to.equal(0);
  });

  it('detects an offline rejoin from joined timestamps without resetting the initial baseline', () => {
    store.attendance('guild', 'user', 0);
    store.activate('guild', 'user', 1, 0);
    expect(store.profile('guild', 'user').xp).to.equal(500);
    store.activate('guild', 'user', 2, 0);
    expect(store.profile('guild', 'user').xp).to.equal(500);
    store.activate('guild', 'user', 3, 3);
    expect(store.profile('guild', 'user').xp).to.equal(0);
    expect(ledgerTotal(store)).to.equal(0);
    expect(store.attendance('guild', 'user', 4)).to.equal(false);
  });

  it('does not increment generations on duplicate departure events', () => {
    store.activate('guild', 'user', 0);
    store.leave('guild', 'user', 1);
    const snapshot = store.member('guild', 'user');
    store.leave('guild', 'user', 2);
    expect(store.member('guild', 'user')).to.deep.equal(snapshot);
  });

  it('prevents overflow and rolls back an attendance claim that cannot be credited', () => {
    store.activate('guild', 'user', 0);
    store.refundXp('guild', 'user', Number.MAX_SAFE_INTEGER, 'seed', 0, 0);
    expect(() => store.attendance('guild', 'user', 1)).to.throw(
      'INVALID_BALANCE',
    );
    expect(
      store.database.prepare('SELECT COUNT(*) AS n FROM xp_attendance').get().n,
    ).to.equal(0);
    expect(ledgerTotal(store)).to.equal(Number.MAX_SAFE_INTEGER);
  });

  it('claims jobs per guild and fences acknowledgments from expired workers', () => {
    store.activate('guild', 'user', 0);
    expect(store.claimJob('other', 0)).to.equal(null);
    const first = store.claimJob('guild', 0, 10);
    expect(store.claimJob('guild', 9)).to.equal(null);
    const next = store.claimJob('guild', 10, 10);
    expect(next.attempts).to.equal(2);
    expect(next.claim_token).not.to.equal(first.claim_token);
    expect(() => store.finishJob(first.id, first.claim_token, 11)).to.throw(
      'JOB_CONFLICT',
    );
    expect(store.finishJob(next.id, next.claim_token, 11)).to.equal(
      'completed',
    );
    expect(store.claimJob('guild', 100)).to.equal(null);
  });

  it('limits automatic retries and cancels jobs from a departing membership', () => {
    store.activate('guild', 'user', 0);
    let timestamp = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const job = store.claimJob('guild', timestamp, 100);
      expect(job.attempts).to.equal(attempt);
      expect(
        store.finishJob(
          job.id,
          job.claim_token,
          timestamp + 1,
          'DISCORD_TEMPORARY',
        ),
      ).to.equal(attempt === 3 ? 'review' : 'pending');
      timestamp += 1 + 1000 * 2 ** attempt;
    }
    expect(store.claimJob('guild', timestamp)).to.equal(null);
    store.leave('guild', 'user', timestamp);
    expect(
      store.database.prepare('SELECT state FROM xp_jobs').get().state,
    ).to.equal('cancelled');
  });
});

describe('Attendance counters and ranking interactions', () => {
  let store;
  beforeEach(() => {
    store = new XpStore(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  it('keeps yesterday streaks, expires on a missed day, and starts again at one', () => {
    store.checkIn('guild', 'user', day('2026-11-20'));
    store.checkIn('guild', 'user', day('2026-11-21'));
    expect(
      store.attendanceProfile('guild', 'user', day('2026-11-22')),
    ).to.include({ total: 2, streak: 2, totalRank: 1, streakRank: 1 });
    expect(
      store.attendanceProfile('guild', 'user', day('2026-11-23')),
    ).to.include({ total: 2, streak: 0, totalRank: 1, streakRank: null });
    expect(store.checkIn('guild', 'user', day('2026-11-23'))).to.include({
      awarded: true,
      total: 3,
      streak: 1,
    });

    it('does not count future-dated attendance when reading an earlier calendar day', () => {
      store.checkIn('guild', 'user', day('2026-11-23'));
      store.checkIn('guild', 'user', day('2026-11-25'));
      expect(
        store.attendanceProfile('guild', 'user', day('2026-11-24')),
      ).to.include({ total: 1, streak: 1 });
      expect(
        store.attendanceProfile('guild', 'user', day('2026-11-22')),
      ).to.include({ total: 0, streak: 0, totalRank: null, streakRank: null });
    });
    expect(store.checkIn('guild', 'user', day('2026-11-23'))).to.include({
      awarded: false,
      rewardXp: 0,
      total: 3,
      streak: 1,
    });
  });

  it('handles the Korean midnight boundary with a single calendar-day award', () => {
    const before = Date.parse('2026-11-24T14:59:59.999Z');
    const after = before + 1;
    expect(store.checkIn('guild', 'user', before).total).to.equal(1);
    expect(store.checkIn('guild', 'user', after)).to.include({
      total: 2,
      streak: 2,
    });
    expect(store.checkIn('guild', 'user', after + 1).awarded).to.equal(false);
  });

  it('uses configured rewards only for future claims including a zero reward', () => {
    expect(store.checkIn('guild', 'user', 0).rewardXp).to.equal(500);
    store.updateSettings('guild', 'attendance', { rewardXp: 750 }, 0, owner, 1);
    expect(store.checkIn('guild', 'user', 2).rewardXp).to.equal(0);
    expect(store.checkIn('guild', 'user', 86400000).rewardXp).to.equal(750);
    store.updateSettings(
      'guild',
      'attendance',
      { rewardXp: 0 },
      1,
      owner,
      86400001,
    );
    expect(store.checkIn('guild', 'user', 2 * 86400000)).to.include({
      awarded: true,
      rewardXp: 0,
      total: 3,
      streak: 3,
    });
    expect(store.profile('guild', 'user').xp).to.equal(1250);
    expect(ledgerTotal(store)).to.equal(1250000);
  });

  it('shows at most ten, shares tied ranks and separately reports a member outside the list', () => {
    const today = day('2026-11-24');
    for (let index = 0; index < 12; index += 1) {
      const id = `member-${String(index).padStart(2, '0')}`;
      store.checkIn('guild', id, today);
      if (index < 10) store.checkIn('guild', id, today - 86400000);
    }
    const ranking = store.attendanceLeaderboard('guild', 'total', today);
    expect(ranking).to.have.length(10);
    expect(ranking.every((member) => member.totalRank === 1)).to.equal(true);
    expect(
      store.attendanceProfile('guild', 'member-11', today).totalRank,
    ).to.equal(11);
    const reply = xpRankingReply(store, 'guild', 'member-11', 'total', today);
    expect(reply.embeds[0].description.split('\n')).to.have.length(10);
    expect(reply.embeds[0].fields[0].value).to.equal('11위');
    expect(
      reply.components[0].components.map((button) => button.label),
    ).to.deep.equal(['경험치 순위', '누적 출석 순위', '연속 출석 순위']);
    expect(reply.allowedMentions.parse).to.deep.equal([]);
  });

  it('excludes departed members and zero streaks while preserving attendance history', () => {
    const today = day('2026-11-24');
    store.checkIn('guild', 'user', today);
    store.checkIn('other', 'other', today);
    store.leave('guild', 'user', today + 1);
    expect(store.attendanceLeaderboard('guild', 'total', today)).to.deep.equal(
      [],
    );
    store.activate('guild', 'user', today + 2);
    expect(store.checkIn('guild', 'user', today + 3)).to.include({
      awarded: false,
      total: 1,
    });
    expect(
      store.attendanceLeaderboard('guild', 'streak', today + 2 * 86400000),
    ).to.deep.equal([]);
    expect(() =>
      store.attendanceLeaderboard('guild', 'arbitrary', today),
    ).to.throw('INVALID_RANKING');
  });

  it('keeps totals and streaks on duplicate command responses using the actual reward', () => {
    store.updateSettings('guild', 'attendance', { rewardXp: 750 }, 0, owner, 0);
    const interaction = {
      guildId: 'guild',
      user: { id: 'user' },
      commandName: '출석',
    };
    const first = xpReply(store, interaction, 0);
    expect(first.content).to.include('750점');
    expect(first.embeds[0].fields.map((field) => field.value)).to.deep.equal([
      '1일 · 1위',
      '1일 · 1위',
    ]);
    const duplicate = xpReply(store, interaction, 0);
    expect(duplicate.content).to.equal(XP_KO.attendanceAlready);
    expect(duplicate.embeds).to.deep.equal(first.embeds);
    expect(ledgerTotal(store)).to.equal(750000);
  });

  it('routes ranking buttons without granting attendance or overwriting another message', async () => {
    const replies = [];
    let checkpoints = 0;
    const tracker = {
      guildId: 'guild',
      active: true,
      checkpoint: () => {
        checkpoints += 1;
      },
    };
    const interaction = {
      guildId: 'guild',
      user: { id: 'user' },
      customId: 'xp:ranking:total',
      isChatInputCommand: () => false,
      isButton: () => true,
      async deferReply() {
        this.deferred = true;
      },
      async editReply(response) {
        replies.push(response);
      },
    };
    await handleXpInteraction(interaction, store, tracker);
    expect(interaction.deferred).to.equal(true);
    expect(replies[0].embeds[0].description).to.equal(XP_KO.emptyLeaderboard);
    expect(checkpoints).to.equal(0);
    expect(ledgerTotal(store)).to.equal(0);
    await handleXpInteraction(
      { ...interaction, customId: 'another-feature' },
      store,
      tracker,
    );
    expect(replies).to.have.length(1);
  });

  it('rejects ranking access in another guild or during tracker unavailability', async () => {
    for (const active of [false, true]) {
      let response;
      const interaction = {
        guildId: active ? 'other' : 'guild',
        user: { id: 'user' },
        customId: 'xp:ranking:streak',
        isChatInputCommand: () => false,
        isButton: () => true,
        async deferReply() {},
        async editReply(value) {
          response = value;
        },
      };
      await handleXpInteraction(interaction, store, {
        guildId: 'guild',
        active,
      });
      expect(response).to.equal(XP_KO.trackingUnavailable);
    }
  });

  it('reconciles real member join timestamps and ignores bot members on startup', () => {
    const guild = { id: 'guild', voiceStates: { cache: new Map() } };
    const tracker = new XpTracker(store, guild.id);
    const member = (joinedTimestamp) => ({
      id: 'user',
      user: { bot: false },
      joinedTimestamp,
    });
    tracker.start(guild, [member(0), { id: 'bot', user: { bot: true } }], 0);
    store.attendance('guild', 'user', 0);
    tracker.suspend();
    tracker.start(guild, [member(100)], 101);
    expect(store.profile('guild', 'user').xp).to.equal(0);
    expect(store.member('guild', 'user').generation).to.equal(2);
    expect(store.member('guild', 'bot')).to.equal(undefined);
  });
});

describe('XP schema upgrades and persistence', () => {
  it('rolls back a migration with unsafe or fractional legacy balances', () => {
    for (const balance of ['9007199254740992', '1.5']) {
      const database = new DatabaseSync(':memory:');
      try {
        database.exec(`
          CREATE TABLE xp_members (guild_id TEXT, user_id TEXT, xp_milli INTEGER);
          INSERT INTO xp_members VALUES ('guild', 'user', ${balance});
        `);
        expect(() => migrateXpDatabase(database)).to.throw('safe range');
        expect(
          database.prepare('PRAGMA user_version').get().user_version,
        ).to.equal(0);
        expect(
          database
            .prepare('PRAGMA table_info(xp_members)')
            .all()
            .map((column) => column.name),
        ).to.deep.equal(['guild_id', 'user_id', 'xp_milli']);
        expect(
          database
            .prepare(
              "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'xp_ledger'",
            )
            .get().n,
        ).to.equal(0);
      } finally {
        database.close();
      }
    }
  });
  it('upgrades a legacy database once without changing balances or attendance history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'off-record-migration-'));
    const filename = join(directory, 'xp.sqlite');
    try {
      const legacy = new DatabaseSync(filename);
      legacy.exec(`
        CREATE TABLE xp_members (
          guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
          xp_milli INTEGER NOT NULL DEFAULT 0 CHECK (xp_milli >= 0),
          messages INTEGER NOT NULL DEFAULT 0, voice_ms INTEGER NOT NULL DEFAULT 0,
          last_message_at INTEGER, active INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (guild_id, user_id)
        );
        INSERT INTO xp_members (guild_id, user_id, xp_milli, messages)
          VALUES ('guild', 'user', 588125, 9);
        CREATE TABLE xp_attendance (
          guild_id TEXT NOT NULL, user_id TEXT NOT NULL, day TEXT NOT NULL,
          PRIMARY KEY (guild_id, user_id, day)
        );
        INSERT INTO xp_attendance VALUES
          ('guild', 'user', '2026-11-23'), ('guild', 'user', '2026-11-24');
      `);
      legacy.close();
      for (let index = 0; index < 2; index += 1) {
        const store = new XpStore(filename);
        try {
          expect(store.profile('guild', 'user')).to.include({
            xp: 588,
            level: 4,
            messages: 9,
          });
          expect(ledgerTotal(store)).to.equal(588125);
          expect(
            store.attendanceProfile('guild', 'user', day('2026-11-24')),
          ).to.include({ total: 2, streak: 2 });
          expect(
            store.database.prepare('SELECT COUNT(*) AS n FROM xp_ledger').get()
              .n,
          ).to.equal(1);
          expect(
            store.database.prepare('PRAGMA integrity_check').get()
              .integrity_check,
          ).to.equal('ok');
        } finally {
          store.close();
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves settings, ledger and queued work across independent connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'off-record-persistence-'));
    const filename = join(directory, 'xp.sqlite');
    try {
      let store = new XpStore(filename);
      store.updateSettings(
        'guild',
        'attendance',
        { rewardXp: 700 },
        0,
        owner,
        0,
      );
      store.attendance('guild', 'user', 0);
      store.close();
      store = new XpStore(filename);
      const second = new XpStore(filename);
      try {
        expect(store.settings('guild', 'attendance').value.rewardXp).to.equal(
          700,
        );
        expect(ledgerTotal(store)).to.equal(700000);
        store.updateSettings(
          'guild',
          'attendance',
          { rewardXp: 800 },
          1,
          owner,
          1,
        );
        expect(() =>
          second.updateSettings(
            'guild',
            'attendance',
            { rewardXp: 900 },
            1,
            owner,
            2,
          ),
        ).to.throw('SETTINGS_CONFLICT');
        const job = store.claimJob('guild', 0);
        expect(job).not.to.equal(null);
        expect(second.claimJob('guild', 1)).to.equal(null);
        expect(second.attendance('guild', 'user', 1)).to.equal(false);
      } finally {
        second.close();
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a newer schema without creating application tables', () => {
    const directory = mkdtempSync(join(tmpdir(), 'off-record-future-'));
    const filename = join(directory, 'xp.sqlite');
    try {
      let database = new DatabaseSync(filename);
      database.exec('PRAGMA user_version = 99');
      database.close();
      expect(() => new XpStore(filename)).to.throw('newer');
      database = new DatabaseSync(filename);
      try {
        expect(
          database
            .prepare(
              "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'",
            )
            .get().n,
        ).to.equal(0);
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
