'use strict';

const Redis = require('ioredis');

const redis = new Redis({
  host:        process.env.REDIS_HOST     || 'redis',
  port:        parseInt(process.env.REDIS_PORT || '6379'),
  password:    process.env.REDIS_PASSWORD || undefined,
  lazyConnect: true,
});

module.exports = redis;
