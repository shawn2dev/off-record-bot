const SCHEMA_VERSION = 3;

function attendanceSummarySql(filter = '') {
  return `
    INSERT OR REPLACE INTO xp_attendance_summary
      (guild_id, user_id, total, last_day, last_streak)
    SELECT guild_id, user_id, COUNT(*), MAX(day),
      SUM(CASE WHEN julianday(last_day) - julianday(day) = position - 1
        THEN 1 ELSE 0 END)
    FROM (
      SELECT guild_id, user_id, day,
        MAX(day) OVER (PARTITION BY guild_id, user_id) AS last_day,
        ROW_NUMBER() OVER (PARTITION BY guild_id, user_id ORDER BY day DESC) AS position
      FROM xp_attendance ${filter}
    ) GROUP BY guild_id, user_id;
  `;
}

function refreshAttendanceSql(reference) {
  const filter = `WHERE guild_id = ${reference}.guild_id AND user_id = ${reference}.user_id`;
  return `DELETE FROM xp_attendance_summary ${filter}; ${attendanceSummarySql(filter)}`;
}

export function assertXpSchema(database) {
  const version = database.prepare('PRAGMA user_version').get().user_version;
  if (version > SCHEMA_VERSION) {
    throw new Error('The XP database schema is newer than this application.');
  }
}

