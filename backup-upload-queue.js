'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// The secondary path may be a Google Drive/OneDrive sync folder.  Never block
// the sale on that path: failed copies are encrypted into this local queue and
// retried by the background timer.
function createBackupUploadQueue({ queueDir, getTargetDir, logger = console, retryMs = 30000 }) {
  const root = path.resolve(queueDir);
  const keyPath = path.join(root, '.backup-queue.key');
  let timer = null;

  function key() {
    fs.mkdirSync(root, { recursive: true });
    if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
    const value = fs.readFileSync(keyPath);
    if (value.length !== 32) throw new Error('Invalid local backup queue key.');
    return value;
  }

  function enqueue(sourceFile, name) {
    const plain = fs.readFileSync(sourceFile);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const payload = Buffer.concat([Buffer.from('SYSTEM-BACKUP-QUEUE\0'), iv, cipher.getAuthTag(), encrypted]);
    const safeName = String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
    const target = path.join(root, `${Date.now()}-${safeName}.queued`);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, payload, { flag: 'wx' });
    fs.renameSync(temporary, target);
    logger.warn?.(`Backup queued for retry: ${target}`);
    return target;
  }

  function flush() {
    const targetDir = String(getTargetDir?.() || '').trim();
    if (!targetDir || !fs.existsSync(root)) return { uploaded: 0, pending: 0 };
    let uploaded = 0;
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isFile() && item.name.endsWith('.queued'))) {
      const queuedPath = path.join(root, entry.name);
      try {
        const payload = fs.readFileSync(queuedPath);
        const header = Buffer.from('SYSTEM-BACKUP-QUEUE\0');
        if (!payload.subarray(0, header.length).equals(header)) throw new Error('Invalid queued backup header.');
        const ivStart = header.length;
        const iv = payload.subarray(ivStart, ivStart + 12);
        const tag = payload.subarray(ivStart + 12, ivStart + 28);
        const encrypted = payload.subarray(ivStart + 28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        fs.mkdirSync(targetDir, { recursive: true });
        const name = entry.name.replace(/^\d+-/, '').replace(/\.queued$/u, '');
        const destination = path.join(path.resolve(targetDir), name);
        const temporary = `${destination}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, plain, { flag: 'wx' });
        fs.renameSync(temporary, destination);
        fs.unlinkSync(queuedPath);
        uploaded += 1;
      } catch (error) { logger.warn?.(`Backup queue retry deferred: ${error.message}`); }
    }
    return { uploaded, pending: fs.existsSync(root) ? fs.readdirSync(root).filter(name => name.endsWith('.queued')).length : 0 };
  }

  function start() {
    if (timer) return timer;
    timer = setInterval(() => { try { flush(); } catch (error) { logger.warn?.(`Backup queue flush failed: ${error.message}`); } }, retryMs);
    timer.unref?.();
    return timer;
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { enqueue, flush, start, stop, queueDir: root };
}

module.exports = { createBackupUploadQueue };
