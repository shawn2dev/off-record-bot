import { isIP } from 'node:net';
import { XpApiError } from './xp-api-errors.js';

export class XpApiLimits {
  constructor({ clock = Date.now, maxKeys = 10000 } = {}) {
    this.clock = clock;
    this.maxKeys = maxKeys;
    this.entries = new Map();
  }

  consume(bucket, identity, maximum) {
    const now = this.clock();
    const key = `${bucket}:${identity}`;
    let entry = this.entries.get(key);
    if (!entry || entry.expires <= now) {
      if (!entry && this.entries.size >= this.maxKeys) this.cleanup(256);
      if (!entry && this.entries.size >= this.maxKeys) {
        throw new XpApiError('SERVER_BUSY', 503, 60);
      }
      entry = { count: 0, expires: now + 60000 };
      this.entries.set(key, entry);
    }
    if (entry.count >= maximum) {
      throw new XpApiError(
        'RATE_LIMITED',
        429,
        Math.max(1, Math.ceil((entry.expires - now) / 1000)),
      );
    }
    entry.count += 1;
  }

  cleanup(maximum = 256) {
    const now = this.clock();
    let visited = 0;
    for (const [key, entry] of this.entries) {
      if (visited++ >= maximum) break;
      this.entries.delete(key);
      if (entry.expires > now) this.entries.set(key, entry);
    }
  }
}

export class XpApiGate {
  constructor({ concurrent = 8, queued = 32, queueTimeout = 5000 } = {}) {
    this.concurrent = concurrent;
    this.queued = queued;
    this.queueTimeout = queueTimeout;
    this.active = 0;
    this.waiters = [];
    this.closed = false;
  }

  async enter(signal) {
    if (this.closed) throw new XpApiError('SERVER_BUSY', 503, 5);
    if (signal?.aborted) throw new XpApiError('REQUEST_TIMEOUT', 408);
    if (this.active < this.concurrent) {
      this.active += 1;
      return () => this.leave();
    }
    if (this.waiters.length >= this.queued)
      throw new XpApiError('SERVER_BUSY', 503, 5);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const remove = (error) => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        waiter.cleanup();
        reject(error);
      };
      const abort = () => remove(new XpApiError('REQUEST_TIMEOUT', 408));
      const timer = setTimeout(
        () => remove(new XpApiError('SERVER_BUSY', 503, 5)),
        this.queueTimeout,
      );
      timer.unref();
      waiter.cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  leave() {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.cleanup();
      waiter.resolve(() => this.leave());
    } else {
      this.active -= 1;
    }
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.cleanup();
      waiter.reject(new XpApiError('SERVER_BUSY', 503, 5));
    }
  }
}

export function xpRequestIp(request, config) {
  const remote = request.socket.remoteAddress;
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
  const forwarded = request.headers['cf-connecting-ip'];
  if (
    config.trustTunnel &&
    loopback &&
    request.headers.host === new URL(config.apiOrigin).host &&
    typeof forwarded === 'string' &&
    isIP(forwarded)
  )
    return forwarded.toLowerCase();
  return remote ?? 'local';
}
