'use strict';

function config() {
  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'pos_central',
    user: process.env.PGUSER || 'pos_user',
    password: process.env.PGPASSWORD
  };
}

function createClient() {
  const pg = require('pg');
  return new pg.Client(config());
}

function createPool(opts) {
  const pg = require('pg');
  return new pg.Pool(Object.assign(config(), opts || {}));
}

module.exports = { config, createClient, createPool };
