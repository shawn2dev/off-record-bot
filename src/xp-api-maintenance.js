import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const authTables = [
  'xp_auth_tokens',
  'xp_auth_codes',
  'xp_auth_states',
  'xp_auth_sessions',
];

export function invalidateXpAuth(database) {
  const removed = {};
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const table of authTables) {
      if (
        database
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(table)
      ) {
        removed[table] = database.prepare(`DELETE FROM ${table}`).run().changes;
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return removed;
}

export function verifyXpLedger(database) {
  if (
    !database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'xp_ledger'",
      )
      .get()
  ) {
    throw new Error(
      'Ledger migration must be applied before balance reconciliation.',
    );
  }
  const members = database.prepare(`
    SELECT guild_id, user_id, xp_milli FROM xp_members ORDER BY guild_id, user_id
  `);
  const history = database.prepare(`
    SELECT delta_milli, balance_after FROM xp_ledger
    WHERE guild_id = ? AND user_id = ? ORDER BY id
  `);
  members.setReadBigInts(true);
  history.setReadBigInts(true);
  let membersChecked = 0;
  let transactionsChecked = 0;
  let mismatchCount = 0;
  const mismatches = [];
  for (const member of members.iterate()) {
    let balance = 0n;
    let validHistory = true;
    for (const row of history.iterate(member.guild_id, member.user_id)) {
      transactionsChecked += 1;
      balance += row.delta_milli;
      if (
        row.balance_after !== balance ||
        balance < 0n ||
        balance > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        validHistory = false;
      }
    }
    membersChecked += 1;
    if (!validHistory || balance !== member.xp_milli) {
      mismatchCount += 1;
      if (mismatches.length < 50)
        mismatches.push({
          guildId: member.guild_id,
          userId: member.user_id,
          recordedBalance: String(member.xp_milli),
          ledgerBalance: String(balance),
          validHistory,
        });
    }
  }
  const orphaned = database
    .prepare(
      `
    SELECT COUNT(*) AS count FROM xp_ledger l
    WHERE NOT EXISTS (SELECT 1 FROM xp_members m WHERE m.guild_id = l.guild_id AND m.user_id = l.user_id)
  `,
    )
    .get().count;
  return {
    valid: mismatchCount === 0 && orphaned === 0,
    membersChecked,
    transactionsChecked,
    mismatchCount,
    orphanedTransactions: orphaned,
    mismatches,
  };
}

export function runXpMaintenance(args = process.argv.slice(2)) {
  const pathIndex = args.indexOf('--database');
  const filename = pathIndex >= 0 ? args[pathIndex + 1] : null;
  const invalidate = args.includes('--invalidate-auth');
  const verify = args.includes('--verify-ledger');
  const allowed = args.filter((value, index) => index !== pathIndex + 1);
  if (
    !filename ||
    (!invalidate && !verify) ||
    allowed.some(
      (value) =>
        !['--database', '--invalidate-auth', '--verify-ledger'].includes(value),
    )
  )
    throw new Error(
      'Usage: --database /absolute/path/xp.sqlite --verify-ledger and/or --invalidate-auth. Stop the bot first.',
    );
  const path = resolve(filename);
  if (!existsSync(path) || !statSync(path).isFile())
    throw new Error('An existing database file is required.');
  const database = new DatabaseSync(path, { readOnly: !invalidate });
  try {
    const integrity = database
      .prepare('PRAGMA integrity_check')
      .get().integrity_check;
    if (integrity !== 'ok')
      throw new Error(
        'Database integrity check failed; keep the service stopped.',
      );
    const result = {
      ...(invalidate
        ? { authenticationInvalidated: invalidateXpAuth(database) }
        : {}),
      ...(verify ? { ledger: verifyXpLedger(database) } : {}),
    };
    if (verify && !result.ledger.valid) process.exitCode = 1;
    return result;
  } finally {
    database.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(JSON.stringify(runXpMaintenance(), null, 2));
  } catch {
    console.error(
      'XP maintenance failed. Check arguments, backup integrity and database schema; keep the service stopped.',
    );
    process.exitCode = 1;
  }
}
