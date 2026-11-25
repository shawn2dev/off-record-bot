import { expect } from 'chai';
import { beforeEach, afterEach, describe, it } from 'mocha';
import sinon from 'sinon';
import { createHash, randomBytes } from 'node:crypto';
import { XpStore } from '../src/xp-store.js';
import { XpAuth } from '../src/xp-auth.js';
import { readXpApiConfig, startXpApi } from '../src/xp-api.js';
import { XpApiLimits, XpApiGate, xpRequestIp } from '../src/xp-api-limits.js';
import { XP_OWNER_ID } from '../src/xp-settings.js';

const USER = '123456789012345678';
const GUILD = '234567890123456789';
const APP = '345678901234567890';
const owner = { userId: XP_OWNER_ID, roleIds: [] };
const random = () => randomBytes(32).toString('base64url');
const proof = () => {
  const verifier = random();
  return {
    verifier,
    attempt: random(),
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
};
const configForTest = () => ({
  ...readXpApiConfig(
    {
      XP_API_ENABLED: 'true',
      XP_API_ORIGIN: 'https://api.off-record.test',
      XP_DASHBOARD_URL: 'https://dashboard.off-record.test/dashboard',
      XP_OAUTH_CLIENT_SECRET: 'private-test-client-secret',
    },
    { applicationId: APP, guildId: GUILD },
  ),
  port: 0,
});
const normalizedMember = (userId) => ({
  userId,
  roleIds: [],
  bot: false,
  joinedAt: 0,
  displayName: '서버 회원',
  nickname: null,
  manageable: true,
});

async function login(auth, config, values = proof()) {
  const started = await auth.begin({
    returnTo: config.dashboardUrl,
    ...values,
  });
  const providerState = new URL(started.redirect).searchParams.get('state');
  const completed = await auth.callback({
    state: providerState,
    code: 'discord-provider-code',
    cookieHeader: started.cookies[0].split(';')[0],
  });
  const code = new URL(completed.redirect).searchParams.get('offrecord_code');
  const token = auth.exchange({
    code,
    verifier: values.verifier,
    attempt: values.attempt,
  });
  return {
    ...token,
    ...values,
    code,
    started,
    completed,
    cookieHeader: completed.cookies
      .find((cookie) => cookie.startsWith(`${auth.sessionCookie}=`))
      .split(';')[0],
  };
}

describe('Dashboard API configuration and admission limits', () => {
  it('disables the listener by default and rejects unsafe public configuration', () => {
    expect(readXpApiConfig({})).to.equal(null);
    const valid = {
      XP_API_ENABLED: 'true',
      XP_API_ORIGIN: 'https://api.off-record.test',
      XP_OAUTH_CLIENT_ID: APP,
      XP_GUILD_ID: GUILD,
      XP_OAUTH_CLIENT_SECRET: 'private-test-client-secret',
    };
    for (const patch of [
      { XP_API_HOST: '0.0.0.0' },
      { XP_API_HOST: '192.168.1.1' },
      { XP_API_ORIGIN: 'http://remote.test' },
      { XP_API_ORIGIN: 'https://user:password@api.test' },
      { XP_API_ORIGIN: 'https://api.test/path' },
      { XP_API_ORIGIN: 'https://api.test/#bad' },
      { XP_API_PORT: '0' },
      { XP_API_PORT: '65536' },
      { XP_API_ENABLED: 'yes' },
      { XP_OAUTH_CLIENT_SECRET: 'replace-me' },
      { XP_OAUTH_CLIENT_ID: 'not-an-id' },
      { XP_API_ALLOWED_SITE_ORIGINS: 'https://somewhere-else.test' },
    ])
      expect(() => readXpApiConfig({ ...valid, ...patch })).to.throw();
    const local = readXpApiConfig({
      ...valid,
      XP_API_ALLOW_HTTP_LOCAL: 'true',
      XP_API_ORIGIN: 'http://127.0.0.1:8080',
      XP_DASHBOARD_URL: 'http://localhost:3000/dashboard',
    });
    expect(local.secure).to.equal(false);
    expect(configForTest()).to.include({
      accessTtl: 300000,
      sessionTtl: 604800000,
      codeTtl: 60000,
    });
  });

  it('bounds cache memory, resets expired buckets and returns retry timing', () => {
    let timestamp = 0;
    const limits = new XpApiLimits({ clock: () => timestamp, maxKeys: 2 });
    limits.consume('read', 'first', 1);
    expect(() => limits.consume('read', 'first', 1)).to.throw('RATE_LIMITED');
    limits.consume('read', 'second', 1);
    expect(() => limits.consume('read', 'third', 1)).to.throw('SERVER_BUSY');
    expect(limits.entries.size).to.equal(2);
    timestamp = 60000;
    limits.consume('read', 'third', 1);
    expect(limits.entries.size).to.be.at.most(2);
  });

  it('limits concurrent work and waiting requests and cancels abandoned waiters', async () => {
    const gate = new XpApiGate({ concurrent: 1, queued: 1 });
    const release = await gate.enter();
    const controller = new AbortController();
    const waiting = gate.enter(controller.signal).then(
      () => null,
      (error) => error.code,
    );
    expect(
      await gate.enter().then(
        () => null,
        (error) => error.code,
      ),
    ).to.equal('SERVER_BUSY');
    controller.abort();
    expect(await waiting).to.equal('REQUEST_TIMEOUT');
    expect(gate.waiters).to.have.length(0);
    release();
    const releaseAgain = await gate.enter();
    gate.close();
    releaseAgain();
    expect(gate.active).to.equal(0);
    expect(
      await gate.enter().then(
        () => null,
        (error) => error.code,
      ),
    ).to.equal('SERVER_BUSY');
  });

  it('trusts only explicit loopback tunnel forwarding and never arbitrary forwarding headers', () => {
    const config = { ...configForTest(), trustTunnel: true };
    const request = {
      socket: { remoteAddress: '127.0.0.1' },
      headers: {
        host: 'api.off-record.test',
        'cf-connecting-ip': '203.0.113.8',
        'x-forwarded-for': '198.51.100.4',
      },
    };
    expect(xpRequestIp(request, config)).to.equal('203.0.113.8');
    expect(xpRequestIp(request, { ...config, trustTunnel: false })).to.equal(
      '127.0.0.1',
    );
    expect(
      xpRequestIp(
        { ...request, socket: { remoteAddress: '192.0.2.4' } },
        config,
      ),
    ).to.equal('192.0.2.4');
    expect(
      xpRequestIp(
        { ...request, headers: { ...request.headers, host: 'wrong.test' } },
        config,
      ),
    ).to.equal('127.0.0.1');
  });
});

describe('Dashboard OAuth and browser-bound sessions', () => {
  let store;
  let auth;
  let config;
  let timestamp;
  let providerCalls;
  let membership;
  beforeEach(() => {
    store = new XpStore(':memory:');
    config = configForTest();
    timestamp = 1000000000;
    providerCalls = [];
    membership = normalizedMember(USER);
    auth = new XpAuth(store, config, {
      clock: () => timestamp,
      discord: {
        async member() {
          return membership;
        },
      },
      async fetcher(url, options) {
        providerCalls.push({ url, options });
        return Response.json(
          url.endsWith('/token')
            ? { access_token: 'private-discord-access-token' }
            : { id: USER, username: '한국어 이름', avatar: null },
        );
      },
    });
  });
  afterEach(() => store.close());

  it('uses identify only, verifies state and cookie, and consumes the OAuth callback once', async () => {
    const values = proof();
    const started = await auth.begin({
      returnTo: config.dashboardUrl,
      ...values,
    });
    const url = new URL(started.redirect);
    expect(url.searchParams.get('scope')).to.equal('identify');
    expect(url.searchParams.has('client_secret')).to.equal(false);
    expect(started.cookies[0])
      .to.include('HttpOnly; SameSite=Lax')
      .and.include('; Secure');
    expect(started.cookies[0]).not.to.include('Domain=');
    const state = url.searchParams.get('state');
    try {
      await auth.callback({ state, code: 'code', cookieHeader: '' });
      expect.fail();
    } catch (error) {
      expect(error.code).to.equal('INVALID_LOGIN');
    }
    await auth.callback({
      state,
      code: 'code',
      cookieHeader: started.cookies[0].split(';')[0],
    });
    try {
      await auth.callback({
        state,
        code: 'code',
        cookieHeader: started.cookies[0].split(';')[0],
      });
      expect.fail();
    } catch (error) {
      expect(error.code).to.equal('INVALID_LOGIN');
    }
    expect(providerCalls).to.have.length(2);
  });

  it('exchanges one-use codes only with the original PKCE and browser binding', async () => {
    const values = await login(auth, config);
    expect(auth.authenticate(`Bearer ${values.accessToken}`).user.id).to.equal(
      USER,
    );
    expect(() =>
      auth.exchange({
        code: values.code,
        verifier: values.verifier,
        attempt: values.attempt,
      }),
    ).to.throw('INVALID_CODE');
    const next = proof();
    const restore = await auth.begin({
      returnTo: config.dashboardUrl,
      ...next,
      restore: true,
      cookieHeader: values.cookieHeader,
    });
    const code = new URL(restore.redirect).searchParams.get('offrecord_code');
    expect(() =>
      auth.exchange({ code, verifier: random(), attempt: next.attempt }),
    ).to.throw('INVALID_CODE');
    expect(() =>
      auth.exchange({ code, verifier: next.verifier, attempt: random() }),
    ).to.throw('INVALID_CODE');
    expect(
      auth.exchange({ code, verifier: next.verifier, attempt: next.attempt })
        .expiresIn,
    ).to.equal(300);
  });

  it('never stores provider tokens, raw session cookies or raw bearer tokens', async () => {
    const values = await login(auth, config);
    const persisted = [
      'xp_auth_sessions',
      'xp_auth_codes',
      'xp_auth_tokens',
      'xp_auth_states',
    ]
      .map((table) =>
        JSON.stringify(store.database.prepare(`SELECT * FROM ${table}`).all()),
      )
      .join('');
    expect(persisted).not.to.include('private-discord-access-token');
    expect(persisted).not.to.include(config.clientSecret);
    expect(persisted).not.to.include(values.accessToken);
    expect(persisted).not.to.include(values.cookieHeader.split('=')[1]);
    expect(() => auth.authenticate(values.cookieHeader)).to.throw(
      'AUTH_REQUIRED',
    );
  });

  it('refuses newer authentication schemas instead of guessing at their layout', () => {
    store.database.exec('UPDATE xp_auth_schema SET version = 99');
    expect(() => new XpAuth(store, config)).to.throw('newer');
  });

  it('does not accept an existing session for a different configured guild', async () => {
    const values = await login(auth, config);
    const second = new XpAuth(
      store,
      { ...config, guildId: '456789012345678901' },
      {
        discord: {
          async member(id) {
            return normalizedMember(id);
          },
        },
        clock: () => timestamp,
      },
    );
    expect(() => second.authenticate(`Bearer ${values.accessToken}`)).to.throw(
      'AUTH_EXPIRED',
    );
    const restored = await second.begin({
      returnTo: config.dashboardUrl,
      ...proof(),
      cookieHeader: values.cookieHeader,
      restore: true,
    });
    expect(
      new URL(restored.redirect).searchParams.get('offrecord_error'),
    ).to.equal('session_expired');
  });

  it('restores expired access tokens using a top-level host session without calling Discord OAuth again', async () => {
    const values = await login(auth, config);
    timestamp += config.accessTtl;
    expect(() => auth.authenticate(`Bearer ${values.accessToken}`)).to.throw(
      'AUTH_EXPIRED',
    );
    const next = proof();
    const restored = await auth.begin({
      returnTo: config.dashboardUrl,
      ...next,
      cookieHeader: values.cookieHeader,
      restore: true,
    });
    const code = new URL(restored.redirect).searchParams.get('offrecord_code');
    const result = auth.exchange({
      code,
      verifier: next.verifier,
      attempt: next.attempt,
    });
    expect(auth.authenticate(`Bearer ${result.accessToken}`).user.id).to.equal(
      USER,
    );
    expect(providerCalls).to.have.length(2);
    timestamp += config.sessionTtl;
    const expired = await auth.begin({
      returnTo: config.dashboardUrl,
      ...proof(),
      cookieHeader: values.cookieHeader,
      restore: true,
    });
    expect(
      new URL(expired.redirect).searchParams.get('offrecord_error'),
    ).to.equal('session_expired');
  });

  it('does not revalidate revoked bearer tokens or old codes when a policy-change session is restored', async () => {
    const values = await login(auth, config);
    const oldProof = proof();
    const old = await auth.begin({
      returnTo: config.dashboardUrl,
      ...oldProof,
      cookieHeader: values.cookieHeader,
      restore: true,
    });
    const oldCode = new URL(old.redirect).searchParams.get('offrecord_code');
    store.updateSettings(
      GUILD,
      'access',
      { adminRoles: {} },
      0,
      owner,
      timestamp,
    );
    expect(() => auth.authenticate(`Bearer ${values.accessToken}`)).to.throw(
      'AUTH_EXPIRED',
    );
    const freshProof = proof();
    const fresh = await auth.begin({
      returnTo: config.dashboardUrl,
      ...freshProof,
      cookieHeader: values.cookieHeader,
      restore: true,
    });
    const code = new URL(fresh.redirect).searchParams.get('offrecord_code');
    const result = auth.exchange({
      code,
      verifier: freshProof.verifier,
      attempt: freshProof.attempt,
    });
    expect(auth.authenticate(`Bearer ${result.accessToken}`).user.id).to.equal(
      USER,
    );
    expect(() => auth.authenticate(`Bearer ${values.accessToken}`)).to.throw(
      'AUTH_EXPIRED',
    );
    expect(() =>
      auth.exchange({
        code: oldCode,
        verifier: oldProof.verifier,
        attempt: oldProof.attempt,
      }),
    ).to.throw('INVALID_CODE');
  });

  it('revokes the server session, all bearer tokens and pending codes on logout', async () => {
    const values = await login(auth, config);
    const next = proof();
    const restored = await auth.begin({
      returnTo: config.dashboardUrl,
      ...next,
      cookieHeader: values.cookieHeader,
      restore: true,
    });
    const session = auth.authenticate(`Bearer ${values.accessToken}`);
    expect(auth.logout(session.sessionHash)).to.include('Max-Age=0');
    expect(() => auth.authenticate(`Bearer ${values.accessToken}`)).to.throw(
      'AUTH_EXPIRED',
    );
    expect(() =>
      auth.exchange({
        code: new URL(restored.redirect).searchParams.get('offrecord_code'),
        verifier: next.verifier,
        attempt: next.attempt,
      }),
    ).to.throw('INVALID_CODE');
  });

  it('rejects unknown return URLs, invalid body types, expired codes and absent members', async () => {
    try {
      await auth.begin({ returnTo: 'https://evil.test', ...proof() });
      expect.fail();
    } catch (error) {
      expect(error.code).to.equal('INVALID_LOGIN');
    }
    for (const invalid of [null, [], {}, 123, ['a'.repeat(43)]]) {
      expect(() =>
        auth.exchange({ code: invalid, verifier: random(), attempt: random() }),
      ).to.throw('INVALID_CODE');
    }
    const values = await login(auth, config);
    membership = null;
    try {
      await auth.begin({
        returnTo: config.dashboardUrl,
        ...proof(),
        cookieHeader: values.cookieHeader,
      });
      expect.fail();
    } catch (error) {
      expect(error.code).to.equal('NOT_MEMBER');
    }
    membership = normalizedMember(USER);
    const next = proof();
    const restored = await auth.begin({
      returnTo: config.dashboardUrl,
      ...next,
      cookieHeader: values.cookieHeader,
    });
    timestamp += config.codeTtl;
    expect(() =>
      auth.exchange({
        code: new URL(restored.redirect).searchParams.get('offrecord_code'),
        verifier: next.verifier,
        attempt: next.attempt,
      }),
    ).to.throw('INVALID_CODE');
  });

  it('returns an explicit cancelled-login result instead of redirecting in a loop', async () => {
    const started = await auth.begin({
      returnTo: config.dashboardUrl,
      ...proof(),
    });
    const result = await auth.callback({
      state: new URL(started.redirect).searchParams.get('state'),
      error: 'access_denied',
      cookieHeader: started.cookies[0].split(';')[0],
    });
    expect(
      new URL(result.redirect).searchParams.get('offrecord_error'),
    ).to.equal('login_cancelled');
    expect(providerCalls).to.have.length(0);
  });

  it('cleans authentication data in bounded batches without deleting financial history', async () => {
    store.activate(GUILD, USER, timestamp);
    store.attendance(GUILD, USER, timestamp);
    store.transaction(() => {
      const statement = store.database.prepare(`
        INSERT INTO xp_auth_states VALUES (?, 'marker', 'challenge', 'attempt', 'return', 0)
      `);
      for (let index = 0; index < 450; index += 1) statement.run(String(index));
    });
    auth.cleanup();
    expect(
      store.database.prepare('SELECT COUNT(*) AS n FROM xp_auth_states').get()
        .n,
    ).to.equal(250);
    expect(
      store.database.prepare('SELECT COUNT(*) AS n FROM xp_ledger').get().n,
    ).to.be.greaterThan(0);
  });
});

describe('Authenticated HTTP API', () => {
  let store;
  let running;
  let config;
  let base;
  let token;
  let cookie;
  let identity;
  let calls;
  let membership;
  let available;
  beforeEach(async () => {
    store = new XpStore(':memory:');
    config = configForTest();
    identity = USER;
    available = true;
    membership = normalizedMember(USER);
    calls = [];
    store.activate(GUILD, USER, Date.now());
    store.activate(GUILD, XP_OWNER_ID, Date.now());
    running = await startXpApi({
      store,
      config,
      isAvailable: () => available,
      discord: {
        async member(id) {
          return membership ? { ...membership, userId: id } : null;
        },
        async roles() {
          return [];
        },
      },
      economy: {
        async execute(action, userId, input) {
          calls.push({ action, userId, input });
          if (action === 'settings.update') {
            return store.updateSettings(
              GUILD,
              input.section,
              input.patch,
              input.version,
              { userId, roleIds: membership.roleIds },
              Date.now(),
            );
          }
          return { action, input };
        },
      },
      async fetcher(url) {
        return Response.json(
          url.endsWith('/token')
            ? { access_token: 'provider-token' }
            : { id: identity, username: '서버 회원' },
        );
      },
    });
    base = `http://127.0.0.1:${running.address.port}`;
    const values = await login(running.api.auth, config);
    token = values.accessToken;
    cookie = values.cookieHeader;
  });
  afterEach(async () => {
    await running.close();
    store.close();
  });
  const request = (base, config, token, path, options = {}) =>
    fetch(`${base}${path}`, {
      ...options,
      headers: {
        Origin: new URL(config.dashboardUrl).origin,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      redirect: 'manual',
    });

  it('serves private no-store JSON and checks membership independently of CORS and cookies', async () => {
    const result = await request(base, config, token, '/api/me');
    expect(result.status).to.equal(200);
    expect(result.headers.get('cache-control')).to.include('no-store');
    expect(result.headers.get('referrer-policy')).to.equal('no-referrer');
    expect(result.headers.get('content-security-policy')).to.include(
      "frame-ancestors 'none'",
    );
    expect((await result.json()).permissions).to.deep.equal([]);
    const cookieOnly = await request(base, config, null, '/api/me', {
      headers: { Cookie: cookie },
    });
    expect(cookieOnly.status).to.equal(401);
    membership = null;
    expect((await request(base, config, token, '/api/me')).status).to.equal(
      403,
    );
  });

  it('completes the actual HTTP redirect and code exchange without third-party cookies', async () => {
    const values = proof();
    const query = new URLSearchParams({
      return_to: config.dashboardUrl,
      challenge: values.challenge,
      attempt: values.attempt,
    });
    const started = await fetch(`${base}/auth/start?${query}`, {
      redirect: 'manual',
    });
    expect(started.status).to.equal(303);
    const authorize = new URL(started.headers.get('location'));
    expect(authorize.origin).to.equal('https://discord.com');
    const marker = started.headers.getSetCookie()[0].split(';')[0];
    const callback = await fetch(
      `${base}/auth/callback?${new URLSearchParams({
        state: authorize.searchParams.get('state'),
        code: 'discord-provider-code',
      })}`,
      { headers: { Cookie: marker }, redirect: 'manual' },
    );
    expect(callback.status).to.equal(303);
    const landed = new URL(callback.headers.get('location'));
    expect(`${landed.origin}${landed.pathname}`).to.equal(config.dashboardUrl);
    const code = landed.searchParams.get('offrecord_code');
    const body = JSON.stringify({
      code,
      verifier: values.verifier,
      attempt: values.attempt,
    });
    const noOrigin = await fetch(`${base}/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(noOrigin.status).to.equal(403);
    const exchanged = await request(base, config, null, '/auth/exchange', {
      method: 'POST',
      body,
    });
    expect(exchanged.status).to.equal(200);
    const bearer = (await exchanged.json()).accessToken;
    expect((await request(base, config, bearer, '/api/me')).status).to.equal(
      200,
    );
    expect(
      (
        await request(base, config, null, '/auth/exchange', {
          method: 'POST',
          body,
        })
      ).status,
    ).to.equal(400);
  });

  it('rejects oversized headers before membership or domain execution', async () => {
    const result = await request(base, config, token, '/api/me', {
      headers: { 'X-Oversized': 'x'.repeat(9000) },
    });
    expect(result.status).to.equal(431);
    expect(calls).to.have.length(0);
  });

  it('permits only explicit origins and authorization preflight without credential cookies', async () => {
    const rejected = await request(base, config, token, '/api/me', {
      headers: { Origin: 'https://untrusted.test' },
    });
    expect(rejected.status).to.equal(403);
    expect(rejected.headers.get('access-control-allow-origin')).to.equal(null);
    const preflight = await request(base, config, null, '/api/me', {
      method: 'OPTIONS',
      headers: {
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    expect(preflight.status).to.equal(204);
    expect(preflight.headers.get('access-control-allow-credentials')).to.equal(
      null,
    );
    expect(preflight.headers.get('access-control-allow-headers')).to.include(
      'Authorization',
    );
    const denied = await request(base, config, null, '/api/me', {
      method: 'OPTIONS',
      headers: {
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-arbitrary-header',
      },
    });
    expect(denied.status).to.equal(403);
  });

  it('enforces JSON body limits and explicit errors before executing mutations', async () => {
    for (const [body, headers, expected] of [
      ['{"key":"unfinished"', {}, 400],
      [JSON.stringify({ unexpected: 'x'.repeat(32768) }), {}, 413],
      ['{}', { 'Content-Type': 'text/plain' }, 415],
      ['{}', { 'Content-Encoding': 'gzip' }, 415],
    ]) {
      const result = await request(base, config, token, '/auth/logout', {
        method: 'POST',
        body,
        headers,
      });
      expect(result.status).to.equal(expected);
      const response = await result.json();
      expect(response.error.message).to.match(/[가-힣]/);
      expect(JSON.stringify(response)).not.to.match(
        /sqlite|stack|secret|provider-token/i,
      );
    }
    expect(calls).to.have.length(0);
  });

  it('guards administrator actions and ignores forged actor fields', async () => {
    for (const path of [
      '/api/shop?manage=true',
      '/api/orders?manage=true',
      '/api/audit',
      '/api/jobs',
    ]) {
      expect((await request(base, config, token, path)).status).to.equal(403);
    }
    expect(
      (
        await request(base, config, token, '/api/xp/adjust', {
          method: 'POST',
          body: JSON.stringify({
            userId: XP_OWNER_ID,
            amount: 10,
            operation: 'add',
            reason: '시험',
            key: random(),
          }),
        })
      ).status,
    ).to.equal(403);
    expect(
      (
        await request(base, config, token, '/api/gifts', {
          method: 'POST',
          body: JSON.stringify({
            userId: XP_OWNER_ID,
            amount: 10,
            key: random(),
            actorId: XP_OWNER_ID,
          }),
        })
      ).status,
    ).to.equal(400);
    expect(calls).to.have.length(0);
  });

  it('routes each user financial request with the authenticated identity and original key', async () => {
    const key = random();
    const result = await request(base, config, token, '/api/gifts', {
      method: 'POST',
      body: JSON.stringify({ userId: XP_OWNER_ID, amount: 101, key }),
    });
    expect(result.status).to.equal(200);
    expect(calls[0]).to.deep.equal({
      action: 'gift.send',
      userId: USER,
      input: { userId: XP_OWNER_ID, amount: 101, key },
    });
    expect(
      (
        await request(base, config, token, '/api/games/dice', {
          method: 'POST',
          body: JSON.stringify({ amount: 10, choice: 1, key: random() }),
        })
      ).status,
    ).to.equal(200);
    expect(calls[1].input.game).to.equal('dice');
  });

  it('bounds ledger pages and prevents user-id or sorting injection', async () => {
    store.attendance(GUILD, USER, Date.now());
    store.message(GUILD, USER, 'one', Date.now());
    const result = await request(base, config, token, '/api/ledger?limit=1');
    const data = await result.json();
    expect(data.items).to.have.length(1);
    expect(data.nextCursor).to.be.a('number');
    expect(
      (await request(base, config, token, '/api/ledger?limit=51')).status,
    ).to.equal(400);
    expect(
      (await request(base, config, token, `/api/ledger?userId=${XP_OWNER_ID}`))
        .status,
    ).to.equal(400);
    expect(
      (await request(base, config, token, '/api/rankings?kind=xp%3BDROP'))
        .status,
    ).to.equal(400);
  });

  it('invalidates old access after owner changes permission policy and supports clean logout', async () => {
    identity = XP_OWNER_ID;
    const values = await login(running.api.auth, config);
    const changed = await request(
      base,
      config,
      values.accessToken,
      '/api/settings/access',
      {
        method: 'PUT',
        body: JSON.stringify({ version: 0, patch: { adminRoles: {} } }),
      },
    );
    expect(changed.status).to.equal(200);
    expect((await request(base, config, token, '/api/me')).status).to.equal(
      401,
    );
    const fresh = await login(running.api.auth, config);
    expect(
      (
        await request(base, config, fresh.accessToken, '/auth/logout', {
          method: 'POST',
          body: '{}',
        })
      ).status,
    ).to.equal(200);
    expect(
      (await request(base, config, fresh.accessToken, '/api/me')).status,
    ).to.equal(401);
  });

  it('keeps health available but rejects new economic work while tracking is suspended', async () => {
    available = false;
    const logging = sinon.stub(console, 'error');
    try {
      expect((await request(base, config, null, '/health')).status).to.equal(
        200,
      );
      const result = await request(base, config, token, '/api/me');
      expect(result.status).to.equal(503);
      expect(result.headers.get('retry-after')).to.equal('5');
      expect(calls).to.have.length(0);
    } finally {
      logging.restore();
    }
  });

  it('limits individual authenticated reads to sixty per minute', async () => {
    for (let index = 0; index < 60; index += 1) {
      expect((await request(base, config, token, '/api/me')).status).to.equal(
        200,
      );
    }
    const limited = await request(base, config, token, '/api/me');
    expect(limited.status).to.equal(429);
    expect(Number(limited.headers.get('retry-after'))).to.be.within(1, 60);
  });

  it('enforces eight active and thirty-two waiting requests under a burst', async () => {
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    let entered = 0;
    running.api.discord.member = async (id) => {
      entered += 1;
      await blocked;
      return normalizedMember(id);
    };
    const logging = sinon.stub(console, 'error');
    try {
      const responses = Array.from({ length: 48 }, () =>
        request(base, config, token, '/api/me'),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(entered).to.equal(8);
      expect(running.api.gate.active).to.equal(8);
      expect(running.api.gate.waiters).to.have.length(32);
      release();
      const settled = await Promise.all(responses);
      expect(
        settled.filter((response) => response.status === 200),
      ).to.have.length(40);
      expect(
        settled.filter((response) => response.status === 503),
      ).to.have.length(8);
      expect(running.api.gate.waiters).to.have.length(0);
    } finally {
      release();
      logging.restore();
    }
  });
});
