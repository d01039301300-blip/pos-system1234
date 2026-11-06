'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const FORMAT_MAGIC = Buffer.from('SYSTEMGDRIVE1\0', 'ascii');
const PASSWORD_FORMAT_MAGIC = Buffer.from('SYSTEMGDRIVE2\0', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const HEADER_BYTES = FORMAT_MAGIC.length + IV_BYTES;
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_API = 'https://oauth2.googleapis.com/token';
const AUTH_API = 'https://accounts.google.com/o/oauth2/v2/auth';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const CHUNK_BYTES = 8 * 1024 * 1024;

function validateClientId(value) {
  const id = String(value || '').trim();
  if (id.length < 20 || id.length > 255 || !/^[\w.-]+\.apps\.googleusercontent\.com$/u.test(id)) throw new Error('أدخل معرّف OAuth صالحاً لتطبيق Desktop من Google Cloud.');
  return id;
}

function safeFileName(value) {
  const base = path.basename(String(value || 'backup.sqlite')).replace(/[^\p{L}\p{N}._-]/gu, '_');
  return base.slice(0, 160) || 'backup.sqlite';
}

async function atomicJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    await fsp.rename(temporary, filePath);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function encryptBackupFile(sourceFile, targetFile, key) {
  const secret = Buffer.from(key);
  if (secret.length !== 32) throw new Error('مفتاح التشفير المحلي يجب أن يكون 256 بت.');
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', secret, iv);
  const header = Buffer.concat([FORMAT_MAGIC, iv]);
  const temporary = `${targetFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.mkdir(path.dirname(targetFile), { recursive: true });
  const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
  output.write(header);
  try {
    await pipeline(fs.createReadStream(sourceFile), cipher, output);
    await fsp.appendFile(temporary, cipher.getAuthTag());
    await fsp.rename(temporary, targetFile);
    return { path: targetFile, size: (await fsp.stat(targetFile)).size, iv: iv.toString('base64') };
  } catch (error) {
    output.destroy();
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function decryptBackupFile(sourceFile, targetFile, key) {
  const secret = Buffer.from(key);
  if (secret.length !== 32) throw new Error('مفتاح التشفير المحلي يجب أن يكون 256 بت.');
  const stat = await fsp.stat(sourceFile);
  if (stat.size < HEADER_BYTES + TAG_BYTES) throw new Error('ملف النسخة المشفرة غير مكتمل.');
  const handle = await fsp.open(sourceFile, 'r');
  let header;
  let tag;
  try {
    header = Buffer.alloc(HEADER_BYTES);
    tag = Buffer.alloc(TAG_BYTES);
    await handle.read(header, 0, HEADER_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, stat.size - TAG_BYTES);
  } finally { await handle.close(); }
  if (!header.subarray(0, FORMAT_MAGIC.length).equals(FORMAT_MAGIC)) throw new Error('صيغة النسخة المشفرة غير معروفة.');
  const iv = header.subarray(FORMAT_MAGIC.length);
  const decipher = crypto.createDecipheriv('aes-256-gcm', secret, iv);
  decipher.setAuthTag(tag);
  const temporary = `${targetFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.mkdir(path.dirname(targetFile), { recursive: true });
  try {
    await pipeline(fs.createReadStream(sourceFile, { start: HEADER_BYTES, end: stat.size - TAG_BYTES - 1 }), decipher, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    await fsp.rename(temporary, targetFile);
    return targetFile;
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function passwordKey(password, salt) {
  const value = String(password || '');
  if (value.length < 10) throw new Error('كلمة مرور النسخ يجب أن تتكون من 10 أحرف على الأقل.');
  return crypto.scryptSync(value, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

async function encryptBackupFileWithPassword(sourceFile, targetFile, password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = passwordKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const header = Buffer.concat([PASSWORD_FORMAT_MAGIC, salt, iv]);
  const temporary = `${targetFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.mkdir(path.dirname(targetFile), { recursive: true });
  const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
  output.write(header);
  try {
    await pipeline(fs.createReadStream(sourceFile), cipher, output);
    await fsp.appendFile(temporary, cipher.getAuthTag());
    await fsp.rename(temporary, targetFile);
    return { path: targetFile, size: (await fsp.stat(targetFile)).size };
  } catch (error) {
    output.destroy();
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function decryptBackupFileWithPassword(sourceFile, targetFile, password) {
  const stat = await fsp.stat(sourceFile);
  const headerBytes = PASSWORD_FORMAT_MAGIC.length + SALT_BYTES + IV_BYTES;
  if (stat.size < headerBytes + TAG_BYTES) throw new Error('ملف النسخة المشفرة غير مكتمل.');
  const handle = await fsp.open(sourceFile, 'r');
  const header = Buffer.alloc(headerBytes);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    await handle.read(header, 0, headerBytes, 0);
    await handle.read(tag, 0, TAG_BYTES, stat.size - TAG_BYTES);
  } finally { await handle.close(); }
  if (!header.subarray(0, PASSWORD_FORMAT_MAGIC.length).equals(PASSWORD_FORMAT_MAGIC)) throw new Error('صيغة النسخة لا تدعم كلمة المرور أو النسخة قديمة.');
  const saltStart = PASSWORD_FORMAT_MAGIC.length;
  const salt = header.subarray(saltStart, saltStart + SALT_BYTES);
  const iv = header.subarray(saltStart + SALT_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', passwordKey(password, salt), iv);
  decipher.setAuthTag(tag);
  const temporary = `${targetFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.mkdir(path.dirname(targetFile), { recursive: true });
  try {
    await pipeline(fs.createReadStream(sourceFile, { start: headerBytes, end: stat.size - TAG_BYTES - 1 }), decipher, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    await fsp.rename(temporary, targetFile);
    return targetFile;
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    if (/auth|authenticate|Unsupported state/i.test(error.message)) throw new Error('كلمة المرور غير صحيحة أو محتوى النسخة عُدّل.');
    throw error;
  }
}

function createGoogleDriveBackupService(options = {}) {
  const userDataDir = path.resolve(options.userDataDir || process.cwd());
  const queueDir = path.join(userDataDir, 'google-drive-backup-queue');
  const getConfig = options.getConfig || (() => ({}));
  const secretStore = options.secretStore || {};
  const openExternal = options.openExternal || (async () => { throw new Error('فتح متصفح النظام متاح من تطبيق Electron فقط.'); });
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const logger = options.logger || console;
  const now = options.now || (() => Date.now());
  const retryMs = Math.max(1000, Number(options.retryMs) || 30000);
  const requestTimeoutMs = Math.max(1000, Number(options.requestTimeoutMs) || 20000);
  let timer = null;
  let drainPromise = null;
  let authFlow = null;
  let connectedAccount = '';
  let lastError = '';
  let lastUploaded = null;
  let stopping = false;

  function requireFetch() { if (typeof fetchImpl !== 'function') throw new Error('لا تتوفر خدمة HTTPS في بيئة التشغيل.'); }
  async function readSecret(name) {
    if (typeof secretStore.get !== 'function') throw new Error('التخزين الآمن متاح داخل تطبيق Electron فقط.');
    return secretStore.get(name);
  }
  async function writeSecret(name, value) {
    if (typeof secretStore.set !== 'function') throw new Error('التخزين الآمن متاح داخل تطبيق Electron فقط.');
    return secretStore.set(name, String(value));
  }
  async function clearSecret(name) {
    if (typeof secretStore.delete !== 'function') throw new Error('التخزين الآمن متاح داخل تطبيق Electron فقط.');
    return secretStore.delete(name);
  }
  async function getEncryptionKey() {
    let encoded = await readSecret('google-drive-encryption-key');
    if (!encoded) {
      encoded = crypto.randomBytes(32).toString('base64');
      await writeSecret('google-drive-encryption-key', encoded);
    }
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32) throw new Error('مفتاح التشفير المحلي المحفوظ غير صالح.');
    return key;
  }
  async function getBackupPassword() { return readSecret('google-drive-backup-password'); }
  async function setBackupPassword(value) {
    const password = String(value || '');
    if (password.length < 10 || password.length > 256) throw new Error('كلمة مرور النسخ يجب أن تكون بين 10 و256 حرفاً.');
    await writeSecret('google-drive-backup-password', password);
    return { saved: true };
  }
  async function backupMetadata(filePath, encryptedPath) {
    const base = { encryptedHash: await fileHash(encryptedPath), dataHash: await fileHash(filePath), appVersion: String(require('./package.json').version).slice(0, 100), createdAt: new Date(now()).toISOString(), schemaVersion: 0, counts: { invoices: 0, products: 0, customers: 0 } };
    let database;
    try {
      const { DatabaseSync } = require('node:sqlite');
      database = new DatabaseSync(filePath, { readOnly: true });
      const count = name => Number(database.prepare('SELECT count(*) AS n FROM storage_rows WHERE collection=?').get(name)?.n || 0);
      base.schemaVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version || 0);
      base.counts = { invoices: count('sales'), products: count('products'), customers: count('customers') };
    } catch (error) { logger.warn?.(`Backup metadata counts unavailable: ${error.message}`); }
    finally { try { database?.close(); } catch {} }
    return base;
  }
  function configuredClientId() { return validateClientId(getConfig()?.google_drive_client_id); }
  function enabled() { return getConfig()?.google_drive_enabled === true; }
  function authorizationUrl(clientId, redirectUri, state, verifier) {
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const url = new URL(AUTH_API);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: DRIVE_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }).toString();
    return url.toString();
  }
  async function jsonRequest(url, init = {}) {
    requireFetch();
    const response = await fetchImpl(url, { ...init, signal: init.signal || AbortSignal.timeout(requestTimeoutMs) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error_description || data.error?.message || data.error || `Google Drive returned HTTP ${response.status}.`);
    return { response, data };
  }
  async function exchangeCode(clientId, code, verifier, redirectUri) {
    const fields = new URLSearchParams({ client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' });
    const { data } = await jsonRequest(TOKEN_API, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: fields });
    if (!data.refresh_token || !data.access_token) throw new Error('Google لم يُرجع رموز وصول قابلة للاستخدام.');
    const token = { refresh_token: data.refresh_token, access_token: data.access_token, expires_at: now() + Math.max(0, Number(data.expires_in) || 0) * 1000, token_type: data.token_type || 'Bearer' };
    await writeSecret('google-drive-oauth-tokens', JSON.stringify(token));
    await options.onConnected?.();
    void drain().catch(error => logger.warn?.('Google Drive queue start after authorization failed:', error.message));
    connectedAccount = String(data.email || 'متصل بحساب Google');
    lastError = '';
    return token;
  }
  async function startAuthorization() {
    if (authFlow) return { started: true, already_running: true };
    const clientId = configuredClientId();
    const state = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const callbackServer = http.createServer();
    let settle;
    const callbackResult = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    callbackServer.on('request', (req, res) => {
      const callbackUrl = new URL(req.url || '/', 'http://127.0.0.1');
      if (callbackUrl.pathname !== '/oauth2/callback') { res.writeHead(404).end('Not found'); return; }
      if (callbackUrl.searchParams.get('state') !== state) { res.writeHead(400).end('Invalid OAuth state.'); settle.reject(new Error('فشل التحقق من حالة OAuth.')); return; }
      const error = callbackUrl.searchParams.get('error');
      if (error) { res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end('<p>لم يتم منح إذن Google Drive. يمكنك إغلاق هذه النافذة.</p>'); settle.reject(new Error(`لم يكتمل تفويض Google Drive: ${error}`)); return; }
      const code = callbackUrl.searchParams.get('code');
      if (!code) { res.writeHead(400).end('Missing authorization code.'); settle.reject(new Error('لم يرجع Google رمز التفويض.')); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end('<!doctype html><meta charset="utf-8"><title>Google Drive</title><p>تم ربط النسخ الاحتياطي. يمكنك إغلاق هذه النافذة والعودة إلى البرنامج.</p>');
      settle.resolve(code);
    });
    callbackServer.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { callbackServer.once('listening', resolve); callbackServer.once('error', reject); });
    const address = callbackServer.address();
    const redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`;
    const authorization = authorizationUrl(clientId, redirectUri, state, verifier);
    const timeout = setTimeout(() => settle.reject(new Error('انتهت مهلة ربط Google Drive. أعد المحاولة.')), 5 * 60 * 1000);
    authFlow = (async () => {
      try {
        await openExternal(authorization);
        const code = await callbackResult;
        await exchangeCode(clientId, code, verifier, redirectUri);
        return { connected: true };
      } catch (error) {
        lastError = error.message;
        throw error;
      } finally {
        clearTimeout(timeout);
        callbackServer.close();
        authFlow = null;
      }
    })();
    authFlow.catch(() => {});
    return { started: true };
  }
  async function getAccessToken() {
    const raw = await readSecret('google-drive-oauth-tokens');
    if (!raw) throw new Error('لم يتم ربط Google Drive بعد.');
    const token = JSON.parse(raw);
    if (token.access_token && Number(token.expires_at) > now() + 60000) return token.access_token;
    const fields = new URLSearchParams({ client_id: configuredClientId(), refresh_token: token.refresh_token, grant_type: 'refresh_token' });
    const { data } = await jsonRequest(TOKEN_API, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: fields });
    token.access_token = data.access_token;
    token.expires_at = now() + Math.max(0, Number(data.expires_in) || 0) * 1000;
    token.token_type = data.token_type || 'Bearer';
    await writeSecret('google-drive-oauth-tokens', JSON.stringify(token));
    return token.access_token;
  }
  async function fileHash(filePath) {
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(filePath), new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(); }, flush(callback) { callback(); } }), new Transform({ transform(_chunk, _encoding, callback) { callback(); } }));
    return hash.digest('hex');
  }
  async function findExisting(accessToken, hash) {
    const query = `appProperties has { key='systemBackupSha256' and value='${hash}' } and trashed=false`;
    const url = new URL(`${DRIVE_API}/files`);
    url.search = new URLSearchParams({ q: query, spaces: 'drive', pageSize: '5', fields: 'files(id,name)' }).toString();
    const { data } = await jsonRequest(url, { headers: { authorization: `Bearer ${accessToken}` } });
    return Array.isArray(data.files) ? data.files[0] || null : null;
  }
  async function uploadEncryptedFile(filePath, name, metadata = {}) {
    const accessToken = await getAccessToken();
    const stat = await fsp.stat(filePath);
    const hash = await fileHash(filePath);
    const existing = await findExisting(accessToken, hash);
    if (existing) return { id: existing.id, name: existing.name, deduplicated: true };
    const driveMetadata = { name: `${safeFileName(name)}.aesgcm`, mimeType: 'application/octet-stream', description: 'SYSTEM encrypted SQLite backup (AES-256-GCM)', appProperties: { systemBackupSha256: hash, systemBackupDataSha256: metadata.dataHash || '', systemBackupFormat: metadata.format || 'aes-256-gcm-v1', systemBackupAppVersion: metadata.appVersion || 'unknown', systemBackupCreatedAt: metadata.createdAt || new Date(now()).toISOString(), systemBackupSchemaVersion: String(metadata.schemaVersion || 0), systemBackupCounts: JSON.stringify(metadata.counts || { invoices: 0, products: 0, customers: 0 }) } };
    const init = await jsonRequest(`${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=id,name`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'application/octet-stream', 'x-upload-content-length': String(stat.size) },
      body: JSON.stringify(driveMetadata)
    });
    let sessionUrl = init.response.headers.get('location');
    if (!sessionUrl) throw new Error('Google Drive لم يُرجع رابط الرفع القابل للاستئناف.');
    const parsedSession = new URL(sessionUrl);
    if (parsedSession.protocol !== 'https:' || !['www.googleapis.com', 'upload.googleapis.com'].includes(parsedSession.hostname)) throw new Error('رابط جلسة الرفع من Google Drive غير موثوق.');
    const handle = await fsp.open(filePath, 'r');
    try {
      async function querySessionStatus() {
        const response = await fetchImpl(sessionUrl, { method: 'PUT', headers: { 'content-length': '0', 'content-range': `bytes */${stat.size}` }, signal: AbortSignal.timeout(requestTimeoutMs) });
        if (response.status === 308) {
          const range = response.headers.get('range');
          // Google documents that a missing Range means it received no bytes.
          return { offset: range ? Number(/bytes=0-(\d+)/u.exec(range)?.[1] || -1) + 1 : 0 };
        }
        const data = await response.json().catch(() => ({}));
        if (response.ok) return { complete: true, data };
        throw new Error(data.error?.message || `Google Drive upload status returned HTTP ${response.status}.`);
      }
      let offset = 0;
      while (offset < stat.size) {
        const length = Math.min(CHUNK_BYTES, stat.size - offset);
        const chunk = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(chunk, 0, length, offset);
        if (bytesRead !== length) throw new Error('تغير حجم النسخة المشفرة أثناء الرفع.');
        const end = offset + length - 1;
        let response;
        try {
          response = await fetchImpl(sessionUrl, { method: 'PUT', headers: { 'content-length': String(length), 'content-range': `bytes ${offset}-${end}/${stat.size}` }, body: chunk, signal: AbortSignal.timeout(requestTimeoutMs) });
        } catch (error) {
          const status = await querySessionStatus();
          if (status.complete) return status.data;
          offset = status.offset;
          continue;
        }
        if (response.status >= 500) {
          const status = await querySessionStatus();
          if (status.complete) return status.data;
          offset = status.offset;
          continue;
        }
        if (response.status === 308) {
          const range = response.headers.get('range');
          offset = range ? Number(/bytes=0-(\d+)/u.exec(range)?.[1] || -1) + 1 : 0;
          continue;
        }
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error?.message || `Google Drive upload failed with HTTP ${response.status}.`);
        offset = end + 1;
        if (offset >= stat.size) return result;
      }
      throw new Error('اكتمل رفع البيانات دون تأكيد من Google Drive.');
    } finally { await handle.close(); }
  }
  async function pendingJobs() {
    await fsp.mkdir(queueDir, { recursive: true });
    const entries = await fsp.readdir(queueDir, { withFileTypes: true });
    const jobs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.job.json')) continue;
      try { jobs.push(JSON.parse(await fsp.readFile(path.join(queueDir, entry.name), 'utf8'))); }
      catch (error) { logger.error?.('Google Drive backup queue metadata is unreadable:', error.message); }
    }
    return jobs.sort((a, b) => a.created_at - b.created_at);
  }
  async function enqueueBackup(sourceFile, name) {
    if (stopping || !enabled()) return { queued: false, reason: 'Google Drive backup is disabled.' };
    const password = await getBackupPassword();
    if (!password) throw new Error('احفظ كلمة مرور نسخ سحابية أولاً لتكون النسخة قابلة للاستعادة على جهاز آخر.');
    const key = null;
    const safeName = safeFileName(name);
    const id = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    const encryptedPath = path.join(queueDir, `${id}-${safeName}.aesgcm`);
    const encrypted = await encryptBackupFileWithPassword(sourceFile, encryptedPath, password);
    const metadata = await backupMetadata(sourceFile, encryptedPath);
    const job = { version: password ? 2 : 1, id, source_name: safeName, encrypted_name: path.basename(encryptedPath), created_at: now(), attempts: 0, next_retry_at: 0, metadata: { ...metadata, format: password ? 'aes-256-gcm-v2-scrypt' : 'aes-256-gcm-v1' } };
    await atomicJson(path.join(queueDir, `${id}.job.json`), job);
    void drain().catch(error => logger.warn?.('Google Drive backup worker deferred:', error.message));
    return { queued: true, id, encrypted_size: (await fsp.stat(encryptedPath)).size };
  }
  async function drain({ force = false } = {}) {
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
      if (stopping || !enabled()) return { uploaded: 0, pending: (await pendingJobs()).length };
      let uploaded = 0;
      for (const job of await pendingJobs()) {
        if (stopping) break;
        if (!force && Number(job.next_retry_at) > now()) continue;
        const jobPath = path.join(queueDir, `${job.id}.job.json`);
        const encryptedPath = path.join(queueDir, job.encrypted_name);
        try {
          if (!fs.existsSync(encryptedPath)) throw new Error('ملف النسخة المشفرة في طابور الرفع غير موجود.');
          const result = await uploadEncryptedFile(encryptedPath, job.source_name, job.metadata || {});
          lastUploaded = { name: result.name || `${job.source_name}.aesgcm`, at: new Date(now()).toISOString(), id: result.id || '' };
          lastError = '';
          await fsp.rm(encryptedPath, { force: true });
          await fsp.rm(jobPath, { force: true });
          uploaded += 1;
        } catch (error) {
          job.attempts = (Number(job.attempts) || 0) + 1;
          job.next_retry_at = now() + Math.min(60 * 60 * 1000, retryMs * (2 ** Math.min(job.attempts - 1, 6)));
          job.last_error = String(error.message || error).slice(0, 500);
          await atomicJson(jobPath, job).catch(writeError => logger.error?.('Google Drive retry state write failed:', writeError.message));
          lastError = job.last_error;
          logger.warn?.(`Google Drive upload queued for retry (${job.attempts}): ${job.last_error}`);
          // One network outage should not delay unrelated local POS work or spin through every queued item.
          break;
        }
      }
      return { uploaded, pending: (await pendingJobs()).length };
    })().finally(() => { drainPromise = null; });
    return drainPromise;
  }
  async function listBackups() {
    const accessToken = await getAccessToken();
    const query = "appProperties has { key='systemBackupSha256' } and trashed=false";
    const files = [];
    let pageToken = '';
    do {
      const url = new URL(`${DRIVE_API}/files`);
      url.search = new URLSearchParams({ q: query, spaces: 'drive', pageSize: '100', orderBy: 'createdTime desc', fields: 'nextPageToken,files(id,name,size,createdTime,mimeType,appProperties)', ...(pageToken ? { pageToken } : {}) }).toString();
      const { data } = await jsonRequest(url, { headers: { authorization: `Bearer ${accessToken}` } });
      for (const file of Array.isArray(data.files) ? data.files : []) {
        const props = file.appProperties || {};
        if (!file.id || !String(props.systemBackupFormat || '').startsWith('aes-256-gcm')) continue;
        let counts = {};
        try { counts = JSON.parse(props.systemBackupCounts || '{}'); } catch {}
        files.push({ id: file.id, name: file.name || 'backup.aesgcm', size: Number(file.size) || 0, created_at: props.systemBackupCreatedAt || file.createdTime || '', app_version: props.systemBackupAppVersion || 'unknown', schema_version: Number(props.systemBackupSchemaVersion) || 0, counts: { invoices: Number(counts.invoices) || 0, products: Number(counts.products) || 0, customers: Number(counts.customers) || 0 }, format: props.systemBackupFormat, sha256: props.systemBackupSha256 || '', data_sha256: props.systemBackupDataSha256 || '' });
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return files;
  }
  async function prepareRestore(fileId, password) {
    const id = String(fileId || '');
    if (!/^[\w-]{5,200}$/u.test(id)) throw new Error('معرّف النسخة غير صالح.');
    const files = await listBackups();
    const metadata = files.find(file => file.id === id);
    if (!metadata) throw new Error('النسخة غير موجودة في حساب Google Drive.');
    const restoreDir = path.join(queueDir, 'restore-staging');
    await fsp.mkdir(restoreDir, { recursive: true });
    const idSuffix = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const encryptedPath = path.join(restoreDir, `${idSuffix}.aesgcm`);
    const databasePath = path.join(restoreDir, `${idSuffix}.sqlite`);
    try {
      const accessToken = await getAccessToken();
      const response = await fetchImpl(`${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(requestTimeoutMs) });
      if (!response.ok) throw new Error(`تعذر تنزيل النسخة (HTTP ${response.status}).`);
      if (response.body && typeof Readable.fromWeb === 'function') {
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(encryptedPath, { flags: 'wx', mode: 0o600 }));
      } else {
        const bytes = Buffer.from(await response.arrayBuffer());
        await fsp.writeFile(encryptedPath, bytes, { flag: 'wx', mode: 0o600 });
      }
      const encryptedSize = (await fsp.stat(encryptedPath)).size;
      if (!encryptedSize || encryptedSize > 1024 * 1024 * 1024 || (metadata.size && encryptedSize !== metadata.size)) throw new Error('تنزيل النسخة غير مكتمل أو تجاوز الحجم المسموح.');
      const encryptedHash = await fileHash(encryptedPath);
      if (!metadata.sha256 || encryptedHash !== metadata.sha256) throw new Error('فشل التحقق من بصمة النسخة المنزّلة.');
      if (metadata.format === 'aes-256-gcm-v2-scrypt') await decryptBackupFileWithPassword(encryptedPath, databasePath, password);
      else if (metadata.format === 'aes-256-gcm-v1') await decryptBackupFile(encryptedPath, databasePath, await getEncryptionKey());
      else throw new Error('صيغة النسخة غير مدعومة.');
      if (metadata.data_sha256 && await fileHash(databasePath) !== metadata.data_sha256) throw new Error('فشل التحقق من بصمة قاعدة البيانات بعد فك التشفير.');
      return { path: databasePath, metadata };
    } catch (error) {
      await fsp.rm(databasePath, { force: true }).catch(() => {});
      throw error;
    } finally { await fsp.rm(encryptedPath, { force: true }).catch(() => {}); }
  }
  async function discardPreparedRestore(filePath) { await fsp.rm(filePath, { force: true }); }
  function start() {
    if (timer) return timer;
    stopping = false;
    timer = setInterval(() => { void drain().catch(error => { lastError = error.message; logger.warn?.('Google Drive queue retry failed:', error.message); }); }, retryMs);
    timer.unref?.();
    void drain().catch(error => { lastError = error.message; logger.warn?.('Google Drive initial queue retry failed:', error.message); });
    return timer;
  }
  async function disconnect() {
    const raw = await readSecret('google-drive-oauth-tokens').catch(() => null);
    if (raw) {
      try {
        const token = JSON.parse(raw);
        const value = token.refresh_token || token.access_token;
        if (value) await fetchImpl('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: value }), signal: AbortSignal.timeout(requestTimeoutMs) });
      } catch (_) {}
    }
    await clearSecret('google-drive-oauth-tokens');
    connectedAccount = '';
  }
  async function getStatus() {
    const jobs = await pendingJobs().catch(() => []);
    const token = await readSecret('google-drive-oauth-tokens').catch(() => null);
    const backupPassword = await readSecret('google-drive-backup-password').catch(() => null);
    return { configured: Boolean(String(getConfig()?.google_drive_client_id || '').trim()), client_id: String(getConfig()?.google_drive_client_id || ''), enabled: enabled(), connected: Boolean(token) && enabled(), password_configured: Boolean(backupPassword), connecting: Boolean(authFlow), account: connectedAccount || (token && enabled() ? 'متصل بحساب Google' : ''), pending: jobs.length, queued_bytes: jobs.reduce((sum, job) => { try { return sum + fs.statSync(path.join(queueDir, job.encrypted_name)).size; } catch (_) { return sum; } }, 0), last_uploaded: lastUploaded, last_error: lastError };
  }
  async function stop() {
    stopping = true;
    if (timer) clearInterval(timer);
    timer = null;
  }
  return { queueDir, encryptBackupFile, decryptBackupFile, setBackupPassword, listBackups, prepareRestore, discardPreparedRestore, startAuthorization, enqueueBackup, drain, start, stop, disconnect, getStatus, isEnabled: enabled };
}

module.exports = { createGoogleDriveBackupService, encryptBackupFile, decryptBackupFile, encryptBackupFileWithPassword, decryptBackupFileWithPassword, validateClientId, FORMAT_MAGIC, PASSWORD_FORMAT_MAGIC, HEADER_BYTES, TAG_BYTES };
