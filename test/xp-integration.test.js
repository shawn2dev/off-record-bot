import { expect } from 'chai';
import { beforeEach, afterEach, describe, it } from 'mocha';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { XpStore } from '../src/xp-store.js';
import { XpEconomy } from '../src/xp-economy.js';
import { startXpApi, readXpApiConfig } from '../src/xp-api.js';
import { verifyXpLedger } from '../src/xp-api-maintenance.js';
import { XP_OWNER_ID } from '../src/xp-settings.js';

const USER = '123456789012345678';
const OTHER = '234567890123456789';
const GUILD = '345678901234567890';
const PRODUCT_ROLE = '456789012345678901';
const ADMIN_ROLE = '567890123456789012';
const member = (userId) => ({
  userId,
  roleIds: [],
  bot: false,
  joinedAt: 1,
  displayName: '서버 회원',
  nickname: null,
  manageable: true,
});

describe('Dashboard and bot shared-service integration', () => {
  let store,
    economy,
    api,
    base,
    config,
    members,
    tokens,
    now,
    identity,
    roleCalls;
  beforeEach(async () => {
    now = Date.parse('2026-11-25T10:00:00Z');
    store = new XpStore(':memory:');
    members = new Map([XP_OWNER_ID, USER, OTHER].map((id) => [id, member(id)]));
    for (const id of members.keys()) store.activate(GUILD, id, now, 1);
    roleCalls = 0;
    const discord = {
      async member(id) {
        return members.has(id) ? structuredClone(members.get(id)) : null;
      },
      async members(roleId) {
        return [...members.values()]
          .filter((entry) => !roleId || entry.roleIds.includes(roleId))
          .map((entry) => structuredClone(entry));
      },
      async roles() {
        return [PRODUCT_ROLE, ADMIN_ROLE].map((id) => ({
          id,
          name: '서버 역할',
          position: 1,
          managed: false,
          dangerous: false,
          manageable: true,
        }));
      },
      async addRole(id, roleId) {
        roleCalls += 1;
        if (!members.get(id).roleIds.includes(roleId))
          members.get(id).roleIds.push(roleId);
      },
      async setNickname(id, name) {
        members.get(id).nickname = name;
      },
    };
    config = {
      ...readXpApiConfig(
        {
          XP_API_ENABLED: 'true',
          XP_API_ORIGIN: 'https://api.off-record.test',
          XP_DASHBOARD_URL: 'https://dashboard.off-record.test/dashboard',
          XP_OAUTH_CLIENT_SECRET: 'private-test-client-secret',
        },
        { guildId: GUILD, applicationId: '678901234567890123' },
      ),
      port: 0,
    };
    economy = new XpEconomy(store, {
      guildId: GUILD,
      discord,
      clock: () => now,
      rng: () => 0,
    });
    api = await startXpApi({
      store,
      economy,
      discord,
      config,
      clock: () => now,
      async fetcher(url) {
        return Response.json(
          url.endsWith('/token')
            ? { access_token: 'provider-test-token' }
            : { id: identity, username: '서버 회원' },
        );
      },
    });
    base = `http://127.0.0.1:${api.address.port}`;
    tokens = new Map();
    for (const id of members.keys()) await issue(id);
  });
  afterEach(async () => {
    await api.close();
    await economy.close();
    store.close();
  });

  async function issue(userId) {
    identity = userId;
    const verifier = randomBytes(32).toString('base64url');
    const attempt = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const started = await api.api.auth.begin({
      returnTo: config.dashboardUrl,
      challenge,
      attempt,
    });
    const completed = await api.api.auth.callback({
      state: new URL(started.redirect).searchParams.get('state'),
      code: 'discord-test-code',
      cookieHeader: started.cookies[0].split(';')[0],
    });
    const code = new URL(completed.redirect).searchParams.get('offrecord_code');
    tokens.set(
      userId,
      api.api.auth.exchange({ code, verifier, attempt }).accessToken,
    );
  }

  async function call(
    userId,
    path,
    body,
    expected = 200,
    method = body ? 'POST' : 'GET',
  ) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: new URL(config.dashboardUrl).origin,
        Authorization: `Bearer ${tokens.get(userId)}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).to.equal(expected);
    return result;
  }

  it('paginates complete role selections without exceeding the 50-item response limit', async () => {
    const roles = Array.from({ length: 75 }, (_, index) => ({
      id: String(600000000000000000n + BigInt(index)),
      name: '서버 역할',
    }));
    api.api.discord.roles = async () => roles.toReversed();
    const first = await call(XP_OWNER_ID, '/api/roles');
    expect(first.items).to.have.length(50);
    expect(first.nextCursor).to.equal(roles[49].id);
    const second = await call(
      XP_OWNER_ID,
      `/api/roles?after=${first.nextCursor}`,
    );
    expect(second.items).to.have.length(25);
    expect(second.items[0].id).to.equal(roles[50].id);
    expect(second.nextCursor).to.equal(null);
    await call(USER, '/api/roles', undefined, 403);
    await call(XP_OWNER_ID, '/api/roles?after=invalid', undefined, 400);
  });

  it('runs gifts, versioned role purchases, four games, raffles and nickname jobs against one ledger', async () => {
    await call(XP_OWNER_ID, '/api/xp/adjust', {
      userId: USER,
      amount: 1000,
      operation: 'add',
      reason: '초기 지급',
      key: randomUUID(),
    });
    const gift = await call(USER, '/api/gifts', {
      userId: OTHER,
      amount: 101,
      key: randomUUID(),
    });
    expect(gift).to.include({ feeXp: 15, receivedXp: 86 });
    expect((await call(OTHER, '/api/me')).profile.xp).to.equal(86);

    const product = {
      title: '역할 상품',
      description: '영구 역할 설명',
      roleId: PRODUCT_ROLE,
      priceXp: 100,
      enabled: true,
      sortOrder: 0,
    };
    const created = (
      await call(XP_OWNER_ID, '/api/products', {
        version: 0,
        product,
        key: randomUUID(),
      })
    ).product;
    const updated = (
      await call(
        XP_OWNER_ID,
        `/api/products/${created.id}`,
        {
          version: created.version,
          product: { ...product, title: '새 상품 이름' },
          key: randomUUID(),
        },
        200,
        'PUT',
      )
    ).product;
    await call(
      USER,
      '/api/purchases',
      {
        productId: created.id,
        version: created.version,
        key: randomUUID(),
      },
      409,
    );
    expect(store.member(GUILD, USER).xp_milli).to.equal(899000);
    const purchase = {
      productId: updated.id,
      version: updated.version,
      key: randomUUID(),
    };
    const bought = await call(USER, '/api/purchases', purchase);
    expect(bought.order.state).to.equal('completed');
    expect(bought.profile.xp).to.equal(799);
    expect((await call(USER, '/api/purchases', purchase)).order.id).to.equal(
      bought.order.id,
    );
    expect(roleCalls).to.equal(1);
    const shop = await call(USER, '/api/shop');
    expect(shop.items[0]).to.include({
      purchased: true,
      owned: true,
      roleLocked: true,
    });
    await call(
      XP_OWNER_ID,
      `/api/products/${created.id}`,
      {
        version: updated.version,
        product: { ...product, roleId: ADMIN_ROLE },
        key: randomUUID(),
      },
      409,
      'PUT',
    );

    for (const [game, choice] of [
      ['slots', undefined],
      ['wheel', undefined],
      ['oddEven', 'odd'],
      ['dice', '1'],
    ]) {
      const request = {
        amount: 10,
        ...(choice ? { choice } : {}),
        key: randomUUID(),
      };
      const result = await call(USER, `/api/games/${game}`, request);
      expect(result.rtp).to.equal(94);
    }
    expect(store.member(GUILD, USER).xp_milli).to.equal(834200);
    const preview = await call(XP_OWNER_ID, '/api/raffles/preview', {
      winners: 2,
      amount: 100,
    });
    const raffle = await call(XP_OWNER_ID, '/api/raffles', {
      previewId: preview.previewId,
      key: randomUUID(),
    });
    expect(
      new Set(raffle.winners.map((winner) => winner.userId)).size,
    ).to.equal(2);
    expect(raffle.totalXp).to.equal(200);
    for (let index = 0; index < 6; index += 1) await economy.tick();
    expect(members.get(USER).nickname).to.equal('[lv.5] 서버 회원');
    const nickname = await call(XP_OWNER_ID, '/api/settings/nickname');
    await call(
      XP_OWNER_ID,
      '/api/settings/nickname',
      {
        version: nickname.version,
        patch: { enabled: false },
      },
      200,
      'PUT',
    );
    const scheduled = await call(XP_OWNER_ID, '/api/jobs/sync', {});
    expect(scheduled).to.deep.equal({
      queued: 3,
      nextCursor: null,
      scheduled: false,
    });
    for (let index = 0; index < 8; index += 1) await economy.tick();
    expect(members.get(USER).nickname).to.equal(null);
    expect(verifyXpLedger(store.database).valid).to.equal(true);
  });

  it('does not silently exclude eligible raffle members after an unexpected persistence failure', async () => {
    const original = economy.assertGeneration.bind(economy);
    economy.assertGeneration = (entry, expected) => {
      if (entry.userId === OTHER) throw new Error('persistence unavailable');
      return original(entry, expected);
    };
    const result = await call(
      XP_OWNER_ID,
      '/api/raffles/preview',
      { winners: 1, amount: 10 },
      500,
    );
    expect(result.error.code).to.equal('INTERNAL_ERROR');
    expect(
      store.database.prepare('SELECT COUNT(*) AS n FROM xp_raffles').get().n,
    ).to.equal(0);
    expect(verifyXpLedger(store.database).valid).to.equal(true);
  });

  it('enforces delegated page permissions, validates role conflicts and observes live role revocation', async () => {
    const changed = await call(
      XP_OWNER_ID,
      '/api/settings/access',
      {
        version: 0,
        patch: {
          adminRoles: { [ADMIN_ROLE]: ['attendance.manage', 'orders.manage'] },
        },
      },
      200,
      'PUT',
    );
    expect(changed.version).to.equal(1);
    members.get(USER).roleIds.push(ADMIN_ROLE);
    await issue(USER);
    await issue(XP_OWNER_ID);
    const current = await call(USER, '/api/me');
    expect(current.permissions)
      .to.include('orders.manage')
      .and.not.include('shop.manage');
    await call(USER, '/api/orders?manage=true');
    await call(USER, '/api/shop?manage=true', null, 403);
    await call(
      USER,
      '/api/settings/attendance',
      { version: 0, patch: { rewardXp: 750 } },
      200,
      'PUT',
    );
    await call(
      USER,
      '/api/xp/adjust',
      {
        userId: OTHER,
        amount: 100,
        operation: 'add',
        reason: '금지된 지급',
        key: randomUUID(),
      },
      403,
    );
    const unsafe = await call(
      XP_OWNER_ID,
      '/api/products',
      {
        version: 0,
        key: randomUUID(),
        product: {
          title: '관리자 역할',
          description: '판매 금지',
          roleId: ADMIN_ROLE,
          priceXp: 100,
          enabled: true,
          sortOrder: 0,
        },
      },
      400,
    );
    expect(unsafe.error.code).to.equal('UNSAFE_ROLE');
    members.get(USER).roleIds = [];
    await call(USER, '/api/settings/attendance', null, 403);
    await call(USER, '/api/orders?manage=true', null, 403);
    const audit = await call(XP_OWNER_ID, '/api/audit?limit=1');
    expect(audit.items).to.have.length(1);
    expect(audit.items[0].details).to.be.an('object');
  });
});
