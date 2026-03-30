'use strict';

const { Pool } = require('pg');

const db = new Pool({
  host:     process.env.PG_HOST     || 'postgres',
  port:     parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DB       || 'wardrive',
  user:     process.env.PG_USER     || 'wardrive',
  password: process.env.PG_PASSWORD,
});

module.exports = db;
