import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { XpAuth } from './xp-auth.js';
import { XpApiError, xpApiError } from './xp-api-errors.js';
import { XpApiGate, XpApiLimits, xpRequestIp } from './xp-api-limits.js';
import {
  canManageXpSettings,
  XP_OWNER_ID,
  XP_PERMISSIONS,
} from './xp-settings.js';
import { readXpApiConfig } from './xp-api-config.js';

export { readXpApiConfig };

const BODY_LIMIT = 32768;
const settingsSections = [
  'attendance',
  'lifecycle',
  'access',
  'gift',
  'nickname',
  'games',
  'raffle',
  'shop',
];
const mutatingMethods = ['POST', 'PUT', 'DELETE'];
const snowflake = (value) =>
  typeof value === 'string' && /^\d{17,20}$/.test(value);

function assertBody(body, allowed, required = []) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(body, key))
  )
    throw new XpApiError('INVALID_REQUEST');
}

function requireKey(body) {
  if (
    typeof body.key !== 'string' ||
    !/^[A-Za-z0-9:_-]{1,120}$/.test(body.key)
  ) {
    throw new XpApiError('INVALID_REQUEST');
  }
}

function assertQuery(url, allowed) {
  const seen = new Set();
  for (const [key] of url.searchParams) {
    if (!allowed.includes(key) || seen.has(key))
      throw new XpApiError('INVALID_REQUEST');
    seen.add(key);
  }
}

function cursor(url) {
  const raw = url.searchParams.get('before');
  if (raw === null) return null;
  if (!/^[1-9]\d{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new XpApiError('INVALID_REQUEST');
  }
  return Number(raw);
}

function pageSize(url) {
  const raw = url.searchParams.get('limit');
  if (raw === null) return 50;
  if (!/^\d{1,2}$/.test(raw) || Number(raw) < 1 || Number(raw) > 50) {
    throw new XpApiError('INVALID_REQUEST');
  }
  return Number(raw);
}

function manageFlag(url) {
  const raw = url.searchParams.get('manage');
  if (raw !== null && raw !== 'true' && raw !== 'false')
    throw new XpApiError('INVALID_REQUEST');
  return raw === 'true';
}

function readJson(request) {
  if (
    typeof request.headers['content-type'] !== 'string' ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      request.headers['content-type'],
    ) ||
    (request.headers['content-encoding'] &&
      request.headers['content-encoding'] !== 'identity')
  )
    throw new XpApiError('UNSUPPORTED_MEDIA', 415);
  const declared = request.headers['content-length'];
  if (
    declared !== undefined &&
    (!/^\d+$/.test(declared) || Number(declared) > BODY_LIMIT)
  ) {
    throw new XpApiError('BODY_TOO_LARGE', 413);
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      if (error) {
        request.pause();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) finish(new XpApiError('BODY_TOO_LARGE', 413));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        finish(new XpApiError('INVALID_REQUEST'));
        return;
      }
      finish(null, value);
    };
    const onError = () => finish(new XpApiError('INVALID_REQUEST'));
    const onClose = () => {
      if (!settled) onError();
      request.removeListener('error', onError);
      request.removeListener('aborted', onError);
    };
    const timer = setTimeout(
      () => finish(new XpApiError('REQUEST_TIMEOUT', 408)),
      8000,
    );
    timer.unref();
    request.on('data', onData);
    request.once('end', onEnd);
    request.on('error', onError);
    request.once('aborted', onError);
    request.once('close', onClose);
  });
}

function permissionsFor(userId, roleIds, access) {
  if (userId === XP_OWNER_ID) return [...XP_PERMISSIONS];
  return XP_PERMISSIONS.filter(
    (permission) =>
      permission !== 'access.manage' &&
      roleIds.some(
        (id) =>
          Object.hasOwn(access.adminRoles, id) &&
          access.adminRoles[id].includes(permission),
      ),
  );
}

