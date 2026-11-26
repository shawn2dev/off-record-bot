import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertXpSchema, migrateXpDatabase } from './xp-migrations.js';
import { XpError } from './xp-errors.js';
import { memberIds, withMemberNames } from './xp-member-names.js';
import {
  canManageXpSettings,
  defaultXpSettings,
  validateXpSettings,
} from './xp-settings.js';
import {
  ATTENDANCE_RANKING_SQL,
  CURRENT_ATTENDANCE_RANKING_SQL,
} from './xp-attendance.js';
import {
  advanceVoice,
  dayKey,
  levelProgress,
  splitVoiceDays,
  XP_SETTINGS,
} from './xp.js';

export class XpStore {
  constructor(filename) {
    if (filename !== ':memory:')
      mkdirSync(dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.transactionDepth = 0;
    this.attendanceCache = null;
    try {
      assertXpSchema(this.database);
      this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS xp_members (
        guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
        xp_milli INTEGER NOT NULL DEFAULT 0 CHECK (xp_milli >= 0),
        messages INTEGER NOT NULL DEFAULT 0, voice_ms INTEGER NOT NULL DEFAULT 0,
        last_message_at INTEGER, active INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS xp_rank ON xp_members (guild_id, active, xp_milli DESC);
      CREATE TABLE IF NOT EXISTS xp_daily (
        guild_id TEXT NOT NULL, user_id TEXT NOT NULL, day TEXT NOT NULL,
        xp_milli INTEGER NOT NULL DEFAULT 0, messages INTEGER NOT NULL DEFAULT 0,
        voice_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id, day)
      );
      CREATE INDEX IF NOT EXISTS xp_daily_period ON xp_daily (guild_id, day);
      CREATE TABLE IF NOT EXISTS xp_messages (
        message_id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS xp_messages_timestamp ON xp_messages (timestamp);
      CREATE TABLE IF NOT EXISTS xp_attendance (
        guild_id TEXT NOT NULL, user_id TEXT NOT NULL, day TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id, day)
      );
      CREATE TABLE IF NOT EXISTS xp_voice (
        guild_id TEXT NOT NULL, user_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL, elapsed_ms INTEGER NOT NULL,
        weighted_ms REAL NOT NULL, multiplier REAL NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
    `);
      migrateXpDatabase(this.database);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  transaction(action) {
    const depth = this.transactionDepth;
    const savepoint = `xp_transaction_${depth}`;
    this.database.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.transactionDepth += 1;
    try {
      const result = action();
      if (result && typeof result.then === 'function') {
        throw new TypeError('XP transactions must be synchronous.');
      }
      this.database.exec(depth ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      this.attendanceCache = null;
      this.database.exec(
        depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK',
      );
      throw error;
    } finally {
      this.transactionDepth = depth;
    }
  }

  rememberMemberNames(guildId, members, timestamp = Date.now()) {
    if (!Number.isSafeInteger(timestamp))
      throw new TypeError('Member name timestamps must be safe integers.');
    const statement = this.database.prepare(`
      INSERT INTO xp_member_names (guild_id, user_id, display_name, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT (guild_id, user_id) DO UPDATE SET
        display_name = excluded.display_name, updated_at = excluded.updated_at
      WHERE excluded.updated_at >= xp_member_names.updated_at
        AND excluded.display_name != xp_member_names.display_name
    `);
    this.transaction(() => {
      for (const member of members) {
        if (
          typeof member.userId !== 'string' ||
          !member.userId ||
          typeof member.displayName !== 'string' ||
          !member.displayName
        )
          throw new TypeError(
            'Member names require an identifier and a display name.',
          );
        statement.run(guildId, member.userId, member.displayName, timestamp);
      }
    });
  }

  memberNames(guildId, userIds) {
    const ids = [...new Set(userIds)];
    if (!ids.length) return {};
    const rows = this.database
      .prepare(
        `
      SELECT user_id AS userId, display_name AS displayName FROM xp_member_names
      WHERE guild_id = ? AND user_id IN (${ids.map(() => '?').join(',')})
    `,
      )
      .all(guildId, ...ids);
    return Object.fromEntries(rows.map((row) => [row.userId, row.displayName]));
  }

  withMemberNames(guildId, value) {
    return withMemberNames(value, this.memberNames(guildId, memberIds(value)));
  }

  settings(guildId, section) {
    const fallback = defaultXpSettings(section);
    const row = this.database
      .prepare(
        'SELECT version, value_json FROM xp_settings WHERE guild_id = ? AND section = ?',
      )
      .get(guildId, section);
    return {
      version: row?.version ?? 0,
      value: row ? JSON.parse(row.value_json) : fallback,
    };
  }

  updateSettings(guildId, section, patch, expectedVersion, actor, timestamp) {
    return this.transaction(() => {
      if (
        !actor ||
        typeof actor.userId !== 'string' ||
        !actor.userId ||
        !Number.isSafeInteger(timestamp) ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0
      )
        throw new XpError('INVALID_SETTINGS');
      const current = this.settings(guildId, section);
      const access = this.settings(guildId, 'access').value;
      if (
        !canManageXpSettings(actor.userId, actor.roleIds ?? [], access, section)
      ) {
        throw new XpError('FORBIDDEN');
      }
      if (current.version !== expectedVersion)
        throw new XpError('SETTINGS_CONFLICT');
      const value = validateXpSettings(section, patch, current.value);
      if (section === 'access') {
        const roleIds = Object.keys(value.adminRoles);
        for (const roleId of roleIds) {
          if (
            this.database
              .prepare(
                'SELECT 1 FROM xp_products WHERE guild_id = ? AND role_id = ? LIMIT 1',
              )
              .get(guildId, roleId) ||
            (actor.roles && !actor.roles.some((role) => role.id === roleId))
          )
            throw new XpError('UNSAFE_ROLE');
        }
      }
      const version = current.version + 1;
      this.database
        .prepare(
          `
        INSERT INTO xp_settings (guild_id, section, version, value_json, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (guild_id, section) DO UPDATE SET version = excluded.version,
          value_json = excluded.value_json, updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `,
        )
        .run(
          guildId,
          section,
          version,
          JSON.stringify(value),
          timestamp,
          actor.userId,
        );
      if (section === 'nickname')
        this.database
          .prepare(
            `
        INSERT INTO xp_nickname_sweeps (guild_id) VALUES (?)
        ON CONFLICT (guild_id) DO UPDATE SET after_user_id = '', active = 1
      `,
          )
          .run(guildId);
      this.database
        .prepare(
          `
        INSERT INTO xp_audit (guild_id, actor_id, action, details_json, created_at)
        VALUES (?, ?, 'settings', ?, ?)
      `,
        )
        .run(
          guildId,
          actor.userId,
          JSON.stringify({
            section,
            before: current.value,
            after: value,
            version,
          }),
          timestamp,
        );
      return { version, value };
    });
  }

  member(guildId, userId) {
    return this.database
      .prepare('SELECT * FROM xp_members WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId);
  }

  ensureMember(guildId, userId) {
    const inserted = this.database
      .prepare(
        'INSERT OR IGNORE INTO xp_members (guild_id, user_id) VALUES (?, ?)',
      )
      .run(guildId, userId);
    if (inserted.changes) this.attendanceCache = null;
    return this.member(guildId, userId);
  }

  activate(guildId, userId, timestamp = Date.now(), joinedAt = null) {
    return this.transaction(() => {
      if (
        !Number.isSafeInteger(timestamp) ||
        (joinedAt !== null && (!Number.isSafeInteger(joinedAt) || joinedAt < 0))
      )
        throw new XpError('INVALID_MEMBER');
      let member = this.member(guildId, userId);
      if (
        member &&
        !member.active &&
        joinedAt !== null &&
        member.joined_at !== null &&
        joinedAt <= member.joined_at
      ) {
        throw new XpError('STALE_MEMBER');
      }
      if (
        member?.active &&
        member.joined_at !== null &&
        joinedAt !== null &&
        joinedAt > member.joined_at
      ) {
        this.leave(guildId, userId, timestamp);
        member = this.member(guildId, userId);
      }
      if (
        member &&
        !member.active &&
        this.settings(guildId, 'lifecycle').value.resetOnLeave
      ) {
        this.resetBalance(guildId, userId, timestamp, 'join');
      }
      this.database
        .prepare(
          `
        INSERT INTO xp_members (guild_id, user_id, joined_at) VALUES (?, ?, ?)
        ON CONFLICT (guild_id, user_id) DO UPDATE SET active = 1,
          joined_at = CASE WHEN joined_at IS NULL THEN excluded.joined_at
            WHEN excluded.joined_at IS NULL THEN joined_at
            ELSE MAX(joined_at, excluded.joined_at) END
      `,
        )
        .run(guildId, userId, joinedAt);
      if (!member || !member.active)
        this.enqueueNickname(guildId, userId, timestamp);
      if (!member || !member.active) this.attendanceCache = null;
      return this.member(guildId, userId);
    });
  }

  applyXp(
    guildId,
    userId,
    deltaMilli,
    {
      key,
      kind,
      timestamp,
      expectedResetVersion = null,
      expectedGeneration = null,
    },
  ) {
    if (!this.transactionDepth)
      throw new Error('XP changes require a transaction.');
    if (
      !Number.isSafeInteger(deltaMilli) ||
      !Number.isSafeInteger(timestamp) ||
      typeof key !== 'string' ||
      !key ||
      key.length > 200 ||
      ![
        'message',
        'voice',
        'attendance',
        'reset',
        'refund',
        'adjust',
        'gift_send',
        'gift_receive',
        'purchase',
        'game_bet',
        'game_payout',
        'raffle',
      ].includes(kind) ||
      (['reset', 'gift_send', 'purchase', 'game_bet'].includes(kind)
        ? deltaMilli > 0
        : kind !== 'adjust' && deltaMilli < 0) ||
      (expectedResetVersion !== null &&
        (!Number.isSafeInteger(expectedResetVersion) ||
          expectedResetVersion < 0)) ||
      (kind === 'refund' &&
        (deltaMilli <= 0 ||
          !Number.isSafeInteger(expectedResetVersion) ||
          expectedResetVersion < 0)) ||
      (expectedGeneration !== null &&
        (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1))
    )
      throw new XpError('INVALID_TRANSACTION');
    const request = JSON.stringify({
      deltaMilli,
      kind,
      expectedResetVersion,
      expectedGeneration,
    });
    const previous = this.database
      .prepare(
        `
      SELECT id, delta_milli, balance_after, kind, request_json FROM xp_ledger
      WHERE guild_id = ? AND user_id = ? AND operation_key = ?
    `,
      )
      .get(guildId, userId, key);
    if (previous) {
      const { request_json: fingerprint, ...result } = previous;
      if (fingerprint !== request) throw new XpError('TRANSACTION_CONFLICT');
      return { ...result, duplicate: true };
    }
    const member = this.member(guildId, userId);
    if (!member) throw new XpError('INVALID_MEMBER');
    const forfeited =
      kind === 'refund' && expectedResetVersion !== member.reset_version;
    if (
      kind !== 'refund' &&
      kind !== 'reset' &&
      (!member.active ||
        (expectedResetVersion !== null &&
          expectedResetVersion !== member.reset_version) ||
        (expectedGeneration !== null &&
          expectedGeneration !== member.generation))
    )
      throw new XpError('STALE_MEMBER');
    const delta = forfeited ? 0 : deltaMilli;
    const balance = member.xp_milli + delta;
    if (!Number.isSafeInteger(balance) || balance < 0)
      throw new XpError('INVALID_BALANCE');
    this.database
      .prepare(
        'UPDATE xp_members SET xp_milli = ? WHERE guild_id = ? AND user_id = ?',
      )
      .run(balance, guildId, userId);
    const result = this.database
      .prepare(
        `
      INSERT INTO xp_ledger (guild_id, user_id, operation_key, kind, delta_milli,
        balance_after, reset_version, request_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        guildId,
        userId,
        key,
        forfeited ? 'refund_forfeited' : kind,
        delta,
        balance,
        member.reset_version,
        request,
        timestamp,
      );
    if (levelProgress(member.xp_milli).level !== levelProgress(balance).level) {
      this.enqueueNickname(guildId, userId, timestamp);
    }
    return {
      id: Number(result.lastInsertRowid),
      delta_milli: delta,
      balance_after: balance,
      kind: forfeited ? 'refund_forfeited' : kind,
      duplicate: false,
    };
  }

  refundXp(guildId, userId, amountMilli, key, expectedResetVersion, timestamp) {
    return this.transaction(() =>
      this.applyXp(guildId, userId, amountMilli, {
        key,
        kind: 'refund',
        timestamp,
        expectedResetVersion,
      }),
    );
  }

  resetBalance(guildId, userId, timestamp, reason) {
    const member = this.member(guildId, userId);
    this.applyXp(guildId, userId, -member.xp_milli, {
      key: `reset:${reason}:${member.generation}:${member.reset_version}`,
      kind: 'reset',
      timestamp,
    });
    this.database
      .prepare(
        `
      UPDATE xp_members SET reset_version = reset_version + 1
      WHERE guild_id = ? AND user_id = ?
    `,
      )
      .run(guildId, userId);
    this.database
      .prepare(
        `
      UPDATE xp_jobs SET state = 'cancelled', claim_token = NULL, claimed_until = NULL
      WHERE guild_id = ? AND user_id = ? AND state IN ('pending', 'processing', 'review')
    `,
      )
      .run(guildId, userId);
  }

  enqueueNickname(guildId, userId, timestamp) {
    const member = this.member(guildId, userId);
    const pending = this.database
      .prepare(
        `
      SELECT id FROM xp_jobs WHERE guild_id = ? AND user_id = ? AND kind = 'nickname'
        AND state = 'pending' AND generation = ? AND reset_version = ? LIMIT 1
    `,
      )
      .get(guildId, userId, member.generation, member.reset_version);
    if (pending) return;
    this.database
      .prepare(
        `
      INSERT INTO xp_jobs (guild_id, user_id, kind, generation, reset_version, state,
        available_at, created_at) VALUES (?, ?, 'nickname', ?, ?, 'pending', ?, ?)
    `,
      )
      .run(
        guildId,
        userId,
        member.generation,
        member.reset_version,
        timestamp,
        timestamp,
      );
  }

  claimJob(guildId, timestamp, leaseMs = 30000) {
    if (
      !Number.isSafeInteger(timestamp) ||
      !Number.isSafeInteger(leaseMs) ||
      !Number.isSafeInteger(timestamp + leaseMs) ||
      leaseMs < 1 ||
      leaseMs > 300000
    )
      throw new XpError('INVALID_JOB');
    return this.transaction(() => {
      this.database
        .prepare(
          `
        UPDATE xp_jobs SET state = 'review', claim_token = NULL, claimed_until = NULL
        WHERE guild_id = ? AND state = 'processing' AND claimed_until <= ? AND attempts >= 3
      `,
        )
        .run(guildId, timestamp);
      const job = this.database
        .prepare(
          `
        SELECT j.* FROM xp_jobs j JOIN xp_members m
          ON m.guild_id = j.guild_id AND m.user_id = j.user_id
        WHERE j.guild_id = ? AND m.active = 1 AND m.generation = j.generation AND m.reset_version = j.reset_version
          AND ((j.state = 'pending' AND j.available_at <= ?)
            OR (j.state = 'processing' AND j.claimed_until <= ?))
          AND j.attempts < 3 ORDER BY j.id LIMIT 1
      `,
        )
        .get(guildId, timestamp, timestamp);
      if (!job) return null;
      const token = randomUUID();
      return this.database
        .prepare(
          `
        UPDATE xp_jobs SET state = 'processing', attempts = attempts + 1,
          claimed_until = ?, claim_token = ? WHERE id = ? RETURNING *
      `,
        )
        .get(timestamp + leaseMs, token, job.id);
    });
  }

  finishJob(id, token, timestamp, errorCode = null, retryAfterMs = 0) {
    return this.transaction(() => {
      if (
        !Number.isSafeInteger(id) ||
        typeof token !== 'string' ||
        !Number.isSafeInteger(timestamp) ||
        !Number.isSafeInteger(retryAfterMs) ||
        retryAfterMs < 0 ||
        retryAfterMs > 86400000 ||
        (errorCode !== null &&
          (typeof errorCode !== 'string' || !/^[A-Z_]{1,60}$/.test(errorCode)))
      ) {
        throw new XpError('INVALID_JOB');
      }
      const job = this.database
        .prepare(
          `
        SELECT * FROM xp_jobs WHERE id = ? AND state = 'processing' AND claim_token = ?
          AND claimed_until > ?
      `,
        )
        .get(id, token, timestamp);
      if (!job) throw new XpError('JOB_CONFLICT');
      const state = errorCode
        ? job.attempts >= 3
          ? 'review'
          : 'pending'
        : 'completed';
      const availableAt =
        state === 'pending'
          ? timestamp + Math.max(1000 * 2 ** job.attempts, retryAfterMs)
          : timestamp;
      if (!Number.isSafeInteger(availableAt)) throw new XpError('INVALID_JOB');
      this.database
        .prepare(
          `
        UPDATE xp_jobs SET state = ?, available_at = ?, error_code = ?,
          claim_token = NULL, claimed_until = NULL WHERE id = ?
      `,
        )
        .run(state, availableAt, errorCode, id);
      return state;
    });
  }

  daily(guildId, userId, day, xpMilli = 0, messages = 0, voiceMs = 0) {
    this.database
      .prepare(
        `
      INSERT INTO xp_daily (guild_id, user_id, day, xp_milli, messages, voice_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (guild_id, user_id, day) DO UPDATE SET
        xp_milli = xp_milli + excluded.xp_milli,
        messages = messages + excluded.messages,
        voice_ms = voice_ms + excluded.voice_ms
    `,
      )
      .run(guildId, userId, day, xpMilli, messages, voiceMs);
  }

  message(guildId, userId, messageId, timestamp) {
    return this.transaction(() => {
      const receipt = this.database
        .prepare(
          'INSERT OR IGNORE INTO xp_message_receipts (message_id, guild_id, user_id) VALUES (?, ?, ?)',
        )
        .run(messageId, guildId, userId);
      if (!receipt.changes) return 0;
      const inserted = this.database
        .prepare(
          'INSERT OR IGNORE INTO xp_messages (message_id, timestamp) VALUES (?, ?)',
        )
        .run(messageId, timestamp);
      if (!inserted.changes) return 0;
      const member = this.ensureMember(guildId, userId);
      if (!member.active) return 0;
      const eligible =
        member.last_message_at === null ||
        timestamp - member.last_message_at >= XP_SETTINGS.messageCooldownMs;
      const xpMilli = eligible ? XP_SETTINGS.messageXp * 1000 : 0;
      this.database
        .prepare(
          `
        UPDATE xp_members SET messages = messages + 1,
          last_message_at = CASE WHEN ? THEN ? ELSE last_message_at END
        WHERE guild_id = ? AND user_id = ?
      `,
        )
        .run(Number(eligible), timestamp, guildId, userId);
      if (xpMilli) {
        this.applyXp(guildId, userId, xpMilli, {
          key: `message:${messageId}`,
          kind: 'message',
          timestamp,
        });
      }
      this.daily(guildId, userId, dayKey(timestamp), xpMilli, 1);
      return xpMilli;
    });
  }

  attendance(guildId, userId, timestamp) {
    return this.transaction(
      () => this.awardAttendance(guildId, userId, timestamp).awarded,
    );
  }

  checkIn(guildId, userId, timestamp) {
    return this.transaction(() => ({
      ...this.awardAttendance(guildId, userId, timestamp),
      ...this.attendanceProfile(guildId, userId, timestamp),
    }));
  }

  awardAttendance(guildId, userId, timestamp) {
    const day = dayKey(timestamp);
    const inserted = this.database
      .prepare(
        `
        INSERT OR IGNORE INTO xp_attendance (guild_id, user_id, day) VALUES (?, ?, ?)
      `,
      )
      .run(guildId, userId, day);
    if (!inserted.changes) return { awarded: false, rewardXp: 0 };
    this.attendanceCache = null;
    const member = this.ensureMember(guildId, userId);
    if (!member.active) throw new XpError('STALE_MEMBER');
    const rewardXp = this.settings(guildId, 'attendance').value.rewardXp;
    const xpMilli = rewardXp * 1000;
    this.applyXp(guildId, userId, xpMilli, {
      key: `attendance:${day}`,
      kind: 'attendance',
      timestamp,
    });
    this.daily(guildId, userId, day, xpMilli);
    return { awarded: true, rewardXp };
  }

  attendanceProfile(guildId, userId, timestamp) {
    const today = dayKey(timestamp);
    const snapshot = this.#attendanceSnapshot(guildId, timestamp);
    if (snapshot)
      return {
        ...(snapshot.members.get(userId) ?? {
          userId,
          total: 0,
          streak: 0,
          totalRank: null,
          streakRank: null,
          lastDay: null,
        }),
      };
    return (
      this.database
        .prepare(
          `${this.#attendanceRankingSql(guildId, today)}
      SELECT * FROM ranked WHERE userId = ?
    `,
        )
        .get(guildId, today, today, dayKey(timestamp - 86400000), userId) ?? {
        userId,
        total: 0,
        streak: 0,
        totalRank: null,
        streakRank: null,
        lastDay: null,
      }
    );
  }

  attendanceLeaderboard(guildId, kind, timestamp) {
    if (!['total', 'streak'].includes(kind))
      throw new XpError('INVALID_RANKING');
    const today = dayKey(timestamp);
    const snapshot = this.#attendanceSnapshot(guildId, timestamp);
    if (snapshot) return snapshot[kind].map((row) => ({ ...row }));
    return this.database
      .prepare(
        `${this.#attendanceRankingSql(guildId, today)}
      SELECT * FROM ranked WHERE ${kind} > 0 ORDER BY ${kind} DESC, userId LIMIT 10
    `,
      )
      .all(guildId, today, today, dayKey(timestamp - 86400000));
  }

  #attendanceRankingSql(guildId, today) {
    const historical = this.database
      .prepare(
        'SELECT 1 FROM xp_attendance_summary WHERE guild_id = ? AND last_day > ? LIMIT 1',
      )
      .get(guildId, today);
    return historical ? ATTENDANCE_RANKING_SQL : CURRENT_ATTENDANCE_RANKING_SQL;
  }

  #attendanceSnapshot(guildId, timestamp) {
    const today = dayKey(timestamp);
    const dataVersion = this.database
      .prepare('PRAGMA data_version')
      .get().data_version;
    if (
      this.attendanceCache?.guildId === guildId &&
      this.attendanceCache.day === today &&
      this.attendanceCache.dataVersion === dataVersion
    )
      return this.attendanceCache;
    const rows = this.database
      .prepare(
        `${this.#attendanceRankingSql(guildId, today)}
      SELECT * FROM ranked LIMIT 50001`,
      )
      .all(guildId, today, today, dayKey(timestamp - 86400000));
    if (rows.length > 50000) {
      this.attendanceCache = null;
      return null;
    }
    const sorted = (kind) =>
      rows
        .filter((row) => row[kind] > 0)
        .sort(
          (a, b) =>
            b[kind] - a[kind] ||
            (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
        )
        .slice(0, 10);
    this.attendanceCache = {
      guildId,
      day: today,
      dataVersion,
      members: new Map(rows.map((row) => [row.userId, row])),
      total: sorted('total'),
      streak: sorted('streak'),
    };
    return this.attendanceCache;
  }

  session(guildId, userId) {
    return this.database
      .prepare(
        `
      SELECT guild_id AS guildId, user_id AS userId, channel_id AS channelId,
        updated_at AS updatedAt, elapsed_ms AS elapsedMs,
        weighted_ms AS weightedMs, multiplier
      FROM xp_voice WHERE guild_id = ? AND user_id = ?
    `,
      )
      .get(guildId, userId);
  }

  settle(session, timestamp) {
    const result = advanceVoice(session, timestamp);
    this.database
      .prepare(
        `
      UPDATE xp_members SET voice_ms = voice_ms + ?
      WHERE guild_id = ? AND user_id = ?
    `,
      )
      .run(result.durationMs, session.guildId, session.userId);
    if (result.xpMilli) {
      const member = this.member(session.guildId, session.userId);
      this.applyXp(session.guildId, session.userId, result.xpMilli, {
        key: `voice:${member.generation}:${session.updatedAt}:${timestamp}`,
        kind: 'voice',
        timestamp,
      });
      this.daily(
        session.guildId,
        session.userId,
        dayKey(timestamp),
        result.xpMilli,
      );
    }
    for (const segment of splitVoiceDays(session.updatedAt, timestamp)) {
      this.daily(
        session.guildId,
        session.userId,
        segment.day,
        0,
        0,
        segment.durationMs,
      );
    }
    return result.session;
  }

  saveSession(session) {
    this.database
      .prepare(
        `
      INSERT INTO xp_voice (guild_id, user_id, channel_id, updated_at, elapsed_ms, weighted_ms, multiplier)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (guild_id, user_id) DO UPDATE SET
        channel_id = excluded.channel_id, updated_at = excluded.updated_at,
        elapsed_ms = excluded.elapsed_ms, weighted_ms = excluded.weighted_ms,
        multiplier = excluded.multiplier
    `,
      )
      .run(
        session.guildId,
        session.userId,
        session.channelId,
        session.updatedAt,
        session.elapsedMs,
        session.weightedMs,
        session.multiplier,
      );
  }

  voice(guildId, userId, channelId, multiplier, timestamp) {
    return this.transaction(() => {
      const previous = this.session(guildId, userId);
      const settled = previous ? this.settle(previous, timestamp) : null;
      if (!channelId) {
        this.database
          .prepare('DELETE FROM xp_voice WHERE guild_id = ? AND user_id = ?')
          .run(guildId, userId);
        return;
      }
      const member = this.ensureMember(guildId, userId);
      if (!member.active) return;
      this.saveSession({
        guildId,
        userId,
        updatedAt: timestamp,
        elapsedMs: 0,
        weightedMs: 0,
        ...settled,
        channelId,
        multiplier,
      });
    });
  }

  checkpoint(timestamp) {
    this.transaction(() => {
      const sessions = this.database
        .prepare('SELECT guild_id, user_id FROM xp_voice')
        .all();
      for (const session of sessions) {
        this.saveSession(
          this.settle(
            this.session(session.guild_id, session.user_id),
            timestamp,
          ),
        );
      }
      this.database
        .prepare('DELETE FROM xp_messages WHERE timestamp < ?')
        .run(timestamp - 7 * 86400000);
    });
  }

  resetVoice() {
    this.database.prepare('DELETE FROM xp_voice').run();
  }

  activeUserIds(guildId) {
    return this.database
      .prepare(
        'SELECT user_id AS userId FROM xp_members WHERE guild_id = ? AND active = 1',
      )
      .all(guildId)
      .map((member) => member.userId);
  }

  leave(guildId, userId, timestamp) {
    this.transaction(() => {
      const member = this.member(guildId, userId);
      if (!member?.active) return;
      this.attendanceCache = null;
      const session = this.session(guildId, userId);
      if (session) this.settle(session, timestamp);
      if (this.settings(guildId, 'lifecycle').value.resetOnLeave) {
        this.resetBalance(guildId, userId, timestamp, 'leave');
      }
      this.database
        .prepare('DELETE FROM xp_voice WHERE guild_id = ? AND user_id = ?')
        .run(guildId, userId);
      this.database
        .prepare(
          `
        UPDATE xp_members SET active = 0, generation = generation + 1, last_message_at = NULL
        WHERE guild_id = ? AND user_id = ?
      `,
        )
        .run(guildId, userId);
      this.database
        .prepare(
          `
        UPDATE xp_jobs SET state = 'cancelled', claim_token = NULL, claimed_until = NULL
        WHERE guild_id = ? AND user_id = ? AND state IN ('pending', 'processing', 'review')
      `,
        )
        .run(guildId, userId);
    });
  }

  profile(guildId, userId) {
    const member = this.database
      .prepare('SELECT * FROM xp_members WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId);
    const xpMilli = member?.xp_milli ?? 0;
    const rank = member?.active
      ? this.database
          .prepare(
            `
      SELECT COUNT(*) + 1 AS rank FROM xp_members
      WHERE guild_id = ? AND active = 1 AND xp_milli > ?
    `,
          )
          .get(guildId, xpMilli).rank
      : null;
    return {
      ...levelProgress(xpMilli),
      rank,
      messages: member?.messages ?? 0,
      voiceMs: member?.voice_ms ?? 0,
    };
  }

  leaderboard(guildId) {
    return this.database
      .prepare(
        `
      SELECT user_id AS userId, xp_milli FROM xp_members
      WHERE guild_id = ? AND active = 1 ORDER BY xp_milli DESC, user_id LIMIT 10
    `,
      )
      .all(guildId)
      .map((member) => ({
        userId: member.userId,
        ...this.profile(guildId, member.userId),
      }));
  }

  stats(guildId, userId, days, timestamp) {
    if (!Number.isInteger(days) || days < 1 || days > 30)
      throw new RangeError('Days must be between 1 and 30.');
    const firstDay = dayKey(timestamp - (days - 1) * 86400000);
    const lastDay = dayKey(timestamp);
    const values = [guildId, firstDay, lastDay];
    if (userId) values.push(userId);
    return this.database
      .prepare(
        `
      SELECT COALESCE(SUM(messages), 0) AS messages,
        COALESCE(SUM(voice_ms), 0) AS voiceMs,
        COALESCE(SUM(xp_milli), 0) / 1000.0 AS earnedXp,
        COUNT(DISTINCT user_id) AS participants
      FROM xp_daily WHERE guild_id = ? AND day BETWEEN ? AND ?
      ${userId ? 'AND user_id = ?' : ''}
    `,
      )
      .get(...values);
  }

  close() {
    this.database.close();
  }
}
