import { expect } from 'chai';
import { describe, it } from 'mocha';
import { DatabaseSync } from 'node:sqlite';
import { XpStore } from '../src/xp-store.js';
import {
  invalidateXpAuth,
  verifyXpLedger,
  runXpMaintenance,
} from '../src/xp-api-maintenance.js';

describe('Offline XP restore verification', () => {
  it('reconciles every recorded balance including resets and forfeited refunds', () => {
    const store = new XpStore(':memory:');
    try {
      store.attendance('guild', 'user', 0);
      store.leave('guild', 'user', 1);
      store.activate('guild', 'user', 2);
      store.refundXp('guild', 'user', 500000, 'old-refund', 0, 3);
      const result = verifyXpLedger(store.database);
      expect(result.valid).to.equal(true);
      expect(result.membersChecked).to.equal(1);
      expect(result.transactionsChecked).to.be.at.least(4);
    } finally {
      store.close();
    }
  });

  it('detects an incorrect intermediate balance even if the final net balance agrees', () => {
    const store = new XpStore(':memory:');
    try {
      store.attendance('guild', 'user', 0);
      store.message('guild', 'user', 'one', 1000);
      store.database.exec(
        'UPDATE xp_ledger SET balance_after = balance_after + 1 WHERE id = 1',
      );
      const result = verifyXpLedger(store.database);
      expect(result.valid).to.equal(false);
      expect(result.mismatchCount).to.equal(1);
      expect(result.mismatches[0].validHistory).to.equal(false);
    } finally {
      store.close();
    }
  });

  it('invalidates only existing authentication tables without deleting economic records', () => {
    const store = new XpStore(':memory:');
    try {
      store.attendance('guild', 'user', 0);
      store.database.exec(`
        CREATE TABLE xp_auth_tokens (value TEXT);
        INSERT INTO xp_auth_tokens VALUES ('expired');
      `);
      expect(invalidateXpAuth(store.database)).to.deep.equal({
        xp_auth_tokens: 1,
      });
      expect(verifyXpLedger(store.database).valid).to.equal(true);
      expect(store.profile('guild', 'user').xp).to.equal(500);
    } finally {
      store.close();
    }
  });

  it('refuses missing input files and uninitialized legacy ledgers', () => {
    expect(() => runXpMaintenance([])).to.throw('Usage');
    expect(() =>
      runXpMaintenance([
        '--database',
        '/this-path-does-not-exist/xp.sqlite',
        '--verify-ledger',
      ]),
    ).to.throw('existing database');
    const database = new DatabaseSync(':memory:');
    try {
      expect(() => verifyXpLedger(database)).to.throw('migration');
    } finally {
      database.close();
    }
  });
});