export class XpApi {
  constructor({
    store,
    economy,
    discord,
    config,
    isAvailable = () => true,
    clock = Date.now,
    fetcher = fetch,
    limits,
    gate,
  }) {
    this.store = store;
    this.economy = economy;
    this.discord = discord;
    this.config = config;
    this.isAvailable = isAvailable;
    this.clock = clock;
    this.auth = new XpAuth(store, config, { discord, clock, fetcher });
    this.limits = limits ?? new XpApiLimits({ clock });
    this.gate = gate ?? new XpApiGate();
    this.bulkGate = new XpApiGate({ concurrent: 1, queued: 0 });
    this.inFlight = new Set();
    this.closed = false;
  }

  available() {
    if (this.closed || !this.isAvailable())
      throw new XpApiError('TRACKING_UNAVAILABLE', 503, 5);
  }

  secureHeaders(response) {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Vary', 'Origin');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    response.setHeader('X-Frame-Options', 'DENY');
    if (this.config.secure)
      response.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }

  send(response, status, body) {
    if (response.destroyed || response.writableEnded) return;
    const encoded = JSON.stringify(body);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(encoded),
    });
    response.end(encoded);
  }

  redirect(response, location, cookies = []) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(303, {
      Location: location,
      'Content-Length': '0',
      ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
    });
    response.end();
  }

  checkOrigin(request, response, required) {
    const origin = request.headers.origin;
    if (origin && !this.config.allowedOrigins.includes(origin))
      throw new XpApiError('FORBIDDEN', 403);
    if (required && !origin) throw new XpApiError('FORBIDDEN', 403);
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Expose-Headers', 'Retry-After');
    }
  }

  run(request, response) {
    const task = this.handle(request, response);
    this.inFlight.add(task);
    const finish = () => this.inFlight.delete(task);
    void task.then(finish, finish);
    return task;
  }

  async handle(request, response) {
    const requestId = randomUUID();
    this.secureHeaders(response);
    response.setHeader('X-Request-Id', requestId);
    let release;
    let releaseBulk;
    let url;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    const onClose = () => {
      if (!response.writableFinished) onAbort();
    };
    request.once('aborted', onAbort);
    response.once('close', onClose);
    const responseDone = new Promise((resolve) => {
      const done = () => {
        response.removeListener('finish', done);
        response.removeListener('close', done);
        resolve();
      };
      response.once('finish', done);
      response.once('close', done);
    });
    const deadline = setTimeout(() => {
      if (response.destroyed || response.writableFinished) return;
      controller.abort();
      if (response.headersSent || response.writableEnded) {
        response.destroy();
        return;
      }
      response.setHeader('Connection', 'close');
      this.send(
        response,
        408,
        xpApiError(new XpApiError('REQUEST_TIMEOUT', 408)).body,
      );
    }, 15000);
    deadline.unref();
    try {
      if (
        typeof request.url !== 'string' ||
        request.url.length > 4096 ||
        !request.url.startsWith('/') ||
        request.url.startsWith('//')
      )
        throw new XpApiError('INVALID_REQUEST');
      url = new URL(request.url, this.config.apiOrigin);
      if (url.origin !== this.config.apiOrigin || url.hash) {
        throw new XpApiError('INVALID_REQUEST');
      }
      const needsOrigin =
        url.pathname.startsWith('/api/') ||
        ['/auth/exchange', '/auth/logout'].includes(url.pathname);
      this.checkOrigin(request, response, needsOrigin);
      const ip = xpRequestIp(request, this.config);
      const authBucket =
        url.pathname === '/auth/start'
          ? 'login'
          : url.pathname === '/auth/exchange'
            ? 'exchange'
            : url.pathname === '/auth/callback'
              ? 'callback'
              : null;
      const write = mutatingMethods.includes(request.method);
      const bucket = authBucket ?? (write ? 'write' : 'read');
      this.limits.consume(
        `${bucket}:ip`,
        ip,
        authBucket ? 10 : write ? 30 : 120,
      );
      this.limits.consume(
        `${bucket}:global`,
        'all',
        authBucket ? 60 : write ? 120 : 600,
      );
      if (request.method === 'OPTIONS') {
        const headers = request.headers['access-control-request-headers'] ?? '';
        const method = request.headers['access-control-request-method'];
        if (
          !request.headers.origin ||
          !['GET', 'POST', 'PUT', 'DELETE'].includes(method) ||
          headers
            .toLowerCase()
            .split(',')
            .some(
              (header) =>
                header.trim() &&
                !['authorization', 'content-type'].includes(header.trim()),
            )
        )
          throw new XpApiError('FORBIDDEN', 403);
        response.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '300',
        });
        response.end();
        return;
      }
      if (!['GET', ...mutatingMethods].includes(request.method)) {
        throw new XpApiError('METHOD_NOT_ALLOWED', 405);
      }
      release = await this.gate.enter(controller.signal);
      if (url.pathname === '/health' && request.method === 'GET') {
        assertQuery(url, []);
        this.send(response, 200, { status: 'ok' });
        return;
      }
      this.available();
      if (
        request.method === 'GET' &&
        (request.headers['transfer-encoding'] ||
          Number(request.headers['content-length'] ?? 0) > 0)
      ) {
        throw new XpApiError('INVALID_REQUEST');
      }
      if (url.pathname === '/auth/start' && request.method === 'GET') {
        assertQuery(url, ['return_to', 'challenge', 'attempt', 'restore']);
        if (
          url.searchParams.has('restore') &&
          url.searchParams.get('restore') !== '1'
        ) {
          throw new XpApiError('INVALID_LOGIN');
        }
        const result = await this.auth.begin({
          returnTo: url.searchParams.get('return_to'),
          challenge: url.searchParams.get('challenge'),
          attempt: url.searchParams.get('attempt'),
          restore: url.searchParams.get('restore') === '1',
          cookieHeader: request.headers.cookie,
        });
        this.redirect(response, result.redirect, result.cookies);
        return;
      }
      if (url.pathname === '/auth/callback' && request.method === 'GET') {
        assertQuery(url, ['state', 'code', 'error', 'error_description']);
        const result = await this.auth.callback({
          state: url.searchParams.get('state'),
          code: url.searchParams.get('code'),
          error: url.searchParams.get('error'),
          cookieHeader: request.headers.cookie,
        });
        this.redirect(response, result.redirect, result.cookies);
        return;
      }
      if (url.pathname === '/auth/exchange' && request.method === 'POST') {
        const body = await readJson(request);
        assertBody(
          body,
          ['code', 'verifier', 'attempt'],
          ['code', 'verifier', 'attempt'],
        );
        this.send(response, 200, this.auth.exchange(body));
        return;
      }
      const session = this.auth.authenticate(request.headers.authorization);
      this.limits.consume(
        `${write ? 'write' : 'read'}:user`,
        session.user.id,
        write ? 10 : 60,
      );
      const body = write ? await readJson(request) : null;
      if (url.pathname === '/auth/logout' && request.method === 'POST') {
        assertBody(body, []);
        response.setHeader('Set-Cookie', this.auth.logout(session.sessionHash));
        this.send(response, 200, { loggedOut: true });
        return;
      }
      if (!url.pathname.startsWith('/api/'))
        throw new XpApiError('NOT_FOUND', 404);
      const member = await this.auth.requireMember(session.user.id);
      this.available();
      if (controller.signal.aborted)
        throw new XpApiError('REQUEST_TIMEOUT', 408);
      const stored = this.store.member(this.config.guildId, session.user.id);
      if (!stored?.active) throw new XpApiError('TRACKING_UNAVAILABLE', 503, 5);
      const actor = { userId: session.user.id, roleIds: member.roleIds };
      const access = this.store.settings(this.config.guildId, 'access').value;
      const permissions = permissionsFor(actor.userId, actor.roleIds, access);
      const context = { session, member, actor, permissions };
      if (
        ['/api/raffles/preview', '/api/raffles'].includes(url.pathname) &&
        request.method === 'POST'
      ) {
        if (
          actor.userId !== XP_OWNER_ID &&
          !permissions.includes('raffle.execute')
        ) {
          throw new XpApiError('FORBIDDEN', 403);
        }
        this.limits.consume('bulk:user', actor.userId, 2);
        this.limits.consume('bulk:global', 'all', 4);
        releaseBulk = await this.bulkGate.enter(controller.signal);
      }
      if (controller.signal.aborted)
        throw new XpApiError('REQUEST_TIMEOUT', 408);
      const result = await this.route(request.method, url, body, context);
      this.send(response, 200, result);
    } catch (error) {
      const result = xpApiError(error);
      if (result.status >= 500)
        console.error(
          'XP API request failed.',
          requestId,
          result.body.error.code,
        );
      if (response.destroyed || response.writableEnded) return;
      if (result.retryAfter)
        response.setHeader('Retry-After', String(result.retryAfter));
      if (url?.pathname === '/auth/callback') {
        console.warn('XP OAuth callback rejected.', {
          code: result.body.error.code,
          loginCookiePresent: Boolean(
            this.auth.readCookie(request.headers.cookie, this.auth.loginCookie),
          ),
        });
        this.redirect(
          response,
          this.auth.redirect({ offrecord_error: 'login_failed' }),
          [this.auth.cookie(this.auth.loginCookie, '', 0)],
        );
      } else {
        if ([400, 408, 413, 415].includes(result.status))
          response.setHeader('Connection', 'close');
        this.send(response, result.status, result.body);
      }
    } finally {
      await responseDone;
      clearTimeout(deadline);
      request.removeListener('aborted', onAbort);
      response.removeListener('close', onClose);
      releaseBulk?.();
      release?.();
    }
  }

  async route(method, url, body, { session, member, actor, permissions }) {
    const { guildId } = this.config;
    const requirePermission = (permission) => {
      if (actor.userId !== XP_OWNER_ID && !permissions.includes(permission)) {
        throw new XpApiError('FORBIDDEN', 403);
      }
    };
    const execute = (action, input = {}) =>
      this.economy.execute(action, actor.userId, input);
    const path = url.pathname;
    if (method === 'GET') {
      if (path === '/api/me') {
        assertQuery(url, []);
        return {
          user: {
            ...session.user,
            displayName: member.displayName ?? session.user.displayName,
          },
          owner: actor.userId === XP_OWNER_ID,
          permissions,
          permissionCatalog: [...XP_PERMISSIONS],
          profile: this.store.profile(guildId, actor.userId),
          attendance: this.store.attendanceProfile(
            guildId,
            actor.userId,
            this.clock(),
          ),
        };
      }
      if (path === '/api/rankings') {
        assertQuery(url, ['kind']);
        const timestamp = this.clock();
        const kind = url.searchParams.get('kind') ?? 'xp';
        if (!['xp', 'total', 'streak'].includes(kind))
          throw new XpApiError('INVALID_REQUEST');
        return kind === 'xp'
          ? {
              items: this.store.leaderboard(guildId),
              own: this.store.profile(guildId, actor.userId),
            }
          : {
              items: this.store.attendanceLeaderboard(guildId, kind, timestamp),
              own: this.store.attendanceProfile(
                guildId,
                actor.userId,
                timestamp,
              ),
            };
      }
      if (path === '/api/settings') {
        assertQuery(url, []);
        const sections = {};
        for (const section of settingsSections) {
          if (
            canManageXpSettings(
              actor.userId,
              actor.roleIds,
              this.store.settings(guildId, 'access').value,
              section,
            )
          ) {
            sections[section] = this.store.settings(guildId, section);
          }
        }
        return { sections };
      }
      const setting = /^\/api\/settings\/([a-z]+)$/.exec(path);
      if (setting) {
        assertQuery(url, []);
        if (
          !settingsSections.includes(setting[1]) ||
          !canManageXpSettings(
            actor.userId,
            actor.roleIds,
            this.store.settings(guildId, 'access').value,
            setting[1],
          )
        ) {
          throw new XpApiError('FORBIDDEN', 403);
        }
        return this.store.settings(guildId, setting[1]);
      }
      if (path === '/api/roles') {
        assertQuery(url, ['after']);
        if (!permissions.length) throw new XpApiError('FORBIDDEN', 403);
        const after = url.searchParams.get('after');
        if (after !== null && !snowflake(after))
          throw new XpApiError('INVALID_REQUEST');
        const roles = (await this.discord.roles())
          .filter((role) => after === null || role.id > after)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const items = roles.slice(0, 50);
        return {
          items,
          nextCursor: roles.length > 50 ? items.at(-1).id : null,
        };
      }
      if (path === '/api/shop') {
        assertQuery(url, ['manage', 'after', 'productId']);
        const manage = manageFlag(url);
        if (manage) requirePermission('shop.manage');
        return execute('shop.list', {
          manage,
          after: url.searchParams.get('after'),
          productId: url.searchParams.get('productId'),
        });
      }
      if (path === '/api/orders') {
        assertQuery(url, ['manage', 'before', 'limit']);
        const manage = manageFlag(url);
        if (manage) requirePermission('orders.manage');
        return execute('orders.list', {
          manage,
          before: cursor(url),
          limit: pageSize(url),
        });
      }
      if (path === '/api/jobs') {
        assertQuery(url, ['before', 'limit']);
        requirePermission('nickname.manage');
        return execute('nickname.status', {
          before: cursor(url),
          limit: pageSize(url),
        });
      }
      if (path === '/api/admin/summary') {
        assertQuery(url, []);
        if (!permissions.length) throw new XpApiError('FORBIDDEN', 403);
        return execute('admin.summary');
      }
      if (path === '/api/audit' || path === '/api/ledger') {
        assertQuery(url, ['before', 'limit']);
        if (path === '/api/audit') requirePermission('audit.view');
        const before = cursor(url);
        const limit = pageSize(url);
        const audit = path === '/api/audit';
        const range = before === null ? '' : 'AND id < ?';
        const rows = this.store.database
          .prepare(
            audit
              ? `
          SELECT id, actor_id AS actorId, action, details_json AS details, created_at AS createdAt
          FROM xp_audit WHERE guild_id = ? ${range}
          ORDER BY id DESC LIMIT ?
        `
              : `
          SELECT id, kind, delta_milli AS deltaMilli, balance_after AS balanceAfter,
            reset_version AS resetVersion, created_at AS createdAt FROM xp_ledger
          WHERE guild_id = ? AND user_id = ? ${range}
          ORDER BY id DESC LIMIT ?
        `,
          )
          .all(
            ...(audit ? [guildId] : [guildId, actor.userId]),
            ...(before === null ? [] : [before]),
            limit + 1,
          );
        const items = rows.slice(0, limit).map((row) => ({
          ...row,
          ...(audit ? { details: JSON.parse(row.details) } : {}),
        }));
        return {
          items,
          nextCursor: rows.length > limit ? items.at(-1).id : null,
        };
      }
    }
    if (method === 'PUT') {
      const setting = /^\/api\/settings\/([a-z]+)$/.exec(path);
      if (setting) {
        assertQuery(url, []);
        assertBody(body, ['version', 'patch'], ['version', 'patch']);
        if (!settingsSections.includes(setting[1]))
          throw new XpApiError('NOT_FOUND', 404);
        return execute('settings.update', { section: setting[1], ...body });
      }
      const product = /^\/api\/products\/([A-Za-z0-9_-]{1,80})$/.exec(path);
      if (product) {
        requirePermission('shop.manage');
        assertQuery(url, []);
        assertBody(
          body,
          ['version', 'product', 'key'],
          ['version', 'product', 'key'],
        );
        requireKey(body);
        return execute('products.save', { ...body, id: product[1] });
      }
    }
    if (method === 'POST') {
      assertQuery(url, []);
      if (path === '/api/products') {
        requirePermission('shop.manage');
        assertBody(
          body,
          ['product', 'version', 'key'],
          ['product', 'version', 'key'],
        );
        requireKey(body);
        return execute('products.save', body);
      }
      if (path === '/api/purchases') {
        assertBody(
          body,
          ['productId', 'version', 'key'],
          ['productId', 'version', 'key'],
        );
        requireKey(body);
        return execute('purchase', body);
      }
      const order = /^\/api\/orders\/([A-Za-z0-9_-]{1,80})\/action$/.exec(path);
      if (order) {
        requirePermission('orders.manage');
        assertBody(body, ['action', 'key'], ['action', 'key']);
        requireKey(body);
        const id = /^\d+$/.test(order[1]) ? Number(order[1]) : order[1];
        return execute('order.review', { ...body, id });
      }
      if (path === '/api/xp/adjust') {
        requirePermission('xp.adjust');
        assertBody(
          body,
          ['userId', 'amount', 'operation', 'reason', 'key'],
          ['userId', 'amount', 'operation', 'reason', 'key'],
        );
        if (!snowflake(body.userId)) throw new XpApiError('INVALID_REQUEST');
        requireKey(body);
        return execute('xp.adjust', body);
      }
      if (path === '/api/gifts') {
        assertBody(
          body,
          ['userId', 'amount', 'key'],
          ['userId', 'amount', 'key'],
        );
        if (!snowflake(body.userId)) throw new XpApiError('INVALID_REQUEST');
        requireKey(body);
        return execute('gift.send', body);
      }
      const game = /^\/api\/games\/(slots|wheel|oddEven|dice)$/.exec(path);
      if (game) {
        assertBody(body, ['amount', 'choice', 'key'], ['amount', 'key']);
        requireKey(body);
        return execute('game.play', { ...body, game: game[1] });
      }
      if (path === '/api/raffles/preview') {
        requirePermission('raffle.execute');
        assertBody(
          body,
          ['roleId', 'winners', 'amount'],
          ['winners', 'amount'],
        );
        if (body.roleId !== undefined && !snowflake(body.roleId))
          throw new XpApiError('INVALID_REQUEST');
        return execute('raffle.preview', body);
      }
      if (path === '/api/raffles') {
        requirePermission('raffle.execute');
        assertBody(body, ['previewId', 'key'], ['previewId', 'key']);
        requireKey(body);
        return execute('raffle.execute', body);
      }
      if (path === '/api/jobs/sync') {
        requirePermission('nickname.manage');
        assertBody(body, ['after']);
        return execute('nickname.sync', body);
      }
    }
    throw new XpApiError('NOT_FOUND', 404);
  }

  async close() {
    this.closed = true;
    this.gate.close();
    this.bulkGate.close();
    await Promise.allSettled([...this.inFlight]);
  }
}

export async function startXpApi(options) {
  const api = new XpApi(options);
  const server = createServer(
    {
      maxHeaderSize: 8192,
      headersTimeout: 10000,
      requestTimeout: 15000,
      keepAliveTimeout: 5000,
      connectionsCheckingInterval: 1000,
    },
    (request, response) => {
      void api.run(request, response).catch(() => {
        console.error('XP API transport failed.');
        response.destroy();
      });
    },
  );
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 128;
  server.on('clientError', (error, socket) => {
    if (!socket.writable) return;
    const status = error.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
    socket.end(
      `HTTP/1.1 ${status} Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.config.port, options.config.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  server.on('error', () => console.error('XP API listener failed.'));
  const timer = setInterval(() => {
    try {
      api.auth.cleanup();
      api.limits.cleanup();
    } catch {
      console.error('XP authentication cleanup failed.');
    }
  }, 60000);
  timer.unref();
  return {
    api,
    address: server.address(),
    async close() {
      clearInterval(timer);
      const closed = new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeIdleConnections();
      await api.close();
      await closed;
    },
  };
}