export function migrateXpDatabase(database) {
  assertXpSchema(database);
  const version = database.prepare('PRAGMA user_version').get().user_version;
  if (version === SCHEMA_VERSION) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    assertXpSchema(database);
    if (
      database.prepare('PRAGMA user_version').get().user_version ===
      SCHEMA_VERSION
    ) {
      database.exec('COMMIT');
      return;
    }
    if (version < 1) {
      database.exec(`
      ALTER TABLE xp_members ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE xp_members ADD COLUMN reset_version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE xp_members ADD COLUMN joined_at INTEGER;
      CREATE TABLE xp_settings (
        guild_id TEXT NOT NULL, section TEXT NOT NULL,
        version INTEGER NOT NULL, value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
        PRIMARY KEY (guild_id, section)
      );
      CREATE TABLE xp_audit (
        id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL,
        actor_id TEXT NOT NULL, action TEXT NOT NULL,
        details_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX xp_audit_guild ON xp_audit (guild_id, id DESC);
      CREATE TABLE xp_ledger (
        id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
        operation_key TEXT NOT NULL, kind TEXT NOT NULL,
        delta_milli INTEGER NOT NULL,
        balance_after INTEGER NOT NULL CHECK (balance_after BETWEEN 0 AND 9007199254740991),
        reset_version INTEGER NOT NULL, request_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (guild_id, user_id, operation_key)
      );
      CREATE INDEX xp_ledger_member ON xp_ledger (guild_id, user_id, id DESC);
      CREATE TABLE xp_jobs (
        id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind = 'nickname'),
        generation INTEGER NOT NULL, reset_version INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'completed', 'review', 'cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
        claimed_until INTEGER, claim_token TEXT, error_code TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX xp_jobs_due ON xp_jobs (state, available_at, id);
    `);
      const invalid = database
        .prepare(
          `SELECT 1 FROM xp_members WHERE typeof(xp_milli) != 'integer'
          OR xp_milli < 0 OR xp_milli > 9007199254740991 LIMIT 1`,
        )
        .get();
      if (invalid)
        throw new Error('An existing XP balance exceeds the safe range.');
      database
        .prepare(
          `
        INSERT INTO xp_ledger (
          guild_id, user_id, operation_key, kind, delta_milli,
          balance_after, reset_version, request_json, created_at
        )
        SELECT guild_id, user_id, 'opening:v1', 'opening', xp_milli,
          xp_milli, 0, '{}', ? FROM xp_members
      `,
        )
        .run(Date.now());
    }
    if (version < 2) {
      database.exec(`
        CREATE TABLE xp_requests (
          guild_id TEXT NOT NULL, user_id TEXT NOT NULL, action TEXT NOT NULL,
          request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
          response_json TEXT NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY (guild_id, user_id, action, request_key)
        );
        CREATE TABLE xp_products (
          id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, version INTEGER NOT NULL,
          title TEXT NOT NULL, description TEXT NOT NULL, role_id TEXT NOT NULL,
          price_xp INTEGER NOT NULL CHECK (price_xp > 0),
          enabled INTEGER NOT NULL, sort_order INTEGER NOT NULL,
          role_locked INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
        );
        CREATE INDEX xp_products_list ON xp_products (guild_id, sort_order, id);
        CREATE UNIQUE INDEX xp_products_active_role ON xp_products (guild_id, role_id) WHERE enabled = 1;
        CREATE TRIGGER xp_products_immutable_role BEFORE UPDATE OF role_id ON xp_products
          WHEN OLD.role_locked = 1 AND OLD.role_id != NEW.role_id
          BEGIN SELECT RAISE(ABORT, 'ROLE_LOCKED'); END;
        CREATE TRIGGER xp_products_immutable_lock BEFORE UPDATE OF role_locked ON xp_products
          WHEN OLD.role_locked = 1 AND NEW.role_locked != 1
          BEGIN SELECT RAISE(ABORT, 'ROLE_LOCKED'); END;
        CREATE TABLE xp_orders (
          id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
          product_id INTEGER NOT NULL, product_version INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL, role_id TEXT NOT NULL, amount_milli INTEGER NOT NULL,
          generation INTEGER NOT NULL, reset_version INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending','processing','completed','review','refunded','refund_forfeited')),
          attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
          claimed_until INTEGER, claim_token TEXT, error_code TEXT,
          refund_milli INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE INDEX xp_orders_due ON xp_orders (guild_id, state, available_at, id);
        CREATE INDEX xp_orders_member ON xp_orders (guild_id, user_id, id DESC);
        CREATE TRIGGER xp_orders_immutable_role BEFORE UPDATE OF role_id ON xp_orders
          WHEN OLD.role_id != NEW.role_id
          BEGIN SELECT RAISE(ABORT, 'ROLE_LOCKED'); END;
        CREATE UNIQUE INDEX xp_orders_unique_pending ON xp_orders (guild_id, user_id, role_id)
          WHERE state IN ('pending','processing','review');
        CREATE TABLE xp_entitlements (
          guild_id TEXT NOT NULL, user_id TEXT NOT NULL, role_id TEXT NOT NULL,
          product_id INTEGER NOT NULL, order_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY (guild_id, user_id, role_id)
        );
        CREATE TABLE xp_game_rounds (
          id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
          game TEXT NOT NULL, amount_xp INTEGER NOT NULL, payout_milli INTEGER NOT NULL,
          outcome TEXT NOT NULL, choice TEXT, settings_version INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL, generation INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX xp_games_cooldown ON xp_game_rounds (guild_id, user_id, game, created_at DESC);
        CREATE TABLE xp_raffles (
          id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, actor_id TEXT NOT NULL,
          role_id TEXT, winners INTEGER NOT NULL, amount_xp INTEGER NOT NULL,
          candidates_json TEXT NOT NULL, winners_json TEXT, results_json TEXT,
          settings_version INTEGER NOT NULL, state TEXT NOT NULL,
          expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE INDEX xp_raffles_actor ON xp_raffles (guild_id, actor_id, created_at DESC);
        CREATE TABLE xp_nicknames (
          guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
          original_nickname TEXT, base_name TEXT NOT NULL, applied_name TEXT,
          applied_prefix TEXT, desired_name TEXT, generation INTEGER NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending', error_code TEXT, updated_at INTEGER NOT NULL,
          PRIMARY KEY (guild_id, user_id)
        );
        CREATE TABLE xp_nickname_sweeps (
          guild_id TEXT PRIMARY KEY, after_user_id TEXT NOT NULL DEFAULT '',
          active INTEGER NOT NULL DEFAULT 1
        );
        INSERT INTO xp_nickname_sweeps (guild_id)
          SELECT DISTINCT guild_id FROM xp_members WHERE active = 1;
        CREATE TABLE xp_message_receipts (
          message_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL
        );
        INSERT OR IGNORE INTO xp_message_receipts (message_id, guild_id, user_id)
          SELECT substr(operation_key, 9), guild_id, user_id FROM xp_ledger WHERE kind = 'message';
      `);
      if (
        database
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'xp_messages'",
          )
          .get()
      ) {
        database.exec(`INSERT OR IGNORE INTO xp_message_receipts (message_id, guild_id, user_id)
          SELECT message_id, '', '' FROM xp_messages`);
      }
    }
    if (version < 3) {
      database.exec(`
        CREATE TABLE xp_attendance_summary (
          guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
          total INTEGER NOT NULL CHECK (total > 0),
          last_day TEXT NOT NULL,
          last_streak INTEGER NOT NULL CHECK (last_streak > 0),
          PRIMARY KEY (guild_id, user_id)
        );
        CREATE INDEX xp_attendance_summary_day ON xp_attendance_summary (guild_id, last_day);
        ${attendanceSummarySql()}
        CREATE TRIGGER xp_attendance_insert_summary AFTER INSERT ON xp_attendance
          BEGIN ${refreshAttendanceSql('NEW')} END;
        CREATE TRIGGER xp_attendance_delete_summary AFTER DELETE ON xp_attendance
          BEGIN ${refreshAttendanceSql('OLD')} END;
        CREATE TRIGGER xp_attendance_update_summary AFTER UPDATE ON xp_attendance
          BEGIN ${refreshAttendanceSql('OLD')} ${refreshAttendanceSql('NEW')} END;
      `);
    }
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
