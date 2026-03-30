'use strict';

const { createRateLimiter } = require('../lib/rateLimit');

function makeRedis(counts = {}) {
  return {
    _counts: counts,
    async incr(key) {
      this._counts[key] = (this._counts[key] || 0) + 1;
      return this._counts[key];
    },
    async expire() {},
  };
}

function makeReq(ip = '127.0.0.1') {
  return { ip };
}

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

describe('createRateLimiter', () => {
  test('allows requests below the limit', async () => {
    const redis = makeRedis();
    const mw = createRateLimiter(redis, { max: 10, window: 60, keyPrefix: 'test' });
    const next = jest.fn();
    for (let i = 0; i < 10; i++) {
      const res = makeRes();
      await mw(makeReq(), res, next);
    }
    expect(next).toHaveBeenCalledTimes(10);
  });

  test('blocks the 11th request with 429', async () => {
    const redis = makeRedis();
    const mw = createRateLimiter(redis, { max: 10, window: 60, keyPrefix: 'test' });
    const next = jest.fn();
    for (let i = 0; i < 10; i++) await mw(makeReq(), makeRes(), next);
    const res = makeRes();
    await mw(makeReq(), res, next);
    expect(res._status).toBe(429);
    expect(next).toHaveBeenCalledTimes(10);
  });

  test('allows exactly the 10th request', async () => {
    const redis = makeRedis();
    const mw = createRateLimiter(redis, { max: 10, window: 60, keyPrefix: 'test' });
    const next = jest.fn();
    for (let i = 0; i < 9; i++) await mw(makeReq(), makeRes(), next);
    const res = makeRes();
    await mw(makeReq(), res, next);
    expect(res._status).toBeNull();
    expect(next).toHaveBeenCalledTimes(10);
  });

  test('scopes limits by IP — different IPs have separate counts', async () => {
    const redis = makeRedis();
    const mw = createRateLimiter(redis, { max: 2, window: 60, keyPrefix: 'test' });
    const next = jest.fn();
    // Exhaust IP A
    await mw({ ip: 'A' }, makeRes(), next);
    await mw({ ip: 'A' }, makeRes(), next);
    const blockedRes = makeRes();
    await mw({ ip: 'A' }, blockedRes, next);
    expect(blockedRes._status).toBe(429);
    // IP B should still be allowed
    const bRes = makeRes();
    await mw({ ip: 'B' }, bRes, next);
    expect(bRes._status).toBeNull();
    expect(next).toHaveBeenCalledTimes(3); // 2 from A + 1 from B
  });

  test('allows through when Redis throws (fail-open)', async () => {
    const brokenRedis = {
      async incr() { throw new Error('Redis down'); },
      async expire() {},
    };
    const mw = createRateLimiter(brokenRedis, { max: 10, window: 60, keyPrefix: 'test' });
    const next = jest.fn();
    const res = makeRes();
    await mw(makeReq(), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res._status).toBeNull();
  });
});
