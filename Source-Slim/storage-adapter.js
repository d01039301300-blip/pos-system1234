'use strict';

const fs = require('node:fs');
const syncBridge = require('./shared/sync-bridge');
const { migrateAccounting } = require('./migrations/006-accounting');
const { migrateWallets } = require('./migrations/007-wallets');
const { migrateSms } = require('./migrations/008-sms');
const { migrateUserBranches } = require('./migrations/009-user-branches');
const { migratePermissions } = require('./migrations/010-permissions');
const { migrateHardwareProfiles } = require('./migrations/011-hardware-profiles');
const { migrateWeightedProducts } = require('./migrations/012-weighted-products');
const { migratePerformanceIndexes } = require('./migrations/013-performance-indexes');

const CATALOG_KEYS = new Set(['business_catalog']);

function installSqliteWarningFilter() {
  if (process.__systemSqliteWarningFilterInstalled) return;
  const emitWarning = process.emitWarning.bind(process);
  Object.defineProperty(process, '__systemSqliteWarningFilterInstalled', { value: true });
  process.emitWarning = function filteredEmitWarning(warning, ...args) {
    const message = typeof warning === 'string' ? warning : warning?.message;
    const name = typeof args[0] === 'string' ? args[0] : args[0]?.type;
    if (name === 'ExperimentalWarning' && /SQLite is an experimental feature/i.test(message || '')) return;
    return emitWarning(warning, ...args);
  };
}

function getDatabaseSync() {
  try {
    installSqliteWarningFilter();
    return require('node:sqlite').DatabaseSync;
  } catch (error) {
    const wrapped = new Error(`تعذر تحميل مكتبة SQLite المضمنة في Node.js: ${error.message}`);
    wrapped.cause = error;
    wrapped.code = 'SQLITE_MODULE_LOAD_FAILED';
    throw wrapped;
  }
}

function normalizedHint(hint) {
  if (!hint) return null;
  if (Array.isArray(hint)) return { collections: new Map(hint.map(name => [String(name), null])) };
  const entries = hint.collections || hint.tables || hint;
  if (Array.isArray(entries)) return { collections: new Map(entries.map(name => [String(name), null])) };
  if (!entries || typeof entries !== 'object') return null;
  const result = new Map();
  for (const [name, rows] of Object.entries(entries)) {
    if (name === 'collections' || name === 'tables') continue;
    result.set(name, rows == null ? null : new Set((Array.isArray(rows) ? rows : [rows]).map(String)));
  }
  return result.size ? { collections: result } : null;
}

function rowKey(row, index, duplicateIndex = 0) {
  if (row && typeof row === 'object' && Object.hasOwn(row, 'id') && row.id !== null) {
    return `id:${typeof row.id}:${JSON.stringify(row.id)}${duplicateIndex ? `#${duplicateIndex}` : ''}`;
  }
  return `idx:${index}${duplicateIndex ? `#${duplicateIndex}` : ''}`;
}

function isHintedRow(hintRows, key, row) {
  if (!hintRows) return false;
  if (hintRows.has(key)) return true;
  try {
    const parsed = JSON.parse(row.payload);
    return parsed && Object.hasOwn(parsed, 'id') && hintRows.has(String(parsed.id));
  } catch { return false; }
}

function stateFromData(data) {
  const collections = new Map();
  const values = new Map();
  for (const [name, value] of Object.entries(data || {})) {
    if (CATALOG_KEYS.has(name)) continue;
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const rows = new Map();
      const duplicateCounts = new Map();
      for (let index = 0; index < value.length; index += 1) {
        const row = value[index];
        const base = rowKey(row, index);
        const duplicate = duplicateCounts.get(base) || 0;
        duplicateCounts.set(base, duplicate + 1);
        rows.set(rowKey(row, index, duplicate), { ordinal: index, payload: JSON.stringify(row) ?? 'null' });
      }
      collections.set(name, rows);
    } else {
      values.set(name, JSON.stringify(value));
    }
  }
  return { collections, values };
}

function parseJson(text, context) {
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`SQLite row ${context} contains invalid JSON: ${error.message}`); }
}

