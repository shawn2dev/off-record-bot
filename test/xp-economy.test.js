import { expect } from 'chai';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { XpStore } from '../src/xp-store.js';
import { XpEconomy } from '../src/xp-economy.js';
import {
  XP_OWNER_ID,
  canManage,
  defaultXpSettings,
} from '../src/xp-settings.js';
import {
  basicOutcomes,
  defaultGameSettings,
  drawGame,
  gameRtp,
} from '../src/xp-games.js';
import { economyReply, shopReply } from '../src/xp-economy-ui.js';
import { XP_KO } from '../src/xp-locale-ko.js';
import { handleXpInteraction } from '../src/xp-bot.js';

const guildId = '111111111111111111';
const alice = '222222222222222222';
const bob = '333333333333333333';
const roleId = '444444444444444444';
const adminRoleId = '555555555555555555';
const owner = XP_OWNER_ID;
const human = (userId, patch = {}) => ({
  userId,
  roleIds: [],
  bot: false,
  joinedAt: 1,
  displayName: `name-${userId}`,
  nickname: null,
  manageable: true,
  ...patch,
});

async function rejects(promise, code) {
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught?.message).to.equal(code);
}

describe('XP economy transactions and durable recovery', () => {
  let store, economy, members, roles, discord, now, roleCalls, nicknameCalls;
  beforeEach(() => {
    store = new XpStore(':memory:');
    now = 100000;
    members = new Map([owner, alice, bob].map((id) => [id, human(id)]));
    roles = [
      {
        id: roleId,
        name: '상품 역할',
        position: 1,
        managed: false,
        dangerous: false,
        manageable: true,
      },
      {
        id: adminRoleId,
        name: '관리 역할',
        position: 2,
        managed: false,
        dangerous: false,
        manageable: true,
      },
    ];
    roleCalls = [];
    nicknameCalls = [];
    discord = {
      async member(id) {
        return members.has(id) ? structuredClone(members.get(id)) : null;
      },
      async roles() {
        return structuredClone(roles);
      },
      async members(role) {
        return [...members.values()]
          .filter((item) => !role || item.roleIds.includes(role))
          .map((item) => structuredClone(item));
      },
      async addRole(id, role) {
        roleCalls.push([id, role]);
        members.get(id).roleIds.push(role);
      },
      async setNickname(id, name) {
        nicknameCalls.push([id, name]);
        members.get(id).nickname = name;
      },
    };
    for (const id of members.keys()) store.activate(guildId, id, now, 1);
    economy = new XpEconomy(store, {
      guildId,
      discord,
      clock: () => now,
      rng: () => 0,
    });
  });
  afterEach(async () => {
    await economy.close();
    store.close();
  });
  const credit = (id, amount = 10000, key = randomUUID()) =>
    economy.execute('xp.adjust', owner, {
      userId: id,
      amount,
      operation: 'add',
      reason: '시험 지급',
      key,
    });
  const product = (patch = {}, extra = {}) =>
    economy.execute('products.save', owner, {
      version: 0,
      product: {
        title: '역할 상품',
        description: '상품 설명',
        roleId,
        priceXp: 100,
        enabled: true,
        sortOrder: 0,
        ...patch,
      },
      ...extra,
    });
  const enableNicknames = () =>
    economy.execute('settings.update', owner, {
      section: 'nickname',
      version: 0,
      patch: { enabled: true },
    });

  it('uses whole-XP floor fees, permits splitting, and keeps activity separate', async () => {
    await credit(alice);
    const result = await economy.execute('gift.send', alice, {
      userId: bob,
      amount: 101,
      key: 'gift',
    });
    expect(result).to.include({ amountXp: 101, feeXp: 15, receivedXp: 86 });
    for (let index = 0; index < 3; index += 1) {
      expect(
        (
          await economy.execute('gift.send', alice, {
            userId: bob,
            amount: 5,
            key: `small-${index}`,
          })
        ).feeXp,
      ).to.equal(0);
    }
    expect(store.stats(guildId, null, 1, now)).to.include({
      earnedXp: 0,
      messages: 0,
      voiceMs: 0,
    });
    expect(store.profile(guildId, alice).xp).to.equal(9884);
    expect(store.profile(guildId, bob).xp).to.equal(101);
  });

  it('persistently fingerprints gift and adjustment requests and rejects mismatched retries', async () => {
    const input = {
      userId: alice,
      amount: 1000,
      operation: 'add',
      reason: '지원',
      key: 'adjust-once',
    };
    const first = await economy.execute('xp.adjust', owner, input);
    expect(await economy.execute('xp.adjust', owner, input)).to.deep.equal(
      first,
    );
    await rejects(
      economy.execute('xp.adjust', owner, { ...input, reason: '다른 사유' }),
      'TRANSACTION_CONFLICT',
    );
    const gift = { userId: bob, amount: 100, key: 'gift-once' };
    const sent = await economy.execute('gift.send', alice, gift);
    expect(await economy.execute('gift.send', alice, gift)).to.deep.equal(sent);
    await rejects(
      economy.execute('gift.send', alice, { ...gift, amount: 101 }),
      'TRANSACTION_CONFLICT',
    );
    expect(store.profile(guildId, alice).xp).to.equal(900);
  });

  it('rolls back both gift legs and receipts if an outbox write fails', async () => {
    await credit(alice, 1000);
    store.database.exec(
      `CREATE TRIGGER reject_recipient BEFORE INSERT ON xp_ledger WHEN NEW.kind = 'gift_receive' BEGIN SELECT RAISE(ABORT, 'ledger failure'); END;`,
    );
    await rejects(
      economy.execute('gift.send', alice, {
        userId: bob,
        amount: 100,
        key: 'atomic',
      }),
      'ledger failure',
    );
    expect(store.profile(guildId, alice).xp).to.equal(1000);
    expect(store.profile(guildId, bob).xp).to.equal(0);
    expect(
      store.database
        .prepare(
          "SELECT COUNT(*) AS n FROM xp_requests WHERE action = 'gift.send'",
        )
        .get().n,
    ).to.equal(0);
  });

  it('allows disabling an existing role that has become dangerous without permitting a new unsafe listing', async () => {
    const { product: saved } = await product();
    roles[0].dangerous = true;
    await product({ enabled: false }, { id: saved.id, version: 1 });
    expect((await economy.execute('shop.list', alice)).items).to.deep.equal([]);
    await rejects(product({ enabled: false }), 'UNSAFE_ROLE');
  });

  it('rejects unauthorized actions, invalid reasons, overdrafts, bots and self-gifts', async () => {
    await rejects(credit(bob, 0), 'INVALID_TRANSACTION');
    await rejects(
      economy.execute('xp.adjust', alice, {
        userId: bob,
        amount: 1,
        operation: 'add',
        reason: '권한 없음',
        key: 'forbidden',
      }),
      'FORBIDDEN',
    );
    await rejects(
      economy.execute('xp.adjust', owner, {
        userId: bob,
        amount: 1,
        operation: 'remove',
        reason: '차감',
        key: 'overdraft',
      }),
      'INVALID_BALANCE',
    );
    await rejects(
      economy.execute('gift.send', alice, {
        userId: alice,
        amount: 1,
        key: 'self',
      }),
      'INVALID_TRANSACTION',
    );
    members.get(bob).bot = true;
    await rejects(
      economy.execute('gift.send', alice, {
        userId: bob,
        amount: 1,
        key: 'bot',
      }),
      'INVALID_MEMBER',
    );
  });

  it('rejects stale trusted membership instead of silently reactivating it', async () => {
    await credit(alice, 100);
    store.leave(guildId, alice, now);
    await rejects(economy.execute('shop.list', alice), 'STALE_MEMBER');
    expect(store.member(guildId, alice).active).to.equal(0);
    store.activate(guildId, alice, now + 1, 2);
    await rejects(economy.execute('shop.list', alice), 'STALE_MEMBER');
    members.get(alice).joinedAt = 2;
    expect((await economy.execute('shop.list', alice)).profile.xp).to.equal(0);
  });

  it('enforces versions, permanent role locks and role entitlements across re-registration', async () => {
    await credit(alice);
    const { product: saved } = await product();
    const result = await economy.execute('purchase', alice, {
      productId: saved.id,
      version: saved.version,
      key: 'buy',
    });
    expect(result.order.state).to.equal('completed');
    expect(roleCalls).to.deep.equal([[alice, roleId]]);
    expect(store.profile(guildId, alice).xp).to.equal(9900);
    const listed = (await economy.execute('shop.list', alice)).items[0];
    expect(listed).to.include({
      purchased: true,
      owned: true,
      roleLocked: true,
      pending: false,
    });
    await rejects(
      product({ roleId: adminRoleId }, { id: saved.id, version: 1 }),
      'ROLE_LOCKED',
    );
    await rejects(
      economy.execute('purchase', bob, {
        productId: saved.id,
        version: 99,
        key: 'price',
      }),
      'PRODUCT_CONFLICT',
    );
    await product({ enabled: false }, { id: saved.id, version: 1 });
    const { product: replacement } = await product();
    members.get(alice).roleIds = [];
    await rejects(
      economy.execute('purchase', alice, {
        productId: replacement.id,
        version: 1,
        key: 'rebuy',
      }),
      'ALREADY_PURCHASED',
    );
    expect((await economy.execute('shop.list', alice)).items[0]).to.include({
      purchased: true,
      owned: false,
    });
  });

  it('prevents dangerous/delegated role sales and inverse delegation conflicts atomically', async () => {
    roles[0].dangerous = true;
    await rejects(product(), 'UNSAFE_ROLE');
    roles[0].dangerous = false;
    await product();
    await rejects(
      economy.execute('settings.update', owner, {
        section: 'access',
        version: 0,
        patch: { adminRoles: { [roleId]: ['xp.adjust'] } },
      }),
      'UNSAFE_ROLE',
    );
    await economy.execute('settings.update', owner, {
      section: 'access',
      version: 0,
      patch: { adminRoles: { [adminRoleId]: ['shop.manage'] } },
    });
    await rejects(product({ roleId: adminRoleId }), 'UNSAFE_ROLE');
    expect(store.settings(guildId, 'access').version).to.equal(1);
    roles[1].dangerous = true;
    roles[1].managed = true;
    roles[1].manageable = false;
    await economy.execute('settings.update', owner, {
      section: 'access',
      version: 1,
      patch: { adminRoles: { [adminRoleId]: ['xp.adjust'] } },
    });
    expect(store.settings(guildId, 'access').version).to.equal(2);
    members.get(alice).roleIds.push(adminRoleId);
    await economy.execute('xp.adjust', alice, {
      userId: bob,
      amount: 1,
      operation: 'add',
      reason: '명시적 권한 위임',
      key: randomUUID(),
    });
    expect(store.profile(guildId, bob).xp).to.equal(1);
  });

  it('keeps owner-only policy, unions delegated permissions and rechecks revocation', async () => {
    await economy.execute('settings.update', owner, {
      section: 'access',
      version: 0,
      patch: { adminRoles: { [adminRoleId]: ['shop.manage', 'xp.adjust'] } },
    });
    members.get(alice).roleIds = [adminRoleId];
    await economy.execute('xp.adjust', alice, {
      userId: bob,
      amount: 1,
      operation: 'add',
      reason: '권한 있음',
      key: 'delegated',
    });
    await rejects(
      economy.execute('settings.update', alice, {
        section: 'access',
        version: 1,
        patch: { adminRoles: {} },
      }),
      'FORBIDDEN',
    );
    members.get(alice).roleIds = [];
    await rejects(
      economy.execute('xp.adjust', alice, {
        userId: bob,
        amount: 1,
        operation: 'add',
        reason: '권한 해제',
        key: 'revoked',
      }),
      'FORBIDDEN',
    );
    expect(canManage(owner, [], {}, 'xp.adjust')).to.equal(true);
    expect(
      canManage(
        alice,
        [roleId, adminRoleId],
        {
          adminRoles: {
            [roleId]: ['attendance.manage'],
            [adminRoleId]: ['xp.adjust'],
          },
        },
        'xp.adjust',
      ),
    ).to.equal(true);
  });

  it('does not double charge concurrent purchases or duplicate product creation retries', async () => {
    await credit(alice);
    const first = await product({}, { key: 'create-once' });
    const duplicate = await product({}, { key: 'create-once' });
    expect(duplicate).to.deep.equal(first);
    const input = {
      productId: first.product.id,
      version: 1,
      key: 'same-button',
    };
    const [a, b] = await Promise.all([
      economy.execute('purchase', alice, input),
      economy.execute('purchase', alice, input),
    ]);
    expect(a.order.id).to.equal(b.order.id);
    expect(roleCalls).to.have.length(1);
    expect(store.profile(guildId, alice).xp).to.equal(9900);
    expect(
      store.database.prepare('SELECT COUNT(*) AS n FROM xp_products').get().n,
    ).to.equal(1);
  });

  it('verifies actual role state when the delivery response is lost', async () => {
    await credit(alice);
    const { product: saved } = await product();
    discord.addRole = async (id, role) => {
      members.get(id).roleIds.push(role);
      throw new Error('response lost');
    };
    expect(
      (
        await economy.execute('purchase', alice, {
          productId: saved.id,
          version: 1,
          key: 'lost',
        })
      ).order.state,
    ).to.equal('completed');
    expect(store.profile(guildId, alice).xp).to.equal(9900);
  });

  it('stops automatic role delivery after exactly three failed verified attempts', async () => {
    await credit(alice);
    const { product: saved } = await product();
    discord.addRole = async () => {
      roleCalls.push('attempt');
      throw new Error('network');
    };
    const first = await economy.execute('purchase', alice, {
      productId: saved.id,
      version: 1,
      key: 'failed',
    });
    expect(first.order).to.include({ state: 'pending', attempts: 1 });
    for (let index = 0; index < 5; index += 1) {
      now += 100000;
      await economy.tick();
    }
    expect(economy.order(first.order.id)).to.include({
      state: 'review',
      attempts: 3,
    });
    expect(roleCalls).to.have.length(3);
    expect(store.profile(guildId, alice).xp).to.equal(9900);
    const refunded = await economy.execute('order.review', owner, {
      id: first.order.id,
      action: 'refund',
      key: 'refund',
    });
    expect(refunded.order).to.include({ state: 'refunded', refundXp: 100 });
    await economy.execute('order.review', owner, {
      id: first.order.id,
      action: 'refund',
      key: 'refund',
    });
    expect(store.profile(guildId, alice).xp).to.equal(10000);
  });

  it('routes unverifiable results to review, then allows state-verified manual completion', async () => {
    await credit(alice);
    const { product: saved } = await product();
    const original = discord.member;
    let verifying = false;
    discord.addRole = async (id, role) => {
      members.get(id).roleIds.push(role);
      verifying = true;
    };
    discord.member = async (id) => {
      if (verifying && id === alice) throw new Error('read unavailable');
      return original(id);
    };
    const result = await economy.execute('purchase', alice, {
      productId: saved.id,
      version: 1,
      key: 'unknown',
    });
    expect(result.order.state).to.equal('review');
    verifying = false;
    await rejects(
      economy.execute('order.review', owner, {
        id: result.order.id,
        action: 'refund',
        key: 'no-refund',
      }),
      'ROLE_ALREADY_GRANTED',
    );
    expect(
      (
        await economy.execute('order.review', owner, {
          id: result.order.id,
          action: 'complete',
          key: 'manual',
        })
      ).order.state,
    ).to.equal('completed');
  });

  it('never retries stale generations, and forfeits refunds after balance reset', async () => {
    await credit(alice);
    const { product: saved } = await product();
    discord.addRole = async () => {
      throw new Error('network');
    };
    const result = await economy.execute('purchase', alice, {
      productId: saved.id,
      version: 1,
      key: 'old-order',
    });
    store.leave(guildId, alice, now);
    members.delete(alice);
    now += 100000;
    await economy.tick();
    expect(economy.order(result.order.id).state).to.equal('review');
    const refunded = await economy.execute('order.review', owner, {
      id: result.order.id,
      action: 'refund',
      key: 'old-refund',
    });
    expect(refunded.order).to.include({
      state: 'refund_forfeited',
      refundXp: 0,
    });
    expect(store.profile(guildId, alice).xp).to.equal(0);
    expect(store.member(guildId, alice).active).to.equal(0);
  });

  it('refunds preserved balances while keeping departed users inactive', async () => {
    await economy.execute('settings.update', owner, {
      section: 'lifecycle',
      version: 0,
      patch: { resetOnLeave: false },
    });
    await credit(alice);
    const { product: saved } = await product();
    discord.addRole = async () => {
      throw new Error('network');
    };
    const result = await economy.execute('purchase', alice, {
      productId: saved.id,
      version: 1,
      key: 'preserve',
    });
    store.leave(guildId, alice, now);
    members.delete(alice);
    now += 100000;
    await economy.tick();
    expect(
      (
        await economy.execute('order.review', owner, {
          id: result.order.id,
          action: 'refund',
          key: 'preserve-refund',
        })
      ).order.state,
    ).to.equal('refunded');
    expect(store.profile(guildId, alice).xp).to.equal(10000);
    expect(store.member(guildId, alice).active).to.equal(0);
  });

  it('rolls back purchase debit, role lock and order if the ledger fails', async () => {
    await credit(alice);
    const { product: saved } = await product();
    store.database.exec(
      "CREATE TRIGGER reject_purchase BEFORE INSERT ON xp_ledger WHEN NEW.kind = 'purchase' BEGIN SELECT RAISE(ABORT, 'purchase failure'); END;",
    );
    await rejects(
      economy.execute('purchase', alice, {
        productId: saved.id,
        version: 1,
        key: 'atomic-buy',
      }),
      'purchase failure',
    );
    expect(store.profile(guildId, alice).xp).to.equal(10000);
    expect(
      store.database.prepare('SELECT COUNT(*) AS n FROM xp_orders').get().n,
    ).to.equal(0);
    expect(
      (await economy.execute('shop.list', alice)).items[0].roleLocked,
    ).to.equal(false);
    expect(roleCalls).to.have.length(0);
  });

  it('snapshots game results/settings and settles exactly once across retries', async () => {
    await credit(alice);
    const input = { game: 'oddEven', amount: 1, choice: 'odd', key: 'round' };
    const result = await economy.execute('game.play', alice, input);
    expect(result).to.include({
      payoutMilli: 1880,
      payoutXp: 1.88,
      rtp: 94,
      settingsVersion: 0,
    });
    expect(await economy.execute('game.play', alice, input)).to.deep.equal(
      result,
    );
    expect(store.member(guildId, alice).xp_milli).to.equal(10000880);
    await rejects(
      economy.execute('game.play', alice, { ...input, choice: 'even' }),
      'TRANSACTION_CONFLICT',
    );
    await rejects(
      economy.execute('game.play', alice, { ...input, key: 'too-soon' }),
      'COOLDOWN',
    );
    expect(
      store.database.prepare('SELECT COUNT(*) AS n FROM xp_game_rounds').get()
        .n,
    ).to.equal(1);
    expect(store.stats(guildId, alice, 1, now).earnedXp).to.equal(0);
  });

  it('enforces game channels, roles, payout caps, choices and atomic overdraft rejection', async () => {
    await credit(alice);
    await economy.execute('settings.update', owner, {
      section: 'games',
      version: 0,
      patch: {
        dice: {
          allowedRoleIds: [roleId],
          allowedChannelIds: [adminRoleId],
          maxPayoutXp: 10,
        },
      },
    });
    const play = {
      game: 'dice',
      amount: 1,
      choice: '1',
      channelId: adminRoleId,
      key: 'restricted',
    };
    await rejects(economy.execute('game.play', alice, play), 'GAME_RESTRICTED');
    members.get(alice).roleIds = [roleId];
    await rejects(
      economy.execute('game.play', alice, { ...play, channelId: roleId }),
      'GAME_RESTRICTED',
    );
    await rejects(
      economy.execute('game.play', alice, { ...play, amount: 2 }),
      'PAYOUT_LIMIT',
    );
    await rejects(
      economy.execute('game.play', alice, { ...play, choice: '7' }),
      'INVALID_CHOICE',
    );
    await rejects(
      economy.execute('game.play', bob, {
        game: 'slots',
        amount: 1,
        key: 'broke',
      }),
      'INVALID_BALANCE',
    );
    expect(
      store.database.prepare('SELECT COUNT(*) AS n FROM xp_game_rounds').get()
        .n,
    ).to.equal(0);
  });

  it('confirms raffle snapshots, excludes stale generations and pays unique current humans once', async () => {
    const preview = await economy.execute('raffle.preview', owner, {
      winners: 2,
      amount: 10,
    });
    expect(preview).to.include({ candidateCount: 3, totalXp: 20 });
    store.leave(guildId, bob, now);
    store.activate(guildId, bob, now + 1, 2);
    members.get(bob).joinedAt = 2;
    const result = await economy.execute('raffle.execute', owner, {
      previewId: preview.previewId,
      key: 'raffle',
    });
    expect(result.winners.map((item) => item.userId)).to.deep.equal([
      owner,
      alice,
    ]);
    expect(
      await economy.execute('raffle.execute', owner, {
        previewId: preview.previewId,
        key: 'raffle',
      }),
    ).to.deep.equal(result);
    expect(store.profile(guildId, bob).xp).to.equal(0);
    expect(new Set(result.winners.map((item) => item.userId)).size).to.equal(2);
    await rejects(
      economy.execute('raffle.execute', owner, {
        previewId: preview.previewId,
        key: 'another',
      }),
      'RAFFLE_CONFLICT',
    );
  });

  it('rejects stale raffle settings, expired confirmation, insufficient humans and caps', async () => {
    await rejects(
      economy.execute('raffle.preview', owner, { winners: 4, amount: 1 }),
      'NOT_ENOUGH_CANDIDATES',
    );
    await rejects(
      economy.execute('raffle.preview', owner, { winners: 1, amount: 10001 }),
      'INVALID_RAFFLE',
    );
    const expired = await economy.execute('raffle.preview', owner, {
      winners: 1,
      amount: 1,
    });
    now += 300001;
    await rejects(
      economy.execute('raffle.execute', owner, {
        previewId: expired.previewId,
        key: 'expired',
      }),
      'PREVIEW_EXPIRED',
    );
    const stale = await economy.execute('raffle.preview', owner, {
      winners: 1,
      amount: 1,
    });
    await economy.execute('settings.update', owner, {
      section: 'raffle',
      version: 0,
      patch: { maxWinners: 2 },
    });
    await rejects(
      economy.execute('raffle.execute', owner, {
        previewId: stale.previewId,
        key: 'stale',
      }),
      'SETTINGS_CONFLICT',
    );
  });

  it('leaves nicknames unchanged by default across level changes until explicitly enabled', async () => {
    expect(defaultXpSettings('nickname').enabled).to.equal(false);
    members.get(alice).nickname = '[Lv.9] 기존 별명';
    members.get(bob).nickname = '[lv.7] 기존 별명';
    for (let index = 0; index < 3; index += 1) await economy.tick();
    await credit(alice, 1000);
    await economy.tick();
    expect(nicknameCalls).to.deep.equal([]);
    expect(members.get(alice).nickname).to.equal('[Lv.9] 기존 별명');
    expect(members.get(bob).nickname).to.equal('[lv.7] 기존 별명');
    await enableNicknames();
    for (let index = 0; index < 3; index += 1) await economy.tick();
    expect(members.get(alice).nickname).to.equal('[lv.5] [Lv.9] 기존 별명');
  });

  it('preserves original names, limits Unicode code points and restores only applied prefixes', async () => {
    await enableNicknames();
    members.get(alice).nickname = '😀'.repeat(32);
    await economy.tick();
    await economy.tick();
    await economy.tick();
    expect(Array.from(members.get(alice).nickname)).to.have.length(32);
    expect(members.get(alice).nickname).to.match(/^\[lv\.0\] /);
    await credit(alice, 1000);
    now += 1000;
    await economy.tick();
    expect(members.get(alice).nickname).to.match(/^\[lv\.5\] /);
    expect(members.get(alice).nickname.match(/\[lv\./g)).to.have.length(1);
    await economy.execute('settings.update', owner, {
      section: 'nickname',
      version: 1,
      patch: { enabled: false },
    });
    for (let index = 0; index < 5; index += 1) await economy.tick();
    expect(members.get(alice).nickname).to.equal('😀'.repeat(32));
    expect(members.get(bob).nickname).to.equal(null);
  });

  it('pauses nickname changes and restorations durably without advancing sweeps, then resumes', async () => {
    await enableNicknames();
    for (let index = 0; index < 3; index += 1) await economy.tick();
    const applied = members.get(alice).nickname;
    expect(applied).to.match(/^\[lv\.0\] /);
    await economy.close();
    economy = new XpEconomy(store, {
      guildId,
      discord,
      clock: () => now,
      nicknamePaused: true,
    });
    nicknameCalls.length = 0;
    await credit(alice, 1000);
    await economy.execute('settings.update', owner, {
      section: 'nickname',
      version: 1,
      patch: { enabled: false },
    });
    const jobs = () =>
      store.database
        .prepare('SELECT id, state, attempts FROM xp_jobs ORDER BY id')
        .all();
    const pending = jobs();
    expect(pending.some((job) => job.state === 'pending')).to.equal(true);
    for (let index = 0; index < 5; index += 1) await economy.tick();
    expect(nicknameCalls).to.deep.equal([]);
    expect(members.get(alice).nickname).to.equal(applied);
    expect(jobs()).to.deep.equal(pending);
    expect(
      store.database
        .prepare(
          'SELECT active, after_user_id FROM xp_nickname_sweeps WHERE guild_id = ?',
        )
        .get(guildId),
    ).to.include({ active: 1, after_user_id: '' });
    await economy.close();
    economy = new XpEconomy(store, {
      guildId,
      discord,
      clock: () => now,
    });
    for (let index = 0; index < 5; index += 1) await economy.tick();
    expect(members.get(alice).nickname).to.equal(null);
    expect(nicknameCalls.length).to.be.greaterThan(0);
  });

  it('continues pending role delivery while nickname processing is paused', async () => {
    await economy.close();
    economy = new XpEconomy(store, {
      guildId,
      discord,
      clock: () => now,
      nicknamePaused: true,
    });
    await credit(alice);
    const { product: saved } = await product();
    const addRole = discord.addRole;
    discord.addRole = async () => {
      throw Object.assign(new Error('rate limited'), { retryAfter: 60000 });
    };
    const result = await economy.execute('purchase', alice, {
      productId: saved.id,
      version: 1,
      key: 'paused-nickname-role',
    });
    expect(economy.order(result.order.id).state).to.equal('pending');
    discord.addRole = addRole;
    now += 60000;
    await economy.tick();
    expect(economy.order(result.order.id).state).to.equal('completed');
    expect(roleCalls).to.deep.equal([[alice, roleId]]);
    expect(nicknameCalls).to.deep.equal([]);
  });

  it('handles user renames, role exclusions, template replacement and ignores Gateway echoes', async () => {
    await enableNicknames();
    members.get(alice).nickname = '[lv.9] 원래이름';
    for (let index = 0; index < 3; index += 1) await economy.tick();
    expect(members.get(alice).nickname).to.equal('[lv.0] [lv.9] 원래이름');
    let previous = structuredClone(members.get(alice));
    members.get(alice).nickname = '새이름';
    economy.memberUpdated(previous, structuredClone(members.get(alice)));
    await economy.tick();
    expect(members.get(alice).nickname).to.equal('[lv.0] 새이름');
    previous = { ...structuredClone(members.get(alice)), nickname: '새이름' };
    const count = store.database
      .prepare('SELECT COUNT(*) AS n FROM xp_jobs')
      .get().n;
    economy.memberUpdated(previous, structuredClone(members.get(alice)));
    expect(
      store.database.prepare('SELECT COUNT(*) AS n FROM xp_jobs').get().n,
    ).to.equal(count);
    await economy.execute('settings.update', owner, {
      section: 'nickname',
      version: 1,
      patch: { template: '등급{레벨}', excludedRoleIds: [roleId] },
    });
    members.get(alice).roleIds = [roleId];
    for (let index = 0; index < 4; index += 1) await economy.tick();
    expect(members.get(alice).nickname).to.equal('새이름');
    previous = structuredClone(members.get(alice));
    members.get(alice).roleIds = [];
    economy.memberUpdated(previous, structuredClone(members.get(alice)));
    await economy.tick();
    expect(members.get(alice).nickname).to.equal('등급0 새이름');
  });

  it('persists nickname failures without reverting XP and stops after three automatic attempts', async () => {
    await enableNicknames();
    members.get(alice).manageable = false;
    await credit(alice, 1000);
    for (let index = 0; index < 10; index += 1) {
      await economy.tick();
      now += 100000;
    }
    const row = store.database
      .prepare("SELECT * FROM xp_jobs WHERE user_id = ? AND state = 'review'")
      .get(alice);
    expect(row).to.include({
      attempts: 3,
      error_code: 'NICKNAME_UNMANAGEABLE',
    });
    expect(store.profile(guildId, alice).xp).to.equal(1000);
  });

  it('treats a cleared nickname as a real user rename rather than a null echo', async () => {
    await enableNicknames();
    members.get(alice).nickname = '기존 별명';
    for (let index = 0; index < 3; index += 1) await economy.tick();
    const previous = structuredClone(members.get(alice));
    members.get(alice).nickname = null;
    economy.memberUpdated(previous, structuredClone(members.get(alice)));
    await economy.tick();
    expect(members.get(alice).nickname).to.equal(
      `[lv.0] ${members.get(alice).displayName}`,
    );
    await economy.execute('settings.update', owner, {
      section: 'nickname',
      version: 1,
      patch: { enabled: false },
    });
    for (let index = 0; index < 4; index += 1) await economy.tick();
    expect(members.get(alice).nickname).to.equal(null);
  });

  it('restores an applied-but-unacknowledged nickname and preserves offline renames', async () => {
    await enableNicknames();
    members.get(alice).nickname = '원래 별명';
    for (let index = 0; index < 3; index += 1) await economy.tick();
    await credit(alice, 1000);
    const set = discord.setNickname;
    discord.setNickname = async (id, value) => {
      await set(id, value);
      throw new Error('lost acknowledgement');
    };
    await economy.tick();
    expect(members.get(alice).nickname).to.equal('[lv.5] 원래 별명');
    discord.setNickname = set;
    now += 10000;
    await economy.execute('settings.update', owner, {
      section: 'nickname',
      version: 1,
      patch: { enabled: false },
    });
    for (let index = 0; index < 4; index += 1) await economy.tick();
    expect(members.get(alice).nickname).to.equal('원래 별명');
    members.get(alice).nickname = '오프라인 변경';
    await economy.execute('settings.update', owner, {
      section: 'nickname',
      version: 2,
      patch: { enabled: true },
    });
    for (let index = 0; index < 4; index += 1) await economy.tick();
    expect(members.get(alice).nickname).to.equal('[lv.5] 오프라인 변경');
  });

  it('continues a full nickname sync durably in <=50-member internal batches', async () => {
    await enableNicknames();
    for (let index = 0; index < 100; index += 1) {
      const id = String(700000000000000000n + BigInt(index));
      members.set(id, human(id));
      store.activate(guildId, id, now, 1);
    }
    store.database.prepare('DELETE FROM xp_jobs').run();
    const result = await economy.execute('nickname.sync', owner);
    expect(result).to.include({ queued: 50, scheduled: true });
    expect(
      store.database.prepare('SELECT COUNT(*) AS n FROM xp_jobs').get().n,
    ).to.equal(50);
    await economy.tick();
    expect(
      store.database.prepare('SELECT COUNT(*) AS n FROM xp_jobs').get().n,
    ).to.equal(100);
    await economy.tick();
    expect(
      store.database.prepare('SELECT COUNT(*) AS n FROM xp_jobs').get().n,
    ).to.equal(103);
    const status = await economy.execute('nickname.status', owner);
    expect(status.items).to.have.length(50);
    expect(status.sweep.active).to.equal(false);
    expect(status.counts).to.include({ completed: 2, pending: 101 });
  });

  it('honors provider retry delays for role delivery rather than retrying early', async () => {
    await credit(alice);
    const { product: saved } = await product();
    discord.addRole = async () => {
      roleCalls.push('rate');
      throw Object.assign(new Error('rate limited'), { retryAfter: 60000 });
    };
    const result = await economy.execute('purchase', alice, {
      productId: saved.id,
      version: 1,
      key: 'rate',
    });
    expect(economy.order(result.order.id).available_at).to.equal(now + 60000);
    now += 59000;
    await economy.tick();
    expect(roleCalls).to.have.length(1);
    now += 1000;
    await economy.tick();
    expect(roleCalls).to.have.length(2);
  });

  it('rechecks delegated roles after provider reads and before committing mutations', async () => {
    await economy.execute('settings.update', owner, {
      section: 'access',
      version: 0,
      patch: { adminRoles: { [adminRoleId]: ['shop.manage'] } },
    });
    members.get(alice).roleIds = [adminRoleId];
    discord.roles = async () => {
      members.get(alice).roleIds = [];
      return roles;
    };
    await rejects(
      economy.execute('products.save', alice, {
        version: 0,
        product: {
          title: '권한 검사',
          description: '',
          roleId,
          priceXp: 1,
          enabled: true,
          sortOrder: 0,
        },
      }),
      'FORBIDDEN',
    );
    expect(
      store.database.prepare('SELECT COUNT(*) AS n FROM xp_products').get().n,
    ).to.equal(0);
  });

  it('never completes or retries an old-generation role write after a rejoin during delivery', async () => {
    await credit(alice);
    const { product: saved } = await product();
    discord.addRole = async (id, role) => {
      store.leave(guildId, id, now);
      store.activate(guildId, id, now + 1, 2);
      members.get(id).joinedAt = 2;
      members.get(id).roleIds = [role];
    };
    const result = await economy.execute('purchase', alice, {
      productId: saved.id,
      version: 1,
      key: 'cross-generation',
    });
    expect(result.order).to.include({
      state: 'review',
      errorCode: 'STALE_MEMBER',
    });
    expect(
      store.database.prepare('SELECT COUNT(*) AS n FROM xp_entitlements').get()
        .n,
    ).to.equal(0);
    await rejects(
      economy.execute('order.review', owner, {
        id: result.order.id,
        action: 'retry',
        key: 'no-reenable',
      }),
      'STALE_MEMBER',
    );
  });
  it('retains message replay receipts after xp_messages cleanup for rewarded and zero-XP messages', () => {
    store.message(guildId, alice, 'rewarded', now);
    store.message(guildId, alice, 'cooldown', now + 1);
    const before = store.member(guildId, alice);
    store.checkpoint(now + 8 * 86400000);
    expect(
      store.database.prepare('SELECT COUNT(*) AS n FROM xp_messages').get().n,
    ).to.equal(0);
    expect(
      store.message(guildId, alice, 'rewarded', now + 9 * 86400000),
    ).to.equal(0);
    expect(
      store.message(guildId, alice, 'cooldown', now + 9 * 86400000),
    ).to.equal(0);
    expect(store.member(guildId, alice)).to.deep.equal(before);
  });

  it('keeps durable processing single-flight and suspends unavailable workers', async () => {
    let release;
    const original = discord.member;
    let blocked = true;
    discord.member = async (id) => {
      if (blocked) {
        blocked = false;
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return original(id);
    };
    const first = economy.tick();
    expect(economy.tick()).to.equal(first);
    release();
    await first;
    economy.isAvailable = () => false;
    await economy.tick();
    await rejects(economy.execute('shop.list', alice), 'UNAVAILABLE');
  });

  it('renders <=25-item Korean shop menus, confirmations and user-bound components without pings', async () => {
    await credit(alice);
    await product();
    const reply = await shopReply(economy, alice);
    expect(reply.allowedMentions).to.deep.equal({
      parse: [],
      repliedUser: false,
    });
  });

  it('renders valid emoji-rich product descriptions within Discord UTF-16 menu limits', async () => {
    const music = '\u{1F3B5}';
    await product({ title: music.repeat(50), description: music.repeat(100) });
    const reply = await shopReply(economy, alice);
    const option = reply.components[0].components[0].options[0];
    expect(option.label).to.equal(music.repeat(50));
    expect(option.description.length).to.be.at.most(100);
    expect(option.description.isWellFormed()).to.equal(true);
    expect(option.description).to.include(music);
  });

  it('orders all shop pages globally by configured sort order and groups menus into 25 choices', async () => {
    for (let index = 0; index < 52; index += 1) {
      const id = String(600000000000000000n + BigInt(index));
      roles.push({
        id,
        name: String(index),
        dangerous: false,
        managed: false,
        manageable: true,
      });
      await product({
        title: `상품 ${index}`,
        roleId: id,
        sortOrder: 51 - index,
      });
    }
    const first = await economy.execute('shop.list', alice);
    expect(first.items).to.have.length(50);
    expect(first.items[0].title).to.equal('상품 51');
    const second = await economy.execute('shop.list', alice, {
      after: first.nextCursor,
    });
    expect(second.items.map((item) => item.title)).to.deep.equal([
      '상품 1',
      '상품 0',
    ]);
    const display = await shopReply(economy, alice);
    expect(display.components[0].components[0].options).to.have.length(25);
    const next = await economyReply(economy, {
      customId: display.components[1].components[0].custom_id,
      user: { id: alice },
    });
    expect(next.components[0].components[0].options[0].label).to.equal(
      '상품 26',
    );
    expect(next.components[0].components[0].options).to.have.length(25);
  });

  it('manually retries reviewed role deliveries only for the original active generation', async () => {
    await credit(alice);
    const { product: saved } = await product();
    const grant = discord.addRole;
    discord.addRole = async () => {
      throw new Error('network');
    };
    const result = await economy.execute('purchase', alice, {
      productId: saved.id,
      version: 1,
      key: 'manual-retry',
    });
    for (let index = 0; index < 3; index += 1) {
      now += 100000;
      await economy.tick();
    }
    discord.addRole = grant;
    expect(
      (
        await economy.execute('order.review', owner, {
          id: result.order.id,
          action: 'retry',
          key: 'retry',
        })
      ).order,
    ).to.include({ state: 'completed', attempts: 1 });
    expect(store.profile(guildId, alice).xp).to.equal(9900);
    const { product: other } = await product({ roleId: adminRoleId });
    discord.addRole = async () => {
      throw new Error('network');
    };
    const old = await economy.execute('purchase', alice, {
      productId: other.id,
      version: 1,
      key: 'old-retry',
    });
    store.leave(guildId, alice, now);
    store.activate(guildId, alice, now + 1, 2);
    members.get(alice).joinedAt = 2;
    now += 100000;
    await economy.tick();
    await rejects(
      economy.execute('order.review', owner, {
        id: old.order.id,
        action: 'retry',
        key: 'stale-retry',
      }),
      'STALE_MEMBER',
    );
  });

  it('verifies absence and refunds a definitive role failure exactly once', async () => {
    await credit(alice);
    const { product: saved } = await product();
    discord.addRole = async () => {
      throw Object.assign(new Error('permission'), { code: 50013 });
    };
    const input = { productId: saved.id, version: 1, key: 'permanent' };
    const result = await economy.execute('purchase', alice, input);
    expect(result.order).to.include({ state: 'refunded', refundXp: 100 });
    expect(
      (await economy.execute('purchase', alice, input)).order.state,
    ).to.equal('refunded');
    expect(store.profile(guildId, alice).xp).to.equal(10000);
    expect(
      store.database
        .prepare("SELECT COUNT(*) AS n FROM xp_ledger WHERE kind = 'refund'")
        .get().n,
    ).to.equal(1);
    expect(
      (await economy.execute('shop.list', alice)).items[0].roleLocked,
    ).to.equal(true);
  });
  it('binds shop menus to the calling user and shows current details', async () => {
    await credit(alice);
    await product();
    const reply = await shopReply(economy, alice);
    const menu = reply.components[0].components[0];
    expect(menu.options).to.have.length(1);
    expect(menu.placeholder).to.equal(XP_KO.shopPlaceholder);
    expect(
      (
        await economyReply(economy, {
          customId: menu.custom_id,
          values: ['1'],
          user: { id: bob },
        })
      ).content,
    ).to.equal(XP_KO.componentOtherUser);
    const selected = await economyReply(economy, {
      customId: menu.custom_id,
      values: ['1'],
      user: { id: alice },
    });
    expect(selected.components[1].components[0].disabled).to.equal(false);
  });

  describe('Bounded attendance snapshots', () => {
    it('reuses rank work across profile/buttons and does not invalidate for unrelated local writes', () => {
      const store = new XpStore(':memory:');
      try {
        store.activate(guildId, alice, 0, 1);
        store.attendance(guildId, alice, 100000);
        const prepare = store.database.prepare.bind(store.database);
        let rankingQueries = 0;
        store.database.prepare = (sql) => {
          if (sql.includes('FROM ranked')) rankingQueries += 1;
          return prepare(sql);
        };
        expect(store.attendanceProfile(guildId, alice, 100000).total).to.equal(
          1,
        );
        const mutable = store.attendanceProfile(guildId, alice, 100000);
        mutable.total = 100;
        store.attendanceLeaderboard(guildId, 'total', 100000)[0].total = 500;
        expect(store.attendanceProfile(guildId, alice, 100000).total).to.equal(
          1,
        );
        store.activate(guildId, alice, 100001, 1);
        store.message(guildId, alice, 'cache-message', 100001);
        store.updateSettings(
          guildId,
          'attendance',
          { rewardXp: 1 },
          0,
          { userId: owner, roleIds: [] },
          100001,
        );
        store.checkIn(guildId, alice, 100002);
        store.attendanceLeaderboard(guildId, 'streak', 100002);
        expect(rankingQueries).to.equal(1);
        store.attendanceProfile(guildId, alice, 100000 + 86400000);
        expect(rankingQueries).to.equal(2);
        store.attendanceProfile(guildId, alice, 100000);
        expect(rankingQueries).to.equal(3);
        store.leave(guildId, alice, 100003);
        expect(
          store.attendanceLeaderboard(guildId, 'total', 100003),
        ).to.deep.equal([]);
        expect(rankingQueries).to.equal(4);
      } finally {
        store.close();
      }
    });

    it('detects other-connection writes with data_version and discards rolled-back snapshots', () => {
      const directory = `.xp-attendance-${randomUUID()}`;
      mkdirSync(directory);
      const first = new XpStore(`${directory}/xp.sqlite`);
      const second = new XpStore(`${directory}/xp.sqlite`);
      try {
        first.activate(guildId, alice, 0, 1);
        first.attendance(guildId, alice, 100000);
        expect(first.attendanceProfile(guildId, alice, 100000).total).to.equal(
          1,
        );
        second.activate(guildId, bob, 0, 1);
        second.attendance(guildId, bob, 100000);
        expect(
          first.attendanceLeaderboard(guildId, 'total', 100000),
        ).to.have.length(2);
        expect(() =>
          first.transaction(() => {
            first.attendance(guildId, alice, 100000 + 86400000);
            expect(
              first.attendanceProfile(guildId, alice, 100000 + 86400000).total,
            ).to.equal(2);
            throw new Error('rollback');
          }),
        ).to.throw('rollback');
        expect(
          first.attendanceProfile(guildId, alice, 100000 + 86400000).total,
        ).to.equal(1);
      } finally {
        first.close();
        second.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
  it('requires final confirmation before purchase and disables completed purchases', async () => {
    await credit(alice);
    await product();
    const selected = await shopReply(economy, alice, { productId: '1' });
    const buy = selected.components[1].components[0];
    const confirmation = await economyReply(economy, {
      customId: buy.custom_id,
      user: { id: alice },
    });
    expect(confirmation.content).to.equal(XP_KO.confirmPurchase);
    expect(store.profile(guildId, alice).xp).to.equal(10000);
    const result = await economyReply(economy, {
      id: 'interaction',
      customId: confirmation.components[1].components[0].custom_id,
      message: { id: '777777777777777777' },
      user: { id: alice },
    });
    expect(result.content).to.include(XP_KO.shopBought);
    const purchased = await shopReply(economy, alice, { productId: '1' });
    expect(purchased.components[1].components[0].disabled).to.equal(true);
  });

  it('defers commands before trusted membership and permission fetches', async () => {
    let deferred = false,
      response;
    const original = discord.member;
    discord.member = (id) => {
      expect(deferred).to.equal(true);
      return original(id);
    };
    await handleXpInteraction(
      {
        guildId,
        id: '888888888888888888',
        commandName: XP_KO.ordersCommand,
        user: { id: alice },
        isChatInputCommand: () => true,
        async deferReply() {
          deferred = true;
        },
        async editReply(value) {
          response = value;
        },
      },
      store,
      { guildId, active: true },
      () => false,
      economy,
    );
    expect(response.content).to.equal(XP_KO.ordersEmpty);
    expect(response.flags).to.equal(undefined);
  });
});

describe('Exact integer-milli game mathematics and persistence', () => {
  it('has exact gross 94% RTP at every default integer stake, including one XP', () => {
    for (const game of ['slots', 'wheel', 'oddEven', 'dice']) {
      const config = defaultGameSettings(game);
      const choices = ['oddEven', 'dice'].includes(game)
        ? config.outcomes.map((item) => item.id)
        : [undefined];
      for (const choice of choices) {
        expect(gameRtp(game, config, choice)).to.equal(94);
        for (const amount of [1, 7, 101, 1000]) {
          let payoutWeighted = 0n,
            total = 0n;
          let ticket = 0;
          for (const outcome of config.outcomes) {
            const result = drawGame(game, config, amount, choice, () => ticket);
            expect(Number.isSafeInteger(result.payoutMilli)).to.equal(true);
            payoutWeighted +=
              BigInt(outcome.weight) * BigInt(result.payoutMilli);
            total += BigInt(outcome.weight);
            ticket += outcome.weight;
          }
          expect(payoutWeighted * 100n).to.equal(
            BigInt(amount * 1000) * total * 94n,
          );
        }
      }
    }
  });

  it('derives basic tables and rejects unrepresentable milli rounding or invalid advanced tables', () => {
    expect(basicOutcomes('oddEven', 95)[0].multiplierMilli).to.equal(1900);
    expect(() => basicOutcomes('slots', 94.01)).to.throw('UNREPRESENTABLE_RTP');
    const store = new XpStore(':memory:');
    try {
      const actor = { userId: owner, roleIds: [] };
      for (const patch of [
        { slots: { outcomes: [], mode: 'advanced' } },
        { dice: { maxBetXp: 0 } },
        { wheel: { allowedChannelIds: ['invalid'] } },
        { slots: { mode: 'basic', targetRtp: 94.01 } },
      ])
        expect(() =>
          store.updateSettings(guildId, 'games', patch, 0, actor, 1),
        ).to.throw();
      const result = store.updateSettings(
        guildId,
        'games',
        {
          slots: {
            mode: 'advanced',
            outcomes: [
              { id: 'lose', weight: 1, multiplierMilli: 0 },
              { id: 'win', weight: 1, multiplierMilli: 1800 },
            ],
          },
        },
        0,
        actor,
        1,
      );
      expect(result.value.slots.targetRtp).to.equal(90);
      expect(defaultXpSettings('games').slots.targetRtp).to.equal(94);
      expect(() =>
        store.updateSettings(
          guildId,
          'gift',
          { feePercent: 0.001 },
          0,
          actor,
          1,
        ),
      ).to.throw('INVALID_SETTINGS');
    } finally {
      store.close();
    }
  });

  it('reopens versioned products, order recovery, fingerprints and nickname originals without losing state', async () => {
    const directory = `.xp-economy-${randomUUID()}`;
    mkdirSync(directory);
    let store;
    let economy;
    const current = new Map([owner, alice].map((id) => [id, human(id)]));
    const discord = {
      async member(id) {
        return structuredClone(current.get(id) ?? null);
      },
      async roles() {
        return [
          {
            id: roleId,
            name: '역할',
            dangerous: false,
            managed: false,
            manageable: true,
          },
        ];
      },
      async addRole(id, role) {
        current.get(id).roleIds.push(role);
      },
      async setNickname(id, nickname) {
        current.get(id).nickname = nickname;
      },
    };
    try {
      store = new XpStore(`${directory}/xp.sqlite`);
      for (const id of current.keys()) store.activate(guildId, id, 100, 1);
      economy = new XpEconomy(store, { guildId, discord, clock: () => 100 });
      await economy.execute('xp.adjust', owner, {
        userId: alice,
        amount: 100,
        operation: 'add',
        reason: '지급',
        key: 'persistent',
      });
      const { product } = await economy.execute('products.save', owner, {
        version: 0,
        product: {
          title: '영구역할',
          description: '',
          roleId,
          priceXp: 10,
          enabled: true,
          sortOrder: 0,
        },
      });
      await economy.execute('purchase', alice, {
        productId: product.id,
        version: 1,
        key: 'purchase',
      });
      await economy.close();
      store.close();
      store = new XpStore(`${directory}/xp.sqlite`);
      economy = new XpEconomy(store, { guildId, discord, clock: () => 101 });
      expect((await economy.execute('shop.list', alice)).items[0]).to.include({
        purchased: true,
        roleLocked: true,
      });
      expect(
        (
          await economy.execute('xp.adjust', owner, {
            userId: alice,
            amount: 100,
            operation: 'add',
            reason: '지급',
            key: 'persistent',
          })
        ).profile.xp,
      ).to.equal(100);
      expect(store.profile(guildId, alice).xp).to.equal(90);
      expect(
        store.database.prepare('PRAGMA integrity_check').get().integrity_check,
      ).to.equal('ok');
    } finally {
      await economy?.close();
      store?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
