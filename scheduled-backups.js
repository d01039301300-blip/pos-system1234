'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { copySqliteDatabase } = require('./sqlite-backup');
const { createBackupUploadQueue } = require('./backup-upload-queue');

function writeAtomic(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

function createScheduledBackupManager(options) {
  const userDataDir = path.resolve(options.userDataDir);
  const getBackupDir = typeof options.getBackupDir === 'function' ? options.getBackupDir : () => path.join(userDataDir, 'backups');
  const databaseFile = path.resolve(options.databaseFile);
  const getCatalogRows = options.getCatalogRows || (() => null);
  const getSecondaryPath = options.getSecondaryPath || (() => '');
  const logger = options.logger || console;
  const onBackupCreated = options.onBackupCreated;
  const cloudPreparationTasks = new Set();
  const now = options.now || (() => new Date());
  const getRetention = typeof options.getRetention === 'function' ? options.getRetention : () => options.maxBackups;
  const schedulerIntervalMs = Number(options.schedulerIntervalMs) > 0 ? Number(options.schedulerIntervalMs) : 60 * 60 * 1000;
  const backupDir = () => path.resolve(getBackupDir() || path.join(userDataDir, 'backups'));
  const uploadQueue = createBackupUploadQueue({
    queueDir: path.join(userDataDir, 'backup-upload-queue'),
    getTargetDir: getSecondaryPath,
    logger,
    retryMs: Number(options.queueRetryMs) > 0 ? Number(options.queueRetryMs) : 30000
  });

  function queueCloudPreparation(backup, reason) {
    if (typeof onBackupCreated !== 'function') return;
    const task = Promise.resolve().then(() => onBackupCreated({ ...backup, reason })).catch(error => {
      logger.warn?.('Cloud backup preparation failed; the local backup remains available:', error.message);
    }).finally(() => cloudPreparationTasks.delete(task));
    cloudPreparationTasks.add(task);
  }

  async function flushCloudPreparation() {
    await Promise.allSettled([...cloudPreparationTasks]);
  }

  function listBackups() {
    if (!fs.existsSync(backupDir())) return [];
    return fs.readdirSync(backupDir(), { withFileTypes: true })
      .filter(entry => entry.isFile() && /^scheduled-(daily|close|manual|automatic)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/u.test(entry.name))
      .map(entry => {
        const fullPath = path.join(backupDir(), entry.name);
        const stat = fs.statSync(fullPath);
        return { name: entry.name, size: stat.size, modified_at: stat.mtime.toISOString(), path: fullPath };
      })
      .sort((a, b) => {
        const stampOf = name => Date.parse(name.replace(/^scheduled-(?:daily|close|manual|automatic)-/u, '').replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.sqlite$/u, 'T$1:$2:$3.$4Z')) || 0;
        return stampOf(b.name) - stampOf(a.name);
      });
  }

  async function createBackup(reason = 'daily') {
    if (!['daily', 'close', 'manual', 'automatic'].includes(reason)) throw new Error('نوع النسخة الاحتياطية غير صالح.');
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const name = `scheduled-${reason}-${stamp}.sqlite`;
    const filePath = path.join(backupDir(), name);
    const backup = await copySqliteDatabase(databaseFile, filePath, { catalogRows: getCatalogRows() });
    queueCloudPreparation({ name, path: filePath, size: backup.size, method: backup.method }, reason);

    try {
      const secondary = String(getSecondaryPath() || '').trim();
      if (secondary) {
        const secondaryRoot = path.resolve(secondary);
        const secondaryFile = path.join(secondaryRoot, name);
        if (path.resolve(secondaryFile) !== path.resolve(filePath)) {
          fs.mkdirSync(path.dirname(secondaryFile), { recursive: true });
          const secondaryTemp = `${secondaryFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
          fs.copyFileSync(filePath, secondaryTemp, fs.constants?.COPYFILE_EXCL || 0);
          fs.renameSync(secondaryTemp, secondaryFile);
        }
      }
    } catch (error) {
      logger.error?.('Secondary scheduled backup failed; queued for retry:', error.message);
      try { uploadQueue.enqueue(filePath, name); }
      catch (queueError) { logger.error?.('Secondary scheduled backup failed and could not be queued:', `${error.message}; ${queueError.message}`); }
    }

    const retention = Number(getRetention());
    const maxBackups = Number.isInteger(retention) && retention > 0 ? retention : 30;
    const existing = listBackups();
    for (const stale of existing.slice(maxBackups)) {
      try { fs.unlinkSync(stale.path); }
      catch (error) { logger.error?.('Scheduled backup retention cleanup failed:', error.message); }
    }
    return { name, path: filePath, size: backup.size, method: backup.method };
  }

  function getBackupPath(name) {
    const safeName = String(name || '');
    if (!/^scheduled-(daily|close|manual|automatic)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/u.test(safeName)) return null;
    const candidate = path.resolve(backupDir(), safeName);
    if (path.dirname(candidate) !== backupDir() || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
    return candidate;
  }

  async function createSafetyBackup() {
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const name = `safety-${stamp}-${crypto.randomBytes(4).toString('hex')}.sqlite`;
    const filePath = path.join(backupDir(), 'safety', name);
    const backup = await copySqliteDatabase(databaseFile, filePath, { catalogRows: getCatalogRows() });
    const result = { name, path: filePath, size: backup.size, method: backup.method };
    queueCloudPreparation(result, 'safety');
    return result;
  }

  function startDailyScheduler() {
    uploadQueue.start();
    let lastScheduleKey = '';
    const maybeCreate = () => {
      const schedule = typeof options.getSchedule === 'function' ? options.getSchedule() : { enabled: true, frequency: 'daily', time: '02:00' };
      if (schedule.enabled === false) return;
      const current = now();
      const [hours, minutes] = String(schedule.time || '02:00').split(':').map(Number);
      if (current.getHours() * 60 + current.getMinutes() < (Number.isFinite(hours) ? hours * 60 : 120) + (Number.isFinite(minutes) ? minutes : 0)) return;
      const day = current.toISOString().slice(0, 10);
      const key = schedule.frequency === 'monthly' ? day.slice(0, 7) : schedule.frequency === 'weekly' ? `${current.getUTCFullYear()}-W${Math.floor((Date.parse(day) - Date.parse(`${current.getUTCFullYear()}-01-01`)) / 604800000)}` : day;
      if (key === lastScheduleKey) return;
      if (listBackups().some(entry => entry.name.includes(`-${key}`))) { lastScheduleKey = key; return; }
      lastScheduleKey = key;
      void createBackup('automatic').catch(error => { lastScheduleKey = ''; logger.error?.('Automatic scheduled backup failed:', error.message); });
    };
    maybeCreate();
    const timer = setInterval(() => {
      try { maybeCreate(); } catch (error) { logger.error?.('Automatic scheduled backup failed:', error.message); }
    }, schedulerIntervalMs);
    timer.unref?.();
    return timer;
  }

  function stop() { uploadQueue.stop(); }
  return { backupDir: backupDir(), getBackupDir: backupDir, databaseFile, listBackups, createBackup, getBackupPath, createSafetyBackup, startDailyScheduler, flushCloudPreparation, stop, uploadQueue };
}

module.exports = { createScheduledBackupManager };