class SQLiteStorageAdapter {
  constructor(filePath, options = {}) {
    if (!filePath || typeof filePath !== 'string') throw new TypeError('SQLite file path is required.');
    const DatabaseSync = getDatabaseSync();
    this.filePath = filePath;
    this.kind = 'sqlite';
    this.closed = false;
    this.lastWriteAt = Date.now();
    this.checkpointTimer = null;
    this.walMetricsFile = process.env.RAWDA_WAL_METRICS_FILE || null;
    this.faultInjector = typeof options.faultInjector === 'function' ? options.faultInjector : null;
    fs.mkdirSync(require('node:path').dirname(filePath), { recursive: true });
    try { this.connection = new DatabaseSync(filePath, { timeout: 5000 }); }
    catch (error) {
      const wrapped = new Error(`تعذر فتح قاعدة SQLite من ${filePath}: ${error.message}`);
      wrapped.cause = error;
      wrapped.code = 'SQLITE_OPEN_FAILED';
      throw wrapped;
    }
    try {
      const integrityRow = this.connection.prepare('PRAGMA quick_check').get();
      const integrityResult = integrityRow?.quick_check || Object.values(integrityRow || {})[0] || '';
      if (integrityResult !== 'ok') throw new Error(`SQLite quick_check failed: ${integrityResult || 'no result'}`);
      this.connection.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=1048576; PRAGMA foreign_keys=ON;');
      this.recordWalMetrics('opened');
      this.checkpointTimer = setInterval(() => {
        if (!this.closed && Date.now() - this.lastWriteAt >= 30000) {
          try { this.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.recordWalMetrics('idle_checkpoint'); } catch {}
        }
      }, 30000);
      this.checkpointTimer.unref?.();
      this.connection.exec(`
        CREATE TABLE IF NOT EXISTS storage_collections (name TEXT PRIMARY KEY) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS storage_rows (
          collection TEXT NOT NULL,
          row_key TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          payload TEXT NOT NULL CHECK (json_valid(payload)),
          PRIMARY KEY (collection, row_key)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS storage_values (
          key TEXT PRIMARY KEY,
          payload TEXT NOT NULL CHECK (json_valid(payload))
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS storage_meta (
          key TEXT PRIMARY KEY,
          payload TEXT NOT NULL CHECK (json_valid(payload))
        ) WITHOUT ROWID;
      `);
      const version = Number(this.connection.prepare('PRAGMA user_version').get()?.user_version || 0);
      if (version < 13) {
        try {
          this.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          const backupDir = require('node:path').join(require('node:path').dirname(filePath), 'backups');
          fs.mkdirSync(backupDir, { recursive: true });
          const backupFile = require('node:path').join(backupDir, `migration-before-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
          fs.copyFileSync(filePath, backupFile, fs.constants.COPYFILE_EXCL);
        } catch (backupError) {
          throw new Error(`تعذر إنشاء النسخة الاحتياطية قبل Migration: ${backupError.message}`);
        }
      }
      if (version < 2) {
        // The old global JSON expression indexes duplicated index entries for
        // every table. Restrict each index to the one collection that uses it.
        this.connection.exec(`
          DROP INDEX IF EXISTS idx_storage_rows_barcode;
          DROP INDEX IF EXISTS idx_storage_rows_item_number;
          DROP INDEX IF EXISTS idx_storage_rows_name;
          DROP INDEX IF EXISTS idx_storage_rows_invoice_number;
          DROP INDEX IF EXISTS idx_storage_rows_created_at;
          CREATE INDEX IF NOT EXISTS idx_storage_products_barcode
            ON storage_rows(json_extract(payload, '$.barcode')) WHERE collection='products';
          CREATE INDEX IF NOT EXISTS idx_storage_products_item_number
            ON storage_rows(json_extract(payload, '$.item_number')) WHERE collection='products';
          CREATE INDEX IF NOT EXISTS idx_storage_sales_invoice_number
            ON storage_rows(json_extract(payload, '$.invoice_number')) WHERE collection='sales';
          CREATE INDEX IF NOT EXISTS idx_storage_sales_created_at
            ON storage_rows(json_extract(payload, '$.created_at')) WHERE collection='sales';
          CREATE INDEX IF NOT EXISTS idx_storage_audit_created_at
            ON storage_rows(json_extract(payload, '$.created_at')) WHERE collection='audit_logs';
          PRAGMA user_version=2;
        `);
      }
      if (version < 3) {
        // Rider/employee ledger lookups are date- and owner-scoped.  These
        // partial indexes avoid indexing unrelated JSON collections while
        // keeping the generic row-per-record storage format intact.
        this.connection.exec(`
          CREATE INDEX IF NOT EXISTS idx_storage_rider_transactions_rider
            ON storage_rows(json_extract(payload, '$.rider_id'))
            WHERE collection='delivery_rider_transactions';
          CREATE INDEX IF NOT EXISTS idx_storage_rider_transactions_created
            ON storage_rows(json_extract(payload, '$.created_at'))
            WHERE collection='delivery_rider_transactions';
          CREATE INDEX IF NOT EXISTS idx_storage_employee_transactions_employee
            ON storage_rows(json_extract(payload, '$.employee_id'))
            WHERE collection='employee_transactions';
          CREATE INDEX IF NOT EXISTS idx_storage_employee_transactions_created
            ON storage_rows(json_extract(payload, '$.created_at'))
            WHERE collection='employee_transactions';
          PRAGMA user_version=3;
        `);
      }
      if (version < 4) {
        // Product records are JSON payloads in storage_rows rather than rows
        // in a dedicated products table. These partial expression indexes are
        // the equivalent narrow indexes and exclude every other collection.
        this.connection.exec(`
          CREATE INDEX IF NOT EXISTS idx_products_barcode
            ON storage_rows(json_extract(payload, '$.barcode')) WHERE collection='products';
          CREATE INDEX IF NOT EXISTS idx_products_name
            ON storage_rows(json_extract(payload, '$.name')) WHERE collection='products';
          CREATE INDEX IF NOT EXISTS idx_products_stock_category
            ON storage_rows(COALESCE(json_extract(payload, '$.quantity'), json_extract(payload, '$.stock')), json_extract(payload, '$.category_id'))
            WHERE collection='products';
          PRAGMA user_version=4;
        `);
      }
      if (version < 5) {
        // Username records use JSON payloads in the shared row store.
        this.connection.exec(`
          CREATE INDEX IF NOT EXISTS idx_storage_users_username
            ON storage_rows(json_extract(payload, '$.username')) WHERE collection='users';
          PRAGMA user_version=5;
        `);
      }
      migrateAccounting(this.connection);
      migrateWallets(this.connection);
    migrateSms(this.connection);
      migrateUserBranches(this.connection);
      migratePermissions(this.connection);
      migrateHardwareProfiles(this.connection);
      migrateWeightedProducts(this.connection);
      migratePerformanceIndexes(this.connection);
    } catch (error) {
      try { this.connection.close(); } catch {}
      this.closed = true;
      throw error;
    }
    this.statements = {
      collections: this.connection.prepare('SELECT name FROM storage_collections'),
      userByUsername: this.connection.prepare("SELECT payload FROM storage_rows WHERE collection='users' AND json_extract(payload, '$.username') = ? ORDER BY ordinal LIMIT 1"),
      rows: this.connection.prepare('SELECT row_key, ordinal, payload FROM storage_rows WHERE collection = ? ORDER BY ordinal, row_key'),
      values: this.connection.prepare('SELECT key, payload FROM storage_values'),
      addCollection: this.connection.prepare('INSERT OR IGNORE INTO storage_collections(name) VALUES (?)'),
      upsertRow: this.connection.prepare(`INSERT INTO storage_rows(collection,row_key,ordinal,payload) VALUES (?,?,?,?)
        ON CONFLICT(collection,row_key) DO UPDATE SET ordinal=excluded.ordinal,payload=excluded.payload`),
      deleteRow: this.connection.prepare('DELETE FROM storage_rows WHERE collection=? AND row_key=?'),
      deleteCollection: this.connection.prepare('DELETE FROM storage_collections WHERE name=?'),
      upsertValue: this.connection.prepare(`INSERT INTO storage_values(key,payload) VALUES (?,?)
        ON CONFLICT(key) DO UPDATE SET payload=excluded.payload`),
      deleteValue: this.connection.prepare('DELETE FROM storage_values WHERE key=?')
    };
    this.statements.updateOrdinal = this.connection.prepare('UPDATE storage_rows SET ordinal=? WHERE collection=? AND row_key=?');
    if (syncBridge.ENABLED) {
      syncBridge.ensureSchema(this.connection);
      this.statements.enqueueSync = this.connection.prepare(
        `INSERT INTO pg_sync_queue(collection,row_key,op,payload,created_at)
         VALUES (?,?,?,?,?)`
      );
    }
  }

  _flushSyncBeforeCommit() {
    if (!syncBridge.ENABLED) return;
    syncBridge.flush(this.statements.enqueueSync);
  }

  _clearPendingSync() {
    if (!syncBridge.ENABLED) return;
    syncBridge.clear();
  }

  getMeta(key) {
    this.assertOpen();
    const row = this.connection.prepare('SELECT payload FROM storage_meta WHERE key=?').get(String(key));
    return row ? parseJson(row.payload, `meta.${key}`) : null;
  }

  setMeta(key, value) {
    this.assertOpen();
    this.connection.prepare(`INSERT INTO storage_meta(key,payload) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET payload=excluded.payload`).run(String(key), JSON.stringify(value));
  }

  deleteMeta(key) {
    this.assertOpen();
    this.connection.prepare('DELETE FROM storage_meta WHERE key=?').run(String(key));
  }

  findUserByUsername(username) {
    this.assertOpen();
    const row = this.statements.userByUsername.get(String(username || ''));
    return row ? parseJson(row.payload, `users.${username}`) : null;
  }
  collectionSummary(names) {
    this.assertOpen();
    const query = this.connection.prepare(`SELECT collection, count(*) AS count, max(ordinal) AS max_ordinal
      FROM storage_rows WHERE collection=? GROUP BY collection`);
    const result = {};
    for (const name of names) {
      const row = query.get(String(name));
      result[name] = { count: Number(row?.count || 0), maxOrdinal: Number(row?.max_ordinal ?? -1) };
    }
    return result;
  }

  assertOpen() {
    if (this.closed) throw new Error('SQLite storage adapter is closed.');
  }

  readState() {
    this.assertOpen();
    const state = { collections: new Map(), values: new Map() };
    for (const { name } of this.statements.collections.all()) state.collections.set(name, new Map());
    for (const name of state.collections.keys()) {
      for (const row of this.statements.rows.all(name)) {
        state.collections.get(name).set(row.row_key, { ordinal: Number(row.ordinal), payload: row.payload });
      }
    }
    for (const row of this.statements.values.all()) state.values.set(row.key, row.payload);
    return state;
  }

  load() {
    const data = {};
    for (const { name } of this.statements.collections.all()) {
      const rows = [];
      let index = 0;
      for (const row of this.statements.rows.iterate(name)) {
        rows.push(parseJson(row.payload, `${name}[${index}]`));
        index += 1;
      }
      data[name] = rows;
    }
    for (const row of this.statements.values.all()) data[row.key] = parseJson(row.payload, row.key);
    return data;
  }

  save(data, hint = null, beforeCommit = null) {
    this.assertOpen();
    this.lastWriteAt = Date.now();
    const normalized = normalizedHint(hint);
    const hinted = normalized?.collections || new Map();
    try {
      this.connection.exec('BEGIN IMMEDIATE');
      // Diff one collection at a time under the write lock. The previous path
      // materialized every old and new payload in parallel, causing a large
      // transient memory spike on 30k-product databases.
      const beforeCollections = new Set(this.statements.collections.all().map(row => row.name));
      const presentCollections = new Set();
      const beforeValues = new Map(this.statements.values.all().map(row => [row.key, row.payload]));
      const presentValues = new Set();
      const fallbackCollections = [];
      let writes = 0;
      let writtenRows = 0;
      let deletedRows = 0;
      const changedCollections = new Set();
      const write = operation => { writes += 1; if (this.faultInjector) this.faultInjector(writes, operation); };
      for (const [collection, value] of Object.entries(data || {})) {
        if (CATALOG_KEYS.has(collection) || !Array.isArray(value)) continue;
        presentCollections.add(collection);
        if (!hinted.has(collection)) fallbackCollections.push(collection);
        if (!beforeCollections.has(collection)) { this.statements.addCollection.run(collection); write({ kind: 'addCollection', collection }); }
        const oldRows = new Map(this.statements.rows.all(collection).map(row => [row.row_key, { ordinal: Number(row.ordinal), payload: row.payload }]));
        const currentKeys = new Set();
        const duplicateCounts = new Map();
        for (let index = 0; index < value.length; index += 1) {
          const row = value[index];
          const base = rowKey(row, index);
          const duplicate = duplicateCounts.get(base) || 0;
          duplicateCounts.set(base, duplicate + 1);
          const key = rowKey(row, index, duplicate);
          currentKeys.add(key);
          const payload = JSON.stringify(row) ?? 'null';
          const previous = oldRows.get(key);
          if (!previous || previous.ordinal !== index || previous.payload !== payload) {
            this.statements.upsertRow.run(collection, key, index, payload);
            syncBridge.enqueue('upsert', collection, key, payload);
            writtenRows += 1;
            changedCollections.add(collection);
            write({ kind: 'upsert', collection, key });
          }
        }
        for (const key of oldRows.keys()) if (!currentKeys.has(key)) {
          this.statements.deleteRow.run(collection, key);
          syncBridge.enqueue('delete', collection, key, null);
          deletedRows += Number(this.connection.prepare('SELECT changes() AS n').get().n || 0);
          changedCollections.add(collection);
          write({ kind: 'delete', collection, key });
        }
      }
      for (const name of beforeCollections) if (!presentCollections.has(name)) {
        const _rows345 = this.connection.prepare(
          'SELECT row_key FROM storage_rows WHERE collection=?').all(name);
        for (const _r of _rows345) syncBridge.enqueue('delete', name, _r.row_key, null);
        this.connection.prepare('DELETE FROM storage_rows WHERE collection=?').run(name);
        this.statements.deleteCollection.run(name);
        changedCollections.add(name);
        write({ kind: 'deleteCollection', collection: name });
      }
      for (const [key, payload] of beforeValues) {
        if (!Object.hasOwn(data || {}, key) || data[key] === undefined) {
          this.statements.deleteValue.run(key);
          syncBridge.enqueue('delete_value', key, key, null);
          write({ kind: 'deleteValue', key });
        }
      }
      for (const [key, value] of Object.entries(data || {})) {
        if (CATALOG_KEYS.has(key) || Array.isArray(value) || value === undefined) continue;
        presentValues.add(key);
        const payload = JSON.stringify(value) ?? 'null';
        if (beforeValues.get(key) !== payload) {
          this.statements.upsertValue.run(key, payload);
          syncBridge.enqueue('upsert_value', key, key, payload);
          write({ kind: 'upsertValue', key });
        }
      }
      if (typeof beforeCommit === 'function') beforeCommit(this.connection);
      this._flushSyncBeforeCommit();
      this.connection.exec('COMMIT');
      this._clearPendingSync();
      syncBridge.notifyPg();
      this.recordWalMetrics('after_save');
      return {
        writtenRows,
        deletedRows,
        changedCollections: [...changedCollections],
        fallbackCollections
      };
    } catch (error) {
      try { this.connection.exec('ROLLBACK'); } catch {}
      this._clearPendingSync();
      throw error;
    }
  }

  saveTracked(changes) {
    this.assertOpen();
    const collections = changes?.collections || [];
    const values = changes?.values || [];
    const deleteValues = changes?.deleteValues || [];
    if (!collections.length && !values.length && !deleteValues.length) return { writtenRows: 0, deletedRows: 0, changedCollections: [], fallbackCollections: [] };
    try {
      this.connection.exec('BEGIN IMMEDIATE');
      let writes = 0;
      let deletedRows = 0;
      const changed = [];
      for (const collection of collections) {
        const { name } = collection;
        changed.push(name);
        this.statements.addCollection.run(name);
        writes += 1;
        if (collection.remove) {
          const _rows396 = this.connection.prepare(
            'SELECT row_key FROM storage_rows WHERE collection=?').all(name);
          for (const _r of _rows396) syncBridge.enqueue('delete', name, _r.row_key, null);
          this.connection.prepare('DELETE FROM storage_rows WHERE collection=?').run(name);
          this.statements.deleteCollection.run(name);
          writes += 1;
          continue;
        }
        if (collection.replace) {
          const _rows402 = this.connection.prepare(
            'SELECT row_key FROM storage_rows WHERE collection=?').all(name);
          for (const _r of _rows402) syncBridge.enqueue('delete', name, _r.row_key, null);
          this.connection.prepare('DELETE FROM storage_rows WHERE collection=?').run(name);
          deletedRows += this.connection.prepare('SELECT changes() AS n').get().n;
          writes += 1;
        }
        for (const key of collection.deletes || []) {
          this.statements.deleteRow.run(name, key);
          syncBridge.enqueue('delete', name, key, null);
          deletedRows += this.connection.prepare('SELECT changes() AS n').get().n;
          writes += 1;
          if (this.faultInjector) this.faultInjector(writes, { kind: 'delete', collection: name, key });
        }
        const ordinalKeys = new Set();
        for (const { key, ordinal } of collection.ordinals || []) {
          ordinalKeys.add(key);
          this.statements.updateOrdinal.run(ordinal, name, key);
          writes += 1;
          if (this.faultInjector) this.faultInjector(writes, { kind: 'ordinal', collection: name, key, ordinal });
        }
        for (const { key, ordinal, row } of collection.rows || []) {
          const payload = JSON.stringify(row);
          this.statements.upsertRow.run(name, key, ordinal, payload === undefined ? 'null' : payload);
          syncBridge.enqueue('upsert', name, key, payload === undefined ? 'null' : payload);
          writes += 1;
          if (this.faultInjector) this.faultInjector(writes, { kind: 'upsert', collection: name, key, ordinal });
        }
      }
      for (const { name, value } of values) {
        this.statements.upsertValue.run(name, JSON.stringify(value));
        syncBridge.enqueue('upsert_value', name, name, JSON.stringify(value));
        writes += 1;
        if (this.faultInjector) this.faultInjector(writes, { kind: 'value', name });
      }
      for (const name of deleteValues) {
        this.statements.deleteValue.run(name);
        syncBridge.enqueue('delete_value', name, name, null);
        writes += 1;
        if (this.faultInjector) this.faultInjector(writes, { kind: 'deleteValue', name });
      }
      this._flushSyncBeforeCommit();
      this.connection.exec('COMMIT');
      this._clearPendingSync();
      syncBridge.notifyPg();
      return { writtenRows: collections.reduce((sum, collection) => sum + (collection.rows?.length || 0), 0), deletedRows, changedCollections: changed, fallbackCollections: [] };
    } catch (error) {
      try { this.connection.exec('ROLLBACK'); } catch {}
      this._clearPendingSync();
      throw error;
    }
  }

  saveHinted(hint, beforeCommit = null) {
    this.assertOpen();
    const collections = hint?.collections || {};
    const values = hint?.values || {};
    const deletedValues = hint?.deleteValues || [];
    try {
      this.connection.exec('BEGIN IMMEDIATE');
      let writtenRows = 0;
      let deletedRows = 0;
      const changedCollections = [];
      for (const [name, change] of Object.entries(collections)) {
        changedCollections.push(name);
        this.statements.addCollection.run(name);
        for (const item of change?.rows || change?.upsert || []) {
          const row = item.row || item;
          const ordinal = Number.isSafeInteger(Number(item.ordinal)) ? Number(item.ordinal) : Number(item.index || 0);
          const usingIdxFallback = (item.ordinal == null && item.index != null);
          if (usingIdxFallback && syncBridge.isMirrored(name)) {
            throw new Error(
              'saveHinted: numeric idx fallback rejected for mirrored collection ' + name);
          }
          const key = item.key || rowKey(row, ordinal);
          this.statements.upsertRow.run(name, key, ordinal, JSON.stringify(row) ?? 'null');
          syncBridge.enqueue('upsert', name, key, JSON.stringify(row) ?? 'null');
          writtenRows += 1;
        }
        for (const item of change?.deletes || change?.deleteIds || []) {
          const key = typeof item === 'string' && /^(?:id:|idx:)/u.test(item)
            ? item : rowKey({ id: item }, 0);
          this.statements.deleteRow.run(name, key);
          syncBridge.enqueue('delete', name, key, null);
          deletedRows += Number(this.connection.prepare('SELECT changes() AS n').get().n || 0);
        }
        for (const item of change?.ordinals || []) this.statements.updateOrdinal.run(Number(item.ordinal), name, item.key || rowKey(item.row || item, Number(item.ordinal)));
      }
      for (const [name, value] of Object.entries(values)) {
        this.statements.upsertValue.run(name, JSON.stringify(value) ?? 'null');
        syncBridge.enqueue('upsert_value', name, name, JSON.stringify(value) ?? 'null');
      }
      for (const name of deletedValues) {
        this.statements.deleteValue.run(String(name));
        syncBridge.enqueue('delete_value', name, name, null);
      }
      if (typeof beforeCommit === 'function') beforeCommit(this.connection);
      this._flushSyncBeforeCommit();
      this.connection.exec('COMMIT');
      this._clearPendingSync();
      syncBridge.notifyPg();
      return { writtenRows, deletedRows, changedCollections, fallbackCollections: [] };
    } catch (error) {
      try { this.connection.exec('ROLLBACK'); } catch {}
      this._clearPendingSync();
      throw error;
    }
  }

  withTransaction(operation) {
    this.assertOpen();
    if (typeof operation !== 'function') throw new TypeError('SQLite transaction requires a callback.');
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const result = operation(this.connection);
      if (result && typeof result.then === 'function') throw new TypeError('SQLite transaction callback must be synchronous.');
      this._flushSyncBeforeCommit();
      this.connection.exec('COMMIT');
      this._clearPendingSync();
      syncBridge.notifyPg();
      this.recordWalMetrics('after_transaction');
      return result;
    } catch (error) {
      try { this.connection.exec('ROLLBACK'); } catch {}
      this._clearPendingSync();
      throw error;
    }
  }

  quickCheck() {
    this.assertOpen();
    const row = this.connection.prepare('PRAGMA quick_check').get();
    return row?.quick_check || Object.values(row || {})[0] || '';
  }

  close() {
    if (this.closed) return;
    if (this.checkpointTimer) { clearInterval(this.checkpointTimer); this.checkpointTimer = null; }
    try { this.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    this.recordWalMetrics('after_close_checkpoint');
    this.connection.close();
    this.closed = true;
  }

  recordWalMetrics(stage) {
    if (!this.walMetricsFile) return;
    try {
      const sizes = {};
      for (const suffix of ['', '-wal', '-shm']) {
        const file = `${this.filePath}${suffix}`;
        sizes[suffix || 'main'] = fs.existsSync(file) ? fs.statSync(file).size : 0;
      }
      sizes.total = sizes.main + sizes['-wal'] + sizes['-shm'];
      fs.mkdirSync(require('node:path').dirname(this.walMetricsFile), { recursive: true });
      fs.appendFileSync(this.walMetricsFile, `${JSON.stringify({ stage, file: this.filePath, ...sizes, at: new Date().toISOString() })}\n`);
    } catch {}
  }
}

function createSqliteStorageAdapter(filePath, options) { return new SQLiteStorageAdapter(filePath, options); }

module.exports = {
  SQLiteStorageAdapter,
  createSqliteStorageAdapter,
  getDatabaseSync,
  installSqliteWarningFilter,
  normalizedHint,
  stateFromData
};
