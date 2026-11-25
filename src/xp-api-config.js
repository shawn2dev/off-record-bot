import process from 'node:process';
import { isIP } from 'node:net';

const DEFAULT_SITE = 'https://main--off-record-bot-site--shawn2dev.aem.live';

function flag(value, name) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} must be true or false.`);
}

function integer(value, fallback, min, max, name) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} is outside its supported range.`);
  }
  return number;
}

function webUrl(value, allowLocalHttp, name, originOnly = false) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a URL.`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' &&
      !(allowLocalHttp && local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (originOnly && url.pathname !== '/')
  )
    throw new Error(`${name} must be an explicit, trusted HTTPS URL.`);
  return url;
}

export function readXpApiConfig(env = process.env, botConfig = {}) {
  if (!flag(env.XP_API_ENABLED, 'XP_API_ENABLED')) return null;
  const allowLocalHttp = flag(
    env.XP_API_ALLOW_HTTP_LOCAL,
    'XP_API_ALLOW_HTTP_LOCAL',
  );
  const host = env.XP_API_HOST || '127.0.0.1';
  if (!isIP(host) || !['127.0.0.1', '::1'].includes(host)) {
    throw new Error('XP_API_HOST must be a loopback address.');
  }
  const api = webUrl(env.XP_API_ORIGIN, allowLocalHttp, 'XP_API_ORIGIN', true);
  const site = webUrl(
    env.XP_DASHBOARD_URL || `${DEFAULT_SITE}/dashboard`,
    allowLocalHttp,
    'XP_DASHBOARD_URL',
  );
  const allowedOrigins = (env.XP_API_ALLOWED_SITE_ORIGINS || site.origin)
    .split(',')
    .map(
      (value) =>
        webUrl(
          value.trim(),
          allowLocalHttp,
          'XP_API_ALLOWED_SITE_ORIGINS',
          true,
        ).origin,
    );
  if (!allowedOrigins.includes(site.origin)) {
    throw new Error('The dashboard origin must be explicitly allowed.');
  }
  const clientId = env.XP_OAUTH_CLIENT_ID || botConfig.applicationId;
  if (!/^\d{17,20}$/.test(clientId ?? '')) {
    throw new Error('XP_OAUTH_CLIENT_ID must be a Discord application ID.');
  }
  const guildId = botConfig.guildId || env.XP_GUILD_ID;
  if (!/^\d{17,20}$/.test(guildId ?? '')) {
    throw new Error('XP_GUILD_ID must be a Discord guild ID.');
  }
  if (
    typeof env.XP_OAUTH_CLIENT_SECRET !== 'string' ||
    env.XP_OAUTH_CLIENT_SECRET.length < 16 ||
    /replace.me|example|placeholder/i.test(env.XP_OAUTH_CLIENT_SECRET)
  )
    throw new Error('XP_OAUTH_CLIENT_SECRET must be configured privately.');
  return {
    host,
    port: integer(env.XP_API_PORT, 8080, 1, 65535, 'XP_API_PORT'),
    apiOrigin: api.origin,
    dashboardUrl: site.href,
    allowedOrigins: [...new Set(allowedOrigins)],
    clientId,
    clientSecret: env.XP_OAUTH_CLIENT_SECRET,
    guildId,
    redirectUri: `${api.origin}/auth/callback`,
    secure: api.protocol === 'https:',
    trustTunnel: flag(env.XP_API_TRUST_TUNNEL, 'XP_API_TRUST_TUNNEL'),
    accessTtl:
      integer(
        env.XP_ACCESS_TTL_SECONDS,
        300,
        60,
        900,
        'XP_ACCESS_TTL_SECONDS',
      ) * 1000,
    sessionTtl:
      integer(env.XP_SESSION_TTL_HOURS, 168, 1, 720, 'XP_SESSION_TTL_HOURS') *
      3600000,
    codeTtl: 60000,
    loginTtl: 300000,
  };
}
