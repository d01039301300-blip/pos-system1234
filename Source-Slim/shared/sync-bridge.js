'use strict';

const {
  COLLECTION_TO_TABLE,
  SOURCE_IDENTITY,
  DEFAULT_SOURCE_IDENTITY,
  SYNC_EXCLUDED_COLLECTIONS
} = require('./collection-map');

const ENABLED = process.env.PG_SYNC_ENABLED === '1';
const MAX_RETRIES = 20;
const DEAD_LETTER = 'dead';

let _pending = [];

function isMirrored(collection) {
  if (SYNC_EXCLUDED_COLLECTIONS.includes(collection)) return false;
  return Object.prototype.hasOwnProperty.call(COLLECTION_TO_TABLE, collection);
}

function targetTable(collection) {
  return COLLECTION_TO_TABLE[collection] || null;
}

function sourceKey(collection) {
  return SOURCE_IDENTITY[collection] || DEFAULT_SOURCE_IDENTITY;
}

function enqueue(op, collection, rowKey, payload) {
  if (!ENABLED) return { queued: false, reason: 'disabled' };
  if (!isMirrored(collection)) return { queued: false, reason: 'not_mirrored' };
  _pending.push({
    op,
    collection,
    row_key: String(rowKey),
    payload: payload == null ? null : payload,
    created_at: Date.now()
  });
  return { queued: true };
}

function flush(stmt) {
  if (!ENABLED || _pending.length === 0) return { written: 0 };
  let written = 0;
  for (const evt of _pending) {
    stmt.run(evt.collection, evt.row_key, evt.op, evt.payload, evt.created_at);
    written++;
  }
  return { written };
}

function clear() { _pending = []; }
function pendingCount() { return _pending.length; }

function ensureSchema(conn) {
  if (!ENABLED) return;
  conn.exec(`
    CREATE TABLE IF NOT EXISTS pg_sync_queue (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT    NOT NULL,
      row_key    TEXT    NOT NULL,
      op         TEXT    NOT NULL,
      payload    TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pgsq_created_at
      ON pg_sync_queue(created_at);
    CREATE INDEX IF NOT EXISTS idx_pgsq_collection_rowkey
      ON pg_sync_queue(collection, row_key);
    CREATE TABLE IF NOT EXISTS pg_sync_dead_letter (
      original_seq INTEGER PRIMARY KEY,
      collection   TEXT NOT NULL,
      row_key      TEXT NOT NULL,
      op           TEXT NOT NULL,
      payload      TEXT,
      last_error   TEXT,
      attempts     INTEGER,
      moved_at     INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pg_sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  const cols = conn.prepare('PRAGMA table_info(pg_sync_queue)').all();
  const names = cols.map(column => column.name);
  if (!names.includes('retry_count')) {
    conn.exec('ALTER TABLE pg_sync_queue ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!names.includes('last_error')) {
    conn.exec('ALTER TABLE pg_sync_queue ADD COLUMN last_error TEXT');
  }
}

let _notifyClient = null;

function notifyPg() {
  if (!ENABLED) return;
  try {
    if (!_notifyClient) {
      const pgClient = require('./pg-client');
      _notifyClient = pgClient.createClient();
      _notifyClient.on('error', () => {
        try { _notifyClient.end(); } catch (_) {}
        _notifyClient = null;
      });
      _notifyClient.connect().catch(() => { _notifyClient = null; });
    }
    _notifyClient.query('NOTIFY pos_sync_enqueue').catch(() => {});
  } catch (_) { /* swallow — polling is fallback */ }
}

function shutdownNotify() {
  if (_notifyClient) {
    try { _notifyClient.end().catch(() => {}); } catch (_) {}
    _notifyClient = null;
  }
}

module.exports = {
  ENABLED, MAX_RETRIES, DEAD_LETTER,
  isMirrored, targetTable, sourceKey,
  enqueue, flush, clear, pendingCount, ensureSchema, notifyPg, shutdownNotify
};
