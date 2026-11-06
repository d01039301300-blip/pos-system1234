'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSqliteStorageAdapter, getDatabaseSync } = require('./storage-adapter');
const DatabaseSync = getDatabaseSync();
const { backup } = require('node:sqlite');

function recordWalMetric(stage, filePath) {
  const target = process.env.RAWDA_WAL_METRICS_FILE;
  if (!target) return;
  try {
    const sizes = {};
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${filePath}${suffix}`;
      sizes[suffix || 'main'] = fs.existsSync(file) ? fs.statSync(file).size : 0;
    }
    sizes.total = sizes.main + sizes['-wal'] + sizes['-shm'];
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${JSON.stringify({ stage, file: filePath, ...sizes, at: new Date().toISOString() })}\n`);
  } catch {}
}

function sqlString(value) { return `'${String(value).replace(/'/g, "''")}'`; }

async function copySqliteDatabase(sourceFile, targetFile, { catalogRows } = {}) {
  const source = path.resolve(sourceFile);
  const target = path.resolve(targetFile);
  if (source === target) throw new Error('مسار نسخة SQLite يطابق مسار القاعدة الأصلية.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `b-${crypto.randomBytes(6).toString('hex')}.sqlite`);
  let sourceDb;
  let tempAdapter;
  try {
    sourceDb = new DatabaseSync(source, { readOnly: true });
    recordWalMetric('before_backup', source);
    if (typeof backup === 'function') await backup(sourceDb, temporary);
    else sourceDb.exec(`VACUUM INTO ${sqlString(temporary)}`);
    if (Array.isArray(catalogRows)) {
      tempAdapter = createSqliteStorageAdapter(temporary);
      const data = tempAdapter.load();
      data.backup_business_catalog = catalogRows;
      tempAdapter.save(data, { collections: { backup_business_catalog: null } });
      tempAdapter.close();
      tempAdapter = null;
    }
    try { sourceDb.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    recordWalMetric('after_backup', source);
    sourceDb.close();
    sourceDb = null;
    fs.renameSync(temporary, target);
    return { path: target, size: fs.statSync(target).size, method: typeof backup === 'function' ? 'node:sqlite.backup' : 'VACUUM INTO' };
  } catch (error) {
    try { tempAdapter?.close(); } catch {}
    try { sourceDb?.close(); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function validateSqliteDatabase(filePath) {
  const adapter = createSqliteStorageAdapter(filePath);
  try {
    const integrity = adapter.quickCheck();
    if (integrity !== 'ok') throw new Error(`SQLite quick_check failed: ${integrity}`);
    const data = adapter.load();
    if (Array.isArray(data.backup_business_catalog)) {
      data.business_catalog = data.backup_business_catalog;
      delete data.backup_business_catalog;
    }
    if (!Array.isArray(data.products) || !Array.isArray(data.categories) || !Array.isArray(data.users)) throw new Error('ملف SQLite لا يحتوي مجموعات النظام الأساسية.');
    return data;
  } finally { adapter.close(); }
}

module.exports = { copySqliteDatabase, validateSqliteDatabase };
