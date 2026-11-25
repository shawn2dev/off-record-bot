import { expect } from 'chai';
import { afterEach, describe, it } from 'mocha';
import sinon from 'sinon';
import worker from '../src/xp-worker.js';

const API = 'https://off-record-xp-api.cbycdy2.workers.dev';
const SITE = 'https://main--off-record-bot-site--shawn2dev.aem.live';
const request = (path, init = {}) =>
  new Request(`${API}${path}`, {
    ...init,
    headers: {
      Origin: SITE,
      'CF-Connecting-IP': '203.0.113.42',
      ...init.headers,
    },
  });
const environment = (fetch) => ({
  XP_API_ORIGIN: API,
  XP_API_ALLOWED_SITE_ORIGINS: SITE,
  PRIVATE_API: { fetch },
});

describe('Private XP Worker gateway', () => {
  afterEach(() => sinon.restore());

  it('uses the bound service and public Host without forwarding spoofable proxy headers', async () => {
    const upstream = sinon.stub().resolves(new Response('{"status":"ok"}'));
    const response = await worker.fetch(
      request('/health', {
        headers: {
          'X-Forwarded-For': '1.2.3.4',
          'X-Real-IP': '1.2.3.4',
          Forwarded: 'for=1.2.3.4',
          'Proxy-Authorization': 'private-proxy-value',
        },
      }),
      environment(upstream),
    );
    const [url, init] = upstream.firstCall.args;
    expect(url).to.equal(API.replace('https:', 'http:') + '/health');
    expect(init.redirect).to.equal('manual');
    expect(init.signal).to.be.instanceOf(AbortSignal);
    expect(init.headers.get('CF-Connecting-IP')).to.equal('203.0.113.42');
    for (const header of [
      'X-Forwarded-For',
      'X-Real-IP',
      'Forwarded',
      'Proxy-Authorization',
    ])
      expect(init.headers.has(header)).to.equal(false);
    expect(response.status).to.equal(200);
    expect(response.headers.get('Cache-Control')).to.equal('no-store');
  });

  it('preserves authentication, CORS preflight headers and request bodies', async () => {
    const upstream = sinon.stub().callsFake(async (url, init) => {
      expect(init.method).to.equal('POST');
      expect(init.headers.get('Authorization')).to.equal('Bearer test-access');
      expect(init.headers.get('Cookie')).to.equal(
        '__Host-session=test-session',
      );
      expect(init.headers.get('Origin')).to.equal(SITE);
      expect(init.headers.get('Content-Type')).to.equal('application/json');
      expect(await new Response(init.body).text()).to.equal(
        '{"code":"one-use"}',
      );
      return new Response('{}');
    });
    await worker.fetch(
      request('/auth/exchange', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-access',
          Cookie: '__Host-session=test-session',
          'Content-Type': 'application/json',
        },
        body: '{"code":"one-use"}',
      }),
      environment(upstream),
    );
    const preflight = sinon
      .stub()
      .resolves(new Response(null, { status: 204 }));
    await worker.fetch(
      request('/api/me', {
        method: 'OPTIONS',
        headers: {
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      }),
      environment(preflight),
    );
    const headers = preflight.firstCall.args[1].headers;
    expect(headers.get('Access-Control-Request-Method')).to.equal('PUT');
    expect(headers.get('Access-Control-Request-Headers')).to.equal(
      'authorization,content-type',
    );
  });

  it('returns redirects and separate secure cookies without following OAuth redirects', async () => {
    const headers = new Headers({
      Location: 'https://discord.com/oauth2/authorize?state=one-use',
    });
    headers.append(
      'Set-Cookie',
      '__Host-login=first; Secure; HttpOnly; Path=/',
    );
    headers.append(
      'Set-Cookie',
      '__Host-session=second; Secure; HttpOnly; Path=/',
    );
    const response = await worker.fetch(
      request('/auth/start?attempt=test'),
      environment(
        sinon.stub().resolves(new Response(null, { status: 303, headers })),
      ),
    );
    expect(response.status).to.equal(303);
    expect(response.headers.get('Location')).to.contain('discord.com');
    expect(response.headers.getSetCookie()).to.have.length(2);
  });

  it('does not retry or disguise upstream errors and rate limits', async () => {
    const upstream = sinon.stub().resolves(
      new Response('{"error":{"code":"RATE_LIMITED"}}', {
        status: 429,
        headers: { 'Retry-After': '60' },
      }),
    );
    const response = await worker.fetch(
      request('/api/me'),
      environment(upstream),
    );
    expect(response.status).to.equal(429);
    expect(response.headers.get('Retry-After')).to.equal('60');
    expect(upstream.callCount).to.equal(1);
  });

  it('rejects unexpected hosts, schemes, paths, methods and long URLs before proxying', async () => {
    const upstream = sinon.stub();
    for (const [input, status] of [
      [new Request('https://other.workers.dev/health'), 403],
      [new Request(API.replace('https:', 'http:') + '/health'), 403],
      [request('/unrelated'), 404],
      [request('//other.example/health'), 400],
      [request('/health', { method: 'PATCH' }), 405],
      [request('/health?value=' + 'x'.repeat(4096)), 400],
    ]) {
      const response = await worker.fetch(input, environment(upstream));
      expect(response.status).to.equal(status);
    }
    expect(upstream.called).to.equal(false);
  });

  it('rejects malformed or oversized declared payloads before proxying', async () => {
    const upstream = sinon.stub();
    for (const [length, status] of [
      ['32769', 413],
      ['900719925474099200', 413],
      ['-1', 400],
      ['invalid', 400],
    ]) {
      const response = await worker.fetch(
        request('/api/gift', {
          method: 'POST',
          headers: { 'Content-Length': length },
        }),
        environment(upstream),
      );
      expect(response.status).to.equal(status);
    }
    expect(upstream.called).to.equal(false);
  });

  it('reports upstream failures without logging cookies, codes or tokens', async () => {
    const log = sinon.stub(console, 'error');
    const response = await worker.fetch(
      request('/auth/callback?code=private-code'),
      environment(
        sinon.stub().rejects(new Error('private-code and private-token')),
      ),
    );
    expect(response.status).to.equal(503);
    expect((await response.json()).error.code).to.equal('UPSTREAM_UNAVAILABLE');
    expect(response.headers.get('Retry-After')).to.equal('5');
    expect(response.headers.get('Access-Control-Allow-Origin')).to.equal(SITE);
    expect(JSON.stringify(log.args)).not.to.contain('private-code');
    expect(JSON.stringify(log.args)).not.to.contain('private-token');
  });

  it('fails explicitly when the private binding is missing and does not allow foreign CORS origins', async () => {
    const log = sinon.stub(console, 'error');
    const response = await worker.fetch(
      request('/health', { headers: { Origin: 'https://untrusted.example' } }),
      { XP_API_ORIGIN: API, XP_API_ALLOWED_SITE_ORIGINS: SITE },
    );
    expect(response.status).to.equal(503);
    expect(response.headers.has('Access-Control-Allow-Origin')).to.equal(false);
    expect(log.calledOnce).to.equal(true);
  });
});
