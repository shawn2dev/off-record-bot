import { XpApiError, xpApiError } from './xp-api-errors.js';

const methods = new Set(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
const forwardedHeaders = [
  'accept',
  'authorization',
  'content-type',
  'content-length',
  'cookie',
  'origin',
  'access-control-request-method',
  'access-control-request-headers',
];

function failure(request, env, code, status) {
  const error = xpApiError(
    new XpApiError(code, status, status === 503 ? 5 : null),
  );
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  if (error.retryAfter) headers.set('Retry-After', String(error.retryAfter));
  const origin = request.headers.get('Origin');
  if (
    origin &&
    (env.XP_API_ALLOWED_SITE_ORIGINS || '')
      .split(',')
      .some((allowed) => allowed.trim() === origin)
  ) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Expose-Headers', 'Retry-After');
    headers.set('Vary', 'Origin');
  }
  return new Response(JSON.stringify(error.body), { status, headers });
}

export default {
  async fetch(request, env) {
    if (!env.XP_API_ORIGIN || typeof env.PRIVATE_API?.fetch !== 'function') {
      console.error(
        'XP Worker requires an API origin and a private VPC binding.',
      );
      return failure(request, env, 'UPSTREAM_UNAVAILABLE', 503);
    }
    const url = new URL(request.url);
    if (url.protocol !== 'https:' || url.origin !== env.XP_API_ORIGIN)
      return failure(request, env, 'FORBIDDEN', 403);
    if (url.href.length > 4096 || url.hash || url.pathname.startsWith('//'))
      return failure(request, env, 'INVALID_REQUEST', 400);
    if (!methods.has(request.method))
      return failure(request, env, 'METHOD_NOT_ALLOWED', 405);
    if (
      url.pathname !== '/health' &&
      !url.pathname.startsWith('/api/') &&
      !url.pathname.startsWith('/auth/')
    )
      return failure(request, env, 'NOT_FOUND', 404);
    const length = request.headers.get('Content-Length');
    if (length !== null && !/^\d+$/.test(length))
      return failure(request, env, 'INVALID_REQUEST', 400);
    if (length !== null && Number(length) > 32768)
      return failure(request, env, 'BODY_TOO_LARGE', 413);
    if (request.method === 'GET' && request.body)
      return failure(request, env, 'INVALID_REQUEST', 400);

    const headers = new Headers();
    for (const name of forwardedHeaders) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const clientIp = request.headers.get('CF-Connecting-IP');
    if (clientIp) headers.set('CF-Connecting-IP', clientIp);
    url.protocol = 'http:';
    try {
      const response = await env.PRIVATE_API.fetch(url.href, {
        method: request.method,
        headers,
        body: request.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
      });
      const result = new Response(response.body, response);
      result.headers.set('Cache-Control', 'no-store');
      return result;
    } catch (error) {
      console.error('XP API upstream connection failed.', {
        name: error.name,
      });
      return failure(request, env, 'UPSTREAM_UNAVAILABLE', 503);
    }
  },
};
