import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { XpApiError } from './xp-api-errors.js';

const opaquePattern = /^[A-Za-z0-9_-]{43}$/;
const isOpaque = (value) =>
  typeof value === 'string' && opaquePattern.test(value);
const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/;
const opaque = () => randomBytes(32).toString('base64url');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const challengeFor = (value) =>
  createHash('sha256').update(value).digest('base64url');

function matches(a, b) {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

export class XpAuth {
  constructor(
    store,
    config,
    { discord, clock = Date.now, fetcher = fetch } = {},
  ) {
    this.store = store;
    this.database = store.database;
    this.config = config;
    this.discord = discord;
    this.clock = clock;
    this.fetcher = fetcher;
    this.sessionCookie = config.secure
      ? '__Host-offrecord_session'
      : 'offrecord_session';
    this.loginCookie = config.secure
      ? '__Host-offrecord_login'
      : 'offrecord_login';
    store.transaction(() => {
      this.database.exec(
        'CREATE TABLE IF NOT EXISTS xp_auth_schema (version INTEGER PRIMARY KEY)',
      );
      const version = this.database
        .prepare(
          'SELECT COALESCE(MAX(version), 0) AS version FROM xp_auth_schema',
        )
        .get().version;
      if (version > 1)
        throw new Error(
          'The authentication schema is newer than this application.',
        );
      if (version === 1) return;
      this.database.exec(`
      CREATE TABLE xp_auth_sessions (
        session_hash TEXT PRIMARY KEY, guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL, user_json TEXT NOT NULL,
        access_version INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS xp_auth_sessions_expiry ON xp_auth_sessions (expires_at);
      CREATE INDEX IF NOT EXISTS xp_auth_sessions_user ON xp_auth_sessions (user_id, created_at);
      CREATE TABLE xp_auth_states (
        state_hash TEXT PRIMARY KEY, login_hash TEXT NOT NULL,
        challenge TEXT NOT NULL, attempt_hash TEXT NOT NULL, return_to TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS xp_auth_states_expiry ON xp_auth_states (expires_at);
      CREATE TABLE xp_auth_codes (
        code_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL,
        challenge TEXT NOT NULL, attempt_hash TEXT NOT NULL, access_version INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS xp_auth_codes_expiry ON xp_auth_codes (expires_at);
      CREATE INDEX IF NOT EXISTS xp_auth_codes_session ON xp_auth_codes (session_hash);
      CREATE TABLE xp_auth_tokens (
        token_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL,
        access_version INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS xp_auth_tokens_expiry ON xp_auth_tokens (expires_at);
      CREATE INDEX IF NOT EXISTS xp_auth_tokens_session ON xp_auth_tokens (session_hash);
    `);
      this.database.prepare('INSERT INTO xp_auth_schema VALUES (1)').run();
    });
  }

  cookie(name, value, maxAge) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.config.secure ? '; Secure' : ''}`;
  }

  readCookie(header, name) {
    if (typeof header !== 'string') return null;
    const found = header
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${name}=`));
    if (found.length !== 1) return null;
    const value = found[0].slice(name.length + 1);
    return isOpaque(value) ? value : null;
  }

  redirect(parameters) {
    const url = new URL(this.config.dashboardUrl);
    for (const [name, value] of Object.entries(parameters))
      url.searchParams.set(name, value);
    return url.href;
  }

  session(value) {
    if (!isOpaque(value)) return null;
    return (
      this.database
        .prepare(
          `
      SELECT * FROM xp_auth_sessions WHERE session_hash = ? AND guild_id = ? AND expires_at > ?
    `,
        )
        .get(hash(value), this.config.guildId, this.clock()) ?? null
    );
  }

  async requireMember(userId) {
    const member = await this.discord.member(userId);
    if (
      !member ||
      member.bot !== false ||
      member.userId !== userId ||
      !Array.isArray(member.roleIds) ||
      member.roleIds.some(
        (id) => typeof id !== 'string' || !/^\d{17,20}$/.test(id),
      )
    ) {
      throw new XpApiError('NOT_MEMBER', 403);
    }
    return member;
  }

  newCode(session, challenge, attemptHash) {
    const code = opaque();
    this.database
      .prepare(
        `
      INSERT INTO xp_auth_codes (code_hash, session_hash, challenge, attempt_hash, access_version, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        hash(code),
        session.session_hash,
        challenge,
        attemptHash,
        this.store.settings(this.config.guildId, 'access').version,
        Math.min(session.expires_at, this.clock() + this.config.codeTtl),
      );
    return code;
  }

  async begin({ returnTo, challenge, attempt, restore = false, cookieHeader }) {
    if (
      returnTo !== this.config.dashboardUrl ||
      !isOpaque(challenge) ||
      !isOpaque(attempt)
    )
      throw new XpApiError('INVALID_LOGIN');
    const current = this.session(
      this.readCookie(cookieHeader, this.sessionCookie),
    );
    if (current) {
      await this.requireMember(current.user_id);
      const code = this.store.transaction(() => {
        const live = this.database
          .prepare(
            `
          SELECT * FROM xp_auth_sessions WHERE session_hash = ? AND guild_id = ? AND expires_at > ?
        `,
          )
          .get(current.session_hash, this.config.guildId, this.clock());
        if (!live) throw new XpApiError('AUTH_EXPIRED', 401);
        this.database
          .prepare(
            `
          UPDATE xp_auth_sessions SET access_version = ? WHERE session_hash = ?
        `,
          )
          .run(
            this.store.settings(this.config.guildId, 'access').version,
            live.session_hash,
          );
        return this.newCode(live, challenge, hash(attempt));
      });
      return { redirect: this.redirect({ offrecord_code: code }), cookies: [] };
    }
    if (restore)
      return {
        redirect: this.redirect({ offrecord_error: 'session_expired' }),
        cookies: [],
      };
    const state = opaque();
    const marker = opaque();
    this.database
      .prepare(
        `
      INSERT INTO xp_auth_states
        (state_hash, login_hash, challenge, attempt_hash, return_to, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        hash(state),
        hash(marker),
        challenge,
        hash(attempt),
        returnTo,
        this.clock() + this.config.loginTtl,
      );
    const authorize = new URL('https://discord.com/oauth2/authorize');
    authorize.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: 'identify',
      state,
    }).toString();
    return {
      redirect: authorize.href,
      cookies: [
        this.cookie(this.loginCookie, marker, this.config.loginTtl / 1000),
      ],
    };
  }

  async providerJson(url, options) {
    let response;
    try {
      response = await this.fetcher(url, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new XpApiError('PROVIDER_UNAVAILABLE', 503);
    }
    if (!response.ok) throw new XpApiError('PROVIDER_UNAVAILABLE', 503);
    try {
      return await response.json();
    } catch {
      throw new XpApiError('PROVIDER_UNAVAILABLE', 503);
    }
  }

  async callback({ state, code, error, cookieHeader }) {
    const marker = this.readCookie(cookieHeader, this.loginCookie);
    if (!isOpaque(state) || !marker) throw new XpApiError('INVALID_LOGIN');
    const pending = this.store.transaction(() => {
      const row = this.database
        .prepare(
          `
        SELECT * FROM xp_auth_states WHERE state_hash = ? AND expires_at > ?
      `,
        )
        .get(hash(state), this.clock());
      if (!row || !matches(row.login_hash, hash(marker)))
        throw new XpApiError('INVALID_LOGIN');
      this.database
        .prepare('DELETE FROM xp_auth_states WHERE state_hash = ?')
        .run(hash(state));
      return row;
    });
    const clearLogin = this.cookie(this.loginCookie, '', 0);
    if (error)
      return {
        redirect: this.redirect({ offrecord_error: 'login_cancelled' }),
        cookies: [clearLogin],
      };
    if (typeof code !== 'string' || !code || code.length > 2048)
      throw new XpApiError('INVALID_LOGIN');
    const token = await this.providerJson(
      'https://discord.com/api/oauth2/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.config.redirectUri,
        }),
      },
    );
    if (
      typeof token.access_token !== 'string' ||
      !token.access_token ||
      token.access_token.length > 4096
    ) {
      throw new XpApiError('PROVIDER_UNAVAILABLE', 503);
    }
    const identity = await this.providerJson(
      'https://discord.com/api/v10/users/@me',
      {
        headers: { Authorization: `Bearer ${token.access_token}` },
      },
    );
    if (
      typeof identity.id !== 'string' ||
      !/^\d{17,20}$/.test(identity.id) ||
      identity.bot
    ) {
      throw new XpApiError('NOT_MEMBER', 403);
    }
    await this.requireMember(identity.id);
    const displayName =
      [identity.global_name, identity.username].find(
        (value) =>
          typeof value === 'string' && value.length > 0 && value.length <= 128,
      ) ?? identity.id;
    const user = {
      id: identity.id,
      displayName,
      avatar: /^(a_)?[a-f0-9]{16,64}$/.test(identity.avatar ?? '')
        ? `https://cdn.discordapp.com/avatars/${identity.id}/${identity.avatar}.png?size=128`
        : null,
    };
    const sessionValue = opaque();
    const appCode = this.store.transaction(() => {
      const old = this.readCookie(cookieHeader, this.sessionCookie);
      if (old) this.revoke(hash(old));
      const session = {
        session_hash: hash(sessionValue),
        expires_at: this.clock() + this.config.sessionTtl,
      };
      this.database
        .prepare(
          `
        INSERT INTO xp_auth_sessions
          (session_hash, guild_id, user_id, user_json, access_version, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          session.session_hash,
          this.config.guildId,
          user.id,
          JSON.stringify(user),
          this.store.settings(this.config.guildId, 'access').version,
          this.clock(),
          session.expires_at,
        );
      const excess = this.database
        .prepare(
          `
        SELECT session_hash FROM xp_auth_sessions WHERE user_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 20 OFFSET 20
      `,
        )
        .all(user.id);
      for (const row of excess) this.revoke(row.session_hash);
      return this.newCode(session, pending.challenge, pending.attempt_hash);
    });
    return {
      redirect: this.redirect({ offrecord_code: appCode }),
      cookies: [
        clearLogin,
        this.cookie(
          this.sessionCookie,
          sessionValue,
          this.config.sessionTtl / 1000,
        ),
      ],
    };
  }

  exchange({ code, verifier, attempt }) {
    if (
      !isOpaque(code) ||
      !isOpaque(attempt) ||
      typeof verifier !== 'string' ||
      !verifierPattern.test(verifier)
    )
      throw new XpApiError('INVALID_CODE');
    return this.store.transaction(() => {
      const row = this.database
        .prepare(
          `
        SELECT c.*, s.access_version AS session_version, s.expires_at AS session_expires
        FROM xp_auth_codes c JOIN xp_auth_sessions s USING (session_hash)
        WHERE c.code_hash = ? AND s.guild_id = ? AND c.expires_at > ? AND s.expires_at > ?
      `,
        )
        .get(hash(code), this.config.guildId, this.clock(), this.clock());
      if (
        !row ||
        !matches(row.challenge, challengeFor(verifier)) ||
        !matches(row.attempt_hash, hash(attempt)) ||
        row.access_version !==
          this.store.settings(this.config.guildId, 'access').version ||
        row.session_version !== row.access_version
      )
        throw new XpApiError('INVALID_CODE');
      this.database
        .prepare('DELETE FROM xp_auth_codes WHERE code_hash = ?')
        .run(hash(code));
      const accessToken = opaque();
      const expiresAt = Math.min(
        row.session_expires,
        this.clock() + this.config.accessTtl,
      );
      this.database
        .prepare(
          `
        INSERT INTO xp_auth_tokens (token_hash, session_hash, access_version, expires_at) VALUES (?, ?, ?, ?)
      `,
        )
        .run(
          hash(accessToken),
          row.session_hash,
          row.access_version,
          expiresAt,
        );
      return {
        accessToken,
        expiresIn: Math.floor((expiresAt - this.clock()) / 1000),
      };
    });
  }

  authenticate(authorization) {
    const match =
      typeof authorization === 'string' &&
      /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
    if (!match) throw new XpApiError('AUTH_REQUIRED', 401);
    const row = this.database
      .prepare(
        `
      SELECT s.*, t.access_version AS token_version FROM xp_auth_tokens t
      JOIN xp_auth_sessions s USING (session_hash)
      WHERE t.token_hash = ? AND s.guild_id = ? AND t.expires_at > ? AND s.expires_at > ?
    `,
      )
      .get(hash(match[1]), this.config.guildId, this.clock(), this.clock());
    if (
      !row ||
      row.token_version !==
        this.store.settings(this.config.guildId, 'access').version
    ) {
      throw new XpApiError('AUTH_EXPIRED', 401);
    }
    return { sessionHash: row.session_hash, user: JSON.parse(row.user_json) };
  }

  revoke(sessionHash) {
    for (const table of [
      'xp_auth_tokens',
      'xp_auth_codes',
      'xp_auth_sessions',
    ]) {
      this.database
        .prepare(`DELETE FROM ${table} WHERE session_hash = ?`)
        .run(sessionHash);
    }
  }

  logout(sessionHash) {
    this.store.transaction(() => this.revoke(sessionHash));
    return this.cookie(this.sessionCookie, '', 0);
  }

  cleanup() {
    this.store.transaction(() => {
      for (const table of [
        'xp_auth_tokens',
        'xp_auth_codes',
        'xp_auth_states',
        'xp_auth_sessions',
      ]) {
        this.database
          .prepare(
            `
          DELETE FROM ${table} WHERE rowid IN
            (SELECT rowid FROM ${table} WHERE expires_at <= ? LIMIT 200)
        `,
          )
          .run(this.clock());
      }
    });
  }
}
