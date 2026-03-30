'use strict';

// Returns an Express middleware that rate-limits by IP using Redis.
// redis    — ioredis client
// max      — max requests allowed in the window
// window   — window duration in seconds
// keyPrefix — Redis key prefix (e.g. 'login_rl')
function createRateLimiter(redis, { max = 10, window = 60, keyPrefix = 'rl' } = {}) {
  return async function rateLimitMiddleware(req, res, next) {
    const key = `${keyPrefix}:${req.ip}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, window);
      if (count > max) {
        return res.status(429).json({ error: 'Too many requests — try again shortly' });
      }
    } catch {
      // Redis failure: allow through rather than block legitimate users
    }
    next();
  };
}

module.exports = { createRateLimiter };
