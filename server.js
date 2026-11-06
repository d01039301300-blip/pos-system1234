const express = require('express');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const branchContext = new AsyncLocalStorage();
const os = require('os');
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const { performance } = require('node:perf_hooks');
const SERVER_PROFILE_START = performance.now();
const serverProfile = name => { if (process.env.RAWDA_PROFILE === '1') console.error(`[PROFILE] server ${name}: ${(performance.now() - SERVER_PROFILE_START).toFixed(2)}ms`); };
const https = require('https');
const license = require('./license');
const { isUnrestrictedAccount, TABS: ACCESS_TABS } = require('./account-access');
const { createScheduledBackupManager } = require('./scheduled-backups');
const { createGoogleDriveBackupService, validateClientId } = require('./google-drive-backup');
const { createSqliteStorageAdapter } = require('./storage-adapter');
const { copySqliteDatabase, validateSqliteDatabase } = require('./sqlite-backup');
const { classifyDatabaseLocation } = require('./electron/startup-runtime');
let createCampaignManager;
try { ({ createCampaignManager } = require('./campaign-whatsapp-manager')); }
catch (error) { console.error(`Campaign manager unavailable: ${error.stack || error.message}`); }
const { sanitizeCatalogExtraFields } = require('./business-catalog-utils');
const { registerWarehouseOperations, ensureBranchWarehouse } = require('./warehouse-operations');
const { normalizePaymentSplits } = require('./pos-payments');
const { postSaleToAccounting, postPurchaseToAccounting, postExpenseToAccounting, postCashTransactionToAccounting, postCashTransferToAccounting } = require('./accounting');
const { registerAccountingRoutes } = require('./accounting-routes');
const { registerWalletRoutes } = require('./wallet-routes');
const { listAlerts: listWalletAlerts, walletRow, assertWalletScope } = require('./wallet-service');
const { registerSmsRoutes } = require('./sms-routes');
const { registerHardwareRoutes } = require('./hardware-routes');
const { seedHardwareProfilesForBranch } = require('./migrations/011-hardware-profiles');
const { listNotifications: listSmsNotifications, createPending } = require('./sms-service');

const electronHostRequests = new Map();
let electronHostRequestSequence = 0;
function requestElectronHost(action, payload = {}) {
  if (typeof process.send !== 'function') return Promise.reject(new Error('خدمات التشفير الآمن وفتح متصفح النظام تتطلب تطبيق Electron.'));
  const requestId = `cloud-${process.pid}-${++electronHostRequestSequence}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { electronHostRequests.delete(requestId); reject(new Error('انتهت مهلة خدمة Electron الآمنة.')); }, 15000);
    electronHostRequests.set(requestId, { resolve, reject, timeout });
    process.send({ type: 'electron-host-request', request_id: requestId, action, ...payload }, error => {
      if (!error) return;
      clearTimeout(timeout);
      electronHostRequests.delete(requestId);
      reject(error);
    });
  });
}
function receiveElectronHostResponse(message) {
  if (message?.type !== 'electron-host-response') return false;
  const pending = electronHostRequests.get(message.request_id);
  if (!pending) return true;
  electronHostRequests.delete(message.request_id);
  clearTimeout(pending.timeout);
  if (message.error) pending.reject(new Error(String(message.error)));
  else pending.resolve(message.result);
  return true;
}
license.configureDefaultStorage();
const db = require('./database');
if (!Array.isArray(db.data.login_attempts)) { db.data.login_attempts = []; db.save(['login_attempts']); }
serverProfile('database-module-loaded');
const DEV_LICENSE_BYPASS = process.env.NODE_ENV === 'development';
function getEffectiveLicenseStatus() {
  const status = license.getStatus();
  return DEV_LICENSE_BYPASS
    ? { ...status, active: true, trial: false, licensed: true, state: 'licensed', reason: 'development-bypass' }
    : status;
}
const TRIAL_ACCESS_ACTIVE = Boolean(getEffectiveLicenseStatus().active && getEffectiveLicenseStatus().trial);
const isTrialPeriodActive = () => Boolean(getEffectiveLicenseStatus().active && getEffectiveLicenseStatus().trial);
let tlsListener = null;
const PASSWORD_HASH_ITERATIONS = 600000;
const PASSWORD_HASH_PREFIX = 'pbkdf2-sha256';
// Production/client builds always enforce bootstrap password rotation. The
// only bypass is an explicit BUILD_MODE=dev; an omitted or unknown value is
// deliberately treated as the client build.
const BUILD_MODE = process.env.BUILD_MODE === 'dev' ? 'dev' : 'client';
// Password rotation is currently disabled for the active UAT flow.  The
// account remains usable even when legacy records still carry the marker.
const ENFORCE_PASSWORD_CHANGE = false;
// The existing UI intentionally contains inline handlers/styles and loads the
// already-approved Cairo/Font Awesome stylesheets. Keep those exact resources
// working while blocking plugins, framing, remote API calls, and untrusted
// object/script sources.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
  "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
].join('; ');

const passwordHash = (password, salt = crypto.randomBytes(16).toString('base64url')) => {
  const digest = crypto.pbkdf2Sync(String(password), salt, PASSWORD_HASH_ITERATIONS, 32, 'sha256').toString('base64url');
  return `${PASSWORD_HASH_PREFIX}$${PASSWORD_HASH_ITERATIONS}$${salt}$${digest}`;
};
const passwordHashAsync = password => new Promise((resolve, reject) => {
  const salt = crypto.randomBytes(16).toString('base64url');
  crypto.pbkdf2(String(password), salt, PASSWORD_HASH_ITERATIONS, 32, 'sha256', (error, digest) => {
    if (error) return reject(error);
    resolve(`${PASSWORD_HASH_PREFIX}$${PASSWORD_HASH_ITERATIONS}$${salt}$${digest.toString('base64url')}`);
  });
});
const isPasswordHash = value => typeof value === 'string' && value.startsWith(`${PASSWORD_HASH_PREFIX}$`);
const verifyPassword = async (password, encoded) => {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 4 || parts[0] !== PASSWORD_HASH_PREFIX) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) return false;
  const expected = Buffer.from(parts[3], 'base64url');
  if (expected.length !== 32) return false;
  const actual = await new Promise((resolve, reject) => crypto.pbkdf2(String(password), parts[2], iterations, 32, 'sha256', (error, digest) => error ? reject(error) : resolve(digest)));
  return crypto.timingSafeEqual(actual, expected);
};
const verifyPasswordSync = (password, encoded) => {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 4 || parts[0] !== PASSWORD_HASH_PREFIX) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) return false;
  const expected = Buffer.from(parts[3], 'base64url');
  if (expected.length !== 32) return false;
  const actual = crypto.pbkdf2Sync(String(password), parts[2], iterations, 32, 'sha256');
  return crypto.timingSafeEqual(actual, expected);
};

const normalizeCatalogText = value => String(value ?? '').toLocaleLowerCase('ar')
  .normalize('NFD').replace(/[\u064B-\u065F\u0670\u0640]/g, '').trim();

// Offline owner account for the publisher's maintenance access. It lives in
// the selected database so application upgrades do not remove it.
const OWNER_USERNAME = 'admin1';
const STANDARD_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'admin123';
const DEFAULT_BOOTSTRAP_PASSWORDS = Object.freeze(['admin123', 'inv123', 'cash123']);
const ADMIN_PERMISSIONS = ['view','add','edit','delete','import_export','print_pdf','system_settings','user_management','image_management'];
const ROLE_ALIASES = Object.freeze({ admin: 'manager', inventory_manager: 'manager' });
const ROLE_DEFAULTS = Object.freeze({
  owner: Object.freeze({ permissions: [...ADMIN_PERMISSIONS], allowed_tabs: null, is_owner: true }),
  manager: Object.freeze({ permissions: [...ADMIN_PERMISSIONS], allowed_tabs: null, is_owner: false }),
  cashier: Object.freeze({ permissions: ['view', 'add', 'print_pdf'], allowed_tabs: ['pos'], is_owner: false }),
  accountant: Object.freeze({ permissions: ['view', 'print_pdf', 'system_settings', 'import_export'], allowed_tabs: ['dashboard', 'sales-history', 'purchases', 'suppliers', 'treasury', 'reports', 'audit-logs'], is_owner: false })
});
const normalizeRole = role => ROLE_DEFAULTS[role] ? role : (ROLE_ALIASES[role] || null);
const roleDefaults = role => ROLE_DEFAULTS[normalizeRole(role)] || null;
const isManagerRole = role => ['admin', 'manager'].includes(String(role || ''));

function ensureStandardAdmin() {
  if (!Array.isArray(db.data.users)) db.data.users = [];
  const existingAdmin = db.data.users.find(user => user.username === STANDARD_ADMIN_USERNAME);
  if (existingAdmin) {
    const hashParts = String(existingAdmin.password_hash || '').split('$');
    const usableHash = hashParts.length === 4
      && hashParts[0] === PASSWORD_HASH_PREFIX
      && Number.isInteger(Number(hashParts[1]))
      && Number(hashParts[1]) >= 100000
      && Number(hashParts[1]) <= 1000000
      && Buffer.from(hashParts[3], 'base64url').length === 32;
    if (!usableHash) {
      if (DEFAULT_BOOTSTRAP_PASSWORDS.includes(existingAdmin.password_hash)) {
        existingAdmin.password_hash = passwordHash(existingAdmin.password_hash);
        existingAdmin.must_change_password = true;
        existingAdmin.bootstrap_password_initialized = true;
        return true;
      }
      const recoveryPassword = `Recovery-${crypto.randomBytes(8).toString('hex')}!`;
      existingAdmin.password_hash = passwordHash(recoveryPassword);
      existingAdmin.must_change_password = true;
      existingAdmin.bootstrap_password_initialized = true;
      console.warn('[AUTH] Existing admin hash was reset; temporary recovery password:', recoveryPassword);
      return true;
    }
    return false;
  }
  db.data.users.push({
    id: db.nextId('users'),
    name: 'مدير النظام',
    username: STANDARD_ADMIN_USERNAME,
    password_hash: passwordHash(DEFAULT_ADMIN_PASSWORD),
    must_change_password: true,
    bootstrap_password_initialized: true,
    role: 'admin',
    permissions: [...ADMIN_PERMISSIONS],
    is_active: true,
    is_owner: false,
    created_at: new Date().toISOString().replace('T', ' ').substring(0, 19)
  });
  return true;
}

function ensureLicensedAccounts() {
  let changed = ensureStandardAdmin();
  for (const user of db.data.users) {
    if (user.username === 'trial' && user.is_active) { user.is_active = false; changed = true; }
  }
  let owner = db.data.users.find(user => user.username === OWNER_USERNAME);
  if (!owner) {
    owner = {
      id: db.nextId('users'), name: 'مالك النظام', username: OWNER_USERNAME,
      role: 'admin', permissions: [...ADMIN_PERMISSIONS], is_active: true, is_owner: true,
      created_at: new Date().toISOString().replace('T', ' ').substring(0, 19)
    };
    db.data.users.push(owner);
    changed = true;
  }
  if (!owner.bootstrap_password_initialized) {
    const ownerPassword = crypto.randomBytes(18).toString('base64url');
    owner.password_hash = passwordHash(ownerPassword);
    owner.must_change_password = true;
    owner.bootstrap_password_initialized = true;
    changed = true;
    console.log('كلمة المرور المؤقتة لحساب admin1 (تُعرض مرة واحدة): ' + ownerPassword);
  }
  if (changed) db.save();
}

if (TRIAL_ACCESS_ACTIVE) {
  if (ensureStandardAdmin()) db.save();
} else {
  ensureLicensedAccounts();
}
serverProfile('licensed-account-normalization');

// Upgrade older plaintext records on disk with a unique salt before serving requests.
let migratedPasswords = false;
for (const user of db.data.users) {
  if (typeof user.password_hash === 'string' && !isPasswordHash(user.password_hash)) {
    user.password_hash = passwordHash(user.password_hash);
    migratedPasswords = true;
  }
}
let migratedDefaultPasswords = false;
for (const user of db.data.users) {
  if (user.username === OWNER_USERNAME || user.username === STANDARD_ADMIN_USERNAME || user.must_change_password === true) continue;
  let matchedDefault = false;
  for (const defaultPassword of DEFAULT_BOOTSTRAP_PASSWORDS) {
    try {
      if (verifyPasswordSync(defaultPassword, user.password_hash)) { matchedDefault = true; break; }
    } catch (_) {}
  }
  if (matchedDefault) { user.must_change_password = true; migratedDefaultPasswords = true; }
}
if (!db.data.system_settings || typeof db.data.system_settings !== 'object') db.data.system_settings = {};
if (!db.data.system_settings.maintenance || typeof db.data.system_settings.maintenance !== 'object') {
  db.data.system_settings.maintenance = { enabled: false, message_ar: 'النظام في وضع الصيانة المؤقتة. حاول مرة أخرى بعد قليل.', message_en: 'The system is temporarily under maintenance. Please try again shortly.', expected_end: '' };
  migratedDefaultPasswords = true;
}
if (!Object.prototype.hasOwnProperty.call(db.data.system_settings, 'return_window_days')) { db.data.system_settings.return_window_days = 14; migratedDefaultPasswords = true; }
if (!db.data.system_settings.backup_settings || typeof db.data.system_settings.backup_settings !== 'object') { db.data.system_settings.backup_settings = { enabled: true, frequency: 'daily', time: '02:00', path: './backups', retention: 30 }; migratedDefaultPasswords = true; }
if (migratedDefaultPasswords || !db.data.system_settings.last_user_migration) {
  db.data.system_settings.last_user_migration = new Date().toISOString();
  migratedDefaultPasswords = true;
}
if (migratedPasswords || migratedDefaultPasswords) db.save();
serverProfile('password-normalization');

const app = express();
const loginSessions = new Map();
const passwordChangeAttempts = new Map();
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 5;
const PASSWORD_CHANGE_WINDOW_MS = 60 * 60 * 1000;
const PASSWORD_CHANGE_LIMIT = 5;
function loginAttemptKey(ip, username) { return `${ip || 'unknown'}|${String(username || '').trim().toLocaleLowerCase('en')}`; }
function getLoginAttempt(key, now = Date.now()) {
  const rows = db.data.login_attempts;
  const index = rows.findIndex(entry => entry.key === key);
  if (index < 0) return null;
  const attempt = rows[index];
  if (now - Number(attempt.windowStartedAt || 0) >= LOGIN_ATTEMPT_WINDOW_MS) { rows.splice(index, 1); db.save(['login_attempts']); return null; }
  return attempt;
}
function recordFailedLogin(key, username, now = Date.now()) {
  const rows = db.data.login_attempts;
  let attempt = getLoginAttempt(key, now);
  if (!attempt) { attempt = { key, username: String(username || '').trim().toLocaleLowerCase('en'), windowStartedAt: now, count: 0, lockedUntil: 0 }; rows.push(attempt); }
  attempt.count = Number(attempt.count || 0) + 1;
  if (attempt.count >= LOGIN_ATTEMPT_LIMIT) attempt.lockedUntil = now + LOGIN_ATTEMPT_WINDOW_MS;
  db.save(['login_attempts']);
  return attempt;
}
function clearLoginAttempt(key) {
  const rows = db.data.login_attempts;
  const remaining = rows.filter(entry => entry.key !== key);
  if (remaining.length !== rows.length) { db.data.login_attempts = remaining; db.save(['login_attempts']); }
}
const webAuthnChallenges = new Map();
const SESSION_COOKIE = 'system_session';
const LEGACY_SESSION_COOKIE = 'rawda_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const webAuthnRpId = () => {
  const publicUrl = String(readRuntimeConfig().public_url || '').trim();
  if (publicUrl) { try { const parsed = new URL(publicUrl); if (parsed.protocol === 'https:') return parsed.hostname; } catch (_) {} }
  return 'localhost';
};
const webAuthnOrigin = () => {
  const publicUrl = String(readRuntimeConfig().public_url || '').trim();
  if (publicUrl) {
    try { const parsed = new URL(publicUrl); if (parsed.protocol === 'https:') return parsed.origin; } catch (_) {}
  }
  return `http://localhost:${PORT}`;
};
const base64url = value => Buffer.from(value).toString('base64url');
const fromBase64url = value => Buffer.from(String(value || ''), 'base64url');
function readCbor(buffer, start = 0) {
  let offset = start;
  const readLength = additional => {
    if (additional < 24) return additional;
    const sizes = { 24: 1, 25: 2, 26: 4, 27: 8 };
    const size = sizes[additional];
    if (!size || offset + size > buffer.length) throw new Error('بيانات WebAuthn غير مكتملة.');
    let value = 0n;
    for (let index = 0; index < size; index += 1) value = (value << 8n) | BigInt(buffer[offset++]);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('قيمة CBOR أكبر من الحد المسموح.');
    return Number(value);
  };
  const decode = () => {
    if (offset >= buffer.length) throw new Error('بيانات WebAuthn غير مكتملة.');
    const initial = buffer[offset++];
    const major = initial >> 5;
    const additional = initial & 31;
    if (major === 7) {
      if (additional === 20) return false;
      if (additional === 21) return true;
      if (additional === 22) return null;
      throw new Error('نوع CBOR غير مدعوم.');
    }
    const length = readLength(additional);
    if (major === 0) return length;
    if (major === 1) return -1 - length;
    if (major === 2 || major === 3) {
      if (offset + length > buffer.length) throw new Error('بيانات WebAuthn غير مكتملة.');
      const value = buffer.subarray(offset, offset + length);
      offset += length;
      return major === 2 ? value : value.toString('utf8');
    }
    if (major === 4) return Array.from({ length }, decode);
    if (major === 5) {
      const value = new Map();
      for (let index = 0; index < length; index += 1) value.set(decode(), decode());
      return value;
    }
    if (major === 6) return decode();
    throw new Error('نوع CBOR غير مدعوم.');
  };
  const value = decode();
  return { value, offset };
}
const webAuthnUser = user => ({ id: user.id, name: user.name, username: user.username, must_change_password: Boolean(user.must_change_password), role: user.role, permissions: Array.isArray(user.permissions) ? user.permissions : [], granular_permissions: granularPermissionsForUser(user), permission_constraints: permissionConstraintsForUser(user), is_owner: Boolean(user.is_owner), allowed_tabs: Array.isArray(user.allowed_tabs) ? user.allowed_tabs : null, branch_id: user.branch_id ?? null, branch_ids: getUserBranchIds(user) });
function getUserBranchIds(user) {
  const primary = Number(user?.branch_id || db.data.default_branch_id || 1);
  const raw = Array.isArray(user?.branch_ids) ? user.branch_ids : [primary];
  const valid = [...new Set(raw.map(Number).filter(id => Number.isInteger(id) && db.data.branches.some(branch => Number(branch.id) === id && branch.is_active !== false)))];
  if (Number.isInteger(primary) && primary > 0 && !valid.includes(primary) && db.data.branches.some(branch => Number(branch.id) === primary && branch.is_active !== false)) valid.unshift(primary);
  return valid;
}
function issueLoginSession(user, req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  loginSessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
  const secureCookie = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secureCookie}`);
  const loginAudit = user.role === 'super_owner'
    ? { username: user.username, ip: req.ip || req.socket?.remoteAddress || '', timestamp: new Date().toISOString() }
    : `تسجيل دخول ناجح للمستخدم ${user.name}`;
  db.logAudit(user.id, user.role === 'super_owner' ? 'تسجيل دخول super_owner' : 'تسجيل دخول', 'users', user.id, loginAudit);
  return webAuthnUser(user);
}
function verifyWebAuthnClientData(clientDataJSON, expectedType, expectedChallenge) {
  const clientData = JSON.parse(fromBase64url(clientDataJSON).toString('utf8'));
  if (clientData.type !== expectedType || clientData.challenge !== expectedChallenge || clientData.origin !== webAuthnOrigin() || clientData.crossOrigin === true) {
    throw new Error('تعذر التحقق من طلب Windows Hello.');
  }
  return clientData;
}
function webAuthnPublicKey(cose) {
  if (!(cose instanceof Map)) throw new Error('مفتاح Windows Hello غير صالح.');
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) {
    return crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: base64url(cose.get(-2)), y: base64url(cose.get(-3)), ext: true } });
  }
  if (kty === 3 && alg === -257) {
    return crypto.createPublicKey({ format: 'jwk', key: { kty: 'RSA', n: base64url(cose.get(-1)), e: base64url(cose.get(-2)), ext: true } });
  }
  throw new Error('نوع مفتاح Windows Hello غير مدعوم على هذا الجهاز.');
}
function parseAuthenticatorData(authData, requireAttested = false) {
  if (authData.length < 37) throw new Error('بيانات المصادقة غير مكتملة.');
  const flags = authData[32];
  if (!(flags & 0x01) || !(flags & 0x04)) throw new Error('يلزم تأكيد المستخدم عبر Windows Hello.');
  const counter = authData.readUInt32BE(33);
  const result = { flags, counter };
  if (requireAttested) {
    if (!(flags & 0x40) || authData.length < 55) throw new Error('بيانات تسجيل Windows Hello غير مكتملة.');
    const credentialLength = authData.readUInt16BE(53);
    const credentialStart = 55;
    const credentialEnd = credentialStart + credentialLength;
    if (!credentialLength || credentialEnd >= authData.length) throw new Error('معرّف جهاز Windows Hello غير صالح.');
    const parsed = readCbor(authData, credentialEnd);
    result.credentialId = authData.subarray(credentialStart, credentialEnd);
    result.publicKey = webAuthnPublicKey(parsed.value);
  }
  return result;
}
function cleanExpiredWebAuthnChallenges() {
  const now = Date.now();
  for (const [key, value] of webAuthnChallenges) if (value.expiresAt <= now) webAuthnChallenges.delete(key);
}
const getCookieToken = req => {
  const cookies = String(req.headers.cookie || '').split(';').map(part => part.trim());
  const current = cookies.find(part => part.startsWith(`${SESSION_COOKIE}=`));
  if (current) return current.slice(SESSION_COOKIE.length + 1);
  const legacy = cookies.find(part => part.startsWith(`${LEGACY_SESSION_COOKIE}=`));
  return legacy?.slice(LEGACY_SESSION_COOKIE.length + 1) || '';
};
function passwordChangeAttempt(ip, now = Date.now()) {
  const key = String(ip || 'unknown');
  const current = passwordChangeAttempts.get(key);
  if (!current || now - current.startedAt >= PASSWORD_CHANGE_WINDOW_MS) {
    const next = { startedAt: now, count: 0 };
    passwordChangeAttempts.set(key, next);
    return next;
  }
  return current;
}
function strongPasswordError(password, currentPassword = '') {
  if (password === currentPassword) return 'كلمة المرور الجديدة يجب أن تختلف عن الحالية.';
  if (password.length < 8 || !/[A-Z]/u.test(password) || !/\d/u.test(password) || !/[^\p{L}\p{N}]/u.test(password)) {
    return 'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل وتحتوي على حرف كبير ورقم ورمز.';
  }
  return '';
}
function maintenanceSettings() {
  const fallback = { enabled: false, message_ar: 'النظام في وضع الصيانة المؤقتة. حاول مرة أخرى بعد قليل.', message_en: 'The system is temporarily under maintenance. Please try again shortly.', expected_end: '' };
  const value = db.data.system_settings?.maintenance;
  return { ...fallback, ...(value && typeof value === 'object' ? value : {}) };
}
const isMaintenanceOwner = user => Boolean(user && (user.is_owner === true || user.role === 'owner' || user.role === 'super_owner'));
const permissionSet = user => new Set(Array.isArray(user?.permissions) ? user.permissions : []);
function granularPermissionValue(user, code) {
  if (!user || !String(code || '').includes('.')) return null;
  try {
    const row = db.storageAdapter?.connection?.prepare(`
      SELECT COALESCE(up.granted, rd.granted, 0) AS granted
      FROM permissions p
      LEFT JOIN role_defaults rd ON rd.permission_id=p.id AND rd.role=?
      LEFT JOIN user_permissions up ON up.permission_id=p.id AND up.user_id=?
      WHERE p.code=?
    `).get(String(user.role || ''), Number(user.id), String(code));
    return row ? Number(row.granted) === 1 : null;
  } catch (_) { return null; }
}
function granularPermissionsForUser(user) {
  if (!user) return [];
  try {
    return db.storageAdapter.connection.prepare(`
      SELECT p.code FROM permissions p
      LEFT JOIN role_defaults rd ON rd.permission_id=p.id AND rd.role=?
      LEFT JOIN user_permissions up ON up.permission_id=p.id AND up.user_id=?
      WHERE COALESCE(up.granted, rd.granted, 0)=1 ORDER BY p.category,p.code
    `).all(String(user.role || ''), Number(user.id)).map(row => row.code);
  } catch (_) { return []; }
}
function permissionConstraintsForUser(user) {
  try {
    return db.storageAdapter.connection.prepare('SELECT max_discount_percent,max_invoice_amount,can_delete_invoice FROM permission_constraints WHERE user_id=?').get(Number(user?.id))
      || { max_discount_percent: 100, max_invoice_amount: 0, can_delete_invoice: 0 };
  } catch (_) { return { max_discount_percent: 100, max_invoice_amount: 0, can_delete_invoice: 0 }; }
}
const userHasPermission = (user, permission) => {
  if (isUnrestrictedAccount(user)) return true;
  const granular = granularPermissionValue(user, permission);
  return granular === null ? permissionSet(user).has(permission) : granular;
};
function explicitBranchAccess(userId, branchId) {
  try {
    return db.storageAdapter?.connection?.prepare('SELECT access_level FROM user_branches WHERE user_id=? AND branch_id=?').get(Number(userId), Number(branchId))?.access_level || null;
  } catch (_) { return null; }
}
function branchAccessLevel(user, branchId) {
  if (isUnrestrictedAccount(user)) return 'write';
  const explicit = explicitBranchAccess(user?.id, branchId);
  if (explicit) return explicit;
  const assigned = getUserBranchIds(user).includes(Number(branchId));
  if (assigned) return normalizeRole(user?.role) === 'accountant' ? 'read' : 'write';
  return ['manager', 'accountant'].includes(normalizeRole(user?.role)) ? 'read' : 'none';
}
function replaceUserBranchAccess(userId, branchIds, accessEntries = null, role = '') {
  const ids = [...new Set((branchIds || []).map(Number).filter(Number.isInteger))];
  const requested = Array.isArray(accessEntries) ? accessEntries : ids.map(branchId => ({ branch_id: branchId, access_level: normalizeRole(role) === 'accountant' ? 'read' : 'write' }));
  const entries = requested.map(item => ({ branch_id: Number(item.branch_id), access_level: String(item.access_level || '') }))
    .filter(item => ids.includes(item.branch_id));
  if (entries.some(item => !['read', 'write', 'none'].includes(item.access_level))) throw new Error('مستوى وصول الفرع غير صالح.');
  const connection = db.storageAdapter?.connection;
  if (!connection) throw new Error('تعذر الوصول إلى جدول صلاحيات الفروع.');
  connection.exec('BEGIN IMMEDIATE');
  try {
    connection.prepare('DELETE FROM user_branches WHERE user_id=?').run(Number(userId));
    const insert = connection.prepare('INSERT INTO user_branches(user_id,branch_id,access_level,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)');
    for (const entry of entries) insert.run(Number(userId), entry.branch_id, entry.access_level);
    connection.exec('COMMIT');
  } catch (error) {
    try { connection.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return entries;
}
function permissionsForRequest(req) {
  const route = req.path.replace(/^\/+|\/+$/g, '');
  if (route === 'me/password' || route === 'auth/change-password' || route === 'auth/logout-all') return [];
  if (route === 'logout' || route === 'me') return [];
  if (route === 'maintenance/toggle') return [];
  if (route === 'config' && req.method === 'GET') return [];
  if (/^users\/\d+\/permissions$/.test(route) || route === 'permissions/catalog') return ['users.manage_permissions'];
  if (route === 'products/import' || route === 'business-catalog/add-to-inventory') return ['import_export', 'add', 'edit'];
  if (route === 'sales' || route.startsWith('sales/')) {
    if (/\/return(?:\/|$)/.test(`/${route}`)) return ['sales.return'];
    if (req.method === 'GET' || req.method === 'HEAD') return ['sales.view'];
    if (req.method === 'POST') return ['sales.create'];
    if (req.method === 'DELETE') return ['sales.delete'];
    return ['sales.edit_price'];
  }
  if (route === 'accounting/journal' || route.startsWith('accounting/journal/')) return [req.method === 'GET' ? 'accounting.journal' : 'accounting.edit'];
  if (route === 'accounting' || route.startsWith('accounting/')) return [req.method === 'GET' ? 'accounting.view' : 'accounting.edit'];
  if (route === 'wallets' || route.startsWith('wallets/')) {
    if (/transfer/.test(route)) return ['wallets.transfer'];
    if (req.method === 'GET' || req.method === 'HEAD') return ['wallets.view'];
    return ['wallets.' + (req.method === 'POST' ? 'create' : 'edit')];
  }
  if (route === 'sms' || route.startsWith('sms/')) return [route.includes('device') ? 'sms.devices' : (route.includes('manual') ? 'sms.manual_match' : 'sms.view')];
  if (route === 'reports' || route.startsWith('reports/')) return [route.includes('profit') ? 'reports.profit' : (route.includes('cost') ? 'reports.cost' : 'reports.view')];
  if (route === 'settings' || route === 'business-profile') return [req.method === 'GET' ? 'settings.view' : 'settings.edit'];
  if (route === 'branches' || route.startsWith('branches/')) return [req.method === 'GET' ? 'branches.view' : 'branches.edit'];
  if (route === 'backup' || route.startsWith('backup/')) return [req.method === 'GET' ? 'backup.create' : 'backup.restore'];
  if (route === 'business-catalog' || route.startsWith('business-catalog/')) return req.method === 'GET' || req.method === 'HEAD' ? ['view', 'import_export'] : ['import_export'];
  if (route === 'accounting/export-data') return ['import_export'];
  if (route === 'reports/tax' || route === 'reports/detailed' || route.startsWith('reports/')) return ['system_settings'];
  if (route === 'users' || route.startsWith('users/')) return [req.method === 'GET' ? 'users.view' : (req.method === 'POST' ? 'users.create' : (req.method === 'DELETE' ? 'users.delete' : 'users.edit'))];
  if (route === 'restore' || route === 'restore-sqlite') return ['backup.restore'];
  if (route === 'scheduled-backups' || route.startsWith('scheduled-backups/')) return ['import_export'];
  if (route === 'google-drive-backup/restore' || route === 'google-drive-backup/list' || route === 'google-drive-backup/download-verified') return ['import_export'];
  if (route === 'google-drive-backup' || route.startsWith('google-drive-backup/')) return ['system_settings'];
  if (route === 'business-profile' || route === 'settings') return ['system_settings'];
  if (route === 'network-info' || route.startsWith('config/')) return ['system_settings'];
  if (route.includes('image')) return ['image_management'];
  if (/\/return(?:\/|$)/.test(`/${route}`)) return ['edit'];
  if (route === 'inventory/adjust') return ['edit'];
  if (req.method === 'GET' || req.method === 'HEAD') return ['view'];
  if (req.method === 'POST') return ['add'];
  if (req.method === 'PUT' || req.method === 'PATCH') return ['edit'];
  if (req.method === 'DELETE') return ['delete'];
  return ['view'];
}
const readRuntimeConfig = () => {
  try {
    const configPath = process.env.RAWDA_CONFIG_PATH || path.join(__dirname, 'config.json');
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {
    return {};
  }
};
const readBusinessProfile = () => {
  const fallback = { business_name: '', owner_name: '', activity: '', address: '', phone: '', email: '', currency: 'EGP', currency_symbol: 'ج.م', timezone: 'Africa/Cairo', language: 'ar', logo: '' };
  let template = fallback;
  try {
    template = { ...fallback, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'business-profile.json'), 'utf8')) };
  } catch (_) {
    template = fallback;
  }
  const saved = db.data.business_profile && typeof db.data.business_profile === 'object' ? db.data.business_profile : {};
  const requestedLogo = String(template.logo || fallback.logo).replace(/\\/g, '/').replace(/^\/+/, '');
  const logo = requestedLogo.startsWith('assets/') && !requestedLogo.split('/').includes('..') ? requestedLogo : fallback.logo;
  const logoData = String(saved.logo_data_url || '');
  const safeLogoData = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(logoData) && Buffer.byteLength(logoData, 'utf8') <= 6 * 1024 * 1024 ? logoData : '';
  const runtimePhone = String(readRuntimeConfig().contact_phone || '').trim();
  return {
    business_name: String(saved.business_name ?? template.business_name ?? '').trim(),
    owner_name: String(saved.owner_name ?? template.owner_name ?? '').trim(),
    activity: String(saved.activity ?? template.activity ?? '').trim(),
    address: String(saved.address ?? template.address ?? '').trim(),
    phone: String(saved.phone ?? runtimePhone).trim(),
    email: String(saved.email ?? template.email ?? '').trim(),
    currency: String(saved.currency ?? template.currency ?? fallback.currency).trim() || fallback.currency,
    currency_symbol: String(saved.currency_symbol ?? template.currency_symbol ?? fallback.currency_symbol).trim() || fallback.currency_symbol,
    timezone: String(saved.timezone ?? template.timezone ?? fallback.timezone).trim() || fallback.timezone,
    language: ['ar', 'en'].includes(String(saved.language ?? template.language ?? fallback.language)) ? String(saved.language ?? template.language ?? fallback.language) : fallback.language,
    logo_url: safeLogoData || (logo ? '/' + logo.split('/').map(encodeURIComponent).join('/') : ''),
    is_configured: Boolean(String(saved.business_name ?? template.business_name ?? '').trim())
  };
};
const runtimeConfig = readRuntimeConfig();
function normalizeTrustProxy(value) {
  if (value === undefined || value === null || value === false || value === 0 || value === '') return false;
  if (value === true) throw new Error('لا يمكن استخدام trust_proxy=true؛ حدد عدد القفزات أو عناوين الوكلاء الموثوقة.');
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))) {
    const hops = Number(value);
    if (!Number.isInteger(hops) || hops < 1 || hops > 10) throw new Error('عدد قفزات trust_proxy يجب أن يكون بين 1 و10 أو صفرًا للتعطيل.');
    return hops;
  }
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const addresses = entries.map(item => String(item).trim()).filter(Boolean);
  const valid = addresses.length > 0 && addresses.every(entry => {
    const [address, prefix, ...extra] = entry.split('/');
    const version = net.isIP(address);
    if (!version || extra.length) return false;
    if (prefix === undefined) return true;
    if (!/^\d+$/.test(prefix)) return false;
    const bits = Number(prefix);
    return bits >= 0 && bits <= (version === 4 ? 32 : 128);
  });
  if (!valid) throw new Error('trust_proxy يجب أن يكون عدد قفزات صحيحًا أو عناوين IP/CIDR موثوقة.');
  return addresses;
}
const TRUST_PROXY = (() => { try { return normalizeTrustProxy(runtimeConfig.trust_proxy); } catch (error) { console.warn(error.message); return false; } })();
app.set('trust proxy', TRUST_PROXY);
function isSecureRequest(req) {
  const publicUrl = String(readRuntimeConfig().public_url || '').trim();
  return HTTPS_ENABLED || Boolean(req?.secure) || /^https:\/\//i.test(publicUrl) || process.env.RAWDA_SECURE_COOKIES === '1';
}
const PORT = Number(process.env.PORT || 3000);
const TLS_PORT = Number(process.env.RAWDA_TLS_PORT || PORT + 1000);
const LICENSED_HOST = process.env.HOST || runtimeConfig.host || '0.0.0.0';
const startupLicense = getEffectiveLicenseStatus();
let HOST = startupLicense.active && !startupLicense.trial ? LICENSED_HOST : '127.0.0.1';
let TLS_HOST = '0.0.0.0';
const TLS_KEY_PATH = String(process.env.RAWDA_TLS_KEY_PATH || '').trim();
const TLS_CERT_PATH = String(process.env.RAWDA_TLS_CERT_PATH || '').trim();
const TLS_PFX_PATH = String(process.env.RAWDA_TLS_PFX_PATH || '').trim();
const TLS_CA_PATH = String(process.env.RAWDA_TLS_CA_PATH || '').trim();
if ((Boolean(TLS_KEY_PATH) !== Boolean(TLS_CERT_PATH)) || (TLS_PFX_PATH && (TLS_KEY_PATH || TLS_CERT_PATH))) {
  throw new Error('حدد إما ملف PFX واحداً أو ملف المفتاح والشهادة معاً لإعداد HTTPS.');
}
const HTTPS_OPTIONS = TLS_PFX_PATH ? { pfx: fs.readFileSync(path.resolve(TLS_PFX_PATH)) }
  : TLS_KEY_PATH ? {
  key: fs.readFileSync(path.resolve(TLS_KEY_PATH)),
  cert: fs.readFileSync(path.resolve(TLS_CERT_PATH)),
  ...(TLS_CA_PATH ? { ca: fs.readFileSync(path.resolve(TLS_CA_PATH)) } : {})
} : null;
const HTTPS_ENABLED = Boolean(HTTPS_OPTIONS);
if (HTTPS_ENABLED && TLS_PORT === PORT) throw new Error('منفذ HTTPS للشبكة يجب أن يختلف عن منفذ التطبيق المحلي.');
const NETWORK_SCHEME = HTTPS_ENABLED ? 'https' : 'http';
const NETWORK_PORT = HTTPS_ENABLED ? TLS_PORT : PORT;

const ensureFinanceTables = () => {
  ['sale_returns', 'customer_transactions', 'supplier_transactions', 'cash_transactions', 'sale_payments'].forEach(table => {
    if (!Array.isArray(db.data[table])) db.data[table] = [];
  });
};
function allocateTrackedLots(productId, quantity, branchId = db.data.default_branch_id || 1, changedRows = null) {
  let left = Number(quantity);
  const today = businessDateToday();
  const rows = db.data.purchase_items.filter(item => item.product_id === Number(productId) && Number(item.branch_id || db.data.default_branch_id || 1) === Number(branchId) && Object.prototype.hasOwnProperty.call(item, 'remaining_quantity') && Number(item.remaining_quantity) > 0 && (!item.expiry_date || item.expiry_date >= today))
    .sort((a, b) => String(a.expiry_date || '9999-12-31').localeCompare(String(b.expiry_date || '9999-12-31')) || Number(a.id) - Number(b.id));
  const allocations = [];
  for (const lot of rows) {
    if (left <= 0) break;
    const taken = Math.min(left, Number(lot.remaining_quantity));
    lot.remaining_quantity = Number((Number(lot.remaining_quantity) - taken).toFixed(3)); left = Number((left - taken).toFixed(3));
    changedRows?.push(lot);
    allocations.push({ purchase_item_id: lot.id, quantity: taken, returned_quantity: 0 });
  }
  return allocations;
}
function sellableTrackedQuantity(productId, branchId = db.data.default_branch_id || 1) {
  const product = db.data.products.find(row => Number(row.id) === Number(productId));
  if (!product) return 0;
  const branchQty = branchQuantity(branchId, productId);
  const lots = db.data.purchase_items.filter(item => Number(item.product_id) === Number(productId) && Number(item.branch_id || db.data.default_branch_id || 1) === Number(branchId) && Object.prototype.hasOwnProperty.call(item, 'remaining_quantity'));
  if (!lots.length) return branchQty;
  const today = businessDateToday();
  const tracked = lots.reduce((sum, lot) => sum + Number(lot.remaining_quantity || 0), 0);
  const legacy = Math.max(0, branchQty - tracked);
  const unexpired = lots.filter(lot => !lot.expiry_date || lot.expiry_date >= today).reduce((sum, lot) => sum + Number(lot.remaining_quantity || 0), 0);
  return Math.min(branchQty, legacy + unexpired);
}
function restoreTrackedLots(saleItem, quantity) {
  let left = Number(quantity);
  for (const allocation of saleItem.lot_allocations || []) {
    if (left <= 0) break;
    const available = Number(allocation.quantity) - Number(allocation.returned_quantity || 0);
    const restored = Math.min(left, available);
    const lot = db.data.purchase_items.find(item => item.id === allocation.purchase_item_id);
    if (lot && restored > 0) { lot.remaining_quantity = Number((Number(lot.remaining_quantity || 0) + restored).toFixed(3)); allocation.returned_quantity = Number((Number(allocation.returned_quantity || 0) + restored).toFixed(3)); left = Number((left - restored).toFixed(3)); }
  }
}
const salePaymentsMissing = !Array.isArray(db.data.sale_payments);
ensureFinanceTables();
if (!Array.isArray(db.data.suspended_sales)) db.data.suspended_sales = [];
let loyaltySchemaChanged = salePaymentsMissing;
if (!Array.isArray(db.data.loyalty_transactions)) { db.data.loyalty_transactions = []; loyaltySchemaChanged = true; }
for (const table of ['ai_insights', 'cashier_shifts', 'cash_audit_chain', 'service_orders', 'installment_contracts', 'promotions', 'purchase_orders', 'purchase_order_items', 'delivery_riders', 'delivery_assignments', 'delivery_settlements', 'delivery_rider_transactions', 'waste_records', 'self_order_requests']) {
  if (!Array.isArray(db.data[table])) { db.data[table] = []; loyaltySchemaChanged = true; }
}
if (!db.data.loyalty_settings || typeof db.data.loyalty_settings !== 'object') {
  db.data.loyalty_settings = { enabled: false, spend_per_point: 10 };
  loyaltySchemaChanged = true;
}
if (!db.data.tax_settings || typeof db.data.tax_settings !== 'object') {
  db.data.tax_settings = { enabled: false, rate: 0, registration_number: '' };
  loyaltySchemaChanged = true;
}
if (!db.data.accounting_settings || typeof db.data.accounting_settings !== 'object') {
  db.data.accounting_settings = { tally: { endpoint: 'http://127.0.0.1:9000', company_name: '', sales_ledger: '', cash_ledger: '', receivables_ledger: '', tax_ledger: '' }, tally_exported_sale_ids: [] };
  loyaltySchemaChanged = true;
} else {
  db.data.accounting_settings.tally ||= { endpoint: 'http://127.0.0.1:9000', company_name: '', sales_ledger: '', cash_ledger: '', receivables_ledger: '', tax_ledger: '' };
  if (!Array.isArray(db.data.accounting_settings.tally_exported_sale_ids)) db.data.accounting_settings.tally_exported_sale_ids = [];
}
if (!db.data.ui_settings || typeof db.data.ui_settings !== 'object' || !Array.isArray(db.data.ui_settings.hidden)) {
  db.data.ui_settings = { hidden: [] };
  loyaltySchemaChanged = true;
}
if (loyaltySchemaChanged) db.save();
const loyaltyBalance = customerId => db.data.loyalty_transactions
  .filter(entry => Number(entry.customer_id) === Number(customerId))
  .reduce((sum, entry) => sum + (Number(entry.points) || 0), 0);
const openCashierShift = (userId, branchId = branchContext.getStore() || db.data.default_branch_id || 1) => db.data.cashier_shifts.find(shift => shift.user_id === Number(userId) && Number(shift.branch_id || db.data.default_branch_id) === Number(branchId) && shift.status === 'open') || null;
const expectedCashForShift = shift => {
  const cashSales = db.data.sales.filter(sale => sale.shift_id === shift.id && ['نقدي', 'مختلط'].includes(sale.payment_method))
    .reduce((sum, sale) => {
      if (sale.payment_method === 'مختلط') return sum + db.data.sale_payments.filter(row => row.sale_id === sale.id && row.method === 'نقدي').reduce((inner, row) => inner + Number(row.amount || 0), 0);
      return sum + Math.max(0, Number(sale.paid_amount || 0) - Number(sale.change_amount || 0));
    }, 0);
  const cashRefunds = db.data.sale_returns.filter(row => row.shift_id === shift.id)
    .reduce((sum, row) => sum + Number(row.cash_amount || 0), 0);
  const expenses = db.data.cash_transactions.filter(row => row.type === 'expense' && row.shift_id === shift.id)
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const otherInflows = db.data.cash_transactions.filter(row => row.shift_id === shift.id && row.direction === 'in' && !['sale', 'sale_return', 'expense'].includes(row.type))
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const otherOutflows = db.data.cash_transactions.filter(row => row.shift_id === shift.id && row.direction === 'out' && !['sale', 'sale_return', 'expense'].includes(row.type))
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  return Number((Number(shift.opening_cash || 0) + cashSales - cashRefunds - expenses + otherInflows - otherOutflows).toFixed(2));
};
const cashBalanceForBranch = branchId => Number((db.data.cash_transactions || [])
  .filter(row => Number(row.branch_id || db.data.default_branch_id || 1) === Number(branchId))
  .reduce((sum, row) => sum + (row.direction === 'out' ? -1 : 1) * (Number(row.amount) || 0), 0).toFixed(2));
function requireCashBalanceConfirmation(req, res, amount, branchId = req.branchId) {
  const value = Number(amount);
  const before = cashBalanceForBranch(branchId);
  if (!Number.isFinite(value) || value <= 0) return { negative: false, before, after: before };
  const after = Number((before - value).toFixed(2));
  if (after < -0.005 && req.body?.confirm_negative_balance !== true) {
    res.status(409).json({ code: 'NEGATIVE_BALANCE', error: `رصيد الخزنة سيصبح سالباً (الرصيد بعد العملية: ${after.toFixed(2)} ج.م)، هل تريد المتابعة؟`, cash_balance_before: before, operation_amount: Number(value.toFixed(2)), cash_balance_after: after });
    return null;
  }
  return { negative: after < -0.005, before, after };
}
const cashConfirmationFields = result => result?.negative ? { negative_balance_confirmed: true, cash_balance_before: result.before, cash_balance_after: result.after } : {};

const addFinanceTransaction = (table, record) => {
  const branchId = Number(record.branch_id || branchContext.getStore() || db.data.default_branch_id || 1);
  const row = { id: db.nextId(table), created_at: nowStr(), ...record, branch_id: branchId };
  db.data[table].push(row);
  if (table === 'cash_transactions') {
    const action = ({ cash_receipt: 'سند قبض نقدي', owner_deposit: 'إيداع من صاحب المحل', cash_payment: 'سند صرف نقدي', sale: 'تحصيل فاتورة بيع', sale_return: 'رد نقدي لفاتورة بيع', expense: 'مصروف نقدي', purchase: 'صرف فاتورة شراء', customer_payment: 'تحصيل عميل', supplier_payment: 'سداد مورد' })[row.type] || `حركة خزينة: ${row.type}`;
    const auditDescription = row.negative_balance_confirmed ? `${row.notes || ''} | NEGATIVE_BALANCE_CONFIRMED balance_before=${row.cash_balance_before} balance_after=${row.cash_balance_after} actor_id=${row.user_id ?? ''}` : row.notes || '';
    try { appendCashAudit({ actor_id: row.user_id ?? null, action, transaction_id: row.id, branch_id: branchId, amount: row.amount, direction: row.direction, reference_id: row.reference_id, shift_id: row.shift_id || null, description: auditDescription }); }
    catch (error) { db.data[table].pop(); throw error; }
  }
  return row;
};
const getBranchInventoryRow = (branchId, productId, create = true) => {
  let row = (db.data.branch_inventory || []).find(item => Number(item.branch_id) === Number(branchId) && Number(item.product_id) === Number(productId));
  if (!row && create) { const product = db.data.products.find(item => Number(item.id) === Number(productId)); row = { id: db.data.branch_inventory.reduce((max,item)=>Math.max(max,Number(item.id)||0),0)+1, branch_id:Number(branchId), product_id:Number(productId), quantity:0, min_stock:Math.max(0,Number(product?.min_stock)||0) }; db.data.branch_inventory.push(row); }
  return row || null;
};
// Branch inventory is the existing branch-to-product assignment table. Use it
// as the visibility boundary so legacy branch stock remains visible only in
// the branch it belongs to, while products without a row stay hidden there.
function getBranchVisibleProductIds(branchId) {
  return new Set((db.data.branch_inventory || [])
    .filter(row => Number(row.branch_id) === Number(branchId))
    .map(row => Number(row.product_id)));
}
const branchQuantity = (branchId, productId) => Number(getBranchInventoryRow(branchId, productId)?.quantity || 0);
const setBranchQuantity = (branchId, productId, quantity) => {
  const row = getBranchInventoryRow(branchId, productId);
  row.quantity = Math.max(0, Number(quantity) || 0);
  // Keep the legacy product-level quantity equal to the total across its
  // branch rows. Branch inventory remains the source for branch-scoped views.
  const product = db.data.products.find(item => Number(item.id) === Number(productId));
  if (product) {
    product.quantity = (db.data.branch_inventory || [])
      .filter(item => Number(item.product_id) === Number(productId))
      .reduce((sum, item) => sum + Math.max(0, Number(item.quantity) || 0), 0);
  }
  return row.quantity;
};
const branchStockFilter = (rows, branchId) => (rows || []).filter(row => Number(row.branch_id || db.data.default_branch_id || 1) === Number(branchId));
const customerBranchBalance = (customerId, branchId) => branchStockFilter(db.data.customer_transactions, branchId).filter(row => Number(row.customer_id) === Number(customerId)).reduce((sum,row) => sum + Number(row.debit || 0) - Number(row.credit || 0), 0);
const supplierBranchBalance = (supplierId, branchId) => branchStockFilter(db.data.supplier_transactions, branchId).filter(row => Number(row.supplier_id) === Number(supplierId)).reduce((sum,row) => sum + Number(row.debit || 0) - Number(row.credit || 0), 0);
const requireOwner = (req,res) => { if (!req.authUser?.is_owner) { res.status(403).json({ error: 'هذه العملية متاحة لمالك النظام فقط.' }); return false; } return true; };
const requireAdmin = (userId, res) => {
  const user = db.data.users.find(u => u.id === Number(userId));
  if (!user || (!user.is_owner && !userHasPermission(user, 'system_settings') && !userHasPermission(user, 'user_management'))) {
    res.status(403).json({ error: 'لا تملك صلاحية إدارة هذه الإعدادات.' });
    return false;
  }
  return true;
};
const requireGranular = (req, res, code) => {
  if (!req.authUser || !userHasPermission(req.authUser, code)) {
    res.status(403).json({ code: 'PERMISSION_DENIED', error: `ليس لديك صلاحية ${code}.` });
    return false;
  }
  return true;
};
const requireCatalogManager = (userId, res) => {
  const user = db.data.users.find(u => u.id === Number(userId));
  if (!user) {
    res.status(403).json({ error: 'يجب تسجيل الدخول أولاً.' });
    return false;
  }
  return true;
};
const requireCatalogImporter = (req, res) => {
  const user = req.authUser;
  if (!user) {
    res.status(403).json({ error: 'يجب تسجيل الدخول أولاً.' });
    return false;
  }
  if (!user.is_owner && !userHasPermission(user, 'import_export')) {
    res.status(403).json({ error: 'لا تملك صلاحية استيراد كتالوج المنتجات.' });
    return false;
  }
  return true;
};

app.use(express.json({ limit: '10mb' }));
app.get('/api/maintenance/status', (_req, res) => {
  const settings = maintenanceSettings();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ enabled: Boolean(settings.enabled), message_ar: String(settings.message_ar || ''), message_en: String(settings.message_en || ''), expected_end: String(settings.expected_end || '') });
});
app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/maintenance/status') return next();
  const settings = maintenanceSettings();
  if (!settings.enabled) return next();
  const token = getCookieToken(req);
  const session = loginSessions.get(token);
  const user = session && session.expiresAt > Date.now() ? db.data.users.find(entry => entry.id === session.userId && entry.is_active !== false) : null;
  if (user && isMaintenanceOwner(user)) {
    req.authUser = user;
    return next();
  }
  const language = String(req.get('accept-language') || '').toLowerCase().startsWith('en') ? 'en' : 'ar';
  return res.status(503).json({ code: 'MAINTENANCE_MODE', maintenance: true, error: language === 'en' ? settings.message_en : settings.message_ar, message_ar: settings.message_ar, message_en: settings.message_en, expected_end: settings.expected_end || '' });
});
const apiRequestTimings = [];
app.use('/api', (req, res, next) => {
  const startedAt = performance.now();
  res.once('finish', () => {
    apiRequestTimings.push({
      endpoint: `${req.method} /api${req.path}`,
      status: res.statusCode,
      duration_ms: Number((performance.now() - startedAt).toFixed(2)),
      finished_at: Date.now()
    });
    while (apiRequestTimings.length > 100) apiRequestTimings.shift();
  });
  next();
});
const apiResponseCache = new Map();
const API_CACHE_POLICIES = new Map([
  ['/dashboard', 30_000],
  ['/products', 60_000],
  ['/settings', 300_000],
  ['/branches', 300_000]
]);
function apiCacheKey(req) {
  const token = getCookieToken(req) || req.get('authorization') || 'anonymous';
  return `${req.method}:${req.path}:${req.originalUrl.split('?')[1] || ''}:${req.get('x-active-branch') || ''}:${token}`;
}
function invalidateApiResponseCache() {
  apiResponseCache.clear();
}
app.use('/api', (req, res, next) => {
  const ttl = req.method === 'GET' ? API_CACHE_POLICIES.get(req.path) : 0;
  if (!ttl) {
    if (req.method !== 'GET') res.once('finish', () => { if (res.statusCode < 400) invalidateApiResponseCache(); });
    return next();
  }
  const key = apiCacheKey(req);
  const cached = apiResponseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    res.setHeader('X-Performance-Cache', 'HIT');
    return res.status(cached.status).json(cached.body);
  }
  if (cached) apiResponseCache.delete(key);
  const originalJson = res.json.bind(res);
  res.json = body => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      apiResponseCache.set(key, { body, status: res.statusCode, expiresAt: Date.now() + ttl });
    }
    res.setHeader('X-Performance-Cache', 'MISS');
    return originalJson(body);
  };
  return next();
});
/* FIX-CSP */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  next();
});


app.get('/activate', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use('/api', (req, res, next) => {
  if ((req.method === 'GET' && req.path === '/license/status') || (req.method === 'POST' && req.path === '/license/activate')) return next();
  const status = getEffectiveLicenseStatus();
  if (status.tamper_detected && ['POST', 'PUT', 'DELETE'].includes(req.method) && !['/login', '/logout', '/me/password'].includes(req.path) && !req.path.startsWith('/webauthn/')) return res.status(403).json({ error: 'يرجى ضبط ساعة الجهاز لإتمام البيع' });
  if (status.active) {
    if (!status.trial) ensureLicensedAccounts();
    return next();
  }
  return res.status(402).json({ error: 'انتهت التجربة. أدخل مفتاح التفعيل.' });
});
app.get('/api/license/status', (_req, res) => res.json(getEffectiveLicenseStatus()));
app.post('/api/license/activate', (req, res) => {
  let status;
  try { status = license.activateTextForDevice(String(req.body?.licenseText || req.body?.licenseKey || '').trim()); }
  catch (error) { return res.status(500).json({ active: false, error: `تعذر حفظ الترخيص: ${error.message}` }); }
  if (!status.active) return res.status(400).json({ active: false, error: status.reason });
  if (listener && HOST !== LICENSED_HOST) {
    res.setHeader('Connection', 'close');
    res.status(200).json({ ...status, message: 'تم تفعيل البرنامج على هذا الجهاز.' });
    res.once('finish', () => setTimeout(() => rebindLicensedListeners(), 0));
    return;
  }
  return res.json({ ...status, message: 'تم تفعيل البرنامج على هذا الجهاز.' });
});
app.use((req, res, next) => {
  const privateFiles = new Set([
    '/server.js', '/database.js',
    '/package.json', '/config.json', '/business-profile.json', '/license-public.pem'
  ]);
  if (privateFiles.has(req.path.toLowerCase()) || /^\/(?:electron|tools|node_modules)(?:\/|$)/i.test(req.path)) {
    return res.status(404).end();
  }
  next();
});

app.get(['/', '/index.html'], (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/account-access.js', (_req, res) => res.sendFile(path.join(__dirname, 'account-access.js')));
app.get('/self-order.js', (_req, res) => res.sendFile(path.join(__dirname, 'self-order.js')));
app.get('/self-order.css', (_req, res) => res.sendFile(path.join(__dirname, 'self-order.css')));
app.get('/storage-migration.js', (_req, res) => res.sendFile(path.join(__dirname, 'storage-migration.js')));
app.get('/business-catalog-utils.js', (_req, res) => res.sendFile(path.join(__dirname, 'business-catalog-utils.js')));
app.get('/product-list-utils.js', (_req, res) => res.sendFile(path.join(__dirname, 'product-list-utils.js')));
app.get('/invoice-share-utils.js', (_req, res) => res.sendFile(path.join(__dirname, 'invoice-share-utils.js')));
app.get('/layout-order-utils.js', (_req, res) => res.sendFile(path.join(__dirname, 'layout-order-utils.js')));
app.get('/locale.js', (_req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'locale.js')));
app.get('/app.js', (_req, res) => res.sendFile(path.join(__dirname, 'app.js')));
app.get('/app.css', (_req, res) => res.sendFile(path.join(__dirname, 'app.css')));
app.get('/pos-mixed-payment.js', (_req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'pos-mixed-payment.js')));
app.get('/pos-mixed-payment.css', (_req, res) => res.type('text/css').sendFile(path.join(__dirname, 'pos-mixed-payment.css')));
app.get('/accounting-ui.js', (_req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'accounting-ui.js')));
app.get('/accounting.css', (_req, res) => res.type('text/css').sendFile(path.join(__dirname, 'accounting.css')));
app.get('/wallets-ui.js', (_req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'wallets-ui.js')));
app.get('/wallets.css', (_req, res) => res.type('text/css').sendFile(path.join(__dirname, 'wallets.css')));
app.get('/sms-ui.js', (_req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'sms-ui.js')));
app.get('/sms.css', (_req, res) => res.type('text/css').sendFile(path.join(__dirname, 'sms.css')));
app.get('/hardware-ui.js', (_req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'hardware-ui.js')));
app.get('/hardware.css', (_req, res) => res.type('text/css').sendFile(path.join(__dirname, 'hardware.css')));
app.get('/customer-display.html', (_req, res) => res.sendFile(path.join(__dirname, 'customer-display.html')));
app.get('/warehouse-ui.html', (_req, res) => res.sendFile(path.join(__dirname, 'warehouse-ui.html')));
app.get('/share/invoice/:token', (_req, res) => res.sendFile(path.join(__dirname, 'invoice-share.html')));
app.get('/share/invoice/:token/data', (req, res) => {
  const sale = db.data.sales.find(row => row.public_share_token && row.public_share_token === String(req.params.token || ''));
  if (!sale) return res.status(404).json({ error: 'رابط الفاتورة غير موجود أو انتهت صلاحيته.' });
  const items = db.data.sale_items.filter(row => row.sale_id === sale.id).map(row => ({ name: db.data.products.find(product => product.id === row.product_id)?.name || 'منتج', quantity: row.quantity, unit_price: row.unit_price, total: row.total }));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ invoice_number: sale.invoice_number, created_at: sale.created_at, items, subtotal: sale.subtotal, discount: sale.discount, tax_amount: sale.tax_amount, total: sale.total, paid_amount: sale.paid_amount, payment_method: sale.payment_method, business: readBusinessProfile() });
});
app.get('/delivery/track/:token', (_req, res) => res.sendFile(path.join(__dirname, 'tracking.html')));
app.get('/delivery/track/:token/data', (req, res) => {
  const row = (db.data.delivery_assignments || []).find(item => item.tracking_token && item.tracking_token === String(req.params.token || ''));
  if (!row) return res.status(404).json({ error: 'رابط التتبع غير صالح.' });
  const sale = db.data.sales.find(item => item.id === row.sale_id);
  if (!sale) return res.status(404).json({ error: 'الطلب غير موجود.' });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ invoice_number: sale.invoice_number, status: row.status, updated_at: row.updated_at, business: readBusinessProfile() });
});
app.get('/delivery/rider/:token', (_req, res) => res.sendFile(path.join(__dirname, 'rider-mobile.html')));
app.get('/delivery/rider/:token/data', (req, res) => {
  const row = (db.data.delivery_assignments || []).find(item => item.rider_token && item.rider_token === String(req.params.token || ''));
  if (!row) return res.status(404).json({ error: 'رابط الطيار غير صالح.' });
  const sale = db.data.sales.find(item => item.id === row.sale_id); const customer = db.data.customers.find(item => item.id === sale?.customer_id);
  if (!sale) return res.status(404).json({ error: 'الطلب غير موجود.' });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ invoice_number: sale.invoice_number, customer_name: customer?.name || 'عميل', customer_phone: customer?.phone || '', due_amount: Math.max(0, Number(sale.total || 0) - Number(sale.paid_amount || 0)), status: row.status });
});
app.get('/self-order', (_req, res) => res.sendFile(path.join(__dirname, 'self-order.html')));
app.get('/self-order.html', (_req, res) => res.sendFile(path.join(__dirname, 'self-order.html')));
const selfOrderRateLimits = new Map();
function allowSelfOrderRequest(req, res, { limit, windowMs }) {
  const now = Date.now();
  const key = `${req.ip || req.socket.remoteAddress || 'unknown'}:${req.method}`;
  let entry = selfOrderRateLimits.get(key);
  if (!entry || now >= entry.resetAt) { entry = { count: 0, resetAt: now + windowMs }; selfOrderRateLimits.set(key, entry); }
  entry.count += 1;
  if (selfOrderRateLimits.size > 2000) for (const [oldKey, value] of selfOrderRateLimits) if (now >= value.resetAt) selfOrderRateLimits.delete(oldKey);
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - entry.count)));
  if (entry.count > limit) { res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000))); res.status(429).json({ error: 'طلبات كثيرة. حاول بعد قليل.' }); return false; }
  return true;
}
const SELF_ORDER_PENDING_TTL_MS = 30 * 60 * 1000;
function selfOrderCreatedAtMs(order) {
  const value = String(order?.created_at || '').trim();
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/u.test(normalized) ? normalized : `${normalized}Z`);
}
function expireStaleSelfOrders(now = Date.now()) {
  const expired = (db.data.self_order_requests || []).filter(order => order.status === 'pending' && now - selfOrderCreatedAtMs(order) >= SELF_ORDER_PENDING_TTL_MS);
  if (!expired.length) return 0;
  db.transaction(['self_order_requests', 'audit_logs'], () => {
    const timestamp = nowStr();
    for (const order of expired) {
      order.status = 'expired'; order.expired_at = timestamp; order.updated_at = timestamp;
      order.status_reason = 'انتهت مهلة مراجعة الطلب بعد 30 دقيقة.';
      db.logAudit(null, 'انتهاء صلاحية طلب ذاتي', 'self_order_requests', order.id, { order_id: order.id, branch_id: order.branch_id, status: 'expired', reason: order.status_reason }, { save: false });
    }
  });
  return expired.length;
}
const selfOrderExpiryTimer = setInterval(() => {
  try { expireStaleSelfOrders(); } catch (error) { console.error('Self-order expiry failed:', error.message); }
}, 60 * 1000);
selfOrderExpiryTimer.unref?.();
function selfOrderStockConflictMap(branchId) {
  const orders = (db.data.self_order_requests || []).filter(order => Number(order.branch_id) === Number(branchId) && ['pending', 'accepted'].includes(order.status));
  const demand = new Map();
  for (const order of orders) for (const item of order.items || []) {
    const productId = Number(item.product_id);
    const entry = demand.get(productId) || { quantity: 0, orders: [] };
    entry.quantity += Number(item.quantity) || 0;
    entry.orders.push(order);
    demand.set(productId, entry);
  }
  const conflictsByOrder = new Map();
  for (const [productId, entry] of demand) {
    const product = (db.data.products || []).find(row => Number(row.id) === productId);
    const available = product ? Math.min(branchQuantity(branchId, productId), sellableTrackedQuantity(productId, branchId)) : 0;
    if (entry.quantity <= available) continue;
    const conflict = { product_id: productId, product_name: String(product?.name || entry.orders[0]?.items?.find(item => Number(item.product_id) === productId)?.product_name || 'صنف'), pending_quantity: entry.quantity, available_quantity: available, shortage: entry.quantity - available };
    for (const order of entry.orders) {
      const list = conflictsByOrder.get(Number(order.id)) || [];
      list.push(conflict);
      conflictsByOrder.set(Number(order.id), list);
    }
  }
  return conflictsByOrder;
}
app.get('/api/public/self-order/catalog', (req, res) => {
  if (!allowSelfOrderRequest(req, res, { limit: 60, windowMs: 60000 })) return;
  const branchId = Number(db.data.default_branch_id || 1);
  const products = (db.data.products || []).filter(product => product.is_active !== false).map(product => {
    const quantity = Math.min(branchQuantity(branchId, product.id), sellableTrackedQuantity(product.id, branchId));
    if (quantity <= 0) return null;
    const category = (db.data.categories || []).find(row => Number(row.id) === Number(product.category_id));
    const image = String(product.image_url || product.image || '');
    return { id: Number(product.id), name: String(product.name || ''), category_id: Number(product.category_id) || null, category_name: String(category?.name || product.category_name || 'عام'), price: Number(product.sale_price ?? product.price) || 0, image_url: /^(?:data:image\/(?:png|jpeg|webp);base64,|\/assets\/)/i.test(image) ? image : '' };
  }).filter(Boolean);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ business: readBusinessProfile(), categories: [...new Set(products.map(row => row.category_name))], products });
});
app.post('/api/public/self-order/orders', (req, res) => {
  if (!allowSelfOrderRequest(req, res, { limit: 8, windowMs: 10 * 60 * 1000 })) return;
  const body = req.body || {};
  const clientKey = String(body.client_order_key || '').trim().slice(0, 80);
  const customerName = String(body.customer_name || '').trim().slice(0, 100);
  const customerPhone = String(body.customer_phone || '').replace(/[^\d+]/g, '').slice(0, 24);
  const fulfillment = body.fulfillment === 'delivery' ? 'delivery' : 'pickup';
  const address = String(body.address || '').trim().slice(0, 250);
  const note = String(body.note || '').trim().slice(0, 500);
  if (!clientKey || !customerName || customerPhone.replace(/\D/g, '').length < 7) return res.status(400).json({ error: 'أدخل الاسم ورقم هاتف صحيحاً.' });
  if (fulfillment === 'delivery' && address.length < 5) return res.status(400).json({ error: 'أدخل عنوان التوصيل كاملاً.' });
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) return res.status(400).json({ error: 'السلة فارغة أو تحتوي على أصناف كثيرة.' });
  const merged = new Map();
  for (const raw of body.items) {
    const productId = Number(raw?.product_id), quantity = Number(raw?.quantity);
    if (!Number.isSafeInteger(productId) || productId < 1 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) return res.status(400).json({ error: 'بيانات صنف أو كمية غير صالحة.' });
    merged.set(productId, (merged.get(productId) || 0) + quantity);
  }
  if ([...merged.values()].some(quantity => quantity > 99)) return res.status(400).json({ error: 'الحد الأقصى 99 قطعة للصنف الواحد.' });
  const existing = db.data.self_order_requests.find(row => row.client_order_key === clientKey);
  if (existing) return res.status(200).json({ order: publicSelfOrderSummary(existing), already_received: true });
  const branchId = Number(db.data.default_branch_id || 1);
  const items = [];
  for (const [productId, quantity] of merged) {
    const product = (db.data.products || []).find(row => Number(row.id) === productId && row.is_active !== false);
    if (!product) return res.status(409).json({ error: 'أحد الأصناف لم يعد متاحاً.' });
    const available = Math.min(branchQuantity(branchId, productId), sellableTrackedQuantity(productId, branchId));
    if (available < quantity) return res.status(409).json({ error: `الكمية المتاحة من ${product.name} هي ${available}. حدّث السلة.` });
    items.push({ product_id: productId, product_name: String(product.name), quantity, unit_price: Number(product.sale_price ?? product.price) || 0, total: Number(((Number(product.sale_price ?? product.price) || 0) * quantity).toFixed(2)) });
  }
  const subtotal = Number(items.reduce((sum, item) => sum + item.total, 0).toFixed(2));
  const taxSettings = db.data.tax_settings || {};
  const taxRate = taxSettings.enabled ? Math.max(0, Number(taxSettings.rate) || 0) : 0;
  const taxAmount = Number((subtotal * taxRate / 100).toFixed(2));
  const statusToken = crypto.randomBytes(32).toString('base64url');
  const order = { id: db.nextId('self_order_requests'), client_order_key: clientKey, status_token_hash: crypto.createHash('sha256').update(statusToken).digest('hex'), branch_id: branchId, status: 'pending', customer_name: customerName, customer_phone: customerPhone, fulfillment, address, note, items, subtotal, tax_rate: taxRate, tax_amount: taxAmount, total: Number((subtotal + taxAmount).toFixed(2)), created_at: nowStr(), updated_at: nowStr(), accepted_ticket_id: null };
  db.data.self_order_requests.push(order);
  const audit = db.logAudit(null, 'استلام طلب ذاتي', 'self_order_requests', order.id, { order_id: order.id, branch_id: branchId, item_count: items.length, total: order.total, status: order.status }, { save: false });
  try { db.save(['self_order_requests', 'audit_logs']); }
  catch (error) { db.data.self_order_requests.pop(); db.data.audit_logs.splice(db.data.audit_logs.indexOf(audit), 1); return res.status(500).json({ error: 'تعذر حفظ الطلب. أعد المحاولة.' }); }
  res.status(201).json({ order: publicSelfOrderSummary(order), status_token: statusToken, message: 'وصل طلبك، وسيراجع المتجر التوفر قبل التأكيد.' });
});
function publicSelfOrderSummary(order) { return { id: order.id, status: order.status, created_at: order.created_at, total: order.total, item_count: order.items?.length || 0 }; }
app.get('/api/public/self-order/orders/:id/status', (req, res) => {
  if (!allowSelfOrderRequest(req, res, { limit: 90, windowMs: 60000 })) return;
  try { expireStaleSelfOrders(); } catch (error) { return res.status(503).json({ error: 'تعذر تحديث حالة الطلب حالياً.' }); }
  const order = (db.data.self_order_requests || []).find(row => Number(row.id) === Number(req.params.id));
  const token = String(req.query.token || '');
  const actualHash = crypto.createHash('sha256').update(token).digest();
  const expectedHash = Buffer.from(String(order?.status_token_hash || '').padEnd(64, '0').slice(0, 64), 'hex');
  if (!order || expectedHash.length !== actualHash.length || !crypto.timingSafeEqual(actualHash, expectedHash)) return res.status(404).json({ error: 'الطلب غير موجود.' });
  res.setHeader('Cache-Control', 'no-store');
  const messages = { pending: 'طلبك قيد مراجعة المتجر.', accepted: 'تم اعتماد طلبك وسيجهزه المتجر.', rejected: order.status_reason || 'تعذر قبول الطلب؛ تواصل مع المتجر.', expired: order.status_reason || 'انتهت مهلة مراجعة الطلب.', completed: 'اكتمل بيع طلبك.' };
  res.json({ id: order.id, status: order.status, message: messages[order.status] || 'حالة الطلب محدثة.' });
});
app.post('/delivery/rider/:token/status', (req, res) => {
  const row = (db.data.delivery_assignments || []).find(item => item.rider_token && item.rider_token === String(req.params.token || ''));
  if (!row) return res.status(404).json({ error: 'رابط الطيار غير صالح.' });
  if (!['assigned', 'dispatched'].includes(row.status)) return res.status(409).json({ error: 'الطلب مغلق بالفعل.' });
  const next = String(req.body?.status || '');
  if (next === 'dispatched') { if (row.status !== 'assigned') return res.status(409).json({ error: 'بدأ التوصيل بالفعل.' }); row.status = 'dispatched'; row.updated_at = nowStr(); db.save(); return res.json({ message: 'تم تحديث الحالة إلى في الطريق.' }); }
  if (next !== 'delivered') return res.status(400).json({ error: 'الحالة المطلوبة غير صالحة.' });
  const signature = String(req.body?.signature || '');
  const match = signature.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match || signature.length > 500000) return res.status(400).json({ error: 'توقيع الاستلام مطلوب ويجب أن يكون صورة PNG صالحة.' });
  const signatureBytes = Buffer.from(match[1], 'base64');
  if (signatureBytes.length < 16 || !signatureBytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return res.status(400).json({ error: 'ملف التوقيع غير صالح.' });
  const sale = db.data.sales.find(item => item.id === row.sale_id); if (!sale) return res.status(404).json({ error: 'الفاتورة غير موجودة.' });
  const collected = Number(req.body?.cash_collected || 0); const due = Math.max(0, Number(sale.total || 0) - Number(sale.paid_amount || 0));
  if (!Number.isFinite(collected) || collected < 0 || collected > due) return res.status(400).json({ error: `المبلغ المحصل يجب أن يكون بين صفر و${due.toFixed(2)} ج.م.` });
  if (collected > 0) { sale.paid_amount = Number((Number(sale.paid_amount || 0) + collected).toFixed(2)); const customer = db.data.customers.find(item => item.id === sale.customer_id); if (customer && Number(customer.id) > 1) customer.balance = Math.max(0, Number((Number(customer.balance || 0) - collected).toFixed(2))); addFinanceTransaction('cash_transactions', { type: 'delivery_collection', amount: collected, direction: 'in', reference_id: sale.invoice_number, notes: 'تحصيل عبر واجهة الطيار' }); row.cash_collected = Number((Number(row.cash_collected || 0) + collected).toFixed(2)); }
  row.status = 'delivered'; row.delivered_at = nowStr(); row.updated_at = row.delivered_at; row.customer_signature = signature; row.signature_at = row.delivered_at; db.save();
  db.logAudit(null, 'تأكيد تسليم من واجهة الطيار', 'delivery_assignments', row.id, `رابط طيار: ${sale.invoice_number}`);
  res.json({ message: 'تم تأكيد التسليم وحفظ التوقيع.' });
});
app.get('/sw.js', (_req, res) => { res.setHeader('Service-Worker-Allowed', '/'); res.type('application/javascript').sendFile(path.join(__dirname, 'sw.js')); });
app.use('/assets', express.static(path.join(__dirname, 'assets'), { dotfiles: 'deny', index: false }));
// Every API call except login and the minimal startup config requires a live
// server-side session. Client-supplied user IDs are replaced with the signed-in user.
app.use('/api', (req, res, next) => {
  if (req.method === 'POST' && /^\/sms\/receive(?:\/[^/]+)?$/.test(req.path)) return next();
  if (req.path === '/me' && req.method === 'GET') {
    const sessionToken = getCookieToken(req);
    const existingSession = loginSessions.get(sessionToken);
    const sessionUser = existingSession && existingSession.expiresAt > Date.now()
      ? db.data.users.find(entry => entry.id === existingSession.userId && entry.is_active)
      : null;
    if (!sessionUser) {
      if (sessionToken) loginSessions.delete(sessionToken);
      return res.json({ authenticated: false });
    }
  }
  if (req.path === '/login' || req.path.startsWith('/webauthn/') || (req.path === '/config/business-profile/initial' && req.method === 'POST')) return next();
  if (req.path === '/config' && req.method === 'GET') {
    const token = getCookieToken(req);
    if (!token || !loginSessions.has(token)) return next();
  }
  const token = getCookieToken(req);
  const session = loginSessions.get(token);
  const user = session && session.expiresAt > Date.now()
    ? db.data.users.find(entry => entry.id === session.userId && entry.is_active)
    : null;
  if (!user) {
    if (token) loginSessions.delete(token);
    return res.status(401).json({ error: 'انتهت جلسة الدخول. سجّل الدخول مرة أخرى.' });
  }
  req.authUser = user;
  if (ENFORCE_PASSWORD_CHANGE && user.must_change_password === true) {
    const passwordBootstrapRoute = (req.method === 'GET' && ['/me', '/config'].includes(req.path))
      || ((req.path === '/me/password' && req.method === 'PUT') || (req.path === '/auth/change-password' && req.method === 'POST'))
      || (req.path === '/logout' && req.method === 'POST');
    if (!passwordBootstrapRoute) {
      return res.status(403).json({ code: 'PASSWORD_CHANGE_REQUIRED', error: 'يجب تغيير كلمة المرور قبل استخدام النظام.' });
    }
  }
  const requestedBranchId = Number(req.get('x-active-branch'));
  const assignedBranchId = Number(user.branch_id || db.data.default_branch_id || 1);
  const allowedBranchIds = getUserBranchIds(user);
  if (isUnrestrictedAccount(user) && Number.isInteger(requestedBranchId) && requestedBranchId > 0) {
    const selectedBranch = db.data.branches.find(branch => branch.id === requestedBranchId && branch.is_active !== false);
    if (!selectedBranch) return res.status(403).json({ error: 'الفرع المحدد غير موجود أو غير نشط.' });
    req.branchId = selectedBranch.id;
  } else {
    const selectedBranchId = req.get('x-active-branch') ? requestedBranchId : assignedBranchId;
    if (branchAccessLevel(user, selectedBranchId) === 'none') return res.status(403).json({ error: 'لا تملك صلاحية الوصول إلى هذا الفرع.' });
    req.branchId = selectedBranchId;
  }
  const selectedAccessLevel = branchAccessLevel(user, req.branchId);
  if (!isUnrestrictedAccount(user) && selectedAccessLevel === 'none') return res.status(403).json({ error: 'لا تملك صلاحية الوصول إلى هذا الفرع.' });
  if (!isUnrestrictedAccount(user) && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && selectedAccessLevel !== 'write') {
    return res.status(403).json({ error: 'هذا الفرع متاح للقراءة فقط.' });
  }
  if (req.body && typeof req.body === 'object' && req.path !== '/restore') req.body.current_user_id = user.id;
  if (req.query && typeof req.query === 'object') req.query.current_user_id = String(user.id);
  const required = permissionsForRequest(req);
  if (!isUnrestrictedAccount(user) && required.length && !required.some(permission => userHasPermission(user, permission))) {
    return res.status(403).json({ error: 'ليس لديك الصلاحية اللازمة لتنفيذ هذا الإجراء.' });
  }
  if (!user.is_owner && ['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Object.prototype.hasOwnProperty.call(req.body, 'image_url') && req.body.image_url && !userHasPermission(user, 'image_management')) {
    return res.status(403).json({ error: 'إدارة صور المنتجات غير مسموح بها لهذا المستخدم.' });
  }
  branchContext.run(req.branchId, () => next());
});

app.get('/api/performance/stats', (req, res) => {
  if (!req.authUser?.is_owner) return res.status(403).json({ error: 'إحصاءات الأداء متاحة لمالك النظام فقط.' });
  const cutoff = Date.now() - (5 * 60 * 1000);
  const grouped = new Map();
  for (const row of apiRequestTimings.filter(item => item.finished_at >= cutoff)) {
    const current = grouped.get(row.endpoint) || { endpoint: row.endpoint, total_ms: 0, count: 0 };
    current.total_ms += row.duration_ms;
    current.count += 1;
    grouped.set(row.endpoint, current);
  }
  res.json({ window_minutes: 5, sample_size: apiRequestTimings.filter(item => item.finished_at >= cutoff).length, requests: [...grouped.values()].map(row => ({ endpoint: row.endpoint, avg_ms: Number((row.total_ms / row.count).toFixed(2)), count: row.count })) });
});

app.get('/api/self-order/orders', (req, res) => {
  try { expireStaleSelfOrders(); } catch (error) { return res.status(503).json({ error: 'تعذر تحديث قائمة الطلبات المنتهية.' }); }
  const conflicts = selfOrderStockConflictMap(req.branchId);
  const rows = (db.data.self_order_requests || []).filter(row => Number(row.branch_id) === Number(req.branchId) && ['pending', 'accepted'].includes(row.status)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map(({ status_token_hash, client_order_key, ...row }) => ({ ...row, stock_conflicts: conflicts.get(Number(row.id)) || [] }));
  res.json(rows);
});
app.post('/api/self-order/orders/:id/reject', (req, res) => {
  if (!req.authUser?.is_owner && !userHasPermission(req.authUser, 'add')) return res.status(403).json({ error: 'لا تملك صلاحية رفض الطلبات.' });
  try { expireStaleSelfOrders(); } catch (error) { return res.status(503).json({ error: 'تعذر تحديث حالة الطلب.' }); }
  const order = (db.data.self_order_requests || []).find(row => Number(row.id) === Number(req.params.id) && Number(row.branch_id) === Number(req.branchId));
  if (!order) return res.status(404).json({ error: 'الطلب الذاتي غير موجود في هذا الفرع.' });
  if (order.status === 'rejected') return res.json({ order: publicSelfOrderSummary(order), already_rejected: true });
  if (order.status !== 'pending') return res.status(409).json({ error: 'يمكن رفض الطلبات المعلقة فقط.' });
  const reason = String(req.body?.reason || 'تعذر تلبية الطلب').trim().slice(0, 240) || 'تعذر تلبية الطلب';
  try {
    db.transaction(['self_order_requests', 'audit_logs'], () => {
      order.status = 'rejected'; order.status_reason = reason; order.rejected_by = req.authUser.id; order.rejected_at = nowStr(); order.updated_at = order.rejected_at;
      db.logAudit(req.authUser.id, 'رفض طلب ذاتي', 'self_order_requests', order.id, { order_id: order.id, branch_id: req.branchId, reason, customer_notified_by_status_poll: true }, { save: false });
    });
  } catch (error) { return res.status(500).json({ error: 'تعذر حفظ رفض الطلب.' }); }
  res.json({ order: publicSelfOrderSummary(order), notification: 'سيظهر إشعار الرفض في صفحة الطلب عند تحديثها تلقائياً.' });
});
app.post('/api/self-order/orders/:id/accept', (req, res) => {
  try { expireStaleSelfOrders(); } catch (error) { return res.status(503).json({ error: 'تعذر تحديث حالة الطلب.' }); }
  const order = (db.data.self_order_requests || []).find(row => Number(row.id) === Number(req.params.id) && Number(row.branch_id) === Number(req.branchId));
  if (!order) return res.status(404).json({ error: 'الطلب الذاتي غير موجود في هذا الفرع.' });
  if (order.status === 'accepted' && order.accepted_ticket_id) {
    const existingTicket = db.data.suspended_sales.find(row => Number(row.id) === Number(order.accepted_ticket_id));
    if (existingTicket) return res.json({ ticket: existingTicket, already_accepted: true });
  }
  if (order.status !== 'pending') return res.status(409).json({ error: 'الطلب لم يعد قيد الانتظار.' });
  const stockConflicts = selfOrderStockConflictMap(req.branchId).get(Number(order.id)) || [];
  if (stockConflicts.length) return res.status(409).json({ error: `تجاوز إجمالي الطلبات المعلقة المخزون المتاح: ${stockConflicts.map(item => `${item.product_name} مطلوب ${item.pending_quantity} والمتاح ${item.available_quantity}`).join('، ')}. ارفض الطلبات غير القابلة للتنفيذ أولاً.` });
  for (const item of order.items || []) {
    const product = db.data.products.find(row => Number(row.id) === Number(item.product_id) && row.is_active !== false);
    const available = product ? Math.min(branchQuantity(req.branchId, item.product_id), sellableTrackedQuantity(item.product_id, req.branchId)) : 0;
    if (!product || available < Number(item.quantity)) return res.status(409).json({ error: `تعذر قبول الطلب؛ المخزون المتاح من ${product?.name || item.product_name} هو ${available}.` });
    const currentPrice = Number(product.sale_price ?? product.price) || 0;
    if (Math.abs(currentPrice - Number(item.unit_price)) > 0.009) return res.status(409).json({ error: `تغير سعر ${product.name} منذ إرسال الطلب. السعر الحالي ${currentPrice.toFixed(2)} ج.م؛ راجع العميل قبل القبول.` });
  }
  const ticketId = db.nextId('suspended_sales');
  const now = nowStr();
  const ticket = { id: ticketId, user_id: req.authUser.id, branch_id: req.branchId, label: `طلب ذاتي #${order.id} — ${order.customer_name}`, customer_id: 1, discount: 0, paid_amount: 0, payment_method: 'نقدي', price_level: 'retail', order_type: order.fulfillment === 'delivery' ? 'توصيل' : 'استلام من الفرع', order_channel: 'تطبيق توصيل', self_order_id: order.id, customer_name: order.customer_name, customer_phone: order.customer_phone, delivery_address: order.address, items: order.items.map(item => ({ product_id: Number(item.product_id), quantity: Number(item.quantity), unit_price: Number(item.unit_price), cost_price: Number(db.data.products.find(product => Number(product.id) === Number(item.product_id))?.cost_price) || 0, discount: 0 })), created_at: now, updated_at: now };
  order.status = 'accepted'; order.accepted_ticket_id = ticketId; order.accepted_by = req.authUser.id; order.updated_at = now;
  db.data.suspended_sales.push(ticket);
  const audit = db.logAudit(req.authUser.id, 'تحويل طلب ذاتي إلى فاتورة معلقة', 'self_order_requests', order.id, { order_id: order.id, ticket_id: ticketId, branch_id: req.branchId }, { save: false });
  try { db.save(['self_order_requests', 'suspended_sales', 'audit_logs']); }
  catch (error) { db.data.suspended_sales.pop(); order.status = 'pending'; order.accepted_ticket_id = null; order.accepted_by = null; db.data.audit_logs.splice(db.data.audit_logs.indexOf(audit), 1); return res.status(500).json({ error: 'تعذر تحويل الطلب إلى فاتورة معلقة.' }); }
  res.status(201).json({ ticket, message: 'أُضيف الطلب إلى الفواتير المعلقة. سيُعاد فحص المخزون عند إتمام البيع.' });
});

// Additive warehouse layer: existing sale/purchase/waste handlers remain the
// source of branch stock changes; this hook mirrors their stock movements into
// the selected warehouse and links returns to the originating sale warehouse.
registerWarehouseOperations({ app, db, requireOwner, isUnrestrictedAccount, logger: console });
serverProfile('warehouse-routes-registered');
registerAccountingRoutes({ app, db });
serverProfile('accounting-routes-registered');
registerWalletRoutes({ app, db, isUnrestrictedAccount });
serverProfile('wallet-routes-registered');
registerSmsRoutes({ app, db, isUnrestrictedAccount });
registerHardwareRoutes({ app, db, isUnrestrictedAccount, requestElectronHost });
serverProfile('sms-routes-registered');

const userDataDir = path.resolve(process.env.RAWDA_USER_DATA_DIR || process.env.RAWDA_DATA_DIR || path.dirname(db.getDatabasePath()));
const cashAuditKeyPath = path.join(userDataDir, 'cash-audit.key');
function readCashAuditKey(create = false) {
  if (fs.existsSync(cashAuditKeyPath)) {
    const key = fs.readFileSync(cashAuditKeyPath);
    if (key.length !== 32) throw new Error('مفتاح سجل تدقيق الخزينة غير صالح.');
    return key;
  }
  if (!create) return null;
  if (db.data.cash_audit_chain?.length) throw new Error('مفتاح سجل تدقيق الخزينة مفقود؛ أوقف التسجيل للحفاظ على إمكانية التحقق.');
  fs.mkdirSync(userDataDir, { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(cashAuditKeyPath, key, { flag: 'wx', mode: 0o600 });
  return key;
}
function cashAuditCanonical(entry) {
  return JSON.stringify({ id: entry.id, created_at: entry.created_at, actor_id: entry.actor_id, iv: entry.iv, tag: entry.tag, ciphertext: entry.ciphertext, previous_hash: entry.previous_hash });
}
function appendCashAudit(event) {
  const key = readCashAuditKey(true);
  const rows = db.data.cash_audit_chain;
  const previous = rows.at(-1)?.entry_hash || '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(event), 'utf8'), cipher.final()]);
  const entry = { id: db.nextId('cash_audit_chain'), created_at: nowStr(), actor_id: event.actor_id ?? null, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), previous_hash: previous };
  entry.entry_hash = crypto.createHmac('sha256', key).update(cashAuditCanonical(entry)).digest('hex');
  rows.push(entry);
  return entry;
}
function readAndVerifyCashAudit() {
  const rows = db.data.cash_audit_chain || [];
  const key = readCashAuditKey(false);
  if (rows.length && !key) return { valid: false, entries: [], reason: 'مفتاح التحقق مفقود.' };
  let previous = '';
  const entries = [];
  for (const entry of rows) {
    if (entry.previous_hash !== previous) return { valid: false, entries: [], reason: `انقطاع سلسلة التدقيق عند القيد ${entry.id}.` };
    const expected = crypto.createHmac('sha256', key).update(cashAuditCanonical(entry)).digest();
    const actual = Buffer.from(String(entry.entry_hash || ''), 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return { valid: false, entries: [], reason: `فشل تحقق توقيع القيد ${entry.id}.` };
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      const clear = Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, 'base64')), decipher.final()]).toString('utf8');
      entries.push({ ...JSON.parse(clear), created_at: entry.created_at, entry_hash: entry.entry_hash });
    } catch { return { valid: false, entries: [], reason: `تعذر فك تشفير القيد ${entry.id}.` }; }
    previous = entry.entry_hash;
  }
  return { valid: true, entries: entries.reverse(), reason: null };
}
const campaignManager = createCampaignManager ? createCampaignManager({ userDataPath: userDataDir, readConfig: readRuntimeConfig, logger: console }) : null;
const requireCampaignManager = res => {
  if (campaignManager) return true;
  res.status(503).json({ error: 'ميزة الحملات غير متاحة حالياً. راجع startup.log لمعرفة السبب.' });
  return false;
};
app.get('/api/campaigns/recipients', (req, res) => {
  if (!requireCampaignManager(res)) return;
  const result = campaignManager.classifyRecipients(db.data.customers.map(customer => ({ id: customer.id, name: customer.name, phone: customer.phone })));
  res.setHeader('Cache-Control', 'no-store');
  res.json(result);
});
app.get('/api/campaigns/whatsapp/status', (_req, res) => {
  if (!requireCampaignManager(res)) return;
  res.setHeader('Cache-Control', 'no-store');
  res.json(campaignManager.getWhatsAppStatus());
});
app.post('/api/campaigns/whatsapp/connect', async (_req, res) => {
  if (!requireCampaignManager(res)) return;
  try { res.json(await campaignManager.connectWhatsApp()); }
  catch (error) { res.status(503).json({ error: error.message, status: campaignManager.getWhatsAppStatus() }); }
});
app.post('/api/campaigns/whatsapp/clear-session', async (_req, res) => {
  if (!requireCampaignManager(res)) return;
  try { res.json(await campaignManager.clearWhatsAppSession()); }
  catch (error) { res.status(500).json({ error: `تعذر مسح جلسة WhatsApp: ${error.message}` }); }
});
app.post('/api/campaigns/start', (req, res) => {
  if (!requireCampaignManager(res)) return;
  const message = String(req.body?.message || '').trim();
  if (!message || message.length > 4000) return res.status(400).json({ error: 'نص الرسالة مطلوب وبحد أقصى 4000 حرف.' });
  const allValid = req.body?.allValid === true;
  const ids = Array.isArray(req.body?.recipientIds) ? new Set(req.body.recipientIds.map(Number).filter(Number.isInteger)) : new Set();
  if (!allValid && !ids.size) return res.status(400).json({ error: 'حدد عميلًا واحدًا على الأقل أو اختر كل الأرقام الصالحة.' });
  const source = db.data.customers.map(customer => ({ id: customer.id, name: customer.name, phone: customer.phone }));
  const classified = campaignManager.classifyRecipients(source);
  const recipients = allValid ? classified.recipients : classified.recipients.filter(customer => ids.has(Number(customer.id)));
  if (!recipients.length) return res.status(400).json({ error: 'لا توجد أرقام صالحة للمستلمين المحددين.' });
  try {
    const job = campaignManager.startCampaign({ recipients, message, channel: req.body?.channel, dryRun: req.body?.dryRun !== false });
    res.status(202).json(job);
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.get('/api/campaigns/jobs/:id', (req, res) => {
  if (!requireCampaignManager(res)) return;
  const job = campaignManager.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'حملة الإرسال غير موجودة.' });
  res.setHeader('Cache-Control', 'no-store');
  res.json(job);
});
app.post('/api/campaigns/jobs/:id/stop', (req, res) => {
  if (!requireCampaignManager(res)) return;
  res.json({ stopped: campaignManager.stopCampaign(req.params.id) });
});
function persistRuntimeConfig(updates) {
  const configPath = process.env.RAWDA_CONFIG_PATH || path.join(__dirname, 'config.json');
  const config = readRuntimeConfig();
  Object.assign(config, updates);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

const DEFAULT_BACKUP_SETTINGS = Object.freeze({ enabled: true, frequency: 'daily', time: '02:00', path: './backups', retention: 30 });
function currentBackupSettings() {
  const value = db.data.system_settings?.backup_settings;
  return { ...DEFAULT_BACKUP_SETTINGS, ...(value && typeof value === 'object' ? value : {}) };
}
function normalizeBackupSettings(input) {
  const value = input && typeof input === 'object' ? input : {};
  const frequency = String(value.frequency || DEFAULT_BACKUP_SETTINGS.frequency);
  const time = String(value.time || DEFAULT_BACKUP_SETTINGS.time);
  const backupPath = String(value.path ?? DEFAULT_BACKUP_SETTINGS.path).trim();
  const retention = Number(value.retention ?? DEFAULT_BACKUP_SETTINGS.retention);
  if (!['daily', 'weekly', 'monthly'].includes(frequency)) throw new Error('تكرار النسخ يجب أن يكون يومياً أو أسبوعياً أو شهرياً.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(time)) throw new Error('وقت النسخ يجب أن يكون بصيغة HH:MM.');
  if (!backupPath || backupPath.length > 500 || backupPath.includes('\0')) throw new Error('مسار النسخ الاحتياطي غير صالح.');
  if (!Number.isInteger(retention) || retention < 1 || retention > 3650) throw new Error('عدد النسخ المحتفظ بها يجب أن يكون بين 1 و3650.');
  return { enabled: value.enabled !== false, frequency, time, path: backupPath, retention };
}
function resolvedBackupDirectory() {
  const configured = currentBackupSettings().path || DEFAULT_BACKUP_SETTINGS.path;
  return path.resolve(path.isAbsolute(configured) ? configured : path.join(userDataDir, configured));
}

const googleDriveBackup = createGoogleDriveBackupService({
  userDataDir,
  getConfig: readRuntimeConfig,
  secretStore: {
    get: async name => (await requestElectronHost('secure-secret', { operation: 'get', name }))?.value || null,
    set: async (name, value) => requestElectronHost('secure-secret', { operation: 'set', name, value }),
    delete: async name => requestElectronHost('secure-secret', { operation: 'delete', name })
  },
  openExternal: url => requestElectronHost('open-google-drive-auth', { url }).then(() => undefined),
  onConnected: () => persistRuntimeConfig({ google_drive_enabled: true }),
  logger: console
});
googleDriveBackup.start();

const scheduledBackups = createScheduledBackupManager({
  userDataDir,
  databaseFile: db.getDatabasePath(),
  getBackupDir: resolvedBackupDirectory,
  getRetention: () => currentBackupSettings().retention,
  getSchedule: currentBackupSettings,
  schedulerIntervalMs: Number(process.env.RAWDA_BACKUP_SCHEDULER_INTERVAL_MS) || undefined,
  getCatalogRows: () => db.getBusinessCatalog(),
  getSecondaryPath: () => readRuntimeConfig().backup_secondary_path || '',
  onBackupCreated: backup => googleDriveBackup.enqueueBackup(backup.path, backup.name),
  logger: console
});
const dailyBackupTimer = scheduledBackups.startDailyScheduler();

app.get('/api/scheduled-backups', (req, res) => {
  res.json({ backups: scheduledBackups.listBackups().map(({ name, size, modified_at }) => ({ name, size, modified_at })) });
});
app.get('/api/scheduled-backups/:filename', (req, res) => {
  const filePath = scheduledBackups.getBackupPath(req.params.filename);
  if (!filePath) return res.status(404).json({ error: 'النسخة المجدولة غير موجودة.' });
  try { res.type('application/vnd.sqlite3').set('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`).send(fs.readFileSync(filePath)); }
  catch (error) { console.error('Scheduled backup read failed:', error.message); res.status(500).json({ error: 'تعذر قراءة النسخة المجدولة.' }); }
});
function requireBackupAccess(req, res, write = false) {
  if (!req.authUser) { res.status(401).json({ error: 'يجب تسجيل الدخول أولاً.' }); return false; }
  if (isUnrestrictedAccount(req.authUser)) return true;
  if (write || !userHasPermission(req.authUser, 'import_export')) { res.status(403).json({ error: 'لا تملك صلاحية إدارة النسخ الاحتياطية.' }); return false; }
  return true;
}
function backupTypeLabel(name) { return name.includes('-manual-') ? 'manual' : 'automatic'; }
app.get('/api/backups', (req, res) => {
  if (!requireBackupAccess(req, res)) return;
  res.json({ backups: scheduledBackups.listBackups().map(backup => ({ id: backup.name, name: backup.name, size: backup.size, modified_at: backup.modified_at, type: backupTypeLabel(backup.name) })) });
});
app.post('/api/backups', async (req, res) => {
  if (!requireBackupAccess(req, res, true)) return;
  try {
    const backup = await scheduledBackups.createBackup('manual');
    db.logAudit(req.authUser.id, 'إنشاء نسخة احتياطية يدوية', 'backup', 1, backup.name);
    res.status(201).json({ message: 'تم إنشاء النسخة الاحتياطية اليدوية.', backup: { id: backup.name, name: backup.name, size: backup.size, type: 'manual', modified_at: new Date().toISOString() } });
  } catch (error) { console.error('Manual backup failed:', error.message); res.status(500).json({ error: 'تعذر إنشاء النسخة الاحتياطية.' }); }
});
app.get('/api/backups/:id/download', (req, res) => {
  if (!requireBackupAccess(req, res)) return;
  const filePath = scheduledBackups.getBackupPath(req.params.id);
  if (!filePath) return res.status(404).json({ error: 'النسخة الاحتياطية غير موجودة.' });
  res.type('application/vnd.sqlite3').set('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`).send(fs.readFileSync(filePath));
});
app.delete('/api/backups/:id', (req, res) => {
  if (!requireBackupAccess(req, res, true)) return;
  const filePath = scheduledBackups.getBackupPath(req.params.id);
  if (!filePath) return res.status(404).json({ error: 'النسخة الاحتياطية غير موجودة.' });
  try { fs.unlinkSync(filePath); db.logAudit(req.authUser.id, 'حذف نسخة احتياطية', 'backup', 1, path.basename(filePath)); res.json({ message: 'تم حذف النسخة الاحتياطية.' }); }
  catch (error) { console.error('Backup delete failed:', error.message); res.status(500).json({ error: 'تعذر حذف النسخة الاحتياطية.' }); }
});
app.post('/api/backups/:id/restore', async (req, res) => {
  if (!req.authUser) return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً.' });
  if (!isUnrestrictedAccount(req.authUser)) return res.status(403).json({ error: 'استعادة النسخ الاحتياطية متاحة للمالك أو حساب admin فقط.' });
  if (req.body?.confirmed !== true) return res.status(400).json({ error: 'يجب تأكيد استبدال قاعدة البيانات الحالية قبل الاستعادة.' });
  const filePath = scheduledBackups.getBackupPath(req.params.id);
  if (!filePath) return res.status(404).json({ error: 'النسخة الاحتياطية غير موجودة.' });
  try {
    const result = await restoreSqliteBuffer(fs.readFileSync(filePath), req.authUser);
    res.json({ ...result, restored_from: path.basename(filePath), restart_required: false });
  } catch (error) { res.status(400).json({ error: error.restoreMessage || 'فشلت استعادة النسخة الاحتياطية.' }); }
});
app.get('/api/settings/backup', (req, res) => {
  if (!requireBackupAccess(req, res)) return;
  res.json(currentBackupSettings());
});
app.post('/api/settings/backup', (req, res) => {
  if (!requireBackupAccess(req, res, true)) return;
  try {
    const settings = normalizeBackupSettings(req.body || {});
    db.data.system_settings.backup_settings = settings;
    db.save();
    db.logAudit(req.authUser.id, 'تعديل إعدادات النسخ الاحتياطي', 'system_settings', 1, JSON.stringify(settings));
    res.json({ message: 'تم حفظ إعدادات النسخ الاحتياطي.', settings });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/scheduled-backups/safety-snapshot', async (req, res) => {
  try {
    const backup = await scheduledBackups.createSafetyBackup();
    db.logAudit(req.authUser.id, 'إنشاء نسخة أمان قبل الاستعادة', 'system', 1, backup.name);
    res.status(201).json({ message: 'تم حفظ نسخة أمان من البيانات الحالية.', name: backup.name });
  } catch (error) {
    console.error('Scheduled safety backup failed:', error.message);
    res.status(500).json({ error: 'تعذر حفظ نسخة الأمان قبل الاستعادة.' });
  }
});

app.put('/api/config/backup-settings', (req, res) => {
  const requestedPath = String(req.body?.backup_secondary_path || '').trim();
  if (requestedPath.length > 500 || requestedPath.includes('\0')) return res.status(400).json({ error: 'مسار النسخ الاحتياطي غير صالح.' });
  const configPath = process.env.RAWDA_CONFIG_PATH || path.join(__dirname, 'config.json');
  const config = readRuntimeConfig();
  config.backup_secondary_path = requestedPath;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    res.json({ message: requestedPath ? 'تم حفظ مسار النسخة الإضافية.' : 'تم إيقاف النسخ إلى المسار الإضافي.', backup_secondary_path: requestedPath });
  } catch (error) {
    console.error('Backup settings save failed:', error.message);
    res.status(500).json({ error: 'تعذر حفظ إعدادات النسخ الاحتياطي.' });
  }
});

app.get('/api/google-drive-backup/status', async (_req, res) => {
  try { res.set('Cache-Control', 'no-store').json(await googleDriveBackup.getStatus()); }
  catch (error) { res.status(500).json({ error: 'تعذر قراءة حالة النسخ السحابي.' }); }
});
app.put('/api/google-drive-backup/config', (req, res) => {
  try {
    const clientId = validateClientId(req.body?.client_id);
    const previous = readRuntimeConfig();
    const changed = String(previous.google_drive_client_id || '') !== clientId;
    const config = persistRuntimeConfig({ google_drive_client_id: clientId, ...(changed ? { google_drive_enabled: false } : {}) });
    res.json({ saved: true, connected: config.google_drive_enabled === true && !changed, message: 'تم حفظ معرّف تطبيق Google Drive.' });
  } catch (error) { res.status(400).json({ error: error.message || 'معرّف Google Drive غير صالح.' }); }
});
app.put('/api/google-drive-backup/password', async (req, res) => {
  try {
    await googleDriveBackup.setBackupPassword(req.body?.password);
    res.json({ saved: true, message: 'حُفظت كلمة مرور النسخ في مخزن النظام الآمن.' });
  } catch (error) { res.status(400).json({ error: error.message || 'تعذر حفظ كلمة مرور النسخ.' }); }
});
app.get('/api/google-drive-backup/list', async (_req, res) => {
  try { res.set('Cache-Control', 'no-store').json({ backups: await googleDriveBackup.listBackups() }); }
  catch (error) { res.status(502).json({ error: error.message || 'تعذر جلب قائمة النسخ من Google Drive.' }); }
});
app.post('/api/google-drive-backup/download-verified', async (req, res) => {
  let prepared;
  try {
    prepared = await googleDriveBackup.prepareRestore(req.body?.file_id, req.body?.password);
    const data = fs.readFileSync(prepared.path);
    res.set('Cache-Control', 'no-store').type('application/vnd.sqlite3').set('X-Backup-App-Version', String(prepared.metadata.app_version || 'unknown')).send(data);
  } catch (error) {
    console.error('Google Drive restore preparation failed:', error.message);
    res.status(400).json({ error: error.message || 'فشل تنزيل النسخة أو فك تشفيرها والتحقق منها.' });
  } finally { if (prepared?.path) await googleDriveBackup.discardPreparedRestore(prepared.path).catch(() => {}); }
});
app.post('/api/google-drive-backup/connect', (req, res) => {
  try {
    validateClientId(readRuntimeConfig().google_drive_client_id);
    void googleDriveBackup.startAuthorization().catch(error => console.warn('Google Drive authorization failed:', error.message));
    res.status(202).json({ started: true, message: 'افتح متصفح النظام لإكمال تفويض Google Drive.' });
  } catch (error) { res.status(400).json({ error: error.message || 'تعذر بدء ربط Google Drive.' }); }
});
app.post('/api/google-drive-backup/drain', async (_req, res) => {
  try {
    const status = await googleDriveBackup.getStatus();
    void googleDriveBackup.drain({ force: true }).catch(error => console.warn('Google Drive manual retry failed:', error.message));
    res.status(202).json({ pending: status.pending, message: 'بدأت محاولة رفع النسخ المشفرة في الخلفية.' });
  } catch (error) { res.status(503).json({ error: error.message || 'تعذرت محاولة الرفع حالياً.' }); }
});
app.post('/api/google-drive-backup/backup-now', async (_req, res) => {
  try {
    if (!(await googleDriveBackup.getStatus()).password_configured) return res.status(400).json({ error: 'احفظ كلمة مرور النسخ السحابي قبل إنشاء نسخة قابلة للاستعادة على جهاز آخر.' });
    persistRuntimeConfig({ google_drive_enabled: true });
    const backup = await scheduledBackups.createSafetyBackup();
    res.status(202).json({ queued: true, name: backup.name, message: 'أُنشئت نسخة SQLite محلية سليمة، وسيُشفّرها ويرفعها العامل الخلفي.' });
  } catch (error) { res.status(500).json({ error: 'تعذر إنشاء النسخة المحلية قبل الرفع.' }); }
});
app.post('/api/google-drive-backup/disconnect', async (_req, res) => {
  try {
    await googleDriveBackup.disconnect();
    persistRuntimeConfig({ google_drive_enabled: false });
    res.json({ disconnected: true, message: 'تم فصل Google Drive. بقيت النسخ المشفرة المعلقة محلياً.' });
  } catch (error) { res.status(500).json({ error: 'تعذر فصل Google Drive.' }); }
});

const MAX_AUTOMATIC_BACKUPS = 14;
const automaticBackupTasks = new Set();
let pendingSaleBackup = null;
function unlinkWithRetry(filePath, attempts = 10, delayMs = 200) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { fs.unlinkSync(filePath); return; }
    catch (error) {
      if (error.code === 'ENOENT') return;
      lastError = error;
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, delayMs);
    }
  }
  throw lastError;
}
function queueAutomaticBackup(snapshot, phase) {
  const task = Promise.resolve().then(() => writeAutomaticBackup(snapshot, phase)).finally(() => automaticBackupTasks.delete(task));
  automaticBackupTasks.add(task);
  return task;
}
function queueCoalescedSaleBackup(snapshot) {
  if (pendingSaleBackup?.timer) clearTimeout(pendingSaleBackup.timer);
  const delay = process.env.NODE_ENV === 'test' && Number.isFinite(Number(process.env.RAWDA_BACKUP_COALESCE_MS))
    ? Math.max(0, Number(process.env.RAWDA_BACKUP_COALESCE_MS)) : 60_000;
  const pending = { snapshot, timer: null };
  pending.timer = setTimeout(() => {
    if (pendingSaleBackup !== pending) return;
    pendingSaleBackup = null;
    void queueAutomaticBackup(pending.snapshot, 'بعد');
  }, delay);
  pendingSaleBackup = pending;
  return pending;
}
function flushCoalescedSaleBackup() {
  if (!pendingSaleBackup) return null;
  clearTimeout(pendingSaleBackup.timer);
  const { snapshot } = pendingSaleBackup;
  pendingSaleBackup = null;
  return queueAutomaticBackup(snapshot, 'بعد');
}
async function writeAutomaticBackup(snapshot, phase) {
  let stagingFile = null;
  let adapter = null;
  try {
    const databaseFile = db.getDatabasePath();
    const folder = path.join(path.dirname(databaseFile), 'backups');
    fs.mkdirSync(folder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const token = crypto.randomBytes(6).toString('hex');
    const file = path.join(folder, `automatic-${phase}-${stamp}-${process.pid}-${token}.sqlite`);
    const data = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
    const catalogRows = Array.isArray(data.business_catalog) ? data.business_catalog : null;
    if (data.backup_live_database === true) {
      // Sales are already committed to the live SQLite file before their HTTP
      // response. Copy that committed database directly; rebuilding a second
      // full database from the in-memory snapshot for every sale is needlessly
      // expensive on large inventories.
      await copySqliteDatabase(databaseFile, file, { catalogRows });
    } else {
      stagingFile = path.join(folder, `.automatic-${token}.stage.sqlite`);
      adapter = createSqliteStorageAdapter(stagingFile);
      adapter.save(data);
      adapter.close();
      adapter = null;
      await copySqliteDatabase(stagingFile, file, { catalogRows });
      unlinkWithRetry(stagingFile);
      stagingFile = null;
    }
    const backups = fs.readdirSync(folder)
      .filter(name => /^automatic-(قبل|بعد)-.*\.sqlite$/u.test(name))
      .map(name => ({ name, mtime: fs.statSync(path.join(folder, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const removed = backups.slice(MAX_AUTOMATIC_BACKUPS);
    for (const stale of removed) fs.unlinkSync(path.join(folder, stale.name));
  } catch (error) { console.error('Automatic database backup failed:', error.message); }
  finally { try { adapter?.close(); } catch {} if (stagingFile) try { unlinkWithRetry(stagingFile); } catch (error) { console.error('Automatic staging cleanup failed:', error.message); } }
}
app.use('/api', (req, res, next) => {
  if (isTrialPeriodActive()) return next();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || req.path === '/login') return next();
  // A sale is committed atomically to SQLite before its response. Keep
  // its post-commit recovery snapshot, but avoid serializing/writing a second
  // full pre-sale copy for every ordinary checkout.
  const isSaleCommit = req.method === 'POST' && req.path === '/sales';
  const snapshotNow = () => JSON.stringify({ ...db.getAutomaticSnapshot(), business_catalog: db.getBusinessCatalog() });
  const before = isSaleCommit ? null : snapshotNow();
  res.once('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      setImmediate(() => {
        if (before !== null) void queueAutomaticBackup(before, 'قبل');
        const afterSnapshot = isSaleCommit
          ? { backup_live_database: true, business_catalog: db.getBusinessCatalog() }
          : snapshotNow();
        if (isSaleCommit) queueCoalescedSaleBackup(afterSnapshot);
        else void queueAutomaticBackup(afterSnapshot, 'بعد');
      });
    }
  });
  next();
});

// Helper to get formatted timestamp
const nowStr = () => new Date().toISOString().replace('T', ' ').substring(0, 19);
const businessDateToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const businessTimeNow = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
const EXPIRY_WARNING_DAYS = 30;
const validOptionalDate = value => {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const getDaysUntilExpiry = value => {
  if (!validOptionalDate(value) || !value) return null;
  const target = Date.parse(`${value}T00:00:00.000Z`);
  const [year, month, day] = businessDateToday().split('-').map(Number);
  const todayUtc = Date.UTC(year, month - 1, day);
  return Math.floor((target - todayUtc) / 86400000);
};
const productDateError = (productionDate, expiryDate) => {
  if (!validOptionalDate(productionDate) || !validOptionalDate(expiryDate)) return 'أدخل تاريخًا صحيحًا بصيغة يوم/شهر/سنة.';
  if (productionDate && expiryDate && productionDate > expiryDate) return 'تاريخ الإنتاج لا يمكن أن يكون بعد تاريخ الانتهاء.';
  return '';
};
const promotionForLine = (product, quantity, unitPrice, date = new Date().toISOString().slice(0, 10)) => {
  const time = businessTimeNow();
  const candidates = (db.data.promotions || []).filter(promotion => {
    if (!promotion.is_active || (promotion.start_date && promotion.start_date > date) || (promotion.end_date && promotion.end_date < date)) return false;
    if (promotion.start_time && time < promotion.start_time) return false;
    if (promotion.end_time && time > promotion.end_time) return false;
    return (!promotion.product_id && !promotion.category_id)
      || Number(promotion.product_id) === Number(product.id)
      || Number(promotion.category_id) === Number(product.category_id);
  }).map(promotion => {
    let discount = 0;
    if (promotion.type === 'bundle') {
      const buy = Number(promotion.buy_quantity) || 0; const free = Number(promotion.get_quantity) || 0;
      if (buy > 0 && free > 0) discount = Math.floor(quantity / (buy + free)) * free * unitPrice;
    } else {
      const perUnit = promotion.type === 'percent' ? unitPrice * Number(promotion.value) / 100 : Math.min(unitPrice, Number(promotion.value));
      discount = Math.min(unitPrice * quantity, perUnit * quantity);
    }
    return { promotion, discount: Number(discount.toFixed(2)) };
  }).sort((a, b) => b.discount - a.discount);
  return candidates[0] || { promotion: null, discount: 0 };
};

// Helper to find local Wi-Fi / Ethernet IPv4
const getLocalIP = () => {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if ((net.family !== 'IPv4' && net.family !== 4) || net.internal) continue;
      if (/^(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(net.address)) return net.address;
    }
  }
  return '';
};

// ----------------------------------------------------
// Auth & Users
// ----------------------------------------------------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const attemptKey = loginAttemptKey(req.ip, username);
  const now = Date.now();
  const attempt = getLoginAttempt(attemptKey, now);
  if (attempt?.lockedUntil > now) return res.status(429).json({ error: 'محاولات دخول كثيرة. انتظر 15 دقيقة ثم حاول مرة أخرى.' });
  const user = db.findUserByUsername(username);
  const passwordMatches = Boolean(user && await verifyPassword(password, user.password_hash));
  if (!passwordMatches) {
    const failedAttempt = recordFailedLogin(attemptKey, username, now);
    if (failedAttempt.lockedUntil > now) return res.status(429).json({ error: 'محاولات دخول كثيرة. انتظر 15 دقيقة ثم حاول مرة أخرى.' });
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة، أو الحساب معطل' });
  }
  clearLoginAttempt(attemptKey);
  res.json(issueLoginSession(user, req, res));
});

app.post('/api/webauthn/register/options', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const attemptKey = loginAttemptKey(req.ip, username);
  const now = Date.now();
  const attempt = getLoginAttempt(attemptKey, now);
  if (attempt?.lockedUntil > now) return res.status(429).json({ error: 'محاولات دخول كثيرة. انتظر 15 دقيقة ثم حاول مرة أخرى.' });
  const user = db.findUserByUsername(username);
  if (!user || !await verifyPassword(password, user.password_hash)) {
    const failedAttempt = recordFailedLogin(attemptKey, username, now);
    return res.status(failedAttempt.lockedUntil > now ? 429 : 401).json({ error: failedAttempt.lockedUntil > now ? 'محاولات دخول كثيرة. انتظر 15 دقيقة ثم حاول مرة أخرى.' : 'اسم المستخدم أو كلمة المرور غير صحيحة، أو الحساب معطل.' });
  }
  clearLoginAttempt(attemptKey);
  cleanExpiredWebAuthnChallenges();
  user.webauthn_user_id ||= base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.randomBytes(32));
  webAuthnChallenges.set(challenge, { userId: user.id, purpose: 'registration', expiresAt: Date.now() + 5 * 60 * 1000 });
  db.save();
  res.json({
    challenge,
    rp: { name: 'SYSTEM لإدارة حسابات بضاعتك', id: webAuthnRpId() },
    user: { id: user.webauthn_user_id, name: user.username, displayName: user.name },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    timeout: 120000,
    attestation: 'none',
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'discouraged', userVerification: 'required' },
    excludeCredentials: (user.webauthn_credentials || []).map(item => ({ type: 'public-key', id: item.id, transports: item.transports || [] }))
  });
});

app.post('/api/webauthn/register/verify', (req, res) => {
  try {
    const credential = req.body || {};
    const challenge = String(credential.challenge || '');
    const pending = webAuthnChallenges.get(challenge);
    const user = pending?.purpose === 'registration' && pending.expiresAt > Date.now()
      ? db.data.users.find(entry => entry.id === pending.userId && entry.is_active) : null;
    if (!user) return res.status(400).json({ error: 'انتهت صلاحية طلب التسجيل. أعد المحاولة.' });
    webAuthnChallenges.delete(challenge);
    verifyWebAuthnClientData(credential.clientDataJSON, 'webauthn.create', challenge);
    const attestation = readCbor(fromBase64url(credential.attestationObject)).value;
    if (!(attestation instanceof Map) || attestation.get('fmt') !== 'none' || !(attestation.get('attStmt') instanceof Map)) {
      return res.status(400).json({ error: 'صيغة تسجيل Windows Hello غير مدعومة.' });
    }
    const authData = attestation.get('authData');
    if (!Buffer.isBuffer(authData)) throw new Error('بيانات التسجيل غير مكتملة.');
    const expectedRpHash = crypto.createHash('sha256').update(webAuthnRpId()).digest();
    if (!crypto.timingSafeEqual(authData.subarray(0, 32), expectedRpHash)) throw new Error('مصدر Windows Hello غير مطابق لهذا التطبيق.');
    const parsed = parseAuthenticatorData(authData, true);
    const credentialId = base64url(parsed.credentialId);
    if (credentialId !== String(credential.id || '')) throw new Error('معرّف جهاز Windows Hello غير مطابق.');
    const coseStart = 55 + authData.readUInt16BE(53);
    const coseEnd = readCbor(authData, coseStart).offset;
    const publicKeyCose = authData.subarray(coseStart, coseEnd);
    const transports = Array.isArray(credential.transports) ? credential.transports.filter(value => ['usb', 'nfc', 'ble', 'internal', 'hybrid'].includes(value)) : ['internal'];
    user.webauthn_credentials ||= [];
    if (user.webauthn_credentials.some(item => item.id === credentialId)) return res.status(409).json({ error: 'Windows Hello مربوط بهذا الحساب بالفعل.' });
    user.webauthn_credentials.push({ id: credentialId, public_key: base64url(publicKeyCose), counter: parsed.counter, transports, created_at: new Date().toISOString() });
    db.save();
    db.logAudit(user.id, 'ربط Windows Hello', 'users', user.id, 'تم ربط وسيلة دخول Windows Hello بالحساب.');
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message || 'تعذر تسجيل Windows Hello.' });
  }
});

app.post('/api/webauthn/auth/options', (req, res) => {
  cleanExpiredWebAuthnChallenges();
  const username = String(req.body?.username || '').trim();
  const user = db.findUserByUsername(username);
  if (!user || !Array.isArray(user.webauthn_credentials) || !user.webauthn_credentials.length) {
    return res.status(404).json({ error: 'لا يوجد Windows Hello مربوط بهذا الحساب. سجّل الدخول بكلمة المرور ثم اربطه أولاً.' });
  }
  const challenge = base64url(crypto.randomBytes(32));
  webAuthnChallenges.set(challenge, { userId: user.id, purpose: 'authentication', expiresAt: Date.now() + 5 * 60 * 1000 });
  res.json({
    challenge,
    timeout: 120000,
    rpId: webAuthnRpId(),
    userVerification: 'required',
    allowCredentials: user.webauthn_credentials.map(item => ({ type: 'public-key', id: item.id, transports: item.transports || [] }))
  });
});

app.post('/api/webauthn/auth/verify', (req, res) => {
  try {
    const assertion = req.body || {};
    const challenge = String(assertion.challenge || '');
    const pending = webAuthnChallenges.get(challenge);
    const user = pending?.purpose === 'authentication' && pending.expiresAt > Date.now()
      ? db.data.users.find(entry => entry.id === pending.userId && entry.is_active) : null;
    if (!user) return res.status(400).json({ error: 'انتهت صلاحية طلب الدخول. حاول مرة أخرى.' });
    webAuthnChallenges.delete(challenge);
    verifyWebAuthnClientData(assertion.clientDataJSON, 'webauthn.get', challenge);
    const credential = (user.webauthn_credentials || []).find(item => item.id === String(assertion.id || ''));
    if (!credential) return res.status(401).json({ error: 'هذا الجهاز غير مربوط بالحساب.' });
    const authData = fromBase64url(assertion.authenticatorData);
    if (authData.length < 37) throw new Error('بيانات الدخول غير مكتملة.');
    const expectedRpHash = crypto.createHash('sha256').update(webAuthnRpId()).digest();
    if (!crypto.timingSafeEqual(authData.subarray(0, 32), expectedRpHash)) throw new Error('مصدر Windows Hello غير مطابق لهذا التطبيق.');
    const parsed = parseAuthenticatorData(authData);
    if (parsed.counter && credential.counter && parsed.counter <= credential.counter) throw new Error('تم رفض محاولة دخول قديمة.');
    const clientHash = crypto.createHash('sha256').update(fromBase64url(assertion.clientDataJSON)).digest();
    const signedData = Buffer.concat([authData, clientHash]);
    const cose = readCbor(fromBase64url(credential.public_key)).value;
    const publicKey = webAuthnPublicKey(cose);
    if (!crypto.verify('sha256', signedData, publicKey, fromBase64url(assertion.signature))) return res.status(401).json({ error: 'تعذر التحقق من بصمة أو وجه Windows Hello.' });
    credential.counter = parsed.counter;
    db.save();
    res.json(issueLoginSession(user, req, res));
  } catch (error) {
    res.status(400).json({ error: error.message || 'تعذر الدخول باستخدام Windows Hello.' });
  }
});

app.get('/api/me', (req, res) => {
  const user = req.authUser;
  res.json({ id: user.id, name: user.name, username: user.username, must_change_password: Boolean(user.must_change_password), role: user.role, permissions: Array.isArray(user.permissions) ? user.permissions : [], is_owner: Boolean(user.is_owner), allowed_tabs: Array.isArray(user.allowed_tabs) ? user.allowed_tabs : null, branch_id: user.branch_id ?? null, branch_ids: getUserBranchIds(user) });
});

async function handlePasswordChange(req, res) {
  const { current_password, new_password } = req.body || {};
  const attempt = passwordChangeAttempt(req.ip);
  if (attempt.count >= PASSWORD_CHANGE_LIMIT) return res.status(429).json({ error: 'تجاوزت عدد محاولات تغيير كلمة المرور. حاول بعد ساعة.' });
  attempt.count += 1;
  if (typeof current_password !== 'string' || typeof new_password !== 'string' || !current_password || !new_password) return res.status(400).json({ error: 'أدخل كلمة المرور الحالية والجديدة.' });
  if (!await verifyPassword(current_password, req.authUser.password_hash)) return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة.' });
  if (new_password.toLocaleLowerCase() === String(req.authUser.username || '').toLocaleLowerCase()) return res.status(400).json({ error: 'لا تستخدم اسم المستخدم ككلمة مرور.' });
  const strengthError = strongPasswordError(new_password, current_password);
  if (strengthError) return res.status(400).json({ error: strengthError });
  req.authUser.password_hash = await passwordHashAsync(new_password);
  req.authUser.must_change_password = false;
  db.save();
  const activeToken = getCookieToken(req);
  for (const [token, session] of loginSessions) if (session.userId === req.authUser.id && token !== activeToken) loginSessions.delete(token);
  db.logAudit(req.authUser.id, 'تغيير كلمة المرور', 'users', req.authUser.id, { ip: req.ip || req.socket?.remoteAddress || '', timestamp: new Date().toISOString() });
  res.json({ message: 'تم تغيير كلمة المرور بنجاح.' });
}
app.put('/api/me/password', handlePasswordChange);
app.post('/api/auth/change-password', handlePasswordChange);

app.post('/api/auth/logout-all', (req, res) => {
  for (const [token, session] of loginSessions) if (session.userId === req.authUser.id) loginSessions.delete(token);
  db.logAudit(req.authUser.id, 'تسجيل الخروج من كل الأجهزة', 'sessions', req.authUser.id, { ip: req.ip || req.socket?.remoteAddress || '', timestamp: new Date().toISOString() });
  const secureCookie = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}`);
  res.json({ success: true, message: 'تم تسجيل الخروج من كل الأجهزة.' });
});

app.post('/api/logout', (req, res) => {
  loginSessions.delete(getCookieToken(req));
  const secureCookie = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}`);
  res.json({ success: true });
});

app.post('/api/maintenance/toggle', (req, res) => {
  if (!isMaintenanceOwner(req.authUser)) return res.status(403).json({ error: 'وضع الصيانة متاح للمالك أو super_owner فقط.' });
  const current = maintenanceSettings();
  const enabled = req.body?.enabled === true || req.body?.enabled === 1;
  const messageAr = String(req.body?.message_ar ?? current.message_ar).trim().slice(0, 500);
  const messageEn = String(req.body?.message_en ?? current.message_en).trim().slice(0, 500);
  const expectedEnd = String(req.body?.expected_end ?? current.expected_end).trim().slice(0, 80);
  if (!messageAr || !messageEn) return res.status(400).json({ error: 'رسالة الصيانة مطلوبة بالعربية والإنجليزية.' });
  db.data.system_settings.maintenance = { enabled, message_ar: messageAr, message_en: messageEn, expected_end: expectedEnd };
  db.save();
  db.logAudit(req.authUser.id, enabled ? 'تفعيل وضع الصيانة' : 'إيقاف وضع الصيانة', 'system_settings', 1, db.data.system_settings.maintenance);
  res.json({ message: enabled ? 'تم تفعيل وضع الصيانة.' : 'تم إيقاف وضع الصيانة.', maintenance: db.data.system_settings.maintenance });
});

const requireBranchManager = (req, res) => { if (!isUnrestrictedAccount(req.authUser)) { res.status(403).json({ error: 'إدارة الفروع متاحة لمالك النظام أو حساب admin فقط.' }); return false; } return true; };
  app.get('/api/branches', (req,res) => { const unrestricted = isUnrestrictedAccount(req.authUser); const allowed = new Set(getUserBranchIds(req.authUser)); const branches=db.data.branches.filter(branch=>!branch.deleted_at&&(unrestricted||allowed.has(Number(branch.id)))).map(branch=>({...branch,user_count:db.data.users.filter(user=>!isUnrestrictedAccount(user)&&user.is_active!==false&&branchAccessLevel(user,Number(branch.id))!=='none').length})); res.json({branches,active_branch_id:req.branchId,can_manage:unrestricted,can_switch:Boolean(unrestricted||allowed.size>1)}); });
  app.get('/api/branches/:id/users', (req,res) => {
    const branchId = Number(req.params.id);
    const branch = db.data.branches.find(row => Number(row.id) === branchId && !row.deleted_at);
    if (!branch) return res.status(404).json({ error: 'الفرع غير موجود.' });
    if (!isUnrestrictedAccount(req.authUser) && branchAccessLevel(req.authUser, branchId) === 'none') return res.status(403).json({ error: 'لا تملك صلاحية قراءة مستخدمي هذا الفرع.' });
    const users = db.data.users.filter(user => !isUnrestrictedAccount(user) && user.is_active !== false && branchAccessLevel(user, branchId) !== 'none').map(user => ({ id: Number(user.id), username: user.username, name: user.name || user.full_name || user.username, role: user.role || 'cashier', access_level: explicitBranchAccess(user.id, branchId) || 'read' }));
    res.json({ branch, users });
  });
app.post('/api/branches',(req,res)=>{
  if(!requireBranchManager(req,res))return;
  const rawProductIds=req.body?.initial_product_ids;
  if(rawProductIds!==undefined&&!Array.isArray(rawProductIds))return res.status(400).json({error:'قائمة الأصناف المختارة غير صالحة.'});
  if(Array.isArray(rawProductIds)&&rawProductIds.length>500)return res.status(400).json({error:'يمكن ربط 500 صنف كحد أقصى عند إنشاء الفرع.'});
  const name=String(req.body?.name||'').trim().slice(0,100);
  if(!name)return res.status(400).json({error:'اسم الفرع مطلوب.'});
  if(db.data.branches.some(branch=>!branch.deleted_at&&branch.name.trim().toLowerCase()===name.toLowerCase()))return res.status(409).json({error:'اسم الفرع مستخدم بالفعل.'});
  const productsById=new Map(db.data.products.map(product=>[Number(product.id),product]));
  const productIds=[...new Set((rawProductIds||[]).map(Number).filter(id=>Number.isInteger(id)&&id>0))].filter(id=>productsById.has(id));
  const branch={id:db.nextId('branches'),name,address:String(req.body?.address||'').trim().slice(0,250),phone:String(req.body?.phone||'').trim().slice(0,40),is_active:true,is_default:false,created_at:nowStr()};
  db.data.branches.push(branch);
  const warehouse=ensureBranchWarehouse(db,branch.id,{save:false});
  const initialCategoryName=String(req.body?.initial_category||'').trim().slice(0,100);
  let category=null;
  if(initialCategoryName&&warehouse){category={id:db.nextId('warehouse_categories'),branch_id:Number(branch.id),warehouse_id:Number(warehouse.id),name:initialCategoryName,created_at:nowStr()};db.data.warehouse_categories.push(category);}
  let nextInventoryId=db.nextId('branch_inventory');
  let nextWarehouseInventoryId=db.nextId('warehouse_inventory');
  let nextWarehouseProductId=db.nextId('warehouse_products');
  const assignedProducts=new Set((db.data.branch_inventory||[]).filter(row=>Number(row.branch_id)===Number(branch.id)).map(row=>Number(row.product_id)));
  const warehouseProducts=new Set((db.data.warehouse_products||[]).filter(row=>Number(row.branch_id)===Number(branch.id)&&Number(row.warehouse_id)===Number(warehouse?.id)).map(row=>Number(row.product_id)));
  const warehouseInventoryProducts=new Set((db.data.warehouse_inventory||[]).filter(row=>Number(row.branch_id)===Number(branch.id)&&Number(row.warehouse_id)===Number(warehouse?.id)).map(row=>Number(row.product_id)));
  for(const productId of productIds){
    const product=productsById.get(productId);
    if(!assignedProducts.has(productId)){db.data.branch_inventory.push({id:nextInventoryId++,branch_id:Number(branch.id),product_id:productId,quantity:0,min_stock:Math.max(0,Number(product?.min_stock)||0)});assignedProducts.add(productId);}
    if(!warehouseProducts.has(productId)){db.data.warehouse_products.push({id:nextWarehouseProductId++,branch_id:Number(branch.id),warehouse_id:Number(warehouse.id),product_id:productId,category_id:category?.id||null,created_at:nowStr()});warehouseProducts.add(productId);}
    if(!warehouseInventoryProducts.has(productId)){db.data.warehouse_inventory.push({id:nextWarehouseInventoryId++,warehouse_id:Number(warehouse.id),branch_id:Number(branch.id),product_id:productId,quantity:0,min_stock:0});warehouseInventoryProducts.add(productId);}
  }
  seedHardwareProfilesForBranch(db.storageAdapter.connection, branch.id);
  db.save(); db.logAudit(req.authUser.id,'إنشاء فرع','branches',branch.id,name); res.status(201).json(branch);
});
app.put('/api/branches/:id',(req,res)=>{ if(!requireBranchManager(req,res))return; const branch=db.data.branches.find(row=>row.id===Number(req.params.id)&&!row.deleted_at); if(!branch)return res.status(404).json({error:'الفرع غير موجود.'}); const name=req.body?.name===undefined?branch.name:String(req.body.name||'').trim().slice(0,100); if(!name)return res.status(400).json({error:'اسم الفرع مطلوب.'}); if(req.body?.is_active===false&&branch.is_default)return res.status(400).json({error:'لا يمكن إيقاف الفرع الرئيسي.'}); if(req.body?.is_active===false&&db.data.users.some(user=>!isUnrestrictedAccount(user)&&user.is_active&&getUserBranchIds(user).includes(branch.id)))return res.status(409).json({error:'انقل المستخدمين النشطين إلى فرع آخر أولاً.'}); branch.name=name; if(req.body?.address!==undefined)branch.address=String(req.body.address||'').trim().slice(0,250); if(req.body?.phone!==undefined)branch.phone=String(req.body.phone||'').trim().slice(0,40); if(typeof req.body?.is_active==='boolean')branch.is_active=req.body.is_active; branch.updated_at=nowStr(); db.save(); db.logAudit(req.authUser.id,'تعديل فرع','branches',branch.id,name); res.json(branch); });
  app.delete('/api/branches/:id', (req, res) => {
  if (!requireBranchManager(req, res)) return;
  return res.status(405).json({ error: 'حذف الفروع غير متاح. استخدم تعطيل الفرع للاحتفاظ بسجلاته.' });
  /*
  const branchId = Number(req.params.id), branch = db.data.branches.find(row => Number(row.id) === branchId && !row.deleted_at);
  if (!branch) return res.status(404).json({ error: 'الفرع غير موجود.' });
  if (branch.is_default) return res.status(400).json({ error: 'لا يمكن حذف الفرع الرئيسي.' });
  if (db.data.users.some(user => getUserBranchIds(user).includes(branchId))) return res.status(409).json({ error: 'انقل المستخدمين المرتبطين بهذا الفرع أولاً.' });
  const warehouses = db.data.warehouses.filter(row => Number(row.branch_id) === branchId);
  const warehouseIds = new Set(warehouses.map(row => Number(row.id)));
  if (db.data.branch_inventory.some(row => Number(row.branch_id) === branchId && Number(row.quantity || 0) !== 0)
    || db.data.warehouse_inventory.some(row => Number(row.branch_id) === branchId && Number(row.quantity || 0) !== 0)) {
    return res.status(409).json({ error: 'صفّر أرصدة الفرع ومخازنه قبل الحذف.' });
  }
  const removableStructure = new Set(['branches', 'branch_inventory', 'warehouses', 'warehouse_categories', 'warehouse_products', 'warehouse_inventory']);
  const branchSaleIds = new Set((db.data.sales || []).filter(row => Number(row.branch_id || db.data.default_branch_id) === branchId).map(row => Number(row.id)));
  const branchPurchaseIds = new Set((db.data.purchases || []).filter(row => Number(row.branch_id || db.data.default_branch_id) === branchId).map(row => Number(row.id)));
  const branchPurchaseOrderIds = new Set((db.data.purchase_orders || []).filter(row => Number(row.branch_id || db.data.default_branch_id) === branchId).map(row => Number(row.id)));
  const branchShiftIds = new Set((db.data.cashier_shifts || []).filter(row => Number(row.branch_id || db.data.default_branch_id) === branchId).map(row => Number(row.id)));
  const branchRiderIds = new Set((db.data.delivery_riders || []).filter(row => Number(row.branch_id || db.data.default_branch_id) === branchId).map(row => Number(row.id)));
  const hasDirectHistory = Object.entries(db.data).some(([key, rows]) => !removableStructure.has(key) && Array.isArray(rows) && rows.some(row => Number(row.branch_id || (['sales', 'purchases'].includes(key) ? db.data.default_branch_id : 0)) === branchId));
  const hasRelatedHistory =
    (db.data.sale_items || []).some(row => branchSaleIds.has(Number(row.sale_id)))
    || (db.data.sale_returns || []).some(row => branchSaleIds.has(Number(row.sale_id)) || branchShiftIds.has(Number(row.shift_id)))
    || (db.data.loyalty_transactions || []).some(row => branchSaleIds.has(Number(row.sale_id)))
    || (db.data.installment_contracts || []).some(row => branchSaleIds.has(Number(row.sale_id)))
    || (db.data.purchase_items || []).some(row => branchPurchaseIds.has(Number(row.purchase_id)))
    || (db.data.purchase_order_items || []).some(row => branchPurchaseOrderIds.has(Number(row.purchase_order_id)))
    || (db.data.delivery_assignments || []).some(row => branchSaleIds.has(Number(row.sale_id)) || branchRiderIds.has(Number(row.rider_id)))
    || (db.data.delivery_settlements || []).some(row => branchRiderIds.has(Number(row.rider_id)))
    || (db.data.cash_transactions || []).some(row => branchShiftIds.has(Number(row.shift_id)));
  const hasHistory = hasDirectHistory || hasRelatedHistory;
  if (hasHistory) return res.status(409).json({ error: 'لا يمكن حذف فرع له فواتير أو حركات تاريخية. أوقف الفرع للاحتفاظ بسجلاته.' });
  for (const key of ['branch_inventory', 'warehouses', 'warehouse_categories', 'warehouse_products', 'warehouse_inventory']) {
    if (!Array.isArray(db.data[key])) continue;
    db.data[key] = db.data[key].filter(row => Number(row.branch_id) !== branchId && !warehouseIds.has(Number(row.warehouse_id)));
  }
  branch.is_active = false;
  branch.deleted_at = nowStr();
  branch.updated_at = branch.deleted_at;
  db.save();
  db.logAudit(req.authUser.id, 'حذف فرع بعد تصفية محتوياته', 'branches', branchId, branch.name);
  res.json({ message: 'تم حذف الفرع ومخازنه الفارغة.' }); */
});

app.get('/api/permissions/catalog', (req, res) => {
  if (!requireGranular(req, res, 'users.manage_permissions')) return;
  const rows = db.storageAdapter.connection.prepare('SELECT id,code,name_ar,category FROM permissions ORDER BY category,code').all();
  const defaults = db.storageAdapter.connection.prepare('SELECT role,permission_id,granted FROM role_defaults').all();
  res.json({ permissions: rows, role_defaults: defaults });
});

app.get('/api/users/:id/permissions', (req, res) => {
  if (!requireGranular(req, res, 'users.manage_permissions')) return;
  const user = db.data.users.find(row => Number(row.id) === Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'المستخدم غير موجود.' });
  const connection = db.storageAdapter.connection;
  const permissions = connection.prepare('SELECT p.code,p.name_ar,p.category,COALESCE(up.granted,rd.granted,0) AS granted,up.granted AS override_granted FROM permissions p LEFT JOIN role_defaults rd ON rd.permission_id=p.id AND rd.role=? LEFT JOIN user_permissions up ON up.permission_id=p.id AND up.user_id=? ORDER BY p.category,p.code').all(String(user.role || ''), Number(user.id));
  res.json({ user_id: user.id, role: user.role, permissions, constraints: permissionConstraintsForUser(user) });
});

app.put('/api/users/:id/permissions', (req, res) => {
  if (!requireGranular(req, res, 'users.manage_permissions')) return;
  const user = db.data.users.find(row => Number(row.id) === Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'المستخدم غير موجود.' });
  const connection = db.storageAdapter.connection;
  const overrides = Array.isArray(req.body?.overrides) ? req.body.overrides : [];
  const valid = new Set(connection.prepare('SELECT code FROM permissions').all().map(row => row.code));
  if (overrides.some(item => !valid.has(String(item.code)))) return res.status(400).json({ error: 'توجد صلاحية غير معروفة.' });
  const constraints = req.body?.constraints || {};
  const maxDiscount = Number(constraints.max_discount_percent ?? 100);
  const maxInvoice = Number(constraints.max_invoice_amount ?? 0);
  const canDelete = constraints.can_delete_invoice === true || Number(constraints.can_delete_invoice) === 1 ? 1 : 0;
  if (!Number.isFinite(maxDiscount) || maxDiscount < 0 || maxDiscount > 100 || !Number.isFinite(maxInvoice) || maxInvoice < 0) return res.status(400).json({ error: 'قيود المستخدم غير صالحة.' });
  const before = connection.prepare('SELECT p.code,up.granted FROM user_permissions up JOIN permissions p ON p.id=up.permission_id WHERE up.user_id=? ORDER BY p.code').all(Number(user.id));
  connection.exec('BEGIN IMMEDIATE');
  try {
    const upsert = connection.prepare('INSERT INTO user_permissions(user_id,permission_id,granted,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id,permission_id) DO UPDATE SET granted=excluded.granted,updated_at=CURRENT_TIMESTAMP');
    const idFor = connection.prepare('SELECT id FROM permissions WHERE code=?');
    for (const item of overrides) upsert.run(Number(user.id), idFor.get(String(item.code)).id, item.granted === true || Number(item.granted) === 1 ? 1 : 0);
    connection.prepare('INSERT INTO permission_constraints(user_id,max_discount_percent,max_invoice_amount,can_delete_invoice,updated_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET max_discount_percent=excluded.max_discount_percent,max_invoice_amount=excluded.max_invoice_amount,can_delete_invoice=excluded.can_delete_invoice,updated_at=CURRENT_TIMESTAMP').run(Number(user.id), maxDiscount, maxInvoice, canDelete);
    connection.exec('COMMIT');
  } catch (error) { try { connection.exec('ROLLBACK'); } catch {} throw error; }
  const after = connection.prepare('SELECT p.code,up.granted FROM user_permissions up JOIN permissions p ON p.id=up.permission_id WHERE up.user_id=? ORDER BY p.code').all(Number(user.id));
  db.logAudit(req.authUser.id, 'تعديل صلاحيات مستخدم', 'user_permissions', user.id, { before, after, constraints: { max_discount_percent: maxDiscount, max_invoice_amount: maxInvoice, can_delete_invoice: canDelete } });
  res.json({ user_id: user.id, permissions: granularPermissionsForUser(user), constraints: permissionConstraintsForUser(user) });
});

app.get('/api/users', (req, res) => {
  const unrestricted = isUnrestrictedAccount(req.authUser);
  const callerBranches = new Set(unrestricted ? db.data.branches.map(branch => Number(branch.id)) : getUserBranchIds(req.authUser));
  const users = db.data.users.filter(u => !u.is_owner && u.is_hidden !== true && (unrestricted || getUserBranchIds(u).some(branchId => callerBranches.has(branchId)))).map(u => ({
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    permissions: Array.isArray(u.permissions) ? u.permissions : [],
    allowed_tabs: Array.isArray(u.allowed_tabs) ? u.allowed_tabs : null,
    branch_id: u.branch_id ?? db.data.default_branch_id,
    branch_ids: getUserBranchIds(u),
    branch_names: getUserBranchIds(u).map(branchId => db.data.branches.find(branch => Number(branch.id) === branchId)?.name).filter(Boolean),
    branch_name: db.data.branches.find(branch => branch.id === Number(u.branch_id))?.name || 'الفرع الرئيسي',
    is_active: u.is_active,
    created_at: u.created_at
  }));
  res.json(users);
});

app.get('/api/users/:id/branches', (req, res) => {
  if (!requireAdmin(req.authUser.id, res)) return;
  const user = db.data.users.find(row => Number(row.id) === Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'المستخدم غير موجود.' });
  const branches = db.data.branches.filter(branch => !branch.deleted_at).map(branch => ({
    branch_id: Number(branch.id),
    branch_name: branch.name,
    access_level: branchAccessLevel(user, branch.id)
  }));
  res.json({ user_id: user.id, branches });
});

app.put('/api/users/:id/branches', (req, res) => {
  if (!requireAdmin(req.authUser.id, res)) return;
  const user = db.data.users.find(row => Number(row.id) === Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'المستخدم غير موجود.' });
  if (user.is_owner) return res.status(403).json({ error: 'حساب مالك النظام لديه وصول كامل ولا يحتاج إلى تعيين فروع.' });
  const branches = Array.isArray(req.body?.branches) ? req.body.branches : [];
  if (branches.some(item => !['read', 'write', 'none'].includes(String(item?.access_level || '')))) return res.status(400).json({ error: 'مستوى وصول الفرع يجب أن يكون قراءة أو كتابة أو منع.' });
  const validIds = new Set(db.data.branches.filter(branch => !branch.deleted_at && branch.is_active !== false).map(branch => Number(branch.id)));
  if (branches.some(item => !validIds.has(Number(item.branch_id)))) return res.status(400).json({ error: 'يوجد فرع غير صالح في التعيين.' });
  const entries = branches.map(item => ({ branch_id: Number(item.branch_id), access_level: String(item.access_level) }));
  try { replaceUserBranchAccess(user.id, entries.map(item => item.branch_id), entries, user.role); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const visibleBranchIds = entries.filter(item => item.access_level !== 'none').map(item => item.branch_id);
  user.branch_ids = visibleBranchIds;
  if (visibleBranchIds.length && !visibleBranchIds.includes(Number(user.branch_id))) user.branch_id = visibleBranchIds[0];
  db.save();
  db.logAudit(req.authUser.id, 'تعديل صلاحيات فروع المستخدم', 'user_branches', user.id, entries);
  res.json({ user_id: user.id, branches: entries });
});

app.post('/api/users', async (req, res) => {
  const { name, username, password, role, permissions, current_user_id } = req.body;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'allowed_tabs') && !isUnrestrictedAccount(req.authUser)) {
    return res.status(403).json({ error: 'تحديد الشاشات المسموحة متاح لمالك النظام أو حساب admin فقط.' });
  }
  if (!requireAdmin(current_user_id, res)) return;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'allowed_tabs') && !Array.isArray(req.body.allowed_tabs)) {
    return res.status(400).json({ error: 'قائمة الشاشات المسموحة غير صالحة.' });
  }
  const allowedTabs = Array.isArray(req.body?.allowed_tabs) ? [...new Set(req.body.allowed_tabs)] : null;
  if (allowedTabs && allowedTabs.some(tab => !ACCESS_TABS.some(([tabId]) => tabId === tab))) return res.status(400).json({ error: 'تحتوي قائمة الشاشات على اختيار غير صالح.' });
  if (!name || !username || !password || !role) {
    return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
  }
  const normalizedRole = normalizeRole(role);
  const defaults = roleDefaults(role);
  if (!normalizedRole || !defaults) return res.status(400).json({ error: 'الدور المحدد غير صالح.' });
  if (db.data.users.some(u => u.username === username)) {
    return res.status(400).json({ error: 'اسم المستخدم موجود مسبقاً' });
  }
  const requestedBranchIds = isUnrestrictedAccount(req.authUser) && Array.isArray(req.body.branch_ids)
    ? [...new Set(req.body.branch_ids.map(Number))]
    : [isUnrestrictedAccount(req.authUser) ? Number(req.body.branch_id || req.branchId) : Number(req.branchId)];
  if (!requestedBranchIds.length) return res.status(400).json({ error: 'اختر فرعاً واحداً على الأقل.' });
  if (requestedBranchIds.some(branchId => !Number.isInteger(branchId) || !db.data.branches.some(branch => Number(branch.id) === branchId && branch.is_active !== false))) return res.status(400).json({ error: 'اختر فروعاً نشطة وصالحة فقط.' });
  const branchIds = requestedBranchIds;
  const branchId = branchIds[0];
  const rolePermissions = Array.isArray(permissions)
    ? permissions.filter(value => ADMIN_PERMISSIONS.includes(value))
    : [...defaults.permissions];
  const branchAccess = Array.isArray(req.body?.branch_access) ? req.body.branch_access : null;
  if (branchAccess?.some(item => !['read', 'write', 'none'].includes(String(item?.access_level || '')))) {
    return res.status(400).json({ error: 'مستوى وصول الفرع يجب أن يكون قراءة أو كتابة أو منع.' });
  }
  const newUser = {
    id: db.nextId('users'),
    name,
    username,
    password_hash: await passwordHashAsync(password),
    role: normalizedRole,
    branch_id: branchId,
    branch_ids: branchIds,
    permissions: rolePermissions,
    ...((allowedTabs || defaults.allowed_tabs) ? { allowed_tabs: allowedTabs || [...defaults.allowed_tabs] } : {}),
    is_owner: Boolean(defaults.is_owner),
    is_active: true,
    created_at: nowStr()
  };
  db.data.users.push(newUser);
  try { replaceUserBranchAccess(newUser.id, branchIds, branchAccess, normalizedRole); }
  catch (error) { db.data.users.pop(); return res.status(400).json({ error: error.message }); }
  db.save();
  db.logAudit(current_user_id, 'إضافة مستخدم', 'users', newUser.id, `إضافة مستخدم جديد: ${name} (${role})`);
  const { password_hash: _passwordHash, ...publicUser } = newUser;
  res.status(201).json(publicUser);
});

app.put('/api/users/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, password, role, permissions, is_active, current_user_id } = req.body;
  const user = db.data.users.find(u => u.id === id);
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'allowed_tabs')) {
    if (!isUnrestrictedAccount(req.authUser)) return res.status(403).json({ error: 'تحديد الشاشات المسموحة متاح لمالك النظام أو حساب admin فقط.' });
    if (user && isUnrestrictedAccount(user)) return res.status(400).json({ error: 'لا يمكن تعيين شاشات محددة للحسابين ذوي الوصول الكامل.' });
    if (!Array.isArray(req.body.allowed_tabs)) return res.status(400).json({ error: 'قائمة الشاشات المسموحة غير صالحة.' });
    if (req.body.allowed_tabs.some(tab => !ACCESS_TABS.some(([tabId]) => tabId === tab))) return res.status(400).json({ error: 'تحتوي قائمة الشاشات على اختيار غير صالح.' });
  }
  if (!requireAdmin(current_user_id, res)) return;
  if (!user || (!isUnrestrictedAccount(req.authUser) && !getUserBranchIds(user).includes(Number(req.branchId)))) return res.status(404).json({ error: 'المستخدم غير موجود في هذا الفرع.' });
  if (user.is_owner) return res.status(403).json({ error: 'حساب مالك النظام محمي ولا يمكن تعديله من إدارة المستخدمين.' });
  const normalizedRole = role === undefined ? user.role : normalizeRole(role);
  const defaults = roleDefaults(normalizedRole);
  if (!defaults) return res.status(400).json({ error: 'الدور المحدد غير صالح.' });

  const isActiveManager = user.is_active !== false && isManagerRole(user.role) && Array.isArray(user.permissions) && user.permissions.includes('user_management');
  const removesManagerRights = (role !== undefined && !isManagerRole(normalizedRole)) || (Array.isArray(permissions) && !permissions.includes('user_management'));
  if (user.id === req.authUser.id && removesManagerRights) return res.status(409).json({ error: 'لا يمكنك سحب صلاحيات إدارة المستخدمين من حسابك الحالي.' });
  const managerCount = db.data.users.filter(entry => !entry.is_owner && entry.is_active !== false && isManagerRole(entry.role) && Array.isArray(entry.permissions) && entry.permissions.includes('user_management')).length;
  if (isActiveManager && managerCount <= 1 && (is_active === false || removesManagerRights)) return res.status(409).json({ error: 'لا يمكن تعطيل أو سحب صلاحيات آخر مدير نشط.' });

  if (name) user.name = name;
  if (role !== undefined) user.role = normalizedRole;
  if (role !== undefined) user.is_owner = Boolean(defaults.is_owner);
  if (password !== undefined && password !== '') user.password_hash = await passwordHashAsync(password);
  if (Array.isArray(permissions)) user.permissions = permissions.filter(value => ADMIN_PERMISSIONS.includes(value));
  else if (role !== undefined) user.permissions = [...defaults.permissions];
  if (Array.isArray(req.body?.allowed_tabs)) user.allowed_tabs = [...new Set(req.body.allowed_tabs)];
  else if (role !== undefined && defaults.allowed_tabs === null) delete user.allowed_tabs;
  else if (role !== undefined) user.allowed_tabs = [...defaults.allowed_tabs];
  if (typeof is_active === 'boolean') user.is_active = is_active;
  if (req.body.branch_ids !== undefined || (isUnrestrictedAccount(req.authUser) && req.body.branch_id !== undefined)) {
    if (!isUnrestrictedAccount(req.authUser)) return res.status(403).json({ error: 'تغيير فروع المستخدم متاح لمالك النظام أو حساب admin فقط.' });
    const requestedBranchIds = Array.isArray(req.body.branch_ids) ? [...new Set(req.body.branch_ids.map(Number))] : [Number(req.body.branch_id)];
    if (!requestedBranchIds.length) return res.status(400).json({ error: 'اختر فرعاً واحداً على الأقل.' });
    if (requestedBranchIds.some(branchId => !Number.isInteger(branchId) || !db.data.branches.some(branch => Number(branch.id) === branchId && branch.is_active !== false))) return res.status(400).json({ error: 'اختر فروعاً نشطة وصالحة فقط.' });
    user.branch_ids = requestedBranchIds;
    user.branch_id = requestedBranchIds[0];
  }
  const branchAccess = Array.isArray(req.body?.branch_access) ? req.body.branch_access : null;
  if (branchAccess?.some(item => !['read', 'write', 'none'].includes(String(item?.access_level || '')))) return res.status(400).json({ error: 'مستوى وصول الفرع يجب أن يكون قراءة أو كتابة أو منع.' });
  try { replaceUserBranchAccess(user.id, getUserBranchIds(user), branchAccess, user.role); }
  catch (error) { return res.status(400).json({ error: error.message }); }

  db.save();
  db.logAudit(current_user_id, 'تعديل مستخدم', 'users', id, `تعديل بيانات المستخدم: ${user.name}`);
  const { password_hash: _passwordHash, ...publicUser } = user;
  res.json(publicUser);
});

// Soft delete as per SPEC-KIT section 5
app.delete('/api/users/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const current_user_id = req.authUser.id;
  if (id === Number(current_user_id)) return res.status(400).json({ error: 'لا يمكن حذف المستخدم الحالي' });
  const user = db.data.users.find(u => u.id === id);
  if (!requireAdmin(current_user_id, res)) return;
  if (!user || (!isUnrestrictedAccount(req.authUser) && !getUserBranchIds(user).includes(Number(req.branchId)))) return res.status(404).json({ error: 'المستخدم غير موجود في هذا الفرع.' });
  if (user.is_owner) return res.status(403).json({ error: 'حساب مالك النظام محمي ولا يمكن حذفه.' });
  const isActiveManager = user.is_active !== false && isManagerRole(user.role) && Array.isArray(user.permissions) && user.permissions.includes('user_management');
  const managerCount = db.data.users.filter(entry => !entry.is_owner && entry.is_active !== false && isManagerRole(entry.role) && Array.isArray(entry.permissions) && entry.permissions.includes('user_management')).length;
  if (isActiveManager && managerCount <= 1) return res.status(409).json({ error: 'لا يمكن حذف آخر مدير نشط.' });

  const purgeRecords = String(req.query.purge_records || '') === '1';
  let deletedAuditLogs = 0;
  if (purgeRecords && Array.isArray(db.data.audit_logs)) {
    const before = db.data.audit_logs.length;
    db.data.audit_logs = db.data.audit_logs.filter(log => log.user_id !== id);
    deletedAuditLogs = before - db.data.audit_logs.length;
  }
  user.is_active = false;
  user.deleted_at = nowStr();
  db.save();
  db.logAudit(current_user_id, 'تعطيل مستخدم', 'users', id, `تم تعطيل حساب المستخدم: ${user.name} (حذف ناعم)`);
  res.json({ message: 'تم حذف المستخدم وسجلات نشاطه بنجاح مع الحفاظ على الفواتير المالية', deleted_audit_logs: deletedAuditLogs });
});

// ----------------------------------------------------
// Categories
// ----------------------------------------------------
app.get('/api/categories', (req, res) => {
  const branchProductIds = getBranchVisibleProductIds(req.branchId);
  const visibleCategoryIds = branchProductIds ? new Set(db.data.products.filter(product => branchProductIds.has(Number(product.id))).map(product => Number(product.category_id))) : null;
  // calculate products count per category within the active branch
  // A category created in this branch must remain selectable before its first
  // product is assigned; legacy shared categories remain visible only when the
  // active branch already has a product in that category.
  const categories = db.data.categories.filter(category => !visibleCategoryIds || visibleCategoryIds.has(Number(category.id)) || Number(category.branch_id) === Number(req.branchId)).map(c => {
    const productCount = db.data.products.filter(p => p.category_id === c.id && (!branchProductIds || branchProductIds.has(Number(p.id)))).length;
    return { ...c, product_count: productCount };
  });
  res.json(categories);
});

app.post('/api/categories', (req, res) => {
  const { name, current_user_id } = req.body;
  if (!requireCatalogManager(current_user_id, res)) return;
  if (!name || !name.trim()) return res.status(400).json({ error: 'اسم الفئة مطلوب' });

  const newCat = {
    id: db.nextId('categories'),
    name: name.trim(),
    branch_id: Number(req.branchId || db.data.default_branch_id || 1),
    created_at: nowStr()
  };
  db.data.categories.push(newCat);
  db.save();
  db.logAudit(current_user_id, 'إضافة فئة', 'categories', newCat.id, `إضافة فئة جديدة: ${newCat.name}`);
  res.status(201).json(newCat);
});

app.put('/api/categories/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const { name, current_user_id } = req.body;
  if (!requireCatalogManager(current_user_id, res)) return;
  const cat = db.data.categories.find(c => c.id === id);
  if (!cat) return res.status(404).json({ error: 'الفئة غير موجودة' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'اسم الفئة مطلوب' });

  cat.name = name.trim();
  db.save();
  db.logAudit(current_user_id, 'تعديل فئة', 'categories', id, `تعديل اسم الفئة إلى: ${cat.name}`);
  res.json(cat);
});

// SPEC-KIT section 5: Prevent deletion if products exist in category
app.delete('/api/categories/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const current_user_id = req.query.current_user_id || 1;
  if (!requireCatalogManager(current_user_id, res)) return;
  const catIndex = db.data.categories.findIndex(c => c.id === id);
  if (catIndex === -1) return res.status(404).json({ error: 'الفئة غير موجودة' });

  const linkedProducts = db.data.products.filter(p => p.category_id === id);
  if (linkedProducts.length > 0) {
    return res.status(400).json({
      error: `لا يمكن حذف هذه الفئة لوجود (${linkedProducts.length}) منتج مرتبط بها. يرجى نقل المنتجات أولاً.`
    });
  }

  const removed = db.data.categories.splice(catIndex, 1)[0];
  db.save();
  db.logAudit(current_user_id, 'حذف فئة', 'categories', id, `حذف الفئة: ${removed.name}`);
  res.json({ message: 'تم حذف الفئة بنجاح' });
});

// ----------------------------------------------------
// Products & Barcodes
// ----------------------------------------------------
// The business catalog is deliberately persisted separately from inventory.
// Nothing becomes a product or changes stock until an explicit product import.
app.get('/api/business-catalog', (req, res) => {
  if (!requireCatalogImporter(req, res)) return;
  res.json({ items: db.data.business_catalog || [] });
});

// E5b: unified catalog reads the existing catalog sidecar and registered
// products through the application's storage model (never raw SQL tables).
app.get('/api/catalog/items', (req, res) => {
  if (!requireCatalogImporter(req, res)) return;
  const search = normalizeCatalogText(req.query.search || '');
  const source = ['catalog', 'registered'].includes(String(req.query.source || '')) ? String(req.query.source) : 'all';
  const branchProductIds = getBranchVisibleProductIds(req.branchId);
  const catalogRows = source === 'registered' ? [] : db.getBusinessCatalog().map(item => ({
    ...item,
    source_type: 'catalog',
    purchase_price: Number(item.cost_price) || 0,
    selling_price: Number(item.sale_price) || 0,
    has_expiry: Boolean(item.has_expiry || item.expiry_date),
    row_key: `catalog:${item.id}`
  }));
  const registeredRows = source === 'catalog' ? [] : db.data.products
    .filter(product => !branchProductIds || branchProductIds.has(Number(product.id)))
    .map(product => ({
      ...product,
      category: db.data.categories.find(category => Number(category.id) === Number(product.category_id))?.name || '',
      purchase_price: Number(product.cost_price) || 0,
      selling_price: Number(product.sale_price) || 0,
      has_expiry: Boolean(product.expiry_date),
      source_type: 'registered',
      row_key: `registered:${product.id}`
    }));
  const items = [...catalogRows, ...registeredRows]
    .filter(item => !search || [item.name, item.barcode, item.category].some(value => normalizeCatalogText(value).includes(search)))
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, 500);
  res.json({ success: true, items, total: catalogRows.length + registeredRows.length });
});

app.post('/api/catalog/transfer', (req, res) => {
  if (!requireCatalogImporter(req, res)) return;
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(Number.isInteger))] : [];
  if (!ids.length) return res.status(400).json({ success: false, error: 'حدد أصنافاً من الكتالوج لإضافتها.' });
  if (ids.length > 500) return res.status(400).json({ success: false, error: 'الحد الأقصى 500 صنف في العملية الواحدة.' });
  const byId = new Map(db.getBusinessCatalog().map(item => [Number(item.id), item]));
  const rows = ids.map(id => byId.get(id)).filter(Boolean);
  if (rows.length !== ids.length) return res.status(400).json({ success: false, error: 'بعض أصناف الكتالوج المحددة لم تعد موجودة.' });
  const originalData = db.data;
  const workingData = JSON.parse(JSON.stringify(originalData));
  const createdCategories = [];
  try {
    db.setData(workingData);
    const totals = upsertProductsFromRows(rows, { branchId: req.branchId, updatePrices: req.body?.update_prices === true, createdCategories });
    db.logAudit(req.authUser.id, 'إضافة أصناف الكتالوج للمخزون', 'business_catalog', ids.length,
      `إضافة ${totals.added} وتحديث ${totals.updated} وتخطي ${totals.skipped}؛ المعرّفات: ${ids.slice(0, 50).join(',')}`, { save: false });
    if (createdCategories.length) db.logAudit(req.authUser.id, 'إنشاء فئات من استيراد الكتالوج', 'categories', createdCategories.length, `إنشاء الفئات: ${createdCategories.join('، ')}`, { save: false });
    db.save();
    return res.json({ success: true, ...totals });
  } catch (error) {
    db.setData(originalData);
    return res.status(500).json({ success: false, error: 'تعذرت إضافة الكتالوج بالكامل؛ لم تتم إضافة أي أصناف.' });
  }
});

app.post('/api/business-catalog/import', (req, res) => {
  const { rows, current_user_id, file_name, activity } = req.body || {};
  if (!requireCatalogImporter(req, res)) return;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 10000) return res.status(400).json({ error: 'يجب أن يحتوي الكتالوج على 1 إلى 10,000 صنف.' });
  const catalogRows = JSON.parse(JSON.stringify(db.getBusinessCatalog()));
  const keys = new Set(catalogRows.map(item => item.barcode
    ? `b:${String(item.barcode).trim()}` : `n:${normalizeCatalogText(item.name)}|${normalizeCatalogText(item.unit || 'قطعة')}`));
  let nextCatalogId = db.nextId('business_catalog');
  let added = 0, skipped = 0;
  const addedCatalogIds = [];
  for (const raw of rows) {
    const extraFields = sanitizeCatalogExtraFields(raw);
    const name = String(raw?.name || extraFields.name_ar || extraFields.name_en || '').trim().slice(0, 200);
    const barcode = String(raw?.barcode || '').trim().slice(0, 100);
    const unit = String(raw?.unit || 'قطعة').trim().slice(0, 30) || 'قطعة';
    if (!name) { skipped++; continue; }
    const key = barcode ? `b:${barcode}` : `n:${normalizeCatalogText(name)}|${normalizeCatalogText(unit)}`;
    if (keys.has(key)) { skipped++; continue; }
    const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
    const catalogItem = {
      id: nextCatalogId++, name, barcode,
      category: String(raw?.category || '').trim().slice(0, 100), unit,
      cost_price: number(raw?.cost_price), sale_price: number(raw?.sale_price), min_stock: number(raw?.min_stock),
      notes: String(raw?.notes || '').trim().slice(0, 500),
      generic_name: String(raw?.generic_name || '').trim().slice(0, 200),
      active_ingredient: String(raw?.active_ingredient || '').trim().slice(0, 200),
      scientific_name: String(raw?.scientific_name || '').trim().slice(0, 200),
      manufacturer: String(raw?.manufacturer || '').trim().slice(0, 200),
      strength: String(raw?.strength || '').trim().slice(0, 100),
      dosage_form: String(raw?.dosage_form || '').trim().slice(0, 100),
      ...(Object.keys(extraFields).length ? { extra_fields: extraFields } : {}),
      catalog_file: String(file_name || '').trim().slice(0, 255), activity: String(activity || '').trim().slice(0, 200),
      created_at: nowStr(), updated_at: nowStr()
    };
    catalogRows.push(catalogItem);
    addedCatalogIds.push(catalogItem.id);
    keys.add(key); added++;
  }
  db.logAudit(req.authUser.id, 'رفع كتالوج مستقل', 'business_catalog', addedCatalogIds.length === 1 ? addedCatalogIds[0] : addedCatalogIds.length, `إضافة ${added} وتخطي ${skipped} صنف؛ لم تُضف إلى المخزون`, { save: false });
  db.saveBusinessCatalog(catalogRows);
  db.save();
  res.json({ added, skipped, total: catalogRows.length });
});

app.get('/api/business-catalog/status', (req, res) => {
  if (!requireCatalogImporter(req, res)) return;
  res.json({ warning: db.getBusinessCatalogLoadError() });
});

app.put('/api/business-catalog', (req, res) => {
  const { rows } = req.body || {};
  if (!requireCatalogImporter(req, res)) return;
  if (!Array.isArray(rows) || rows.length > 500) return res.status(400).json({ error: 'قائمة الكتالوج غير صالحة. الحد الأقصى 500 صف في الطلب.' });
  const catalogRows = JSON.parse(JSON.stringify(db.getBusinessCatalog()));
  const existing = new Map(catalogRows.map(item => [Number(item.id), item]));
  const seen = new Set();
  let nextCatalogId = db.nextId('business_catalog');
  let added = 0, updated = 0, unchanged = 0;
  const savedItems = [];
  const textLimits = { name: 200, barcode: 100, category: 100, unit: 30, notes: 500, generic_name: 200, active_ingredient: 200,
    scientific_name: 200, manufacturer: 200, strength: 100, dosage_form: 100 };
  const allowedText = Object.keys(textLimits);
  const numberFields = ['cost_price', 'sale_price', 'min_stock'];
  for (const raw of rows) {
    const requestedId = raw?.id === undefined || raw?.id === null || raw?.id === '' ? null : Number(raw.id);
    if (requestedId !== null && Number.isFinite(requestedId)) {
      if (seen.has(requestedId)) return res.status(400).json({ error: 'معرّف الصنف مكرر داخل الطلب.' });
      seen.add(requestedId);
    }
    const old = requestedId === null ? null : existing.get(requestedId);
    const candidate = {};
    for (const field of allowedText) {
      if (Object.prototype.hasOwnProperty.call(raw || {}, field)) candidate[field] = String(raw[field] ?? '').trim().slice(0, textLimits[field]);
      else if (old) candidate[field] = old[field] ?? '';
    }
    for (const field of numberFields) {
      if (Object.prototype.hasOwnProperty.call(raw || {}, field)) {
        const value = Number(raw[field]); candidate[field] = Number.isFinite(value) ? Math.max(0, value) : 0;
      } else if (old) candidate[field] = Number(old[field]) || 0;
      else candidate[field] = 0;
    }
    candidate.name = String(candidate.name || '').trim();
    candidate.barcode = String(candidate.barcode || '').trim();
    candidate.unit = String(candidate.unit || 'قطعة').trim().slice(0, 30) || 'قطعة';
    candidate.category = String(candidate.category || '').trim().slice(0, 100);
    candidate.notes = String(candidate.notes || '').trim().slice(0, 500);
    if (Object.prototype.hasOwnProperty.call(raw || {}, 'extra_fields')) {
      candidate.extra_fields = sanitizeCatalogExtraFields({ extra_fields: raw.extra_fields });
    }
    const id = old ? Number(old.id) : nextCatalogId++;
    const { name, barcode, unit } = candidate;
    if (!name) return res.status(400).json({ error: 'اسم كل صنف مطلوب قبل الحفظ.' });
    const key = barcode ? `b:${barcode}` : `n:${normalizeCatalogText(name)}|${normalizeCatalogText(unit)}`;
    if ([...existing.values()].some(item => Number(item.id) !== id && (item.barcode ? `b:${String(item.barcode).trim()}` : `n:${normalizeCatalogText(item.name)}|${normalizeCatalogText(item.unit || 'قطعة')}`) === key))
      return res.status(400).json({ error: 'يوجد صنف مكرر بالاسم أو الباركود داخل الكتالوج.' });
    const next = { ...(old || {}), ...candidate, id, updated_at: nowStr() };
    if (old) {
      const changed = Object.keys(candidate).some(field => String(old[field] ?? '') !== String(candidate[field] ?? ''));
      if (changed) { Object.assign(old, next); updated++; } else unchanged++;
      savedItems.push(old);
    } else { catalogRows.push(next); existing.set(id, next); savedItems.push(next); added++; }
  }
  db.logAudit(req.authUser.id, 'حفظ تعديلات الكتالوج المستقل', 'business_catalog', savedItems.length === 1 ? savedItems[0].id : added + updated, `إضافة ${added} وتحديث ${updated} دون حذف أصناف`, { save: false });
  db.saveBusinessCatalog(catalogRows);
  db.save();
  res.json({ added, updated, unchanged, items: savedItems });
});

app.post('/api/business-catalog/add-to-inventory', (req, res) => {
  const { ids, all, update_prices = false } = req.body || {};
  if (!requireCatalogImporter(req, res)) return;
  if (all !== true && !Array.isArray(ids)) return res.status(400).json({ error: 'حدد أصناف الكتالوج المطلوب إضافتها.' });
  const idSet = new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite));
  const catalogRows = db.getBusinessCatalog().filter(item => all === true || idSet.has(Number(item.id)));
  if (all !== true && catalogRows.length !== idSet.size) return res.status(400).json({ error: 'بعض أصناف الكتالوج المحددة غير موجودة.' });
  const originalData = db.data;
  const workingData = JSON.parse(JSON.stringify(originalData));
  const createdCategories = [];
  try {
    db.setData(workingData);
    const totals = upsertProductsFromRows(catalogRows, { branchId: req.branchId, updatePrices: update_prices === true, createdCategories });
    db.logAudit(req.authUser.id, 'إضافة أصناف الكتالوج للمخزون', 'business_catalog', catalogRows.length,
      `إضافة ${totals.added} وتحديث ${totals.updated} وتخطي ${totals.skipped}؛ المعرّفات: ${catalogRows.slice(0, 50).map(item => item.id).join(',')}`, { save: false });
    if (createdCategories.length) db.logAudit(req.authUser.id, 'إنشاء فئات من استيراد الكتالوج', 'categories', createdCategories.length, `إنشاء الفئات: ${createdCategories.join('، ')}`, { save: false });
    db.save();
    return res.json(totals);
  } catch (error) {
    db.setData(originalData);
    return res.status(500).json({ error: 'تعذرت إضافة الكتالوج بالكامل؛ لم تتم إضافة أي أصناف. حاول مرة أخرى.' });
  }
});

app.delete('/api/business-catalog', (req, res) => {
  const { ids, all } = req.body || {};
  if (!requireCatalogImporter(req, res)) return;
  const catalogRows = db.getBusinessCatalog();
  const before = catalogRows.length, idSet = new Set((Array.isArray(ids) ? ids : []).map(Number));
  const deletedRows = catalogRows.filter(item => all === true || idSet.has(Number(item.id)));
  const remainingRows = all === true ? [] : catalogRows.filter(item => !idSet.has(Number(item.id)));
  const deleted = before - remainingRows.length;
  const preview = deletedRows.slice(0, 50).map(item => `${item.id}:${String(item.name || '').slice(0, 200)}`).join(' | ');
  db.logAudit(req.authUser.id, all === true ? 'حذف الكتالوج المستقل بالكامل' : 'حذف أصناف من الكتالوج المستقل', 'business_catalog', deleted, `حذف ${deleted} صنف قبل الحذف؛ أول ${Math.min(deletedRows.length, 50)} معرّف/اسم: ${preview}`, { save: false });
  db.saveBusinessCatalog(remainingRows);
  db.save();
  res.json({ deleted, total: remainingRows.length });
});

app.get('/api/products', (req, res) => {
  const branchProductIds = getBranchVisibleProductIds(req.branchId);
  const products = db.data.products.filter(product => !branchProductIds || branchProductIds.has(Number(product.id))).map(p => {
    const cat = db.data.categories.find(c => c.id === p.category_id);
    const stock = getBranchInventoryRow(req.branchId, p.id);
    return {
      ...p, quantity: Number(stock?.quantity || 0), min_stock: Number(stock?.min_stock || 0), branch_id: req.branchId,
      category_name: cat ? cat.name : 'غير محدد',
      is_low_stock: Number(stock?.quantity || 0) <= Number(stock?.min_stock || 0),
      days_until_expiry: getDaysUntilExpiry(p.expiry_date),
      expiry_warning_days: EXPIRY_WARNING_DAYS
    };
  });
  res.json(products);
});

function upsertProductsFromRows(rows, { branchId, updatePrices = false, createdCategories = [] } = {}) {
  if (!Array.isArray(db.data.categories)) db.data.categories = [];
  if (!Array.isArray(db.data.products)) db.data.products = [];
  const categoryByName = new Map(db.data.categories.map(category => [normalizeCatalogText(category.name), category.id]));
  let nextCategoryId = db.nextId('categories');
  let nextProductId = db.nextId('products');
  let nextInventoryId = db.nextId('branch_inventory');
  const ensureCategory = rawName => {
    const name = String(rawName || '').trim().slice(0, 100) || 'غير مصنف';
    const key = normalizeCatalogText(name);
    if (categoryByName.has(key)) return categoryByName.get(key);
    const category = { id: nextCategoryId++, name, created_at: nowStr() };
    db.data.categories.push(category);
    categoryByName.set(key, category.id);
    createdCategories.push(name);
    return category.id;
  };
  const seen = new Set();
  const totals = { added: 0, updated: 0, skipped: 0 };
  for (const row of rows) {
    const name = String(row?.name || '').trim();
    const barcode = String(row?.barcode || '').trim();
    const categoryName = String(row?.category || '').trim().slice(0, 100);
    const unit = String(row?.unit || 'قطعة').trim().slice(0, 30) || 'قطعة';
    if (!name) { totals.skipped++; continue; }
    const categoryId = ensureCategory(categoryName);
    const importKey = barcode ? `barcode:${barcode}` : `text:${normalizeCatalogText(name)}|${normalizeCatalogText(unit)}|${normalizeCatalogText(categoryName)}`;
    if (seen.has(importKey)) { totals.skipped++; continue; }
    seen.add(importKey);
    const details = {
      generic_name: String(row.generic_name || '').trim(), active_ingredient: String(row.active_ingredient || '').trim(),
      scientific_name: String(row.scientific_name || '').trim(), manufacturer: String(row.manufacturer || '').trim(),
      strength: String(row.strength || '').trim(), dosage_form: String(row.dosage_form || '').trim(),
      is_weighted: row.is_weighted === true || row.is_weighted === 1 || String(row.is_weighted || '') === '1'
    };
    const matchesNameUnitCategory = product => {
      if (normalizeCatalogText(product.name) !== normalizeCatalogText(name)
        || normalizeCatalogText(product.unit || 'قطعة') !== normalizeCatalogText(unit)) return false;
      if (!categoryName) return true;
      const existingCategory = db.data.categories.find(category => category.id === product.category_id);
      return normalizeCatalogText(existingCategory?.name || '') === normalizeCatalogText(categoryName);
    };
    let existing = barcode ? db.data.products.find(product => String(product.barcode || '').trim() === barcode) : null;
    if (!existing && barcode) existing = db.data.products.find(product => !String(product.barcode || '').trim() && matchesNameUnitCategory(product));
    if (!existing && !barcode) existing = db.data.products.find(matchesNameUnitCategory);
    if (existing) {
      if (barcode) existing.barcode = barcode;
      existing.name = name;
      for (const [key, value] of Object.entries(details)) if (value) existing[key] = value;
      if (updatePrices) {
        for (const key of ['cost_price', 'sale_price']) {
          const value = row[key];
          if (value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0) existing[key] = Number(value);
        }
      }
      const minStock = row.min_stock;
      if (minStock !== undefined && minStock !== null && minStock !== '' && Number.isFinite(Number(minStock)) && Number(minStock) > 0) {
        getBranchInventoryRow(branchId, existing.id).min_stock = Number(minStock);
        existing.min_stock = Number(minStock);
      }
      existing.unit = unit;
      existing.category_id = categoryId;
      if (String(row.notes || '').trim()) existing.notes = String(row.notes).trim().slice(0, 500);
      existing.updated_at = nowStr();
      totals.updated++;
      continue;
    }
    const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
    const importedProduct = {
      id: nextProductId++, item_number: db.nextProductItemNumber(), name, barcode, category_id: categoryId,
      cost_price: number(row.cost_price), sale_price: number(row.sale_price),
      quantity: 0, min_stock: Number.isFinite(Number(row.min_stock)) ? Math.max(0, Number(row.min_stock)) : 5, unit,
      image_url: '', notes: String(row.notes || '').trim().slice(0, 500), production_date: '', expiry_date: '', ...details,
      created_at: nowStr(), updated_at: nowStr()
    };
    db.data.products.push(importedProduct);
    db.data.branch_inventory.push({ id: nextInventoryId++, branch_id: Number(branchId), product_id: importedProduct.id, quantity: 0, min_stock: importedProduct.min_stock });
    totals.added++;
  }
  return totals;
}

app.post('/api/products/import', (req, res) => {
  const { rows, update_prices = false } = req.body || {};
  if (!requireCatalogImporter(req, res)) return;
  if (!Array.isArray(rows) || rows.length > 500) return res.status(400).json({ error: 'يجب إرسال حتى 500 صنف في الدفعة الواحدة.' });
  const createdCategories = [];
  const totals = upsertProductsFromRows(rows, { branchId: req.branchId, updatePrices: update_prices === true, createdCategories });
  if (createdCategories.length) db.logAudit(req.authUser.id, 'إنشاء فئات من استيراد الكتالوج', 'categories', createdCategories.length, `إنشاء الفئات: ${createdCategories.join('، ')}`, { save: false });
  db.logAudit(req.authUser.id, 'استيراد كتالوج', 'products', 0, `إضافة ${totals.added} وتحديث ${totals.updated} وتخطي ${totals.skipped} صنفاً`, { save: false });
  db.save(['categories', 'products', 'branch_inventory', 'audit_logs']);
  res.json(totals);
});
app.post('/api/products', (req, res) => {
  const {
    name,
    category_id,
    barcode,
    cost_price,
    sale_price,
    wholesale_price,
    special_price,
    quantity,
    min_stock,
    unit,
    image_url,
    notes,
    name_en,
    medicine_catalog_id,
    generic_name,
    scientific_name,
    manufacturer,
    drug_class,
    route,
    production_date,
    expiry_date,
    is_weighted,
    current_user_id
  } = req.body;

  if (!name || sale_price === undefined) {
    return res.status(400).json({ error: 'اسم المنتج وسعر البيع مطلوبان' });
  }
  for (const [key, value] of [['wholesale_price', wholesale_price], ['special_price', special_price]]) if (value !== undefined && value !== null && value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0)) return res.status(400).json({ error: 'أسعار المستويات الإضافية يجب أن تكون أرقاماً غير سالبة.' });
  const dateError = productDateError(production_date, expiry_date);
  if (dateError) return res.status(400).json({ error: dateError });
  const weightedProduct = is_weighted === true || is_weighted === 1 || String(is_weighted || '') === '1';
  const requestedQuantity = Number(quantity ?? 0);
  const quantityText = String(quantity ?? '0').trim();
  if (weightedProduct ? !/^\d+(?:\.\d{1,3})?$/.test(quantityText) : !Number.isInteger(requestedQuantity)) return res.status(400).json({ error: weightedProduct ? 'كمية المنتج الموزون يجب أن تكون رقماً حتى 3 منازل عشرية.' : 'كمية المنتج العادي يجب أن تكون عدداً صحيحاً.' });

  // Never invent a medicine barcode: an incorrect code can select another product.
  const finalBarcode = barcode ? String(barcode).trim() : '';
  if (finalBarcode && db.data.products.some(product => String(product.barcode || '').trim() === finalBarcode)) {
    return res.status(409).json({ error: 'الباركود مستخدم بالفعل لصنف آخر.' });
  }

  const newProd = {
    id: db.nextId('products'),
    item_number: db.nextProductItemNumber(),
    name: name.trim(),
    category_id: parseInt(category_id) || 1,
    barcode: finalBarcode,
    cost_price: parseFloat(cost_price) || 0,
    sale_price: parseFloat(sale_price) || 0,
    wholesale_price: wholesale_price === undefined || wholesale_price === null || wholesale_price === '' ? null : Number(Number(wholesale_price).toFixed(2)),
    special_price: special_price === undefined || special_price === null || special_price === '' ? null : Number(Number(special_price).toFixed(2)),
    quantity: Math.max(0, requestedQuantity || 0),
    min_stock: parseInt(min_stock) || 5,
    unit: unit || 'قطعة',
    image_url: image_url || '',
    notes: notes || '',
    name_en: name_en || '',
    medicine_catalog_id: medicine_catalog_id ? Number(medicine_catalog_id) : null,
    generic_name: generic_name || '',
    scientific_name: scientific_name || '',
    manufacturer: manufacturer || '',
    drug_class: drug_class || '',
    route: route || '',
    production_date: production_date || '',
    expiry_date: expiry_date || '',
    is_weighted: is_weighted === true || is_weighted === 1 || String(is_weighted || '') === '1',
    is_active: true,
    created_at: nowStr(),
    updated_at: nowStr()
  };

  const initialQuantity = Math.max(0, Number(newProd.quantity) || 0);
  newProd.quantity = 0; newProd.min_stock = Math.max(0, Number(min_stock) || 5);
  db.data.products.push(newProd);
  const branchStock = getBranchInventoryRow(req.branchId, newProd.id); branchStock.quantity = initialQuantity;

  // Record initial stock movement if quantity > 0
  if (initialQuantity > 0) {
    db.data.stock_movements.push({
      id: db.nextId('stock_movements'),
      branch_id: req.branchId, product_id: newProd.id,
      type: 'adjustment',
      quantity: initialQuantity,
      reference_id: 'INITIAL',
      created_at: nowStr()
    });
  }

  db.save(['products', 'branch_inventory', 'stock_movements', 'audit_logs']);
  db.logAudit(current_user_id, 'إضافة منتج', 'products', newProd.id, `إضافة منتج جديد: ${newProd.name} (باركود: ${newProd.barcode})`);
  res.status(201).json({ ...newProd, quantity: initialQuantity, min_stock: branchStock.min_stock, branch_id: req.branchId });
});

app.put('/api/products/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const prod = db.data.products.find(p => p.id === id);
  if (!prod) return res.status(404).json({ error: 'المنتج غير موجود' });

  const {
    name,
    category_id,
    barcode,
    cost_price,
    sale_price,
    wholesale_price,
    special_price,
    quantity,
    min_stock,
    unit,
    image_url,
    notes,
    name_en,
    medicine_catalog_id,
    generic_name,
    scientific_name,
    manufacturer,
    drug_class,
    route,
    production_date,
    expiry_date,
    is_weighted,
    is_active,
    current_user_id
  } = req.body;

  const dateError = productDateError(
    production_date === undefined ? prod.production_date : production_date,
    expiry_date === undefined ? prod.expiry_date : expiry_date
  );
  if (dateError) return res.status(400).json({ error: dateError });

  const nextBarcode = barcode === undefined ? String(prod.barcode || '').trim() : String(barcode || '').trim();
  if (nextBarcode && db.data.products.some(product => product.id !== id && String(product.barcode || '').trim() === nextBarcode)) {
    return res.status(409).json({ error: 'الباركود مستخدم بالفعل لصنف آخر.' });
  }

  const oldPrice = prod.sale_price;
  const oldCost = prod.cost_price;
  const stockRow = getBranchInventoryRow(req.branchId, prod.id);
  const oldQty = Number(stockRow.quantity || 0);
  const nextWeighted = is_weighted === undefined ? Boolean(prod.is_weighted) : (is_weighted === true || is_weighted === 1 || String(is_weighted || '') === '1');
  if (quantity !== undefined) {
    const quantityText = String(quantity).trim();
    const numericQuantity = Number(quantity);
    if (nextWeighted ? !/^\d+(?:\.\d{1,3})?$/.test(quantityText) : !Number.isInteger(numericQuantity)) return res.status(400).json({ error: nextWeighted ? 'كمية المنتج الموزون يجب أن تكون رقماً حتى 3 منازل عشرية.' : 'كمية المنتج العادي يجب أن تكون عدداً صحيحاً.' });
  }

  if (name) prod.name = name.trim();
  if (category_id !== undefined) prod.category_id = parseInt(category_id);
  if (barcode !== undefined) prod.barcode = String(barcode || '').trim();
  if (cost_price !== undefined) prod.cost_price = parseFloat(cost_price);
  if (sale_price !== undefined) prod.sale_price = parseFloat(sale_price);
  for (const [key, value] of [['wholesale_price', wholesale_price], ['special_price', special_price]]) if (value !== undefined) {
    if (value !== null && value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0)) return res.status(400).json({ error: 'أسعار المستويات الإضافية يجب أن تكون أرقاماً غير سالبة.' });
    prod[key] = value === null || value === '' ? null : Number(Number(value).toFixed(2));
  }
  if (min_stock !== undefined) stockRow.min_stock = Math.max(0, parseInt(min_stock) || 0);
  if (unit !== undefined) prod.unit = unit;
  if (image_url !== undefined) prod.image_url = image_url;
  if (notes !== undefined) prod.notes = notes;
  if (name_en !== undefined) prod.name_en = name_en;
  if (medicine_catalog_id !== undefined) prod.medicine_catalog_id = medicine_catalog_id ? Number(medicine_catalog_id) : null;
  if (generic_name !== undefined) prod.generic_name = generic_name;
  if (scientific_name !== undefined) prod.scientific_name = scientific_name;
  if (manufacturer !== undefined) prod.manufacturer = manufacturer;
  if (drug_class !== undefined) prod.drug_class = drug_class;
  if (route !== undefined) prod.route = route;
  if (production_date !== undefined) prod.production_date = production_date || '';
  if (expiry_date !== undefined) prod.expiry_date = expiry_date || '';
  if (is_weighted !== undefined) prod.is_weighted = is_weighted === true || is_weighted === 1 || String(is_weighted || '') === '1';
  if (is_active !== undefined) {
    if (typeof is_active !== 'boolean') return res.status(400).json({ error: 'حالة الصنف غير صالحة.' });
    prod.is_active = is_active;
  }
  prod.updated_at = nowStr();

  // If quantity manually changed
  if (quantity !== undefined && Number(quantity) !== oldQty) {
    const diff = Number(quantity) - oldQty;
    setBranchQuantity(req.branchId, prod.id, Number(quantity));
    db.data.stock_movements.push({
      id: db.nextId('stock_movements'), branch_id: req.branchId,
      product_id: prod.id,
      type: 'adjustment',
      quantity: diff,
      reference_id: 'MANUAL_EDIT',
      created_at: nowStr()
    });
    db.logAudit(current_user_id, 'تعديل كمية يدوي', 'products', prod.id, `تعديل رصيد منتج ${prod.name} من ${oldQty} إلى ${prod.quantity}`);
  }

  db.save(['products', 'branch_inventory', 'stock_movements', 'audit_logs']);
  db.logAudit(current_user_id, 'تعديل منتج', 'products', prod.id, `تعديل بيانات المنتج ${prod.name}`);
  res.json({ ...prod, quantity: branchQuantity(req.branchId, prod.id), min_stock: stockRow.min_stock, branch_id: req.branchId });
});

app.delete('/api/products/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const index = db.data.products.findIndex(p => p.id === id);
  if (index === -1) return res.status(404).json({ error: 'المنتج غير موجود' });

  const historyTables = ['sale_items', 'purchase_items', 'purchase_order_items', 'stock_movements', 'promotions', 'waste_records'];
  const hasHistory = historyTables.some(table => (db.data[table] || []).some(row => Number(row.product_id) === id));
  if (hasHistory) return res.status(409).json({ error: 'لا يمكن حذف صنف مرتبط بحركات أو مستندات سابقة. استخدم «إيقاف الصنف» بدلاً من ذلك.' });

  const removed = db.data.products.splice(index, 1)[0];
  db.data.branch_inventory = (db.data.branch_inventory || []).filter(row => Number(row.product_id) !== id);
  db.save();
  db.logAudit(req.authUser.id, 'حذف منتج', 'products', id, `حذف المنتج نهائياً: ${removed.name} (باركود: ${removed.barcode})`);
  res.json({ message: 'تم حذف المنتج بنجاح' });
});

// ----------------------------------------------------
// Customers & Suppliers
// ----------------------------------------------------
app.get('/api/customers', (req, res) => {
  res.json(db.data.customers.map(customer => {
    const purchases = branchStockFilter(db.data.sales, req.branchId).filter(sale => Number(sale.customer_id) === Number(customer.id) && sale.status !== 'returned');
    const totalSpent = purchases.reduce((sum, sale) => sum + Math.max(0, Number(sale.total || 0) - Number(sale.returned_amount || 0)), 0);
    const latestPurchase = purchases.map(sale => sale.created_at).filter(Boolean).sort().at(-1) || null;
    return { ...customer, balance: Number(customerBranchBalance(customer.id, req.branchId).toFixed(2)), total_spent: Number(totalSpent.toFixed(2)), last_purchase_date: latestPurchase, loyalty_points: loyaltyBalance(customer.id) };
  }));
});

// Local, rule-based stock forecasts derived from recorded sales and returns.
// This is a transparent heuristic, not a call to an external AI service.
app.get('/api/insights', (req, res) => {
  const day = businessDateToday();
  res.json(branchStockFilter(db.data.ai_insights || [], req.branchId).filter(item => item.business_date === day).slice(-200));
});

app.post('/api/insights/generate', (req, res) => {
  if (!requireAdmin(req.authUser?.id, res)) return;
  const today = businessDateToday();
  const since = new Date(`${today}T00:00:00.000Z`);
  since.setUTCDate(since.getUTCDate() - 29);
  const startDate = since.toISOString().slice(0, 10);
  const recentSales = new Set(db.data.sales
    .filter(sale => sale.status !== 'returned' && String(sale.created_at || '').slice(0, 10) >= startDate)
    .map(sale => Number(sale.id)));
  const returnedByItem = new Map();
  for (const row of db.data.sale_returns || []) {
    const key = Number(row.sale_item_id);
    returnedByItem.set(key, (returnedByItem.get(key) || 0) + Number(row.quantity || 0));
  }
  const soldByProduct = new Map();
  for (const item of db.data.sale_items || []) {
    if (!recentSales.has(Number(item.sale_id))) continue;
    const productId = Number(item.product_id);
    const netQuantity = Math.max(0, Number(item.quantity || 0) - Number(returnedByItem.get(Number(item.id)) || 0));
    soldByProduct.set(productId, (soldByProduct.get(productId) || 0) + netQuantity);
  }
  const rows = [];
  for (const product of db.data.products || []) {
    const stock = Math.max(0, branchQuantity(req.branchId, product.id));
    const minimum = Math.max(0, Number(getBranchInventoryRow(req.branchId, product.id)?.min_stock || 0));
    const sold = Number(soldByProduct.get(Number(product.id)) || 0);
    const daily = sold / 30;
    const daysCover = daily > 0 ? stock / daily : null;
    const reachesMinimumSoon = daily > 0 && Math.max(0, stock - minimum) / daily <= 7;
    if (stock > minimum && !reachesMinimumSoon) continue;
    const suggested = daily > 0 ? Math.max(0, Math.ceil(daily * 7 + minimum - stock)) : Math.max(0, minimum - stock);
    const message = daily > 0
      ? `${product.name}: المخزون ${stock}، ومتوسط البيع ${daily.toFixed(2)} يومياً؛ يكفي نحو ${daysCover.toFixed(1)} يوم. كمية إعادة الطلب المقترحة للأسبوع القادم: ${suggested}.`
      : `${product.name}: المخزون ${stock} عند حد الأمان (${minimum}) أو دونه، ولا توجد مبيعات كافية خلال آخر 30 يوماً لحساب معدل الاستهلاك.`;
    rows.push({ business_date: today, product_id: product.id, product_name: product.name, insight_type: 'inventory_forecast', current_stock: stock, min_stock: minimum, units_sold_30d: Number(sold.toFixed(3)), average_daily_sales: Number(daily.toFixed(3)), days_of_stock: daysCover === null ? null : Number(daysCover.toFixed(1)), suggested_reorder: suggested, message, created_at: nowStr() });
  }
  rows.sort((a, b) => (a.days_of_stock ?? Infinity) - (b.days_of_stock ?? Infinity));
  const existingForToday = (db.data.ai_insights || []).filter(item => item.business_date !== today);
  const savedRows = rows.map(row => ({ id: db.nextId('ai_insights'), branch_id: req.branchId, ...row }));
  db.data.ai_insights = [...existingForToday, ...savedRows].slice(-500);
  db.save();
  db.logAudit(req.authUser.id, 'توليد تحليل المخزون', 'ai_insights', null, `تم إنشاء ${savedRows.length} توصية من بيانات المبيعات والمخزون لآخر 30 يوماً`);
  res.json({ business_date: today, lookback_days: 30, count: savedRows.length, insights: savedRows, method: 'rule_based_sales_velocity' });
});

app.get('/api/loyalty/settings', (_req, res) => res.json(db.data.loyalty_settings));
app.put('/api/loyalty/settings', (req, res) => {
  if (!requireAdmin(req.authUser?.id, res)) return;
  const enabled = req.body?.enabled === true;
  const spendPerPoint = Number(req.body?.spend_per_point);
  if (!Number.isSafeInteger(spendPerPoint) || spendPerPoint < 1 || spendPerPoint > 1000000000) {
    return res.status(400).json({ error: 'قيمة الإنفاق لاكتساب النقطة يجب أن تكون رقمًا صحيحًا موجبًا.' });
  }
  db.data.loyalty_settings = { enabled, spend_per_point: spendPerPoint };
  db.save();
  db.logAudit(req.authUser.id, 'تعديل إعدادات الولاء', 'loyalty_settings', 1, `البرنامج ${enabled ? 'مفعّل' : 'متوقف'}؛ كل ${spendPerPoint} ج.م = نقطة`);
  res.json(db.data.loyalty_settings);
});

// ---- الضريبة وإقرار الضريبة المحصلة ----
app.get('/api/tax/settings', (_req, res) => res.json(db.data.tax_settings || { enabled: false, rate: 0, registration_number: '' }));
app.put('/api/tax/settings', (req, res) => {
  if (!requireAdmin(req.authUser?.id, res)) return;
  const enabled = req.body?.enabled === true;
  const rate = Number(req.body?.rate);
  const registrationNumber = String(req.body?.registration_number || '').trim();
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) return res.status(400).json({ error: 'نسبة الضريبة يجب أن تكون بين 0 و100.' });
  if (registrationNumber.length > 100) return res.status(400).json({ error: 'رقم التسجيل الضريبي طويل أكثر من اللازم.' });
  db.data.tax_settings = { enabled, rate: Number(rate.toFixed(4)), registration_number: registrationNumber };
  db.save();
  db.logAudit(req.authUser.id, 'تعديل إعدادات الضريبة', 'tax_settings', 1, `الضريبة ${enabled ? 'مفعلة' : 'متوقفة'} بنسبة ${db.data.tax_settings.rate}%`);
  res.json(db.data.tax_settings);
});

const DEFAULT_PRINT_SETTINGS = Object.freeze({ type: '80mm', copies: 1, show_logo: true, show_tax: true, font_size: 'medium', auto_print: false, preview_before_print: true });
const DEFAULT_RETURN_WINDOW_DAYS = 14;
function currentReturnWindowDays() {
  const value = Number(db.data.system_settings?.return_window_days);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_RETURN_WINDOW_DAYS;
}
function currentPrintSettings() {
  return { ...DEFAULT_PRINT_SETTINGS, ...(db.data.print_settings || {}) };
}
function normalizePrintSettings(input) {
  const print = input && typeof input === 'object' ? input : {};
  const type = String(print.type || DEFAULT_PRINT_SETTINGS.type);
  const copies = Number(print.copies ?? DEFAULT_PRINT_SETTINGS.copies);
  const fontSize = String(print.font_size || DEFAULT_PRINT_SETTINGS.font_size);
  if (!['58mm', '80mm', 'A4'].includes(type)) throw new Error('نوع الطابعة غير مدعوم.');
  if (!Number.isInteger(copies) || copies < 1 || copies > 3) throw new Error('عدد النسخ يجب أن يكون بين 1 و3.');
  if (!['small', 'medium', 'large'].includes(fontSize)) throw new Error('حجم خط الفاتورة غير مدعوم.');
  return {
    type,
    copies,
    show_logo: print.show_logo !== false,
    show_tax: print.show_tax !== false,
    font_size: fontSize,
    auto_print: print.auto_print === true,
    preview_before_print: print.preview_before_print !== false
  };
}

app.get('/api/settings/print', (req, res) => {
  if (!requireAdmin(req.authUser?.id, res)) return;
  res.json(currentPrintSettings());
});

app.post('/api/settings/print', (req, res) => {
  if (!requireAdmin(req.authUser?.id, res)) return;
  try {
    db.data.print_settings = normalizePrintSettings(req.body || {});
    db.save();
    db.logAudit(req.authUser.id, 'تعديل إعدادات الطباعة', 'system_settings', 1, JSON.stringify(db.data.print_settings));
    res.json({ message: 'تم حفظ إعدادات الطباعة.', print: currentPrintSettings() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/settings', (req, res) => {
  if (!requireAdmin(req.authUser?.id, res)) return;
  res.json({ tax: db.data.tax_settings, loyalty: db.data.loyalty_settings, print: currentPrintSettings(), return_window_days: currentReturnWindowDays() });
});

app.post('/api/settings', (req, res) => {
  if (!requireAdmin(req.authUser?.id, res)) return;
  const body = req.body || {};
  const tax = body.tax && typeof body.tax === 'object' ? body.tax : (Object.prototype.hasOwnProperty.call(body, 'tax_enabled') ? {
    enabled: body.tax_enabled,
    rate: body.tax_rate,
    registration_number: body.tax_registration_number
  } : null);
  const loyalty = body.loyalty && typeof body.loyalty === 'object' ? body.loyalty : (Object.prototype.hasOwnProperty.call(body, 'loyalty_enabled') ? {
    enabled: body.loyalty_enabled,
    spend_per_point: body.loyalty_spend_per_point
  } : null);
  const print = body.print && typeof body.print === 'object' ? body.print : null;
  const hasReturnWindow = Object.prototype.hasOwnProperty.call(body, 'return_window_days');
  if (!tax && !loyalty && !print && !hasReturnWindow) return res.status(400).json({ error: 'لا توجد إعدادات صالحة للحفظ.' });
  let returnWindowDays = currentReturnWindowDays();
  if (hasReturnWindow) {
    returnWindowDays = Number(body.return_window_days);
    if (!Number.isInteger(returnWindowDays) || returnWindowDays < 0 || returnWindowDays > 3650) return res.status(400).json({ error: 'مدة السماح بالارتجاع يجب أن تكون رقماً صحيحاً بين 0 و3650.' });
    db.data.system_settings.return_window_days = returnWindowDays;
  }
  if (tax) {
    const rate = Number(tax.rate);
    const registrationNumber = String(tax.registration_number || '').trim();
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) return res.status(400).json({ error: 'نسبة الضريبة يجب أن تكون بين 0 و100.' });
    if (registrationNumber.length > 100) return res.status(400).json({ error: 'رقم التسجيل الضريبي طويل أكثر من اللازم.' });
    db.data.tax_settings = { enabled: tax.enabled === true, rate: Number(rate.toFixed(4)), registration_number: registrationNumber };
  }
  if (loyalty) {
    const spendPerPoint = Number(loyalty.spend_per_point);
    if (!Number.isSafeInteger(spendPerPoint) || spendPerPoint < 1 || spendPerPoint > 1000000000) return res.status(400).json({ error: 'قيمة الإنفاق لاكتساب النقطة يجب أن تكون رقمًا صحيحًا موجبًا.' });
    db.data.loyalty_settings = { enabled: loyalty.enabled === true, spend_per_point: spendPerPoint };
  }
  if (print) {
    try { db.data.print_settings = normalizePrintSettings(print); } catch (error) { return res.status(400).json({ error: error.message }); }
  }
  db.save();
  db.logAudit(req.authUser.id, 'تعديل إعدادات النظام', 'system_settings', 1, 'تم حفظ الضريبة والولاء من مركز الإعدادات');
  res.json({ message: 'تم حفظ إعدادات النظام.', tax: db.data.tax_settings, loyalty: db.data.loyalty_settings, print: currentPrintSettings(), return_window_days: currentReturnWindowDays() });
});
app.get('/api/reports/tax', (req, res) => {
  const from = String(req.query.from || '').slice(0, 10);
  const to = String(req.query.to || '').slice(0, 10);
  const validDate = value => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!validDate(from) || !validDate(to) || (from && to && from > to)) return res.status(400).json({ error: 'فترة التقرير غير صحيحة.' });
  const inRange = value => {
    const date = String(value || '').slice(0, 10);
    return (!from || date >= from) && (!to || date <= to);
  };
  const sales = branchStockFilter(db.data.sales, req.branchId).filter(row => inRange(row.created_at) && Number(row.tax_amount || 0) > 0)
    .map(row => ({ type: 'sale', date: row.created_at, reference: row.invoice_number, amount: Number(row.tax_amount), rate: Number(row.tax_rate || 0) }));
  const returns = branchStockFilter(db.data.sale_returns, req.branchId).filter(row => inRange(row.created_at) && Number(row.tax_amount || 0) > 0)
    .map(row => ({ type: 'return', date: row.created_at, reference: db.data.sales.find(sale => sale.id === row.sale_id)?.invoice_number || '', amount: -Number(row.tax_amount), rate: Number(db.data.sales.find(sale => sale.id === row.sale_id)?.tax_rate || 0) }));
  const rows = [...sales, ...returns].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  res.json({ from, to, tax_settings: db.data.tax_settings || { enabled: false, rate: 0, registration_number: '' }, sales_tax: Number(sales.reduce((sum, row) => sum + row.amount, 0).toFixed(2)), returned_tax: Number(-returns.reduce((sum, row) => sum + row.amount, 0).toFixed(2)), net_tax: Number(rows.reduce((sum, row) => sum + row.amount, 0).toFixed(2)), rows });
});
const normalizeTallyEndpoint = value => {
  const raw = String(value || '').trim();
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const privateHost = host === 'localhost' || host === '::1' || host.endsWith('.local') || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (!['http:', 'https:'].includes(url.protocol) || !privateHost || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null;
    return `${url.protocol}//${url.host}`;
  } catch { return null; }
};
const tallyConfig = () => db.data.accounting_settings?.tally || { endpoint: 'http://127.0.0.1:9000', company_name: '', sales_ledger: '', cash_ledger: '', receivables_ledger: '', tax_ledger: '' };
const xmlText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
const tallyAmount = value => Number(Number(value || 0).toFixed(2)).toFixed(2);
const tallyEnvelope = (company, voucher) => `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xmlText(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${voucher}</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
const buildTallySalesVoucher = (sale, config) => {
  const date = String(sale.created_at || '').slice(0, 10).replace(/-/g, '');
  const paid = Math.max(0, Number(sale.paid_amount || 0) - Number(sale.change_amount || 0));
  const due = Math.max(0, Number(sale.total || 0) - paid);
  const partyEntries = [];
  if (paid > 0) partyEntries.push(`<LEDGERENTRIES.LIST><LEDGERNAME>${xmlText(config.cash_ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>No</ISPARTYLEDGER><AMOUNT>-${tallyAmount(paid)}</AMOUNT></LEDGERENTRIES.LIST>`);
  if (due > 0) partyEntries.push(`<LEDGERENTRIES.LIST><LEDGERNAME>${xmlText(config.receivables_ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-${tallyAmount(due)}</AMOUNT></LEDGERENTRIES.LIST>`);
  const taxable = Math.max(0, Number(sale.total || 0) - Number(sale.tax_amount || 0));
  const salesEntry = `<LEDGERENTRIES.LIST><LEDGERNAME>${xmlText(config.sales_ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${tallyAmount(taxable)}</AMOUNT></LEDGERENTRIES.LIST>`;
  const taxEntry = Number(sale.tax_amount || 0) > 0 ? `<LEDGERENTRIES.LIST><LEDGERNAME>${xmlText(config.tax_ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${tallyAmount(sale.tax_amount)}</AMOUNT></LEDGERENTRIES.LIST>` : '';
  return `<VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Accounting Voucher View"><DATE>${date}</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>${xmlText(sale.invoice_number)}</VOUCHERNUMBER><GUID>${xmlText(`RAWDA-SALE-${sale.id}`)}</GUID><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE><NARRATION>${xmlText(`فاتورة نقطة البيع ${sale.invoice_number} (${sale.order_channel || 'مباشر'})`)}</NARRATION>${partyEntries.join('')}${salesEntry}${taxEntry}</VOUCHER>`;
};
const tallyPost = async (endpoint, xml) => {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8' }, body: xml, signal: AbortSignal.timeout(8000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`استجاب Tally برمز HTTP ${response.status}.`);
  return text;
};

app.get('/api/integrations/tally/settings', (_req, res) => {
  const config = tallyConfig();
  res.json({ ...config, exported_sales_count: db.data.accounting_settings?.tally_exported_sale_ids?.length || 0 });
});
app.put('/api/integrations/tally/settings', (req, res) => {
  if (!requireAdmin(req.authUser?.id, res)) return;
  const body = req.body || {};
  const endpoint = normalizeTallyEndpoint(body.endpoint);
  if (!endpoint) return res.status(400).json({ error: 'عنوان Tally يجب أن يكون على الجهاز المحلي أو شبكة خاصة، مثل http://127.0.0.1:9000.' });
  const config = {
    endpoint,
    company_name: String(body.company_name || '').trim().slice(0, 120),
    sales_ledger: String(body.sales_ledger || '').trim().slice(0, 120),
    cash_ledger: String(body.cash_ledger || '').trim().slice(0, 120),
    receivables_ledger: String(body.receivables_ledger || '').trim().slice(0, 120),
    tax_ledger: String(body.tax_ledger || '').trim().slice(0, 120)
  };
  db.data.accounting_settings ||= { tally_exported_sale_ids: [] };
  db.data.accounting_settings.tally = config;
  db.data.accounting_settings.tally_exported_sale_ids ||= [];
  db.save();
  db.logAudit(req.authUser.id, 'إعداد ربط TallyPrime', 'accounting_settings', 1, `حفظ عنوان الربط وخرائط حسابات Tally`);
  res.json({ ...config, exported_sales_count: db.data.accounting_settings.tally_exported_sale_ids.length });
});
app.post('/api/integrations/tally/test', async (req, res) => {
  if (!requireAdmin(req.authUser?.id, res)) return;
  const config = tallyConfig();
  const endpoint = normalizeTallyEndpoint(config.endpoint);
  if (!endpoint) return res.status(400).json({ error: 'عنوان Tally غير صالح.' });
  try {
    const response = await tallyPost(endpoint, '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Company Info</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>');
    if (/<LINEERROR>|<STATUS>0<\/STATUS>/i.test(response)) return res.status(502).json({ error: 'وصل الاتصال إلى Tally لكن الاختبار أعاد خطأ. تحقق من تشغيل الشركة.' });
    res.json({ connected: true, endpoint, company_name: config.company_name, message: 'استجاب TallyPrime للاتصال.' });
  } catch (error) { res.status(502).json({ error: `تعذر الاتصال بـ TallyPrime: ${error.message}` }); }
});
app.post('/api/integrations/tally/sync-sales', async (req, res) => {
  if (!requireAdmin(req.authUser?.id, res)) return;
  const config = tallyConfig();
  const endpoint = normalizeTallyEndpoint(config.endpoint);
  if (!endpoint || !config.company_name || !config.sales_ledger || !config.cash_ledger || !config.receivables_ledger) return res.status(400).json({ error: 'أكمل عنوان Tally واسم الشركة وحسابات المبيعات والنقدية والعملاء أولاً.' });
  const from = String(req.body?.from || '').slice(0, 10), to = String(req.body?.to || '').slice(0, 10);
  if ((from && !validOptionalDate(from)) || (to && !validOptionalDate(to)) || (from && to && from > to)) return res.status(400).json({ error: 'فترة الإرسال غير صحيحة.' });
  const exported = new Set(db.data.accounting_settings?.tally_exported_sale_ids || []);
  const candidates = branchStockFilter(db.data.sales, req.branchId).filter(sale => {
    const date = String(sale.created_at || '').slice(0, 10);
    return !exported.has(sale.id) && sale.status !== 'returned' && (!from || date >= from) && (!to || date <= to);
  });
  const results = [];
  for (const sale of candidates) {
    if (Number(sale.tax_amount || 0) > 0 && !config.tax_ledger) { results.push({ invoice_number: sale.invoice_number, status: 'error', message: 'اسم حساب الضريبة غير محدد.' }); continue; }
    try {
      const xml = tallyEnvelope(config.company_name, buildTallySalesVoucher(sale, config));
      const response = await tallyPost(endpoint, xml);
      const created = Number(response.match(/<CREATED>\s*(\d+)/i)?.[1] || 0);
      const errors = Number(response.match(/<ERRORS>\s*(\d+)/i)?.[1] || 0);
      const lineError = response.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/i)?.[1];
      if (created < 1 || errors > 0 || lineError) throw new Error(xmlText(lineError || 'لم يؤكد Tally إنشاء القيد؛ لم نسجل الفاتورة كمصدرة.'));
      db.data.accounting_settings.tally_exported_sale_ids.push(sale.id);
      db.save();
      results.push({ invoice_number: sale.invoice_number, status: 'sent' });
    } catch (error) { results.push({ invoice_number: sale.invoice_number, status: 'error', message: error.message }); }
  }
  if (results.some(row => row.status === 'sent')) db.logAudit(req.authUser.id, 'إرسال مبيعات إلى TallyPrime', 'accounting_settings', 1, `تم إرسال ${results.filter(row => row.status === 'sent').length} فاتورة`);
  res.json({ total: candidates.length, sent: results.filter(row => row.status === 'sent').length, failed: results.filter(row => row.status === 'error').length, results });
});

app.get('/api/accounting/export-data', (req, res) => {
  const from = String(req.query.from || '').slice(0, 10);
  const to = String(req.query.to || '').slice(0, 10);
  if ((from && !validOptionalDate(from)) || (to && !validOptionalDate(to)) || (from && to && from > to)) return res.status(400).json({ error: 'فترة التصدير غير صحيحة.' });
  const inRange = value => { const date = String(value || '').slice(0, 10); return (!from || date >= from) && (!to || date <= to); };
  const sales = branchStockFilter(db.data.sales, req.branchId).filter(row => inRange(row.created_at)).map(sale => ({
    ...sale,
    customer_name: db.data.customers.find(customer => customer.id === sale.customer_id)?.name || 'عميل نقدي',
    customer_phone: db.data.customers.find(customer => customer.id === sale.customer_id)?.phone || '',
    cashier_name: db.data.users.find(user => user.id === sale.user_id)?.name || '',
    items: db.data.sale_items.filter(item => item.sale_id === sale.id).map(item => ({ ...item, product_name: db.data.products.find(product => product.id === item.product_id)?.name || 'صنف غير معروف' }))
  }));
  const purchases = branchStockFilter(db.data.purchases, req.branchId).filter(row => inRange(row.created_at)).map(purchase => ({
    ...purchase,
    supplier_name: db.data.suppliers.find(supplier => supplier.id === purchase.supplier_id)?.name || '',
    items: db.data.purchase_items.filter(item => item.purchase_id === purchase.id).map(item => ({ ...item, product_name: db.data.products.find(product => product.id === item.product_id)?.name || 'صنف غير معروف' }))
  }));
  const cashTransactions = branchStockFilter(db.data.cash_transactions, req.branchId).filter(row => inRange(row.created_at));
  const returns = branchStockFilter(db.data.sale_returns, req.branchId).filter(row => inRange(row.created_at)).map(row => ({ ...row, invoice_number: db.data.sales.find(sale => sale.id === row.sale_id)?.invoice_number || '' }));
  const customerName = customerId => db.data.customers.find(customer => customer.id === customerId)?.name || 'عميل نقدي';
  const serviceOrders = branchStockFilter(db.data.service_orders || [], req.branchId).filter(row => inRange(row.created_at)).map(row => ({ ...row, customer_name: customerName(row.customer_id) }));
  const installmentContracts = branchStockFilter(db.data.installment_contracts || [], req.branchId).filter(row => inRange(row.created_at)).map(row => ({ ...row, customer_name: customerName(row.customer_id) }));
  const customers = db.data.customers.map(({ id, name, phone }) => ({ id, name, phone, balance: Number(customerBranchBalance(id,req.branchId).toFixed(2)) }));
  const suppliers = db.data.suppliers.map(({ id, name, phone }) => ({ id, name, phone, balance: Number(supplierBranchBalance(id,req.branchId).toFixed(2)) }));
  const customer_ledgers = branchStockFilter(db.data.customer_transactions || [], req.branchId).filter(row => inRange(row.created_at)).map(row => ({ ...row, customer_name: customers.find(customer => customer.id === row.customer_id)?.name || '' }));
  const supplier_ledgers = branchStockFilter(db.data.supplier_transactions || [], req.branchId).filter(row => inRange(row.created_at)).map(row => ({ ...row, supplier_name: suppliers.find(supplier => supplier.id === row.supplier_id)?.name || '' }));
  const inventory = branchStockFilter(db.data.products || [], req.branchId).map(({ id, name, barcode, quantity, min_stock, cost_price, sale_price, category_id, expiry_date }) => ({ id, name, barcode, quantity: Number(quantity || 0), min_stock: Number(min_stock || 0), cost_price: Number(cost_price || 0), sale_price: Number(sale_price || 0), category_id, expiry_date: expiry_date || '' }));
  res.json({ from, to, business: readBusinessProfile(), sales, purchases, returns, service_orders: serviceOrders, installment_contracts: installmentContracts, cash_transactions: cashTransactions, customers, suppliers, inventory, customer_ledgers, supplier_ledgers });
});

// Detailed sales, purchases and profit/loss report. The requested branch is
// checked against the authenticated user's branch assignments before data is
// read, and product costs come from the immutable sale-item cost snapshot.
app.get('/api/reports/detailed', (req, res) => {
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const validDate = value => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
  if (!validDate(from) || !validDate(to) || (from && to && from > to)) return res.status(400).json({ error: 'فترة التقرير غير صحيحة.' });
  const unrestricted = isUnrestrictedAccount(req.authUser);
  const permittedBranches = unrestricted
    ? (db.data.branches || []).filter(row => row.is_active !== false && !row.deleted_at).map(row => Number(row.id))
    : getUserBranchIds(req.authUser);
  const requestedBranch = Number(req.query.branch_id || req.branchId);
  if (!Number.isInteger(requestedBranch) || !permittedBranches.includes(requestedBranch)) return res.status(403).json({ error: 'لا تملك صلاحية عرض تقارير هذا الفرع.' });
  const warehouseId = Number(req.query.warehouse_id) || null;
  const categoryId = Number(req.query.category_id) || null;
  const partyId = Number(req.query.party_id) || null;
  const userId = Number(req.query.user_id) || null;
  const productQuery = String(req.query.product || '').trim().toLocaleLowerCase();
  const kind = ['sales', 'purchases', 'profit-loss'].includes(String(req.query.kind)) ? String(req.query.kind) : 'profit-loss';
  const branchRows = rows => branchStockFilter(rows || [], requestedBranch);
  const inRange = value => { const day = String(value || '').slice(0, 10); return (!from || day >= from) && (!to || day <= to); };
  const warehouseProducts = branchRows(db.data.warehouse_products || []);
  const productById = new Map((db.data.products || []).map(row => [Number(row.id), row]));
  const productMatches = productId => {
    const product = productById.get(Number(productId));
    if (!product) return false;
    if (productQuery && !`${product.name || ''} ${product.barcode || ''} ${product.item_number || ''}`.toLocaleLowerCase().includes(productQuery)) return false;
    if (categoryId && Number(product.category_id || 0) !== categoryId && !warehouseProducts.some(row => Number(row.product_id) === Number(productId) && Number(row.category_id) === categoryId)) return false;
    if (warehouseId && !warehouseProducts.some(row => Number(row.product_id) === Number(productId) && Number(row.warehouse_id) === warehouseId)) return false;
    return true;
  };
  const customers = new Map((db.data.customers || []).map(row => [Number(row.id), row]));
  const suppliers = new Map((db.data.suppliers || []).map(row => [Number(row.id), row]));
  const users = new Map((db.data.users || []).map(row => [Number(row.id), row]));
  const branchSales = branchRows(db.data.sales);
  const branchPurchases = branchRows(db.data.purchases);
  const branchSaleIds = new Set(branchSales.map(row => Number(row.id)));
  const branchPurchaseIds = new Set(branchPurchases.map(row => Number(row.id)));
  const branchSaleItems = (db.data.sale_items || []).filter(row => branchSaleIds.has(Number(row.sale_id)));
  const branchPurchaseItems = (db.data.purchase_items || []).filter(row => branchPurchaseIds.has(Number(row.purchase_id)));
  const sales = branchSales.filter(row => inRange(row.created_at) && (!partyId || Number(row.customer_id) === partyId) && (!userId || Number(row.user_id) === userId)).map(sale => {
    const items = branchSaleItems.filter(item => Number(item.sale_id) === Number(sale.id) && productMatches(item.product_id)).map(item => ({ id: item.id, product_id: item.product_id, product_name: productById.get(Number(item.product_id))?.name || 'صنف غير معروف', product_barcode: productById.get(Number(item.product_id))?.barcode || '', quantity: item.quantity, unit_price: item.unit_price, cost_price: item.cost_price, discount: item.discount, total: item.total }));
    return { id: sale.id, branch_id: sale.branch_id, created_at: sale.created_at, invoice_number: sale.invoice_number, customer_id: sale.customer_id, user_id: sale.user_id, total: sale.total, subtotal: sale.subtotal, discount: sale.discount, tax_amount: sale.tax_amount, paid_amount: sale.paid_amount, change_amount: sale.change_amount, payment_method: sale.payment_method, order_type: sale.order_type, status: sale.status, customer_name: customers.get(Number(sale.customer_id))?.name || 'عميل نقدي', cashier_name: users.get(Number(sale.user_id))?.name || 'كاشير', items };
  }).filter(sale => (!productQuery && !categoryId && !warehouseId) || sale.items.length > 0);
  const purchases = branchPurchases.filter(row => inRange(row.created_at) && (!partyId || Number(row.supplier_id) === partyId) && (!userId || Number(row.user_id) === userId)).map(purchase => {
    const items = branchPurchaseItems.filter(item => Number(item.purchase_id) === Number(purchase.id) && !item.wac_reversed && productMatches(item.product_id)).map(item => ({ id: item.id, product_id: item.product_id, product_name: productById.get(Number(item.product_id))?.name || 'صنف غير معروف', quantity: item.quantity, unit_cost: item.unit_cost, lot_number: item.lot_number, production_date: item.production_date, expiry_date: item.expiry_date }));
    return { id: purchase.id, branch_id: purchase.branch_id, created_at: purchase.created_at, supplier_id: purchase.supplier_id, user_id: purchase.user_id, total: purchase.total, paid_amount: purchase.paid_amount, remaining_amount: purchase.remaining_amount, status: purchase.status, supplier_name: suppliers.get(Number(purchase.supplier_id))?.name || 'مورد عام', user_name: users.get(Number(purchase.user_id))?.name || 'المسؤول', items };
  }).filter(purchase => (!productQuery && !categoryId && !warehouseId) || purchase.items.length > 0);
  const returns = (db.data.sale_returns || []).filter(row => inRange(row.created_at) && branchSaleIds.has(Number(row.sale_id))).map(row => {
    const sale = db.data.sales.find(item => Number(item.id) === Number(row.sale_id));
    const saleItem = db.data.sale_items.find(item => Number(item.id) === Number(row.sale_item_id));
    return { id: row.id, sale_id: row.sale_id, sale_item_id: row.sale_item_id, product_id: row.product_id, quantity: row.quantity, amount: row.amount, tax_amount: row.tax_amount, reason: row.reason, created_at: row.created_at, invoice_number: sale?.invoice_number || '', customer_name: customers.get(Number(sale?.customer_id))?.name || 'عميل نقدي', user_id: row.user_id || sale?.user_id || null, source_sale: sale, source_sale_item: saleItem };
  }).filter(row => row.source_sale && (!partyId || Number(row.source_sale.customer_id) === partyId) && (!userId || Number(row.source_sale.user_id) === userId) && (!row.source_sale_item || productMatches(row.source_sale_item.product_id)));
  const publicReturns = returns.map(({ source_sale, source_sale_item, ...row }) => row);
  const cashRows = branchRows(db.data.cash_transactions);
  const expenses = cashRows.filter(row => row.type === 'expense' && inRange(row.created_at) && (!userId || Number(row.user_id) === userId)).map(row => ({ id: row.id, created_at: row.created_at, reference_id: row.reference_id, notes: row.notes, amount: row.amount, user_id: row.user_id }));
  const assignments = branchRows(db.data.delivery_assignments || []).filter(row => row.status === 'delivered' && inRange(row.delivered_at || row.updated_at || row.created_at));
  const saleById = new Map(sales.map(row => [Number(row.id), row]));
  const deliveryWages = assignments.filter(row => saleById.has(Number(row.sale_id)) || (!partyId && !productQuery && !categoryId && !warehouseId)).filter(row => {
    const sale = db.data.sales.find(item => Number(item.id) === Number(row.sale_id));
    if (!sale || (userId && Number(sale.user_id) !== userId) || (partyId && Number(sale.customer_id) !== partyId)) return false;
    if (productQuery || categoryId || warehouseId) return branchSaleItems.some(item => Number(item.sale_id) === Number(sale.id) && productMatches(item.product_id));
    return true;
  }).map(row => ({ id: row.id, sale_id: row.sale_id, rider_id: row.rider_id, rider_name: (db.data.delivery_riders || []).find(rider => Number(rider.id) === Number(row.rider_id))?.name || 'الطيار', delivered_at: row.delivered_at, delivery_fee_rider: row.delivery_fee_rider, invoice_number: db.data.sales.find(sale => Number(sale.id) === Number(row.sale_id))?.invoice_number || '' }));
  const ownerDeposits = cashRows.filter(row => ['owner_deposit', 'owner_capital', 'owner_funding'].includes(String(row.type)) && inRange(row.created_at)).map(row => ({ id: row.id, created_at: row.created_at, reference_id: row.reference_id, notes: row.notes, amount: row.amount }));
  const salesRevenue = sales.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const returnsTotal = returns.reduce((sum, row) => sum + Number(row.amount || 0) + Number(row.tax_amount || 0), 0);
  const originalCogs = sales.reduce((sum, sale) => sum + sale.items.reduce((itemSum, item) => itemSum + Number(item.cost_price || 0) * Number(item.quantity || 0), 0), 0);
  const returnedCogs = returns.reduce((sum, row) => {
    const saleItem = db.data.sale_items.find(item => Number(item.id) === Number(row.sale_item_id));
    return sum + Number(saleItem?.cost_price || 0) * Number(row.quantity || 0);
  }, 0);
  const cogs = Math.max(0, originalCogs - returnedCogs);
  const expenseTotal = expenses.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const deliveryWagesTotal = deliveryWages.reduce((sum, row) => sum + Number(row.delivery_fee_rider || 0), 0);
  const netProfit = salesRevenue - cogs - returnsTotal - expenseTotal - deliveryWagesTotal;
  const branch = (db.data.branches || []).find(row => Number(row.id) === requestedBranch);
  const warehouses = (db.data.warehouses || []).filter(row => Number(row.branch_id) === requestedBranch).map(row => ({ id: row.id, name: row.name }));
  const categories = (db.data.categories || []).filter(row => !row.branch_id || Number(row.branch_id) === requestedBranch).map(row => ({ id: row.id, name: row.name }));
  const branchUsers = [...users.values()].filter(row => getUserBranchIds(row).includes(requestedBranch));
  const branchCustomerIds = new Set(branchSales.map(row => Number(row.customer_id)));
  const branchSupplierIds = new Set(branchPurchases.map(row => Number(row.supplier_id)));
  res.json({
    filters: { kind, from, to, branch_id: requestedBranch, warehouse_id: warehouseId, product: productQuery, category_id: categoryId, party_id: partyId, user_id: userId },
    options: { branches: (db.data.branches || []).filter(row => permittedBranches.includes(Number(row.id)) && row.is_active !== false && !row.deleted_at).map(row => ({ id: row.id, name: row.name })), warehouses, categories, customers: [...customers.values()].filter(row => Number(row.id) > 1 && branchCustomerIds.has(Number(row.id))).map(row => ({ id: row.id, name: row.name })), suppliers: [...suppliers.values()].filter(row => Number(row.id) > 1 && branchSupplierIds.has(Number(row.id))).map(row => ({ id: row.id, name: row.name })), users: branchUsers.map(row => ({ id: row.id, name: row.name })) },
    branch_name: branch?.name || '',
    summary: { sales_count: sales.length, purchases_count: purchases.length, sales_revenue: Number(salesRevenue.toFixed(2)), sales_paid: Number(sales.reduce((sum, row) => sum + Number(row.paid_amount || 0), 0).toFixed(2)), sales_due: Number(sales.reduce((sum, row) => sum + Math.max(0, Number(row.total || 0) - Number(row.paid_amount || 0)), 0).toFixed(2)), purchases_total: Number(purchases.reduce((sum, row) => sum + Number(row.total || 0), 0).toFixed(2)), purchases_paid: Number(purchases.reduce((sum, row) => sum + Number(row.paid_amount || 0), 0).toFixed(2)), purchases_due: Number(purchases.reduce((sum, row) => sum + Math.max(0, Number(row.total || 0) - Number(row.paid_amount || 0)), 0).toFixed(2)), cogs: Number(cogs.toFixed(2)), returns: Number(returnsTotal.toFixed(2)), expenses: Number(expenseTotal.toFixed(2)), delivery_wages: Number(deliveryWagesTotal.toFixed(2)), net_profit: Number(netProfit.toFixed(2)), owner_deposits: Number(ownerDeposits.reduce((sum, row) => sum + Number(row.amount || 0), 0).toFixed(2)), owner_deposit_rows: ownerDeposits.length },
    sales, purchases, returns: publicReturns, expenses, delivery_wages: deliveryWages, owner_deposits: ownerDeposits
  });
});

// ---- العروض والخصومات الترويجية ----
const normalizePromotion = (body = {}, previous = {}) => {
  const merged = { ...previous, ...body };
  const name = String(merged.name || '').trim();
  const type = String(merged.type || 'percent');
  const value = Number(merged.value);
  const buyQuantity = Number(merged.buy_quantity || 0); const getQuantity = Number(merged.get_quantity || 0);
  const startTime = String(merged.start_time || '').trim(); const endTime = String(merged.end_time || '').trim();
  const productId = merged.product_id === '' || merged.product_id === null || merged.product_id === undefined ? null : Number(merged.product_id);
  const categoryId = merged.category_id === '' || merged.category_id === null || merged.category_id === undefined ? null : Number(merged.category_id);
  const startDate = String(merged.start_date || '').slice(0, 10);
  const endDate = String(merged.end_date || '').slice(0, 10);
  if (!name || name.length > 100) return { error: 'اسم العرض مطلوب ولا يزيد عن 100 حرف.' };
  if (!['percent', 'fixed', 'bundle'].includes(type) || (type !== 'bundle' && (!Number.isFinite(value) || value <= 0 || (type === 'percent' && value > 100))) || (type === 'bundle' && (!Number.isInteger(buyQuantity) || !Number.isInteger(getQuantity) || buyQuantity < 1 || getQuantity < 1 || buyQuantity + getQuantity > 1000))) return { error: 'نوع العرض أو قيمته غير صحيحة.' };
  if ((productId !== null && (!Number.isInteger(productId) || !db.data.products.some(product => product.id === productId)))
    || (categoryId !== null && (!Number.isInteger(categoryId) || !db.data.categories.some(category => category.id === categoryId)))
    || (productId && categoryId)) return { error: 'حدد صنفًا أو فئة واحدة موجودة، أو اترك النطاق عامًا.' };
  if (!validOptionalDate(startDate) || !validOptionalDate(endDate) || (startDate && endDate && startDate > endDate)) return { error: 'فترة العرض غير صحيحة.' };
  const validTime = v => !v || /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  if (!validTime(startTime) || !validTime(endTime) || (startTime && endTime && startTime >= endTime)) return { error: 'وقت بداية ونهاية العرض غير صحيح.' };
  return { value: { name, type, value: type === 'bundle' ? 0 : Number(value.toFixed(4)), buy_quantity: type === 'bundle' ? buyQuantity : null, get_quantity: type === 'bundle' ? getQuantity : null, start_time: startTime, end_time: endTime, product_id: productId, category_id: categoryId, start_date: startDate, end_date: endDate, is_active: merged.is_active !== false } };
};
app.get('/api/promotions', (req, res) => res.json(branchStockFilter(db.data.promotions || [], req.branchId).slice().sort((a, b) => Number(b.id) - Number(a.id))));
app.post('/api/promotions', (req, res) => {
  if (!requireAdmin(req.authUser?.id, res)) return;
  const normalized = normalizePromotion(req.body);
  if (normalized.error) return res.status(400).json({ error: normalized.error });
  const promotion = { id: db.nextId('promotions'), branch_id: req.branchId, ...normalized.value, created_at: nowStr(), updated_at: nowStr(), created_by: req.authUser.id };
  db.data.promotions.push(promotion);
  db.save();
  db.logAudit(req.authUser.id, 'إنشاء عرض ترويجي', 'promotions', promotion.id, promotion.name);
  res.status(201).json(promotion);
});
app.put('/api/promotions/:id', (req, res) => {
  if (!requireAdmin(req.authUser?.id, res)) return;
  const promotion = (db.data.promotions || []).find(row => row.id === Number(req.params.id));
  if (!promotion) return res.status(404).json({ error: 'العرض غير موجود.' });
  const normalized = normalizePromotion(req.body, promotion);
  if (normalized.error) return res.status(400).json({ error: normalized.error });
  Object.assign(promotion, normalized.value, { updated_at: nowStr() });
  db.save();
  db.logAudit(req.authUser.id, 'تعديل عرض ترويجي', 'promotions', promotion.id, promotion.name);
  res.json(promotion);
});
app.delete('/api/promotions/:id', (req, res) => {
  if (!requireAdmin(req.authUser?.id, res)) return;
  const promotion = (db.data.promotions || []).find(row => row.id === Number(req.params.id));
  if (!promotion) return res.status(404).json({ error: 'العرض غير موجود.' });
  promotion.is_active = false;
  promotion.updated_at = nowStr();
  db.save();
  db.logAudit(req.authUser.id, 'إيقاف عرض ترويجي', 'promotions', promotion.id, promotion.name);
  res.json({ message: 'تم إيقاف العرض.' });
});

app.get('/api/whatsapp-offer-message', (req, res) => {
  res.json({ message: typeof db.data.whatsapp_offer_message === 'string' ? db.data.whatsapp_offer_message : null });
});
app.put('/api/whatsapp-offer-message', (req, res) => {
  const message = String(req.body?.message ?? '');
  if (!message.trim()) return res.status(400).json({ error: 'اكتب نص الرسالة قبل حفظها.' });
  if (message.length > 4000) return res.status(400).json({ error: 'الحد الأقصى لنص الرسالة 4000 حرف.' });
  db.data.whatsapp_offer_message = message;
  db.save();
  db.logAudit(req.authUser.id, 'حفظ نص رسالة عروض واتساب', 'whatsapp_offer_message', 1, `عدد الحروف: ${message.length}`);
  res.json({ message });
});
app.delete('/api/whatsapp-offer-message', (req, res) => {
  db.data.whatsapp_offer_message = '';
  db.save();
  db.logAudit(req.authUser.id, 'حذف نص رسالة عروض واتساب', 'whatsapp_offer_message', 1, 'تم حذف قالب رسالة العروض.');
  res.json({ message: '' });
});

// ---- إخفاء الشاشات والأقسام من الواجهة (يحدده المدير) ----
// يمكن إخفاء أي شاشة أو قسم، وتبقى الإعدادات متاحة للمدير لإظهار العناصر مجدداً.
const HIDEABLE_UI_ITEMS = new Set([
  'tab:pos', 'tab:service-orders', 'tab:installments', 'tab:promotions', 'tab:offer-messages', 'tab:dashboard', 'tab:products', 'tab:categories', 'tab:inventory',
  'tab:purchases', 'tab:sales-history', 'tab:customers', 'tab:employees', 'tab:barcodes', 'tab:delivery', 'tab:delivery-riders',
  'tab:reports', 'tab:users', 'tab:audit-logs',
  'group:overview', 'group:settings', 'group:catalog', 'group:customers', 'group:suppliers', 'group:purchases', 'group:sales', 'group:reports',
  'group:employees', 'group:cash', 'group:installments', 'group:maintenance', 'group:database',
  'group:accounting', 'group:tax', 'group:owner-alerts', 'group:order-channels', 'group:customer-phone-search', 'group:salesperson-commission', 'group:purchase-orders', 'group:delivery', 'group:delivery-riders', 'group:attendance', 'group:ask-store', 'group:price-levels', 'group:waste',
  'nav:network', 'nav:theme', 'nav:dashboard', 'nav:low-stock', 'nav:branch',
  ...['new-sale','order-search','wholesale','offers','purchases','products','categories','suppliers','cash','employees','delivery','riders','e-invoice','smart-delivery','offline-sale','dynamic-pricing','customer-display','owner-report','shift-cash','ledger-stock'].map(id => `card:quick-${id}`),
  ...['dash-today-sales','dash-today-profit','dash-today-invoices','dash-low-stock-count','dash-cash-balance','dash-customer-debt','dash-supplier-debt'].map(id => `card:${id}`)
]);
const isUiVisibilityAdmin = user => Boolean(user?.is_owner === true || user?.role === 'admin');
const getUiHiddenForRole = role => {
  const byRole = db.data.ui_settings?.by_role;
  const roleHidden = byRole && Array.isArray(byRole[role]) ? byRole[role] : null;
  return roleHidden || db.data.ui_settings?.hidden || [];
};
app.get('/api/ui-settings', (req, res) => {
  const role = String(req.query.role || req.authUser?.role || '').trim();
  if (!role || (role !== req.authUser?.role && !isUiVisibilityAdmin(req.authUser))) return res.status(403).json({ error: 'لا تملك صلاحية عرض إعدادات هذا الدور.' });
  const roles = isUiVisibilityAdmin(req.authUser) ? [...new Set(db.data.users.map(user => String(user.role || '').trim()).filter(Boolean))].sort() : [];
  res.json({ role, roles, hidden: getUiHiddenForRole(role) });
});
app.put('/api/ui-settings', (req, res) => {
  if (!isUiVisibilityAdmin(req.authUser)) return res.status(403).json({ error: 'إعدادات إظهار العناصر متاحة للأدمن فقط.' });
  const role = String(req.body?.role || '').trim();
  if (!role || role.length > 60 || !db.data.users.some(user => user.role === role)) return res.status(400).json({ error: 'اختر دورًا موجودًا في النظام.' });
  const hidden = req.body?.hidden;
  if (!Array.isArray(hidden) || hidden.length > 100 || hidden.some(item => typeof item !== 'string' || !HIDEABLE_UI_ITEMS.has(item))) {
    return res.status(400).json({ error: 'قائمة العناصر المخفية غير صالحة.' });
  }
  db.data.ui_settings ||= { hidden: [] };
  db.data.ui_settings.by_role ||= {};
  db.data.ui_settings.by_role[role] = [...new Set(hidden)];
  db.save();
  db.logAudit(req.authUser.id, 'تعديل إظهار وإخفاء الواجهة حسب الدور', 'ui_settings', 1, `الدور: ${role}؛ العناصر المخفية: ${db.data.ui_settings.by_role[role].length}`);
  res.json({ role, roles: [...new Set(db.data.users.map(user => String(user.role || '').trim()).filter(Boolean))].sort(), hidden: db.data.ui_settings.by_role[role] });
});
app.get('/api/customers/:id/loyalty', (req, res) => {
  const customerId = Number(req.params.id);
  const customer = db.data.customers.find(item => item.id === customerId);
  if (!customer) return res.status(404).json({ error: 'العميل غير موجود.' });
  const transactions = db.data.loyalty_transactions
    .filter(entry => Number(entry.customer_id) === customerId)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  res.json({ customer_id: customerId, points: loyaltyBalance(customerId), transactions });
});

app.post('/api/customers', (req, res) => {
  const { name, phone, notes, balance, credit_limit, current_user_id } = req.body;
  if (!name) return res.status(400).json({ error: 'اسم العميل مطلوب' });
  const creditLimit = credit_limit === '' || credit_limit === undefined || credit_limit === null ? null : Number(credit_limit);
  if (creditLimit !== null && (!Number.isFinite(creditLimit) || creditLimit < 0)) return res.status(400).json({ error: 'الحد الائتماني غير صحيح.' });

  const cust = {
    id: db.nextId('customers'),
    name: name.trim(),
    phone: phone || '',
    notes: notes || '',
    balance: parseFloat(balance) || 0,
    credit_limit: creditLimit
  };
  db.data.customers.push(cust);
  db.save();
  db.logAudit(current_user_id, 'إضافة عميل', 'customers', cust.id, `إضافة عميل: ${cust.name}`);
  res.status(201).json(cust);
});

app.put('/api/customers/:id', (req, res) => {
  const cust = db.data.customers.find(c => c.id === Number(req.params.id));
  if (!cust) return res.status(404).json({ error: 'العميل غير موجود' });
  const { name, phone, notes, credit_limit, current_user_id } = req.body;
  const creditLimit = credit_limit === '' || credit_limit === undefined || credit_limit === null ? null : Number(credit_limit);
  if (credit_limit !== undefined && creditLimit !== null && (!Number.isFinite(creditLimit) || creditLimit < 0)) return res.status(400).json({ error: 'الحد الائتماني غير صحيح.' });
  if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'اسم العميل مطلوب' });
  if (name !== undefined) cust.name = String(name).trim();
  if (phone !== undefined) cust.phone = String(phone);
  if (notes !== undefined) cust.notes = String(notes);
  if (credit_limit !== undefined) cust.credit_limit = creditLimit;
  db.save();
  db.logAudit(current_user_id, 'تعديل عميل', 'customers', cust.id, `تعديل بيانات العميل: ${cust.name}`);
  res.json(cust);
});

app.delete('/api/customers/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === 1) return res.status(400).json({ error: 'لا يمكن حذف العميل النقدي الافتراضي' });
  const index = db.data.customers.findIndex(c => c.id === id);
  if (index < 0) return res.status(404).json({ error: 'العميل غير موجود' });
  const removed = db.data.customers.splice(index, 1)[0];
  db.save();
  db.logAudit(req.query.current_user_id, 'حذف عميل', 'customers', id, `حذف العميل: ${removed.name}`);
  res.json({ message: 'تم حذف العميل بنجاح' });
});

app.get('/api/customers/:id/ledger', (req, res) => {
  const id = Number(req.params.id);
  const customer = db.data.customers.find(c => c.id === id);
  if (!customer) return res.status(404).json({ error: 'العميل غير موجود' });
  const transactions = branchStockFilter(db.data.customer_transactions, req.branchId).filter(t => t.customer_id === id).slice().reverse();
  const totalDebit = transactions.reduce((sum, t) => sum + (t.debit || 0), 0);
  const totalCredit = transactions.reduce((sum, t) => sum + (t.credit || 0), 0);
  res.json({ customer, transactions, total_debit: totalDebit, total_credit: totalCredit, balance: totalDebit - totalCredit });
});

app.post('/api/customers/:id/payments', (req, res) => {
  const id = Number(req.params.id);
  const customer = db.data.customers.find(c => c.id === id);
  const amount = Number(req.body.amount);
  if (!customer) return res.status(404).json({ error: 'العميل غير موجود' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'قيمة السداد غير صحيحة' });
  let transaction;
  try {
    transaction = db.transaction(['customers', 'customer_transactions', 'cash_transactions', 'cash_audit_chain', 'audit_logs'], () => {
      addFinanceTransaction('customer_transactions', { customer_id: id, type: 'payment', debit: 0, credit: amount, reference_id: req.body.reference_id || 'سداد عميل', notes: req.body.notes || '' });
      customer.balance = Math.max(0, (customer.balance || 0) - amount);
      addFinanceTransaction('cash_transactions', { type: 'customer_payment', amount, direction: 'in', reference_id: `CUSTOMER-${id}`, notes: req.body.notes || '', user_id: req.authUser.id });
      db.logAudit(req.authUser.id, 'سداد عميل آجل', 'customers', id, `سداد ${amount} ج.م من العميل ${customer.name}`, { save: false });
      return db.data.customer_transactions.at(-1);
    });
  } catch (error) { return res.status(500).json({ error: `تعذر حفظ سداد العميل وسجل التدقيق معاً: ${error.message}` }); }
  res.status(201).json({ message: 'تم تسجيل السداد', transaction, balance: customer.balance });
});

app.get('/api/suppliers', (req, res) => {
  res.json(db.data.suppliers.map(supplier => ({ ...supplier, balance: Number(supplierBranchBalance(supplier.id, req.branchId).toFixed(2)) })));
});

app.post('/api/suppliers', (req, res) => {
  const { name, phone, notes, balance, current_user_id } = req.body;
  if (!name) return res.status(400).json({ error: 'اسم المورد مطلوب' });

  const supp = {
    id: db.nextId('suppliers'),
    name: name.trim(),
    phone: phone || '',
    notes: notes || '',
    balance: parseFloat(balance) || 0
  };
  db.data.suppliers.push(supp);
  db.save();
  db.logAudit(current_user_id, 'إضافة مورد', 'suppliers', supp.id, `إضافة مورد: ${supp.name}`);
  res.status(201).json(supp);
});

app.put('/api/suppliers/:id', (req, res) => {
  const supp = db.data.suppliers.find(s => s.id === Number(req.params.id));
  if (!supp) return res.status(404).json({ error: 'المورد غير موجود' });
  const { name, phone, notes, current_user_id } = req.body;
  if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'اسم المورد مطلوب' });
  if (name !== undefined) supp.name = String(name).trim();
  if (phone !== undefined) supp.phone = String(phone);
  if (notes !== undefined) supp.notes = String(notes);
  db.save();
  db.logAudit(current_user_id, 'تعديل مورد', 'suppliers', supp.id, `تعديل بيانات المورد: ${supp.name}`);
  res.json(supp);
});

app.delete('/api/suppliers/:id', (req, res) => {
  const id = Number(req.params.id);
  const index = db.data.suppliers.findIndex(s => s.id === id);
  if (index < 0) return res.status(404).json({ error: 'المورد غير موجود' });
  const removed = db.data.suppliers.splice(index, 1)[0];
  db.save();
  db.logAudit(req.query.current_user_id, 'حذف مورد', 'suppliers', id, `حذف المورد: ${removed.name}`);
  res.json({ message: 'تم حذف المورد بنجاح' });
});

app.get('/api/suppliers/:id/ledger', (req, res) => {
  const id = Number(req.params.id);
  const supplier = db.data.suppliers.find(s => s.id === id);
  if (!supplier) return res.status(404).json({ error: 'المورد غير موجود' });
  const transactions = branchStockFilter(db.data.supplier_transactions, req.branchId).filter(t => t.supplier_id === id).slice().reverse();
  const totalDebit = transactions.reduce((sum, t) => sum + (t.debit || 0), 0);
  const totalCredit = transactions.reduce((sum, t) => sum + (t.credit || 0), 0);
  res.json({ supplier, transactions, total_debit: totalDebit, total_credit: totalCredit, balance: totalDebit - totalCredit });
});

app.post('/api/suppliers/:id/payments', (req, res) => {
  const id = Number(req.params.id);
  const supplier = db.data.suppliers.find(s => s.id === id);
  const amount = Number(req.body.amount);
  if (!supplier) return res.status(404).json({ error: 'المورد غير موجود' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'قيمة السداد غير صحيحة' });
  let transaction;
  try {
    transaction = db.transaction(['suppliers', 'supplier_transactions', 'cash_transactions', 'cash_audit_chain', 'audit_logs'], () => {
      const cashConfirmation = requireCashBalanceConfirmation(req, res, amount);
      if (!cashConfirmation) return null;
      addFinanceTransaction('supplier_transactions', { supplier_id: id, type: 'payment', debit: 0, credit: amount, reference_id: req.body.reference_id || 'سداد مورد', notes: req.body.notes || '' });
      supplier.balance = Math.max(0, (supplier.balance || 0) - amount);
      addFinanceTransaction('cash_transactions', { type: 'supplier_payment', amount, direction: 'out', reference_id: `SUPPLIER-${id}`, notes: req.body.notes || '', user_id: req.authUser.id, ...cashConfirmationFields(cashConfirmation) });
      db.logAudit(req.authUser.id, 'سداد مورد', 'suppliers', id, `سداد ${amount} ج.م للمورد ${supplier.name}`, { save: false });
      return db.data.supplier_transactions.at(-1);
    });
  } catch (error) { return res.status(500).json({ error: `تعذر حفظ سداد المورد وسجل التدقيق معاً: ${error.message}` }); }
  if (!transaction) return;
  res.status(201).json({ message: 'تم تسجيل السداد', transaction, balance: supplier.balance });
});

// ----------------------------------------------------
// Employees & Payroll
// ----------------------------------------------------
app.get('/api/employees', (req, res) => {
  const activeBranch = db.data.branches.find(branch => Number(branch.id) === Number(req.branchId) && branch.is_active !== false);
  if (!activeBranch) return res.status(400).json({ error: 'اختر فرعاً نشطاً صالحاً.' });
  const employees = (db.data.employees || [])
    .filter(emp => Number(emp.branch_id || db.data.default_branch_id) === Number(req.branchId))
    .map(emp => {
    const transactions = (db.data.employee_transactions || []).filter(t => t.employee_id === emp.id);
    let totalAdvances = 0;
    let totalBonuses = 0;
    let totalDeductions = 0;

    transactions.forEach(t => {
      if (t.type === 'advance') totalAdvances += t.amount;
      if (t.type === 'bonus') totalBonuses += t.amount;
      if (t.type === 'deduction') totalDeductions += t.amount;
    });

    const netPayable = emp.base_salary - totalAdvances + totalBonuses - totalDeductions;
    return {
      ...emp,
      branch_id: Number(emp.branch_id || db.data.default_branch_id),
      branch_name: activeBranch.name,
      attendance_pin_hash: undefined,
      total_advances: totalAdvances,
      total_bonuses: totalBonuses,
      total_deductions: totalDeductions,
      net_payable: netPayable,
      transactions_count: transactions.length
    };
  });
  res.json(employees);
});

app.post('/api/employees', async (req, res) => {
  const { name, role, phone, salary_type, base_salary, hire_date, work_start, work_end, work_days, notes, commission_rate, attendance_pin, attendance_card_uid, current_user_id } = req.body;
  if (!requireCatalogManager(current_user_id, res)) return;
  if (!name || base_salary === undefined) {
    return res.status(400).json({ error: 'اسم الموظف والراتب الأساسي مطلوبان' });
  }
  const branchId = isUnrestrictedAccount(req.authUser) ? Number(req.body.branch_id ?? req.branchId) : Number(req.branchId);
  const employeeBranch = db.data.branches.find(branch => Number(branch.id) === branchId && branch.is_active !== false);
  if (!employeeBranch) return res.status(400).json({ error: 'اختر فرعاً نشطاً صالحاً.' });
  const commissionRate = Number(commission_rate || 0);
  if (!Number.isFinite(commissionRate) || commissionRate < 0 || commissionRate > 100) return res.status(400).json({ error: 'نسبة العمولة يجب أن تكون بين 0 و100%.' });
  if (attendance_pin && !/^\d{4,8}$/.test(String(attendance_pin))) return res.status(400).json({ error: 'رمز حضور PIN يجب أن يتكون من 4 إلى 8 أرقام.' });
  const cardUid = String(attendance_card_uid || '').trim().slice(0, 100);
  if (cardUid && (db.data.employees || []).some(employee => employee.attendance_card_uid === cardUid && employee.is_active !== false)) return res.status(409).json({ error: 'رقم البطاقة مسجل لموظف آخر.' });
  if (attendance_pin) for (const employee of (db.data.employees || [])) if (employee.attendance_pin_hash && await verifyPassword(String(attendance_pin), employee.attendance_pin_hash)) return res.status(409).json({ error: 'رمز PIN مسجل لموظف آخر.' });

  if (!db.data.employees) db.data.employees = [];
  const emp = {
    id: db.nextId('employees'), branch_id: branchId,
    name: name.trim(),
    role: role || 'موظف مبيعات',
    phone: phone || '',
    salary_type: salary_type || 'monthly',
    base_salary: parseFloat(base_salary) || 0,
    commission_rate: commissionRate,
    attendance_pin_hash: attendance_pin ? await passwordHashAsync(String(attendance_pin)) : '',
    attendance_card_uid: cardUid,
    hire_date: hire_date || nowStr().slice(0, 10),
    work_start: work_start || '09:00',
    work_end: work_end || '17:00',
    work_days: work_days || 'السبت - الخميس',
    notes: notes || '',
    is_active: true,
    created_at: nowStr()
  };

  db.data.employees.push(emp);
  db.save();
  db.logAudit(current_user_id, 'إضافة موظف', 'employees', emp.id, `إضافة الموظف: ${emp.name} (راتب: ${emp.base_salary})`);
  const { attendance_pin_hash: _pinHash, ...safeEmployee } = emp;
  safeEmployee.branch_name = employeeBranch.name;
  res.status(201).json(safeEmployee);
});

app.put('/api/employees/:id', async (req, res) => {
  const id = Number(req.params.id);
  const emp = (db.data.employees || []).find(e => e.id === id && (isUnrestrictedAccount(req.authUser) || Number(e.branch_id || db.data.default_branch_id) === Number(req.branchId)));
  if (!requireCatalogManager(req.body.current_user_id, res)) return;
  if (!emp) return res.status(404).json({ error: 'الموظف غير موجود' });
  const previousBranchId = Number(emp.branch_id || db.data.default_branch_id);
  const requestedBranchId = isUnrestrictedAccount(req.authUser) ? Number(req.body.branch_id ?? previousBranchId) : Number(req.branchId);
  const employeeBranch = db.data.branches.find(branch => Number(branch.id) === requestedBranchId && branch.is_active !== false);
  if (!employeeBranch) return res.status(400).json({ error: 'اختر فرعاً نشطاً صالحاً.' });
  emp.branch_id = requestedBranchId;
  ['name', 'role', 'phone', 'salary_type', 'hire_date', 'work_start', 'work_end', 'work_days', 'notes'].forEach(key => {
    if (req.body[key] !== undefined) emp[key] = req.body[key];
  });
  if (req.body.base_salary !== undefined) emp.base_salary = Number(req.body.base_salary) || 0;
  if (req.body.commission_rate !== undefined) {
    const commissionRate = Number(req.body.commission_rate);
    if (!Number.isFinite(commissionRate) || commissionRate < 0 || commissionRate > 100) return res.status(400).json({ error: 'نسبة العمولة يجب أن تكون بين 0 و100%.' });
    emp.commission_rate = commissionRate;
  }
  if (req.body.attendance_pin !== undefined && req.body.attendance_pin !== '') {
    const pin = String(req.body.attendance_pin);
    if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'رمز حضور PIN يجب أن يتكون من 4 إلى 8 أرقام.' });
    for (const other of db.data.employees) if (other.id !== id && other.attendance_pin_hash && await verifyPassword(pin, other.attendance_pin_hash)) return res.status(409).json({ error: 'رمز PIN مسجل لموظف آخر.' });
    emp.attendance_pin_hash = await passwordHashAsync(pin);
  }
  if (req.body.attendance_card_uid !== undefined) {
    const cardUid = String(req.body.attendance_card_uid || '').trim().slice(0, 100);
    if (cardUid && db.data.employees.some(other => other.id !== id && other.attendance_card_uid === cardUid && other.is_active !== false)) return res.status(409).json({ error: 'رقم البطاقة مسجل لموظف آخر.' });
    emp.attendance_card_uid = cardUid;
  }
  db.save();
  db.logAudit(req.body.current_user_id, 'تعديل موظف', 'employees', id, `تعديل بيانات الموظف: ${emp.name}`);
  if (previousBranchId !== requestedBranchId) {
    const previousBranch = db.data.branches.find(branch => Number(branch.id) === previousBranchId);
    db.logAudit(req.body.current_user_id, 'تغيير فرع موظف', 'employees', id, `نقل الموظف ${emp.name} من ${previousBranch?.name || previousBranchId} إلى ${employeeBranch.name}`);
  }
  const { attendance_pin_hash: _pinHash, ...safeEmployee } = emp;
  safeEmployee.branch_name = employeeBranch.name;
  res.json(safeEmployee);
});

app.delete('/api/employees/:id', (req, res) => {
  const id = Number(req.params.id);
  const emp = (db.data.employees || []).find(e => e.id === id && Number(e.branch_id || db.data.default_branch_id) === Number(req.branchId));
  if (!emp) return res.status(404).json({ error: 'الموظف غير موجود' });
  emp.is_active = false;
  db.save();
  db.logAudit(req.query.current_user_id, 'حذف موظف', 'employees', id, `تعطيل الموظف: ${emp.name}`);
  res.json({ message: 'تم حذف الموظف (تعطيل الحساب) بنجاح' });
});

app.get('/api/attendance', (req, res) => {
  let rows = (Array.isArray(db.data.attendance) ? db.data.attendance : []).filter(row => Number(row.branch_id || db.data.default_branch_id) === Number(req.branchId));
  if (req.query.employee_id) rows = rows.filter(r => r.employee_id === Number(req.query.employee_id));
  if (req.query.from) rows = rows.filter(r => String(r.work_date) >= req.query.from);
  if (req.query.to) rows = rows.filter(r => String(r.work_date) <= req.query.to);
  res.json(rows.slice().sort((a, b) => `${b.work_date} ${b.check_in || ''}`.localeCompare(`${a.work_date} ${a.check_in || ''}`)));
});

const resolveAttendanceEmployee = async (body, branchId) => {
  const inBranch = employee => employee && employee.is_active !== false && Number(employee.branch_id || db.data.default_branch_id) === Number(branchId);
  if (body.employee_id) return (db.data.employees || []).find(employee => employee.id === Number(body.employee_id) && inBranch(employee));
  const credential = String(body.credential || '').trim();
  if (!credential) return null;
  const byCard = (db.data.employees || []).find(employee => inBranch(employee) && employee.attendance_card_uid && employee.attendance_card_uid === credential);
  if (byCard) return byCard;
  if (!/^\d{4,8}$/.test(credential)) return null;
  for (const employee of (db.data.employees || [])) if (inBranch(employee) && employee.attendance_pin_hash && await verifyPassword(credential, employee.attendance_pin_hash)) return employee;
  return null;
};

app.post('/api/attendance/check-in', async (req, res) => {
  const resolvedEmployee = await resolveAttendanceEmployee(req.body, req.branchId);
  const employeeId = Number(resolvedEmployee?.id);
  const emp = resolvedEmployee;
  if (!emp) return res.status(404).json({ error: 'الموظف غير موجود' });
  const date = req.body.credential ? businessDateToday() : (req.body.work_date || businessDateToday());
  if (!Array.isArray(db.data.attendance)) db.data.attendance = [];
  let row = db.data.attendance.find(r => r.employee_id === employeeId && Number(r.branch_id || db.data.default_branch_id) === Number(req.branchId) && r.work_date === date);
  if (row && row.check_in) return res.status(400).json({ error: 'تم تسجيل الحضور لهذا اليوم بالفعل' });
  if (!row) { row = { id: db.nextId('attendance'), branch_id: req.branchId, employee_id: employeeId, work_date: date, check_in: req.body.credential ? businessTimeNow() : (req.body.check_in || businessTimeNow()), check_out: null, hours: 0, notes: req.body.notes || '' }; db.data.attendance.push(row); }
  else row.check_in = req.body.credential ? businessTimeNow() : (req.body.check_in || businessTimeNow());
  db.save();
  db.logAudit(req.body.current_user_id, 'تسجيل حضور', 'attendance', row.id, `حضور الموظف ${emp.name} بتاريخ ${date}`);
  res.status(201).json({ ...row, employee_name: emp.name });
});

app.post('/api/attendance/check-out', async (req, res) => {
  const resolvedEmployee = await resolveAttendanceEmployee(req.body, req.branchId);
  const employeeId = Number(resolvedEmployee?.id);
  if (!resolvedEmployee) return res.status(404).json({ error: 'الموظف غير موجود أو رمز PIN/البطاقة غير صحيح.' });
  const date = req.body.credential ? businessDateToday() : (req.body.work_date || businessDateToday());
  const row = (db.data.attendance || []).find(r => r.employee_id === employeeId && Number(r.branch_id || db.data.default_branch_id) === Number(req.branchId) && r.work_date === date);
  if (!row || !row.check_in) return res.status(400).json({ error: 'يجب تسجيل الحضور أولاً' });
  if (row.check_out) return res.status(400).json({ error: 'تم تسجيل الانصراف لهذا اليوم بالفعل' });
  row.check_out = req.body.credential ? businessTimeNow() : (req.body.check_out || businessTimeNow());
  const [ih, im] = row.check_in.split(':').map(Number);
  const [oh, om] = row.check_out.split(':').map(Number);
  let minutes = (oh * 60 + om) - (ih * 60 + im);
  if (minutes < 0) minutes += 24 * 60;
  row.hours = Number((minutes / 60).toFixed(2));
  db.save();
  db.logAudit(req.body.current_user_id, 'تسجيل انصراف', 'attendance', row.id, `انصراف الموظف بتاريخ ${date}`);
  res.json({ ...row, employee_name: resolvedEmployee.name });
});

app.put('/api/attendance/:id', (req, res) => {
  const row = (db.data.attendance || []).find(entry => entry.id === Number(req.params.id) && Number(entry.branch_id || db.data.default_branch_id) === Number(req.branchId));
  if (!row) return res.status(404).json({ error: 'سجل الحضور غير موجود.' });
  const checkIn = String(req.body.check_in ?? row.check_in ?? '');
  const checkOut = String(req.body.check_out ?? row.check_out ?? '');
  const validTime = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (!validTime(checkIn) || (checkOut && !validTime(checkOut))) return res.status(400).json({ error: 'أدخل وقت الحضور والانصراف بصيغة ساعة:دقيقة.' });
  row.check_in = checkIn;
  row.check_out = checkOut || null;
  row.notes = String(req.body.notes ?? row.notes ?? '').trim().slice(0, 300);
  if (row.check_out) {
    const [ih, im] = row.check_in.split(':').map(Number), [oh, om] = row.check_out.split(':').map(Number);
    let minutes = oh * 60 + om - (ih * 60 + im); if (minutes < 0) minutes += 1440;
    row.hours = Number((minutes / 60).toFixed(2));
  } else row.hours = 0;
  db.save();
  const employee = (db.data.employees || []).find(item => item.id === row.employee_id);
  db.logAudit(req.authUser.id, 'تعديل كشف الحضور', 'attendance', row.id, `تعديل سجل ${employee?.name || 'موظف'} بتاريخ ${row.work_date}`);
  res.json(row);
});

app.post('/api/employees/:id/transactions', (req, res) => {
  const employee_id = parseInt(req.params.id);
  const { type, amount, notes, current_user_id } = req.body;
  const emp = (db.data.employees || []).find(e => e.id === employee_id && Number(e.branch_id || db.data.default_branch_id) === Number(req.branchId));
  if (!emp) return res.status(404).json({ error: 'الموظف غير موجود' });

  if (!db.data.employee_transactions) db.data.employee_transactions = [];
  const cashOutflow = ['advance', 'bonus', 'settlement'].includes(String(type)) ? Number(amount) : 0;
  if (cashOutflow > 0 && (!Number.isFinite(cashOutflow) || cashOutflow <= 0)) return res.status(400).json({ error: 'قيمة الحركة النقدية غير صحيحة.' });
  const trans = {
    id: db.nextId('employee_transactions'), branch_id: req.branchId,
    employee_id,
    type, // 'advance', 'bonus', 'deduction', 'settlement'
    amount: parseFloat(amount) || 0,
    notes: notes || '',
    created_at: nowStr()
  };

  const typeLabels = {
    advance: 'سلفة نقدية',
    bonus: 'مكافأة / عمولة',
    deduction: 'خصم / جزاء',
    settlement: 'صرف راتب وتصفية'
  };

  const committed = db.transaction(['employee_transactions', 'cash_transactions', 'cash_audit_chain', 'audit_logs'], () => {
    const cashConfirmation = cashOutflow > 0 ? requireCashBalanceConfirmation(req, res, cashOutflow) : { negative: false };
    if (!cashConfirmation) return null;
    db.data.employee_transactions.push(trans);
    if (cashOutflow > 0) addFinanceTransaction('cash_transactions', { type: `employee_${type}`, amount: Number(cashOutflow.toFixed(2)), direction: 'out', reference_id: `EMP-${emp.id}-${trans.id}`, notes: `${typeLabels[type] || type} — ${emp.name}`, user_id: req.authUser.id, branch_id: req.branchId, ...cashConfirmationFields(cashConfirmation) });
    db.logAudit(current_user_id, `حسابات موظف (${typeLabels[type] || type})`, 'employees', emp.id, `تسجيل ${typeLabels[type] || type} بمبلغ ${trans.amount} ج.م للموظف ${emp.name}`, { save: false });
    return trans;
  });
  if (!committed) return;
  res.status(201).json(trans);
});

app.get('/api/employees/:id/transactions', (req, res) => {
  const employee_id = parseInt(req.params.id);
  if (!(db.data.employees || []).some(emp => emp.id === employee_id && Number(emp.branch_id || db.data.default_branch_id) === Number(req.branchId))) return res.status(404).json({ error: 'الموظف غير موجود في هذا الفرع.' });
  const trans = branchStockFilter(db.data.employee_transactions || [], req.branchId).filter(t => t.employee_id === employee_id);
  res.json(trans.reverse());
});

// ----------------------------------------------------
// POS & Sales
// ----------------------------------------------------
app.get('/api/sales', (req, res) => {
  // Return sales list with items and customer name
  const sales = branchStockFilter(db.data.sales, req.branchId).map(s => {
    const cust = db.data.customers.find(c => c.id === s.customer_id);
    const cashier = db.data.users.find(u => u.id === s.user_id);
    const items = db.data.sale_items.filter(item => item.sale_id === s.id).map(item => {
      const prod = db.data.products.find(p => p.id === item.product_id);
      return {
        ...item,
        product_name: prod ? prod.name : 'منتج غير معروف',
        product_barcode: prod ? prod.barcode : ''
      };
    });
    return {
      ...s,
      customer_name: cust ? cust.name : 'عميل نقدي',
      cashier_name: cashier ? cashier.name : 'كاشير',
      returns: db.data.sale_returns.filter(row => Number(row.sale_id) === Number(s.id)),
      payments: db.data.sale_payments.filter(row => Number(row.sale_id) === Number(s.id)),
      items
    };
  });
  const from = req.query.from || '';
  const to = req.query.to || '';
  const search = String(req.query.search || '').trim().toLowerCase();
  const filtered = sales.filter(s => {
    const day = String(s.created_at || '').slice(0, 10);
    const haystack = `${s.invoice_number} ${s.customer_name} ${s.total}`.toLowerCase();
    return (!from || day >= from) && (!to || day <= to) && (!search || haystack.includes(search));
  });
  const ordered = filtered.reverse();
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const requestedOffset = Number.parseInt(req.query.offset, 10);
  if (Number.isInteger(requestedLimit) && requestedLimit > 0) {
    const limit = Math.min(requestedLimit, 200);
    const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
    res.set('X-Pagination-Total', String(ordered.length));
    res.set('X-Pagination-Offset', String(offset));
    res.set('X-Pagination-Limit', String(limit));
    res.set('X-Pagination-Has-More', String(offset + limit < ordered.length));
    return res.json(ordered.slice(offset, offset + limit));
  }
  res.json(ordered);
});
app.get('/api/sales/:id', (req, res) => {
  const sale = db.data.sales.find(row => Number(row.id) === Number(req.params.id));
  if (!sale || Number(sale.branch_id || db.data.default_branch_id) !== Number(req.branchId)) {
    return res.status(404).json({ error: 'فاتورة البيع غير موجودة في هذا الفرع.' });
  }
  const customer = db.data.customers.find(row => Number(row.id) === Number(sale.customer_id));
  const cashier = db.data.users.find(row => Number(row.id) === Number(sale.user_id));
  const items = db.data.sale_items.filter(row => Number(row.sale_id) === Number(sale.id)).map(item => {
    const product = db.data.products.find(row => Number(row.id) === Number(item.product_id));
    return { ...item, product_name: product ? product.name : 'منتج غير معروف', product_barcode: product?.barcode || '' };
  });
  const pendingWalletPayment = db.storageAdapter.connection.prepare('SELECT p.*,w.name AS wallet_name,w.wallet_number FROM pending_wallet_payments p JOIN wallets w ON w.id=p.wallet_id WHERE p.sale_id=?').get(sale.id) || null;
  res.json({
    ...sale,
    customer_name: customer?.name || 'عميل نقدي',
    cashier_name: cashier?.name || 'كاشير',
    returns: db.data.sale_returns.filter(row => Number(row.sale_id) === Number(sale.id)),
    payments: db.data.sale_payments.filter(row => Number(row.sale_id) === Number(sale.id)),
    pending_wallet_payment: pendingWalletPayment,
    items
  });
});
app.post('/api/sales/:id/share-token', (req, res) => {
  const sale = db.data.sales.find(row => row.id === Number(req.params.id));
  if (!sale || Number(sale.branch_id || db.data.default_branch_id) !== Number(req.branchId)) return res.status(404).json({ error: 'الفاتورة غير موجودة في هذا الفرع.' });
  if (!sale.public_share_token) sale.public_share_token = crypto.randomBytes(24).toString('base64url');
  db.save();
  res.json({ token: sale.public_share_token, url: `${req.protocol}://${req.get('host')}/share/invoice/${sale.public_share_token}` });
});

// Parked checkout tickets: preserve a cart without changing stock or cash.
app.get('/api/suspended-sales', (req, res) => {
  const userId = req.authUser.id;
  res.json(db.data.suspended_sales.filter(ticket => ticket.user_id === userId).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))));
});

app.post('/api/suspended-sales', (req, res) => {
  const userId = req.authUser.id;
  const items = req.body.items;
  if (!Number.isInteger(userId) || !db.data.users.some(user => user.id === userId)) return res.status(400).json({ error: 'حساب المستخدم غير صحيح' });
  if (!Array.isArray(items) || !items.length || items.length > 500) return res.status(400).json({ error: 'الفاتورة المعلقة يجب أن تحتوي على أصناف' });
  if (req.body.price_level !== undefined && !['retail', 'wholesale', 'special'].includes(req.body.price_level)) return res.status(400).json({ error: 'مستوى السعر غير صالح.' });
  for (const item of items) {
    if (!Number.isInteger(Number(item.product_id)) || !db.data.products.some(product => product.id === Number(item.product_id)) || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) <= 0 || !Number.isFinite(Number(item.unit_price)) || Number(item.unit_price) < 0) {
      return res.status(400).json({ error: 'بيانات أحد أصناف الفاتورة غير صحيحة' });
    }
  }
  const now = nowStr();
  const id = db.nextId('suspended_sales');
  const ticket = {
    id, user_id: userId,
    label: String(req.body.label || '').trim().slice(0, 80) || `فاتورة معلقة ${id}`,
    customer_id: Number(req.body.customer_id) || 1,
    discount: Math.max(0, Number(req.body.discount) || 0),
    paid_amount: Math.max(0, Number(req.body.paid_amount) || 0),
    payment_method: String(req.body.payment_method || 'نقدي').slice(0, 30),
    price_level: req.body.price_level || 'retail',
    order_type: String(req.body.order_type || 'داخل المحل').slice(0, 40),
    order_channel: String(req.body.order_channel || 'مباشر').slice(0, 40),
    salesperson_id: req.body.salesperson_id ? Number(req.body.salesperson_id) : null,
    items: items.map(item => ({ product_id: Number(item.product_id), category_id: Number(item.category_id) || null, quantity: Number(item.quantity), unit_price: Number(item.unit_price), cost_price: Number(item.cost_price) || 0, discount: Math.max(0, Number(item.discount) || 0) })),
    created_at: now, updated_at: now
  };
  db.data.suspended_sales.push(ticket);
  db.save();
  res.status(201).json(ticket);
});

app.post('/api/suspended-sales/:id/consume', (req, res) => {
  const index = db.data.suspended_sales.findIndex(ticket => ticket.id === Number(req.params.id) && ticket.user_id === req.authUser.id);
  if (index < 0) return res.status(404).json({ error: 'الفاتورة المعلقة غير موجودة' });
  const [ticket] = db.data.suspended_sales.splice(index, 1);
  db.save();
  res.json(ticket);
});

app.post('/api/suspended-sales/:id/discard', (req, res) => {
  const index = db.data.suspended_sales.findIndex(ticket => ticket.id === Number(req.params.id) && ticket.user_id === req.authUser.id);
  if (index < 0) return res.status(404).json({ error: 'الفاتورة المعلقة غير موجودة' });
  db.data.suspended_sales.splice(index, 1);
  db.save();
  res.json({ message: 'تم حذف الفاتورة المعلقة' });
});

app.delete('/api/suspended-sales/:id', (req, res) => {
  const userId = req.authUser.id;
  const id = Number(req.params.id);
  const index = db.data.suspended_sales.findIndex(ticket => ticket.id === id && ticket.user_id === userId);
  if (index < 0) return res.status(404).json({ error: 'الفاتورة المعلقة غير موجودة' });
  db.data.suspended_sales.splice(index, 1);
  db.save();
  res.json({ message: 'تم حذف الفاتورة المعلقة' });
});

app.post('/api/sales', (req, res) => {
  const saleProfileStart = performance.now();
  const saleProfile = phase => { if (process.env.RAWDA_PROFILE === '1') console.error(`[PROFILE] sale ${phase}: ${(performance.now() - saleProfileStart).toFixed(2)}ms`); };
  const clientTransactionId = String(req.body?.client_transaction_id || '').trim().slice(0, 100);
  if (clientTransactionId) {
    const existingSale = db.data.sales.find(row => row.client_transaction_id === clientTransactionId && Number(row.branch_id || db.data.default_branch_id) === Number(req.branchId));
    if (existingSale) {
      if (Number(existingSale.user_id) !== Number(req.authUser.id)) return res.status(409).json({ error: 'معرّف العملية مرتبط بمستخدم آخر.' });
      const existingItems = db.data.sale_items.filter(item => item.sale_id === existingSale.id).map(item => ({ ...item, product_name: db.data.products.find(product => product.id === item.product_id)?.name || 'منتج غير معروف' }));
      const existingPayments = db.data.sale_payments.filter(payment => payment.sale_id === existingSale.id);
      return res.json({ ...existingSale, items: existingItems, payments: existingPayments, already_processed: true });
    }
  }
  const {
    customer_id,
    user_id,
    items,
    discount,
    paid_amount,
    payment_method,
    order_type,
    order_channel,
    delivery_rider_id,
    delivery_address,
    delivery_fee_customer,
    delivery_fee_rider,
    salesperson_id,
    price_level,
    due_term_days,
    payments,
    wallet_payment_mode
  } = req.body;
  if (Array.isArray(payments) && payments.length > 0 && !clientTransactionId) return res.status(400).json({ error: 'الدفع المختلط يحتاج client_transaction_id لمنع تكرار الفاتورة عند إعادة الإرسال.' });
  const selfOrderId = req.body?.self_order_id ? Number(req.body.self_order_id) : null;
  const selfOrderToComplete = selfOrderId ? (db.data.self_order_requests || []).find(row => Number(row.id) === selfOrderId && row.status === 'accepted' && Number(row.branch_id) === Number(req.branchId) && Number(row.accepted_by) === Number(req.authUser.id)) : null;
  if (selfOrderId && !selfOrderToComplete) return res.status(409).json({ error: 'الطلب الذاتي لم يعد مقبولاً لهذا المستخدم أو الفرع.' });

  if (!items || !items.length) {
    return res.status(400).json({ error: 'الفاتورة يجب أن تحتوي على صنف واحد على الأقل' });
  }
  if (price_level !== undefined && !['retail', 'wholesale', 'special'].includes(price_level)) return res.status(400).json({ error: 'مستوى السعر غير صالح.' });

  for (const item of items) {
    const validationProduct = db.data.products.find(product => Number(product.id) === Number(item.product_id));
    const quantityText = String(item.quantity ?? '').trim();
    const quantityIsValid = validationProduct?.is_weighted === true || Number(validationProduct?.is_weighted) === 1
      ? /^\d+(?:\.\d{1,3})?$/.test(quantityText) && Number(quantityText) > 0
      : Number.isInteger(Number(item.quantity)) && Number(item.quantity) > 0;
    if (!Number.isInteger(Number(item.product_id)) || !quantityIsValid) {
      return res.status(400).json({ error: 'بيانات الصنف أو الكمية غير صحيحة' });
    }
    if (!Number.isFinite(Number(item.unit_price)) || Number(item.unit_price) < 0 || !Number.isFinite(Number(item.discount || 0)) || Number(item.discount || 0) < 0) {
      return res.status(400).json({ error: 'السعر أو الخصم غير صحيح' });
    }
  }
  if (selfOrderToComplete) {
    const expected = new Map((selfOrderToComplete.items || []).map(item => [Number(item.product_id), Number(item.quantity)]));
    const actual = new Map();
    for (const item of items) actual.set(Number(item.product_id), (actual.get(Number(item.product_id)) || 0) + Number(item.quantity));
    if (expected.size !== actual.size || [...expected].some(([id, quantity]) => actual.get(id) !== quantity)) return res.status(409).json({ error: 'أصناف الطلب الذاتي تغيرت. راجع الطلب قبل إتمام البيع.' });
  }
  saleProfile('input-validation-and-line-checks');

  // Calculate totals and validate stock
  let subtotal = 0;
  const lineDiscounts = [];
  for (const item of items) {
    const prod = db.data.products.find(p => p.id === item.product_id);
    if (!prod) {
      return res.status(400).json({ error: `المنتج رقم ${item.product_id} غير موجود` });
    }
    if (prod.is_active === false) return res.status(400).json({ error: `الصنف [${prod.name}] موقوف ولا يمكن بيعه.` });
    if (price_level) {
      const tierPrice = price_level === 'wholesale' ? prod.wholesale_price : price_level === 'special' ? prod.special_price : prod.sale_price;
      const expectedPrice = tierPrice === null || tierPrice === undefined || tierPrice === '' ? Number(prod.sale_price) : Number(tierPrice);
      if (Math.abs(Number(item.unit_price) - expectedPrice) > 0.009) return res.status(400).json({ error: `سعر الصنف [${prod.name}] لا يطابق مستوى ${price_level}. حدّث سلة البيع.` });
    }
    const isServiceProduct = prod.is_service === true || String(prod.unit || '').trim() === 'خدمة';
    const availableQuantity = isServiceProduct ? Number.MAX_SAFE_INTEGER : branchQuantity(req.branchId, prod.id);
    const sellableQuantity = isServiceProduct ? Number.MAX_SAFE_INTEGER : sellableTrackedQuantity(prod.id, req.branchId);
    if (!isServiceProduct && (availableQuantity < item.quantity || sellableQuantity < item.quantity)) {
      return res.status(400).json({
        error: `الكمية القابلة للبيع من [${prod.name}] هي (${Math.min(availableQuantity, sellableQuantity)}) فقط؛ راجع التشغيلات والصلاحية.`
      });
    }
    const rawTotal = Number(item.unit_price) * Number(item.quantity);
    const manualDiscount = Number(item.discount || 0);
    if (!Number.isFinite(manualDiscount) || manualDiscount < 0 || manualDiscount > rawTotal) return res.status(400).json({ error: 'خصم الصنف أكبر من قيمة الصنف أو غير صالح.' });
    const { promotion, discount: promotionDiscount } = promotionForLine(prod, Number(item.quantity), Number(item.unit_price));
    const effectiveDiscount = Number(Math.min(rawTotal, manualDiscount + promotionDiscount).toFixed(2));
    subtotal += rawTotal - effectiveDiscount;
    lineDiscounts.push({ manual_discount: manualDiscount, promotion_discount: Number(Math.min(promotionDiscount, rawTotal - manualDiscount).toFixed(2)), promotion_id: promotion?.id || null, effective_discount: effectiveDiscount });
  }

  const invoiceDiscount = parseFloat(discount) || 0;
  if (invoiceDiscount < 0 || invoiceDiscount > subtotal) return res.status(400).json({ error: 'قيمة خصم الفاتورة غير صحيحة.' });
  const taxableAmount = Number(Math.max(0, subtotal - invoiceDiscount).toFixed(2));
  const taxSettings = db.data.tax_settings || { enabled: false, rate: 0, registration_number: '' };
  const taxRate = taxSettings.enabled ? Number(taxSettings.rate) || 0 : 0;
  const taxAmount = Number((taxableAmount * taxRate / 100).toFixed(2));
  const requestedCustomerDeliveryFee = Number(delivery_fee_customer || 0);
  const requestedRiderDeliveryFee = Number(delivery_fee_rider || 0);
  if (!Number.isFinite(requestedCustomerDeliveryFee) || requestedCustomerDeliveryFee < 0 || !Number.isFinite(requestedRiderDeliveryFee) || requestedRiderDeliveryFee < 0) return res.status(400).json({ error: 'رسوم التوصيل غير صحيحة.' });
  const customerDeliveryFee = order_type === 'توصيل' ? Number(requestedCustomerDeliveryFee.toFixed(2)) : 0;
  const riderDeliveryFee = order_type === 'توصيل' ? Number(requestedRiderDeliveryFee.toFixed(2)) : 0;
  const total = Number((taxableAmount + taxAmount + customerDeliveryFee).toFixed(2));
  let paymentSplit = null;
  if (Array.isArray(payments)) {
    try { paymentSplit = normalizePaymentSplits(payments, total); }
    catch (error) { return res.status(400).json({ error: error.message }); }
  }
  const walletPaymentMethod = ['محفظة إلكترونية', 'محفظة', 'wallet', 'e-wallet', 'e_wallet'].includes(String(payment_method || '').trim());
  const awaitingWalletPayment = walletPaymentMethod && String(wallet_payment_mode || '').trim() === 'await_sms';
  const directWalletId = Number(req.body?.wallet_id || req.body?.wallet?.id);
  if (walletPaymentMethod && (!Number.isInteger(directWalletId) || directWalletId < 1)) return res.status(400).json({ error: 'اختر محفظة إلكترونية لإتمام البيع.' });
  const walletSnapshot = walletId => {
    const wallet = assertWalletScope(walletRow(db.storageAdapter.connection, walletId), { branchId: req.branchId, unrestricted: false, requireActive: true });
    return { wallet_id: wallet.id, name: wallet.name, wallet_number: wallet.wallet_number, wallet_type: wallet.wallet_type, fee: 0 };
  };
  let salePaymentRows = [];
  try {
    salePaymentRows = paymentSplit?.rows?.map(payment => payment.method === 'محفظة إلكترونية'
      ? { ...payment, method_details: walletSnapshot(Number(payment.method_details?.wallet_id)) }
      : payment)
      || (walletPaymentMethod && !awaitingWalletPayment ? [{ method: 'محفظة إلكترونية', amount: total, method_details: walletSnapshot(directWalletId) }] : []);
  } catch (error) {
    return res.status(Number(error.statusCode) || 400).json({ error: error.message || 'المحفظة غير متاحة.' });
  }
  const paid = paymentSplit
    ? Number((paymentSplit.cashPaid + paymentSplit.cardPaid + paymentSplit.walletPaid).toFixed(2))
    : awaitingWalletPayment
      ? 0
    : walletPaymentMethod
      ? total
    : paid_amount === undefined || paid_amount === null || paid_amount === ''
      ? total
      : Number(paid_amount);
  if (!Number.isFinite(paid) || paid < 0) {
    return res.status(400).json({ error: 'المبلغ المدفوع غير صحيح' });
  }
  const change = Math.max(0, paid - total);
  const remainingAmount = Number(Math.max(0, total - paid).toFixed(2));
  const isCreditSale = !awaitingWalletPayment && remainingAmount > 0.009;
  const paymentTermDays = Number(due_term_days);
  let dueDate = null;
  if (isCreditSale) {
    if (!Number.isInteger(Number(customer_id)) || Number(customer_id) <= 1) return res.status(400).json({ error: 'اختر عميلاً لإتمام البيع الآجل.' });
    if (!Number.isInteger(paymentTermDays) || paymentTermDays < 1 || paymentTermDays > 3650) return res.status(400).json({ error: 'اختر فترة سداد صحيحة قبل إتمام البيع الآجل.' });
    if (!db.data.customers.some(customer => Number(customer.id) === Number(customer_id))) return res.status(400).json({ error: 'العميل المحدد غير موجود.' });
    const saleDate = businessDateToday();
    const [year, month, day] = saleDate.split('-').map(Number);
    const due = new Date(Date.UTC(year, month - 1, day + paymentTermDays));
    dueDate = due.toISOString().slice(0, 10);
  }
  if (isCreditSale && Number(customer_id) > 1) {
    const creditCustomer = db.data.customers.find(customer => Number(customer.id) === Number(customer_id));
    if (!creditCustomer) return res.status(400).json({ error: 'العميل المحدد غير موجود.' });
    const currentBranchBalance = customerBranchBalance(creditCustomer.id, req.branchId);
    const projectedBalance = currentBranchBalance + (total - paid);
    if (creditCustomer.credit_limit !== null && creditCustomer.credit_limit !== undefined && projectedBalance > Number(creditCustomer.credit_limit) + 0.009) {
      return res.status(400).json({ error: `سيؤدي البيع إلى تجاوز الحد الائتماني للعميل. المديونية الحالية ${currentBranchBalance.toFixed(2)} ج.م، والحد ${Number(creditCustomer.credit_limit).toFixed(2)} ج.م.` });
    }
  }

  // Generate sequential invoice number
  const dateCode = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const allowedOrderTypes = ['داخل المحل', 'استلام من الفرع', 'توصيل'];
  const allowedOrderChannels = ['مباشر', 'هاتف', 'واتساب', 'تطبيق توصيل'];
  if ((order_type && !allowedOrderTypes.includes(order_type)) || (order_channel && !allowedOrderChannels.includes(order_channel))) return res.status(400).json({ error: 'نوع الطلب أو قناة الطلب غير صالحة.' });
  const salesperson = salesperson_id ? db.data.employees.find(employee => employee.id === Number(salesperson_id) && employee.is_active !== false) : null;
  if (salesperson_id && !salesperson) return res.status(400).json({ error: 'موظف البيع المحدد غير موجود أو غير نشط.' });
  saleProfile('totals-and-customer-validation');
  const commissionRate = salesperson ? Number(salesperson.commission_rate) || 0 : 0;
  const commissionAmount = Number((taxableAmount * commissionRate / 100).toFixed(2));
  const deliveryRiderId = delivery_rider_id ? Number(delivery_rider_id) : null;
  const deliveryRider = deliveryRiderId ? (db.data.delivery_riders || []).find(row => Number(row.id) === deliveryRiderId && Number(row.branch_id || db.data.default_branch_id) === Number(req.branchId) && row.is_active !== false) : null;
  if (deliveryRiderId && !deliveryRider) return res.status(400).json({ error: 'الطيار المحدد غير موجود أو غير نشط.' });
  const saleId = db.nextId('sales');
  const invoiceNumber = `INV-${dateCode}-${String(saleId).padStart(4, '0')}`;

  const sale = {
    id: saleId, branch_id: req.branchId,
    ...(selfOrderToComplete ? { self_order_id: selfOrderToComplete.id } : {}),
    ...(clientTransactionId ? { client_transaction_id: clientTransactionId } : {}),
    public_share_token: crypto.randomBytes(24).toString('base64url'),
    invoice_number: invoiceNumber,
    customer_id: customer_id ? parseInt(customer_id) : 1,
    user_id: user_id ? parseInt(user_id) : 1,
    subtotal: parseFloat(subtotal.toFixed(2)),
    discount: parseFloat(invoiceDiscount.toFixed(2)),
    taxable_amount: taxableAmount,
    tax_rate: taxRate,
    tax_amount: taxAmount,
    tax_registration_number: taxAmount > 0 ? String(taxSettings.registration_number || '') : '',
    total: parseFloat(total.toFixed(2)),
    paid_amount: parseFloat(paid.toFixed(2)),
    change_amount: parseFloat(change.toFixed(2)),
    remaining_amount: remainingAmount,
    payment_term_days: isCreditSale ? paymentTermDays : null,
    due_date: dueDate,
    payment_method: paymentSplit ? 'مختلط' : walletPaymentMethod ? 'محفظة إلكترونية' : payment_method || 'نقدي',
    payment_status: awaitingWalletPayment ? 'awaiting_wallet_payment' : paid >= total - 0.009 ? 'paid' : 'open',
    wallet_payment_status: awaitingWalletPayment ? 'waiting' : null,
    wallet_id: walletPaymentMethod ? directWalletId : null,
    order_type: order_type || 'داخل المحل',
    order_channel: order_channel || 'مباشر',
    delivery_rider_id: order_type === 'توصيل' ? deliveryRider?.id || null : null,
    delivery_address: order_type === 'توصيل' ? String(delivery_address || '').trim().slice(0, 250) : '',
    delivery_fee_customer: customerDeliveryFee,
    delivery_fee_rider: riderDeliveryFee,
    price_level: price_level || 'retail',
    salesperson_id: salesperson?.id || null,
    salesperson_name: salesperson?.name || '',
    commission_rate: commissionRate,
    commission_amount: commissionAmount,
    commission_reversed: 0,
    shift_id: openCashierShift(req.authUser.id)?.id || null,
    created_at: nowStr()
  };
  saleProfile('sale-record-built');

  const loyaltySettings = db.data.loyalty_settings || { enabled: false, spend_per_point: 10 };
  const eligibleCustomerId = Number(customer_id || 1);
  const pointsEarned = loyaltySettings.enabled && eligibleCustomerId > 1
    ? Math.floor(taxableAmount / Math.max(1, Number(loyaltySettings.spend_per_point) || 10))
    : 0;
  if (pointsEarned > 0) sale.loyalty_points_earned = pointsEarned;

  const rollbackTables = ['sales', 'sale_items', 'sale_payments', 'stock_movements', 'employee_transactions', 'loyalty_transactions', 'cash_transactions', 'cash_audit_chain', 'customer_transactions', 'delivery_assignments'];
  const rollbackLengths = Object.fromEntries(rollbackTables.map(table => [table, db.data[table].length]));
  const originalBranchInventoryLength = db.data.branch_inventory.length;
  const productIds = new Set(items.map(item => Number(item.product_id)));
  const originalInventory = db.data.branch_inventory.filter(row => Number(row.branch_id) === Number(req.branchId) && productIds.has(Number(row.product_id))).map(row => ({ row, quantity: row.quantity }));
  const originalLots = db.data.purchase_items.filter(row => Number(row.branch_id || db.data.default_branch_id || 1) === Number(req.branchId) && productIds.has(Number(row.product_id)) && Object.prototype.hasOwnProperty.call(row, 'remaining_quantity')).map(row => ({ row, remaining_quantity: row.remaining_quantity }));
  const customerForBalance = paid < total && customer_id && customer_id > 1 ? db.data.customers.find(row => Number(row.id) === Number(customer_id)) : null;
  const originalCustomerBalance = customerForBalance ? { exists: Object.prototype.hasOwnProperty.call(customerForBalance, 'balance'), value: customerForBalance.balance } : null;
  saleProfile('rollback-snapshot');
  const createdItems = [];
  let pendingWalletResult = null;
  let saleAudit = null;
  const rowHints = { rowHints: true, collections: {} };
  const hintRow = (name, row, ordinal) => {
    const collection = rowHints.collections[name] ||= { rows: [] };
    const index = Number.isInteger(ordinal) ? ordinal : db.data[name].indexOf(row);
    collection.rows.push({ row, ordinal: index });
  };

  try {
    db.data.sales.push(sale);
    hintRow('sales', sale, db.data.sales.length - 1);
    if (salePaymentRows.length) {
      for (const payment of salePaymentRows) {
        const paymentRow = {
          id: db.nextId('sale_payments'),
          sale_id: sale.id,
          branch_id: req.branchId,
          method: payment.method,
          amount: payment.amount,
          method_details: payment.method_details || null,
          created_at: nowStr()
        };
        db.data.sale_payments.push(paymentRow);
        hintRow('sale_payments', paymentRow, db.data.sale_payments.length - 1);
      }
    }
    saleProfile('sale-and-related-records-pushed');
    if (sale.order_type === 'توصيل') {
      const assignment = {
        id: db.nextId('delivery_assignments'), branch_id: req.branchId, sale_id: sale.id,
        rider_id: sale.delivery_rider_id || null,
        status: sale.delivery_rider_id ? 'assigned' : 'unassigned',
        assigned_at: sale.delivery_rider_id ? nowStr() : null,
        assignment_history: sale.delivery_rider_id ? [{ from_rider_id: null, to_rider_id: sale.delivery_rider_id, changed_by: req.authUser.id, changed_at: nowStr() }] : [],
        delivery_address: sale.delivery_address || '', delivery_fee_customer: Number(sale.delivery_fee_customer || 0), delivery_fee_rider: Number(sale.delivery_fee_rider || 0), rider_fee_status: 'unpaid', tracking_token: crypto.randomBytes(24).toString('base64url'), rider_token: crypto.randomBytes(24).toString('base64url'), cash_collected: 0, cash_settled: 0, notes: '', created_at: nowStr(), updated_at: nowStr()
      };
      db.data.delivery_assignments.push(assignment);
      hintRow('delivery_assignments', assignment, db.data.delivery_assignments.length - 1);
    }
    if (salesperson && commissionAmount > 0) {
      const transaction = { id: db.nextId('employee_transactions'), employee_id: salesperson.id, type: 'bonus', amount: commissionAmount, notes: `عمولة بيع ${sale.invoice_number} (${commissionRate}%)`, reference_id: sale.invoice_number, created_at: nowStr(), user_id: req.authUser.id };
      db.data.employee_transactions.push(transaction);
      hintRow('employee_transactions', transaction, db.data.employee_transactions.length - 1);
    }
    if (pointsEarned > 0) {
      const transaction = {
        id: db.nextId('loyalty_transactions'), customer_id: eligibleCustomerId,
        sale_id: sale.id, reference_id: sale.invoice_number, type: 'earn', points: pointsEarned,
        notes: 'نقاط مكتسبة من فاتورة بيع', created_at: nowStr(), user_id: req.authUser.id
      };
      db.data.loyalty_transactions.push(transaction);
      hintRow('loyalty_transactions', transaction, db.data.loyalty_transactions.length - 1);
    }

    // Process items, deduct stock, record stock movement and profit tracking
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const item = items[itemIndex];
      const prod = db.data.products.find(p => p.id === item.product_id);
      const isServiceProduct = prod.is_service === true || String(prod.unit || '').trim() === 'خدمة';
      if (!isServiceProduct) setBranchQuantity(req.branchId, prod.id, branchQuantity(req.branchId, prod.id) - item.quantity);
      const inventory = getBranchInventoryRow(req.branchId, prod.id);
      hintRow('branch_inventory', inventory);
      const changedLots = [];
      const lotAllocations = isServiceProduct ? [] : allocateTrackedLots(prod.id, item.quantity, req.branchId, changedLots);
      for (const lot of changedLots) hintRow('purchase_items', lot);

      const saleItem = {
        id: db.nextId('sale_items'),
        sale_id: sale.id, branch_id: req.branchId,
        product_id: prod.id,
        quantity: item.quantity,
        unit_price: parseFloat(item.unit_price),
        cost_price: parseFloat(prod.cost_price), // Record cost at time of sale
        discount: lineDiscounts[itemIndex].effective_discount,
        manual_discount: Number(lineDiscounts[itemIndex].manual_discount.toFixed(2)),
        promotion_discount: lineDiscounts[itemIndex].promotion_discount,
        promotion_id: lineDiscounts[itemIndex].promotion_id,
        total: parseFloat(((item.unit_price * item.quantity) - lineDiscounts[itemIndex].effective_discount).toFixed(2)),
        lot_allocations: lotAllocations
      };
      db.data.sale_items.push(saleItem);
      hintRow('sale_items', saleItem, db.data.sale_items.length - 1);
      createdItems.push({ ...saleItem, product_name: prod.name });

      // Stock movement
      const movement = {
        id: db.nextId('stock_movements'),
        branch_id: req.branchId, product_id: prod.id,
        type: 'sale',
        quantity: -item.quantity,
        reference_id: sale.invoice_number,
        created_at: nowStr()
      };
      db.data.stock_movements.push(movement);
      hintRow('stock_movements', movement, db.data.stock_movements.length - 1);
    }
    saleProfile('items-and-stock-updated');

    // Update customer balance if debt exists
    if (!awaitingWalletPayment && paid < total && customer_id && customer_id > 1 && customerForBalance) {
      customerForBalance.balance = Number(customerForBalance.balance || 0) + (total - paid);
      hintRow('customers', customerForBalance);
    }

    const cashAmount = paymentSplit ? paymentSplit.cashPaid : walletPaymentMethod ? 0 : paid;
    const cashTransaction = cashAmount > 0
      ? addFinanceTransaction('cash_transactions', { type: 'sale', amount: cashAmount, direction: 'in', reference_id: sale.invoice_number, notes: sale.payment_method, user_id: req.authUser.id })
      : null;
    if (cashTransaction) {
      hintRow('cash_transactions', cashTransaction, db.data.cash_transactions.length - 1);
      hintRow('cash_audit_chain', db.data.cash_audit_chain.at(-1), db.data.cash_audit_chain.length - 1);
    }
    if (sale.customer_id > 1) {
      const transaction = addFinanceTransaction('customer_transactions', {
        customer_id: sale.customer_id,
        type: 'sale',
        debit: sale.total,
        credit: sale.paid_amount,
        reference_id: sale.invoice_number,
        notes: `فاتورة بيع ${sale.invoice_number}${sale.due_date ? `؛ موعد الاستحقاق ${sale.due_date}` : ''}`
      });
      hintRow('customer_transactions', transaction, db.data.customer_transactions.length - 1);
    }

    saleAudit = db.logAudit(user_id, 'إتمام بيع', 'sales', sale.id, `فاتورة بيع رقم ${sale.invoice_number} بقيمة ${sale.total} ج.م`, { save: false });
    hintRow('audit_logs', saleAudit, -db.data.audit_logs.length);
    if (selfOrderToComplete) {
      selfOrderToComplete.status = 'completed';
      selfOrderToComplete.completed_sale_id = sale.id;
      selfOrderToComplete.completed_at = nowStr();
      selfOrderToComplete.updated_at = selfOrderToComplete.completed_at;
      hintRow('self_order_requests', selfOrderToComplete);
    }
    saleProfile('audit-created');
    saleProfile('before-db-save-call');
    db.save(rowHints, null, connection => {
      if (awaitingWalletPayment) {
        pendingWalletResult = createPending(connection, {
          sale_id: sale.id,
          wallet_id: directWalletId,
          expected_amount: sale.total,
          notes: 'بانتظار تحويل SMS.'
        });
        return pendingWalletResult;
      }
      return postSaleToAccounting({ ...sale, items: createdItems }, salePaymentRows, connection);
    });
    saleProfile('committed');
  } catch (error) {
    for (const table of rollbackTables) db.data[table].length = rollbackLengths[table];
    db.data.branch_inventory.length = originalBranchInventoryLength;
    for (const entry of originalInventory) entry.row.quantity = entry.quantity;
    for (const entry of originalLots) entry.row.remaining_quantity = entry.remaining_quantity;
    if (customerForBalance && originalCustomerBalance) {
      if (originalCustomerBalance.exists) customerForBalance.balance = originalCustomerBalance.value;
      else delete customerForBalance.balance;
    }
    if (saleAudit) {
      const auditIndex = db.data.audit_logs.indexOf(saleAudit);
      if (auditIndex >= 0) db.data.audit_logs.splice(auditIndex, 1);
    }
    if (selfOrderToComplete) { selfOrderToComplete.status = 'accepted'; delete selfOrderToComplete.completed_sale_id; delete selfOrderToComplete.completed_at; }
    console.error('Sale commit failed; in-memory changes were rolled back:', error.message);
    return res.status(Number(error.statusCode) || 500).json({ error: error.message || 'تعذر حفظ عملية البيع. لم تُسجّل الفاتورة.', code: error.code || 'SALE_COMMIT_FAILED' });
  }

  res.status(201).json({
    ...sale,
    items: createdItems,
    payments: salePaymentRows,
    pending_wallet_payment: pendingWalletResult?.pending || null
  });
  saleProfile('response-created');
});

app.put('/api/sales/:id', (req, res) => {
  const sale = db.data.sales.find(s => s.id === Number(req.params.id));
  if (!sale || Number(sale.branch_id || db.data.default_branch_id) !== Number(req.branchId)) return res.status(404).json({ error: 'فاتورة البيع غير موجودة في هذا الفرع.' });
  if (Number(sale.returned_amount || 0) > 0) return res.status(400).json({ error: 'لا يمكن تعديل فاتورة بعد تسجيل مرتجع عليها.' });
  const items = Array.isArray(req.body.items) ? req.body.items : db.data.sale_items.filter(i => i.sale_id === sale.id);
  const oldTotal = sale.total;
  let subtotal = 0;
  for (const item of items) {
    const line = db.data.sale_items.find(i => i.id === item.id && i.sale_id === sale.id);
    if (!line) return res.status(400).json({ error: 'أحد أصناف الفاتورة غير موجود' });
    const price = Number(item.unit_price);
    const lineDiscount = Number(item.discount || 0);
    if (!Number.isFinite(price) || price < 0 || !Number.isFinite(lineDiscount) || lineDiscount < 0) return res.status(400).json({ error: 'السعر أو الخصم غير صحيح' });
    line.unit_price = price;
    line.discount = lineDiscount;
    line.total = parseFloat((price * line.quantity - lineDiscount).toFixed(2));
    subtotal += line.total;
  }
  const invoiceDiscount = Math.max(0, Number(req.body.discount ?? sale.discount) || 0);
  if (invoiceDiscount > subtotal) return res.status(400).json({ error: 'خصم الفاتورة يتجاوز مجموع الأصناف.' });
  sale.subtotal = parseFloat(subtotal.toFixed(2));
  sale.discount = parseFloat(invoiceDiscount.toFixed(2));
  sale.taxable_amount = Number(Math.max(0, subtotal - invoiceDiscount).toFixed(2));
  sale.tax_amount = Number((sale.taxable_amount * Number(sale.tax_rate || 0) / 100).toFixed(2));
  sale.total = Number((sale.taxable_amount + sale.tax_amount).toFixed(2));
  if (sale.salesperson_id) {
    const oldCommission = Number(sale.commission_amount || 0);
    const newCommission = Number((sale.taxable_amount * Number(sale.commission_rate || 0) / 100).toFixed(2));
    const commissionDelta = Number((newCommission - oldCommission).toFixed(2));
    if (commissionDelta !== 0) db.data.employee_transactions.push({ id: db.nextId('employee_transactions'), employee_id: sale.salesperson_id, type: commissionDelta > 0 ? 'bonus' : 'deduction', amount: Math.abs(commissionDelta), notes: `تسوية عمولة تعديل ${sale.invoice_number}`, reference_id: sale.invoice_number, created_at: nowStr(), user_id: req.authUser.id });
    sale.commission_amount = newCommission;
  }
  sale.change_amount = parseFloat(Math.max(0, sale.paid_amount - sale.total).toFixed(2));
  const delta = sale.total - oldTotal;
  if (sale.customer_id > 1 && delta !== 0) {
    const cust = db.data.customers.find(c => c.id === sale.customer_id);
    if (cust) cust.balance = Math.max(0, (cust.balance || 0) + delta);
    addFinanceTransaction('customer_transactions', { customer_id: sale.customer_id, type: 'sale_edit', debit: Math.max(0, delta), credit: Math.max(0, -delta), reference_id: sale.invoice_number, notes: 'تعديل قيمة فاتورة' });
  }
  db.save(['sales', 'sale_items', 'employee_transactions', 'customers', 'customer_transactions', 'audit_logs']);
  db.logAudit(req.body.current_user_id, 'تعديل فاتورة بيع', 'sales', sale.id, `تعديل الفاتورة ${sale.invoice_number}`);
  res.json(sale);
});

app.post('/api/sales/:id/return', (req, res) => {
  // Authorization is resolved by the server-side session middleware. Do not
  // authorize a return from an identity supplied by the browser.
  const returnUser = req.authUser;
  if (!returnUser) return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً.' });
  const sale = db.data.sales.find(s => s.id === Number(req.params.id));
  if (!sale || Number(sale.branch_id || db.data.default_branch_id) !== Number(req.branchId)) return res.status(404).json({ error: 'فاتورة البيع غير موجودة في هذا الفرع.' });
  if (sale.status === 'returned') return res.status(409).json({ error: 'تم استرجاع هذه الفاتورة بالكامل من قبل.' });
  const sourceShift = sale.shift_id ? db.data.cashier_shifts.find(shift => Number(shift.id) === Number(sale.shift_id)) : null;
  const saleTime = Date.parse(String(sale.created_at || '').replace(' ', 'T'));
  const returnWindowDays = currentReturnWindowDays();
  const outsideReturnWindow = returnWindowDays > 0 && (!Number.isFinite(saleTime) || (Date.now() - saleTime) > returnWindowDays * 24 * 60 * 60 * 1000);
  const outsideOpenPeriod = sale.shift_id
    ? sourceShift?.status !== 'open'
    : false;
  const overrideClosedPeriod = req.body.override_closed_period === true;
  if (overrideClosedPeriod && !isUnrestrictedAccount(req.authUser)) return res.status(403).json({ error: 'تجاوز الفترة المالية المغلقة متاح لمالك النظام أو حساب admin فقط.' });
  if (outsideReturnWindow && (!overrideClosedPeriod || !isUnrestrictedAccount(req.authUser))) {
    return res.status(400).json({ code: 'RETURN_WINDOW_EXPIRED', error: `انتهت مدة السماح بالارتجاع (${returnWindowDays} أيام)`, return_window_days: returnWindowDays, manager_override_required: true });
  }
  if (outsideOpenPeriod && (!overrideClosedPeriod || !isUnrestrictedAccount(req.authUser))) {
    return res.status(409).json({ code: 'RETURN_PERIOD_LOCKED', error: 'الفترة المالية لهذه الفاتورة مغلقة. يلزم اعتماد مالك النظام أو حساب admin مع ذكر سبب التجاوز.', manager_override_required: true });
  }
  const overrideReason = String(req.body.override_reason || '').trim().slice(0, 500);
  if ((outsideOpenPeriod || outsideReturnWindow) && overrideClosedPeriod && overrideReason.length < 4) return res.status(400).json({ error: 'اكتب سبباً واضحاً لتجاوز إغلاق الفترة المالية أو مدة السماح.' });
  if (db.data.cash_audit_chain.length) readCashAuditKey(false);
  const requested = Array.isArray(req.body.items) && req.body.items.length
    ? req.body.items
    : db.data.sale_items.filter(i => i.sale_id === sale.id).map(i => ({ sale_item_id: i.id, quantity: i.quantity }));
  const normalized = [];
  const seenSaleItems = new Set();
  for (const request of requested) {
    const line = db.data.sale_items.find(i => i.id === Number(request.sale_item_id) && i.sale_id === sale.id);
    if (!line) return res.status(400).json({ error: 'أحد أصناف الفاتورة غير موجود' });
    if (seenSaleItems.has(Number(line.id))) return res.status(400).json({ error: 'أرسل كل صنف مرة واحدة فقط في طلب المرتجع.' });
    seenSaleItems.add(Number(line.id));
    const already = db.data.sale_returns.filter(r => r.sale_item_id === line.id).reduce((sum, r) => sum + Number(r.quantity || 0), 0);
    const quantity = Number(request.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity + already > line.quantity) return res.status(400).json({ error: 'كمية المرتجع غير صحيحة' });
    normalized.push({ line, quantity, already, remaining_quantity: Number(line.quantity) - already - quantity });
  }
  if (!normalized.length) return res.status(400).json({ error: 'حدد صنفاً واحداً على الأقل للاسترجاع.' });
  if (!Array.isArray(db.data.sale_return_items)) db.data.sale_return_items = [];
  const previewReturnTotal = Number(normalized.reduce((sum, { line, quantity }) => sum + ((Number(line.unit_price) * quantity) - (Number(line.discount || 0) / Number(line.quantity || 1)) * quantity), 0).toFixed(2));
  const previewReturnedTax = db.data.sale_returns.filter(row => row.sale_id === sale.id).reduce((sum, row) => sum + Number(row.tax_amount || 0), 0);
  const previewSaleTaxable = Number(sale.taxable_amount ?? Math.max(0, Number(sale.subtotal || 0) - Number(sale.discount || 0)));
  const previewTaxRemaining = Math.max(0, Number(sale.tax_amount || 0) - previewReturnedTax);
  const previewTax = previewSaleTaxable > 0 ? Number(Math.min(previewTaxRemaining, Number((Number(sale.tax_amount || 0) * previewReturnTotal / previewSaleTaxable).toFixed(2))).toFixed(2)) : 0;
  const previewGrossReturn = Number((previewReturnTotal + previewTax).toFixed(2));
  const previewPaymentRatio = sale.total > 0 ? Math.min(1, (Number(sale.paid_amount || 0) + Number(sale.additional_paid_amount || 0)) / sale.total) : 0;
  const previewRefundAmount = sale.payment_method === 'نقدي' ? Number((previewGrossReturn * previewPaymentRatio).toFixed(2)) : 0;
  const committedReturn = db.transaction(['sales', 'sale_items', 'sale_returns', 'sale_return_items', 'products', 'branch_inventory', 'stock_movements', 'customers', 'customer_transactions', 'cash_transactions', 'cash_audit_chain', 'installment_contracts', 'employee_transactions', 'delivery_assignments', 'delivery_rider_transactions', 'loyalty_transactions', 'audit_logs', 'warehouse_inventory', 'warehouse_stock_movements'], () => {
  const cashConfirmation = previewRefundAmount > 0 ? requireCashBalanceConfirmation(req, res, previewRefundAmount) : { negative: false };
  if (!cashConfirmation) return null;
  let returnTotal = 0;
  const createdReturnRows = [];
  const returnShiftId = openCashierShift(req.authUser.id)?.id || null;
  for (const { line, quantity, already, remaining_quantity } of normalized) {
    const product = db.data.products.find(p => p.id === line.product_id);
    if (product) {
      setBranchQuantity(req.branchId, product.id, branchQuantity(req.branchId, product.id) + quantity);
      product.updated_at = nowStr();
      restoreTrackedLots(line, quantity);
    }
    const amount = parseFloat(((line.unit_price * quantity) - (line.discount / line.quantity) * quantity).toFixed(2));
    returnTotal += amount;
    addFinanceTransaction('sale_returns', { sale_id: sale.id, sale_item_id: line.id, product_id: line.product_id, quantity, remaining_quantity, quantity_before_return: Number(line.quantity) - already, amount, user_id: req.body.current_user_id, reason: req.body.reason || '', shift_id: returnShiftId });
    const returnRow = db.data.sale_returns.at(-1);
    returnRow.shift_id = returnShiftId;
    returnRow.original_invoice_number = sale.invoice_number;
    returnRow.document_type = 'credit_note';
    db.data.sale_return_items.push({
      id: db.nextId('sale_return_items'),
      return_id: returnRow.id,
      sale_id: sale.id,
      sale_item_id: line.id,
      branch_id: req.branchId,
      product_id: line.product_id,
      quantity,
      unit_price: Number(line.unit_price),
      amount,
      created_at: returnRow.created_at
    });
    createdReturnRows.push(returnRow);
    db.data.stock_movements.push({ id: db.nextId('stock_movements'), branch_id: req.branchId, product_id: line.product_id, type: 'return', quantity, reference_id: sale.invoice_number, created_at: nowStr() });
  }
  const previouslyReturnedTax = db.data.sale_returns.filter(row => row.sale_id === sale.id).reduce((sum, row) => sum + Number(row.tax_amount || 0), 0);
  const saleTaxable = Number(sale.taxable_amount ?? Math.max(0, Number(sale.subtotal || 0) - Number(sale.discount || 0)));
  const taxRemaining = Math.max(0, Number(sale.tax_amount || 0) - previouslyReturnedTax);
  const returnTax = saleTaxable > 0 ? Number(Math.min(taxRemaining, Number((Number(sale.tax_amount || 0) * returnTotal / saleTaxable).toFixed(2))).toFixed(2)) : 0;
  let taxAllocated = 0;
  createdReturnRows.forEach((row, index) => {
    row.tax_amount = index === createdReturnRows.length - 1
      ? Number((returnTax - taxAllocated).toFixed(2))
      : Number((returnTax * row.amount / Math.max(returnTotal, 0.01)).toFixed(2));
    row.total_amount = Number((Number(row.amount || 0) + row.tax_amount).toFixed(2));
    taxAllocated += row.tax_amount;
  });
  const grossReturn = Number((returnTotal + returnTax).toFixed(2));
  const paymentRatio = sale.total > 0 ? Math.min(1, (Number(sale.paid_amount || 0) + Number(sale.additional_paid_amount || 0)) / sale.total) : 0;
  const refundAmount = parseFloat((grossReturn * paymentRatio).toFixed(2));
  const cashRefundAmount = sale.payment_method === 'نقدي' ? refundAmount : 0;
  let cashRefundAllocated = 0;
  createdReturnRows.forEach((row, index) => {
    row.cash_amount = index === createdReturnRows.length - 1
      ? parseFloat((cashRefundAmount - cashRefundAllocated).toFixed(2))
      : parseFloat((row.amount * paymentRatio).toFixed(2));
    cashRefundAllocated += row.cash_amount;
  });
  if (sale.customer_id > 1) {
    const cust = db.data.customers.find(c => c.id === sale.customer_id);
    if (cust) cust.balance = Math.max(0, (cust.balance || 0) - (grossReturn - refundAmount));
    addFinanceTransaction('customer_transactions', { customer_id: sale.customer_id, type: 'return', debit: 0, credit: grossReturn - refundAmount, reference_id: sale.invoice_number, notes: 'مرتجع فاتورة' });
  }
  const installmentContract = (db.data.installment_contracts || []).find(contract => Number(contract.sale_id) === sale.id && contract.status === 'active');
  if (installmentContract && grossReturn > refundAmount) {
    let reduction = Number((grossReturn - refundAmount).toFixed(2));
    for (const installment of [...(Array.isArray(installmentContract.schedule) ? installmentContract.schedule : [])].reverse()) {
      const unpaid = Math.max(0, Number((installment.amount - installment.paid_amount).toFixed(2)));
      const applied = Math.min(unpaid, reduction);
      if (!applied) continue;
      installment.amount = Number((installment.amount - applied).toFixed(2));
      reduction = Number((reduction - applied).toFixed(2));
      if (installment.amount <= installment.paid_amount) installment.status = 'paid';
      installment.adjusted_by_return = true;
    }
    installmentContract.remaining_amount = Number(Math.max(0, Number((installmentContract.remaining_amount - (grossReturn - refundAmount)).toFixed(2))).toFixed(2));
    installmentContract.total = Number((installmentContract.paid_amount + installmentContract.remaining_amount).toFixed(2));
    if (installmentContract.remaining_amount === 0) installmentContract.status = 'settled_by_return';
  }
  if (refundAmount > 0) addFinanceTransaction('cash_transactions', { type: 'sale_return', amount: refundAmount, direction: 'out', reference_id: sale.invoice_number, notes: 'رد قيمة مرتجع', user_id: req.authUser.id, shift_id: returnShiftId, ...cashConfirmationFields(cashConfirmation) });
  const returned = db.data.sale_returns.filter(r => r.sale_id === sale.id).reduce((sum, r) => sum + Number(r.amount || 0) + Number(r.tax_amount || 0), 0);
  sale.returned_amount = parseFloat(returned.toFixed(2));
  const returnableSaleTotal = Math.max(0, Number(sale.total || 0) - Number(sale.delivery_fee_customer || 0));
  sale.status = sale.returned_amount >= returnableSaleTotal - 0.009 ? 'returned' : 'partially_returned';
  const deliveryAssignments = (db.data.delivery_assignments || []).filter(row => Number(row.sale_id) === Number(sale.id));
  for (const assignment of deliveryAssignments) {
    if (sale.status === 'returned' && !['delivered', 'cancelled'].includes(assignment.status)) {
      assignment.status = 'cancelled';
      assignment.notes = [assignment.notes, `أُلغيت بسبب استرجاع الفاتورة ${sale.invoice_number}`].filter(Boolean).join(' · ').slice(0, 500);
      assignment.updated_at = nowStr();
    }
  }
  if (sale.salesperson_id && Number(sale.commission_amount || 0) > 0 && sale.total > 0) {
    const reversal = Number(Math.min(Number(sale.commission_amount) - Number(sale.commission_reversed || 0), Number(sale.commission_amount) * grossReturn / Math.max(0.01, returnableSaleTotal)).toFixed(2));
    if (reversal > 0) {
      sale.commission_reversed = Number((Number(sale.commission_reversed || 0) + reversal).toFixed(2));
      db.data.employee_transactions.push({ id: db.nextId('employee_transactions'), employee_id: sale.salesperson_id, type: 'deduction', amount: reversal, notes: `عكس عمولة مرتجع ${sale.invoice_number}`, reference_id: sale.invoice_number, created_at: nowStr(), user_id: req.authUser.id });
    }
  }
  const saleLoyaltyEntries = db.data.loyalty_transactions.filter(entry => entry.sale_id === sale.id);
  const earnedPoints = saleLoyaltyEntries.filter(entry => entry.type === 'earn')
    .reduce((sum, entry) => sum + Math.max(0, Number(entry.points) || 0), 0);
  const netPoints = saleLoyaltyEntries.reduce((sum, entry) => sum + (Number(entry.points) || 0), 0);
  const pointsRemainingAfterReturn = returnableSaleTotal > 0
    ? Math.floor(earnedPoints * Math.max(0, 1 - Math.min(1, sale.returned_amount / returnableSaleTotal)) + 1e-9)
    : 0;
  const pointsToReverse = Math.max(0, netPoints - pointsRemainingAfterReturn);
  if (pointsToReverse > 0) {
    db.data.loyalty_transactions.push({
      id: db.nextId('loyalty_transactions'), customer_id: sale.customer_id,
      sale_id: sale.id, reference_id: sale.invoice_number, type: 'return_reversal', points: -pointsToReverse,
      notes: 'خصم نقاط مقابل مرتجع فاتورة', created_at: nowStr(), user_id: req.authUser.id
    });
  }
  const encryptedReturnAudit = appendCashAudit({
    actor_id: req.authUser.id,
    actor_name: req.authUser.name || req.authUser.username,
    action: 'مرتجع فاتورة بيع',
    sale_id: sale.id,
    invoice_number: sale.invoice_number,
    branch_id: req.branchId,
    source_shift_id: sale.shift_id || null,
    source_period_status: sourceShift?.status || (outsideOpenPeriod ? 'closed_or_missing' : 'no_shift_within_24h'),
    return_shift_id: returnShiftId,
    return_total: Number(returnTotal.toFixed(2)),
    refund_amount: refundAmount,
    override_closed_period: outsideOpenPeriod && overrideClosedPeriod,
    override_reason: outsideOpenPeriod && overrideClosedPeriod ? overrideReason : '',
    reason: String(req.body.reason || '').trim().slice(0, 500),
    items: createdReturnRows.map(row => ({ sale_item_id: row.sale_item_id, product_id: row.product_id, returned_quantity: row.quantity, remaining_quantity: row.remaining_quantity, amount: row.amount }))
  });
  createdReturnRows.forEach(row => { row.audit_entry_hash = encryptedReturnAudit.entry_hash; });
  const firstReturnId = Number(createdReturnRows[0]?.id || db.nextId('sale_returns'));
  const returnNumber = `CN-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(firstReturnId).padStart(4, '0')}`;
  createdReturnRows.forEach(row => { row.return_number = returnNumber; });
  db.logAudit(req.body.current_user_id, 'استرجاع فاتورة بيع', 'sales', sale.id, `استرجاع بقيمة ${returnTotal} من الفاتورة ${sale.invoice_number}؛ سجل التدقيق المشفر ${encryptedReturnAudit.entry_hash.slice(0, 16)}`, { save: false });
  return {
    sale,
    return_total: returnTotal,
    refund_amount: refundAmount,
    return_document: {
      number: returnNumber,
      type: 'credit_note',
      original_invoice_number: sale.invoice_number,
      created_at: createdReturnRows[0]?.created_at || nowStr(),
      customer_name: db.data.customers.find(customer => Number(customer.id) === Number(sale.customer_id))?.name || 'عميل نقدي',
      reason: String(req.body.reason || '').trim().slice(0, 500),
      subtotal: returnTotal,
      tax_amount: returnTax,
      total: grossReturn,
      refunded_amount: refundAmount,
      items: createdReturnRows.map(row => ({
        product_id: row.product_id,
        product_name: db.data.products.find(product => Number(product.id) === Number(row.product_id))?.name || 'منتج غير معروف',
        quantity: row.quantity,
        unit_price: Number(row.quantity) > 0 ? Number((Number(row.amount || 0) / Number(row.quantity)).toFixed(2)) : 0,
        total: Number(row.total_amount || row.amount || 0)
      }))
    }
  };
  });
  if (!committedReturn) return;
  res.json({ message: 'تم تسجيل المرتجع وتحديث المخزون والحسابات', ...committedReturn });
});

// ----------------------------------------------------
// Purchases (Suppliers & Stock In)
// ----------------------------------------------------
app.get('/api/purchases', (req, res) => {
  const purchases = branchStockFilter(db.data.purchases, req.branchId).map(pur => {
    const supp = db.data.suppliers.find(s => s.id === pur.supplier_id);
    const user = db.data.users.find(u => u.id === pur.user_id);
    const items = db.data.purchase_items.filter(item => item.purchase_id === pur.id && !item.wac_reversed).map(item => {
      const prod = db.data.products.find(p => p.id === item.product_id);
      return {
        ...item,
        product_name: prod ? prod.name : 'منتج غير معروف'
      };
    });
    return {
      ...pur,
      items_count: items.length,
      supplier_name: supp ? supp.name : 'مورد عام',
      user_name: user ? user.name : 'المسؤول',
      items
    };
  });
  res.json(purchases.reverse());
});

const validatePurchaseOrderItems = items => {
  if (!Array.isArray(items) || items.length < 1 || items.length > 500) return 'أمر الشراء يحتاج من صنف واحد إلى 500 صنف.';
  for (const item of items) {
    if (!db.data.products.some(product => product.id === Number(item.product_id))) return `المنتج رقم ${item.product_id} غير موجود.`;
    if (!Number.isInteger(Number(item.quantity)) || Number(item.quantity) <= 0 || !Number.isFinite(Number(item.unit_cost)) || Number(item.unit_cost) < 0) return 'كمية الصنف أو سعر التكلفة غير صحيح.';
    const dateError = productDateError(item.production_date || '', item.expiry_date || '');
    if (dateError) return dateError;
    if (item.lot_number != null && (typeof item.lot_number !== 'string' || item.lot_number.length > 80)) return 'رقم التشغيلة يجب ألا يتجاوز 80 حرفاً.';
  }
  return null;
};

app.get('/api/inventory/lots', (req, res) => {
  const today = businessDateToday();
  const rows = branchStockFilter(db.data.purchase_items, req.branchId).filter(item => !item.wac_reversed && (item.expiry_date || item.lot_number || Object.prototype.hasOwnProperty.call(item, 'remaining_quantity')))
    .filter(item => !req.query.product_id || item.product_id === Number(req.query.product_id))
    .filter(item => db.data.purchases.some(purchase => purchase.id === item.purchase_id && purchase.status !== 'cancelled'))
    .map(item => {
      const product = db.data.products.find(row => row.id === item.product_id); const purchase = db.data.purchases.find(row => row.id === item.purchase_id);
      return { ...item, product_name: product?.name || 'صنف غير معروف', supplier_name: db.data.suppliers.find(row => row.id === purchase?.supplier_id)?.name || 'مورد عام', available_quantity: item.remaining_quantity === undefined ? item.quantity : item.remaining_quantity, expired: Boolean(item.expiry_date && item.expiry_date < today), days_until_expiry: item.expiry_date ? getDaysUntilExpiry(item.expiry_date) : null };
    }).filter(item => !req.query.expiring || (item.expiry_date && item.days_until_expiry !== null && item.days_until_expiry <= Number(req.query.expiring)))
    .sort((a, b) => String(a.expiry_date || '9999-12-31').localeCompare(String(b.expiry_date || '9999-12-31')) || a.id - b.id);
  res.json(rows);
});

app.get('/api/inventory/waste', (req, res) => {
  const rows = branchStockFilter(db.data.waste_records || [], req.branchId).map(record => ({ ...record, product_name: db.data.products.find(product => product.id === record.product_id)?.name || 'صنف غير معروف' })).sort((a, b) => b.id - a.id).slice(0, 200);
  res.json(rows);
});
app.post('/api/inventory/waste', (req, res) => {
  const product = db.data.products.find(row => row.id === Number(req.body?.product_id));
  const quantity = Number(req.body?.quantity); const reason = String(req.body?.reason || '').trim().slice(0, 300);
  if (!product) return res.status(404).json({ error: 'الصنف غير موجود.' });
  const currentQuantity = branchQuantity(req.branchId, product.id);
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > currentQuantity) return res.status(400).json({ error: `كمية الهالك يجب أن تكون عدداً صحيحاً لا يتجاوز رصيد الفرع ${currentQuantity}.` });
  if (reason.length < 3) return res.status(400).json({ error: 'اكتب سبب تسجيل الهالك.' });
  const allocations = []; let remaining = quantity; let costValue = 0;
  const lotId = req.body?.lot_id ? Number(req.body.lot_id) : null;
  if (lotId) {
    const lot = db.data.purchase_items.find(item => item.id === lotId && item.product_id === product.id && Object.prototype.hasOwnProperty.call(item, 'remaining_quantity'));
    if (!lot) return res.status(400).json({ error: 'التشغيلة المحددة غير قابلة للتعديل أو لا تخص هذا الصنف.' });
    if (Number(lot.remaining_quantity) < quantity) return res.status(400).json({ error: `المتبقي في التشغيلة ${lot.lot_number || lot.id} هو ${lot.remaining_quantity} فقط.` });
    lot.remaining_quantity = Number((Number(lot.remaining_quantity) - quantity).toFixed(3));
    allocations.push({ purchase_item_id: lot.id, lot_number: lot.lot_number || '', quantity }); costValue = quantity * Number(lot.unit_cost || product.cost_price || 0); remaining = 0;
  } else {
    const trackedLots = db.data.purchase_items.filter(item => item.product_id === product.id && Object.prototype.hasOwnProperty.call(item, 'remaining_quantity') && Number(item.remaining_quantity) > 0)
      .sort((a, b) => String(a.expiry_date || '9999-12-31').localeCompare(String(b.expiry_date || '9999-12-31')) || Number(a.id) - Number(b.id));
    for (const lot of trackedLots) {
      if (remaining <= 0) break;
      const taken = Math.min(remaining, Number(lot.remaining_quantity)); lot.remaining_quantity = Number((Number(lot.remaining_quantity) - taken).toFixed(3)); remaining = Number((remaining - taken).toFixed(3));
      allocations.push({ purchase_item_id: lot.id, lot_number: lot.lot_number || '', quantity: taken }); costValue += taken * Number(lot.unit_cost || product.cost_price || 0);
    }
    if (remaining > 0) { costValue += remaining * Number(product.cost_price || 0); allocations.push({ purchase_item_id: null, lot_number: '', quantity: remaining }); }
  }
  const nextQuantity = setBranchQuantity(req.branchId, product.id, currentQuantity - quantity); product.updated_at = nowStr();
  const record = { id: db.nextId('waste_records'), branch_id: req.branchId, product_id: product.id, quantity, reason, allocations, cost_value: Number(costValue.toFixed(2)), user_id: req.authUser.id, created_at: nowStr() };
  db.data.waste_records.push(record);
  db.data.stock_movements.push({ id: db.nextId('stock_movements'), branch_id: req.branchId, product_id: product.id, type: 'waste', quantity: -quantity, reference_id: `WASTE-${record.id}`, created_at: record.created_at });
  db.save(); db.logAudit(req.authUser.id, 'تسجيل هالك مخزون', 'waste_records', record.id, `${product.name}: ${quantity} — ${reason}`);
  res.status(201).json({ ...record, product_name: product.name, product_quantity: nextQuantity });
});

app.get('/api/delivery/riders', (req, res) => {
  const rows = branchStockFilter(db.data.delivery_riders || [], req.branchId);
  res.json(req.query.include_inactive === '1' ? rows : rows.filter(row => row.is_active !== false));
});
app.get('/api/delivery/riders/summary', (req, res) => {
  const riders = branchStockFilter(db.data.delivery_riders || [], req.branchId);
  const orders = branchStockFilter(db.data.delivery_assignments || [], req.branchId);
  res.json(riders.map(rider => {
    const rows = orders.filter(row => row.rider_id === rider.id);
    const linkedEmployee = rider.employee_id ? (db.data.employees || []).find(emp => emp.id === Number(rider.employee_id) && Number(emp.branch_id || db.data.default_branch_id) === Number(req.branchId)) : null;
    const transactions = linkedEmployee
      ? branchStockFilter(db.data.employee_transactions || [], req.branchId).filter(t => t.employee_id === linkedEmployee.id)
      : branchStockFilter(db.data.delivery_rider_transactions || [], req.branchId).filter(t => t.rider_id === rider.id);
    const advanceBalance = transactions.reduce((sum, t) => sum + (t.type === 'advance' ? Number(t.amount || 0) : t.type === 'settlement' ? -Number(t.amount || 0) : 0), 0);
    const custodyGiven = transactions.reduce((sum, t) => sum + (t.type === 'custody_given' ? Number(t.amount || 0) : t.type === 'custody_return' ? -Number(t.amount || 0) : 0), 0);
    const collected = rows.reduce((sum, row) => sum + Number(row.cash_collected || 0), 0);
    const settled = rows.reduce((sum, row) => sum + Number(row.cash_settled || 0), 0);
    const riderFeesDue = rows.reduce((sum, row) => sum + (row.status === 'delivered' ? Number(row.delivery_fee_rider || 0) : 0), 0);
    return { rider_id: rider.id, rider_name: rider.name, rider_phone: rider.phone || '', employee_id: linkedEmployee?.id || null, delivered: rows.filter(row => row.status === 'delivered').length, pending: rows.filter(row => ['unassigned', 'assigned', 'dispatched'].includes(row.status)).length, returned: rows.filter(row => ['returned', 'cancelled'].includes(row.status)).length, open_custody: Number((collected - settled).toFixed(2)), custody_balance: Number(custodyGiven.toFixed(2)), advance_balance: Number(advanceBalance.toFixed(2)), rider_fees_due: Number(riderFeesDue.toFixed(2)) };
  }));
});
app.get('/api/delivery/profit-summary', (req, res) => {
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const inRange = value => { const day = String(value || '').slice(0, 10); return (!from || day >= from) && (!to || day <= to); };
  const deliverySales = branchStockFilter(db.data.sales || [], req.branchId)
    .filter(sale => sale.order_type === 'توصيل' && sale.status !== 'cancelled' && inRange(sale.created_at || sale.date));
  const assignments = branchStockFilter(db.data.delivery_assignments || [], req.branchId)
    .filter(row => row.status === 'delivered' && inRange(row.delivered_at || row.updated_at || row.created_at));
  const assignmentsBySale = new Map();
  for (const assignment of branchStockFilter(db.data.delivery_assignments || [], req.branchId)) {
    if (!inRange(assignment.delivered_at || assignment.updated_at || assignment.created_at)) continue;
    assignmentsBySale.set(Number(assignment.sale_id), (assignmentsBySale.get(Number(assignment.sale_id)) || 0) + Number(assignment.cash_collected || 0));
  }
  const customerFees = deliverySales.reduce((sum, sale) => {
    const fee = Number(sale.delivery_fee_customer || 0);
    const total = Number(sale.total || 0);
    const collected = Number(sale.paid_amount || 0) + Number(assignmentsBySale.get(Number(sale.id)) || 0);
    const collectedRatio = total > 0 ? Math.min(1, Math.max(0, collected / total)) : 0;
    return sum + fee * collectedRatio;
  }, 0);
  const riderWages = assignments.reduce((sum, row) => sum + Number(row.delivery_fee_rider || 0), 0);
  const net = customerFees - riderWages;
  res.json({
    from: from || null, to: to || null,
    delivery_sales_count: deliverySales.length,
    delivered_orders_count: assignments.length,
    customer_delivery_fees: Number(customerFees.toFixed(2)),
    rider_wages_due: Number(riderWages.toFixed(2)),
    net_delivery_result: Number(net.toFixed(2)),
    result_kind: net >= 0 ? 'profit' : 'loss'
  });
});
app.get('/api/delivery/riders/:id/transactions', (req, res) => {
  const rider = (db.data.delivery_riders || []).find(row => row.id === Number(req.params.id) && Number(row.branch_id || db.data.default_branch_id) === Number(req.branchId));
  if (!rider) return res.status(404).json({ error: 'ملف الطيار غير موجود.' });
  const linkedEmployee = rider.employee_id ? (db.data.employees || []).find(emp => emp.id === Number(rider.employee_id) && Number(emp.branch_id || db.data.default_branch_id) === Number(req.branchId)) : null;
  const rows = linkedEmployee ? branchStockFilter(db.data.employee_transactions || [], req.branchId).filter(t => t.employee_id === linkedEmployee.id) : branchStockFilter(db.data.delivery_rider_transactions || [], req.branchId).filter(t => t.rider_id === rider.id);
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const status = String(req.query.status || '').trim();
  const includeReversals = req.query.include_reversals === '1';
  const inRange = row => { const day = String(row.transaction_date || row.created_at || '').slice(0, 10); return (!from || day >= from) && (!to || day <= to); };
  const fullRows = rows.filter(inRange).filter(row => !status || (row.reversed_by ? 'reversed' : row.reversed_transaction_id ? 'reversal' : 'active') === status).sort((a, b) => String(b.transaction_date || b.created_at || '').localeCompare(String(a.transaction_date || a.created_at || '')) || Number(b.id) - Number(a.id));
  const ledgerRows = fullRows.filter(row => includeReversals || !row.reversed_transaction_id).map(row => ({
    ...row,
    ledger_status: row.reversed_by ? 'reversed' : 'active',
    reversal_id: row.reversed_by || null
  }));
  res.json({ source: linkedEmployee ? 'employee' : 'rider', employee_id: linkedEmployee?.id || null, transactions: ledgerRows, ledger_transactions: ledgerRows, audit_transactions: fullRows, hidden_reversals: fullRows.filter(row => row.reversed_transaction_id).length });
});
app.post('/api/delivery/riders/:id/transactions', (req, res) => {
  const rider = (db.data.delivery_riders || []).find(row => row.id === Number(req.params.id) && Number(row.branch_id || db.data.default_branch_id) === Number(req.branchId));
  const amount = Number(req.body?.amount); const type = String(req.body?.type || 'advance');
  if (!rider) return res.status(404).json({ error: 'ملف الطيار غير موجود.' });
  if (!Number.isFinite(amount) || amount <= 0 || !['advance', 'settlement', 'custody_given', 'custody_return'].includes(type)) return res.status(400).json({ error: 'نوع ومبلغ حركة الطيار غير صالحين.' });
  const cashDirection = ['advance', 'custody_given'].includes(type) ? 'out' : 'in';
  const linkedEmployee = rider.employee_id ? (db.data.employees || []).find(emp => emp.id === Number(rider.employee_id) && Number(emp.branch_id || db.data.default_branch_id) === Number(req.branchId)) : null;
  const table = linkedEmployee ? 'employee_transactions' : 'delivery_rider_transactions';
  const transactionDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.transaction_date || '')) ? String(req.body.transaction_date) : businessDateToday();
  const transaction = { id: db.nextId(table), branch_id: req.branchId, ...(linkedEmployee ? { employee_id: linkedEmployee.id } : { rider_id: rider.id }), type, amount: Number(amount.toFixed(2)), notes: String(req.body?.notes || '').slice(0, 300), transaction_date: transactionDate, created_at: nowStr(), user_id: req.authUser.id };
  const committed = db.transaction([table, 'cash_transactions', 'cash_audit_chain', 'audit_logs'], () => {
    const cashConfirmation = cashDirection === 'out' ? requireCashBalanceConfirmation(req, res, amount) : { negative: false };
    if (!cashConfirmation) return null;
    db.data[table].push(transaction);
    addFinanceTransaction('cash_transactions', { type: `rider_${type}`, amount: Number(amount.toFixed(2)), direction: cashDirection, reference_id: `RIDER-${rider.id}-${transaction.id}`, notes: `${type} — ${rider.name}`, user_id: req.authUser.id, branch_id: req.branchId, ...cashConfirmationFields(cashConfirmation) });
    db.logAudit(req.authUser.id, `${type === 'advance' ? 'سلفة طيار' : type === 'custody_given' ? 'عهدة طيار' : type === 'custody_return' ? 'تسليم عهدة طيار' : 'تسوية طيار'}`, table, transaction.id, `${rider.name}: ${transaction.amount}`, { save: false });
    return transaction;
  });
  if (!committed) return;
  res.status(201).json(transaction);
});
app.post('/api/delivery/riders/:id/transactions/:transactionId/reverse', (req, res) => {
  const rider = (db.data.delivery_riders || []).find(row => row.id === Number(req.params.id) && Number(row.branch_id || db.data.default_branch_id) === Number(req.branchId));
  if (!rider) return res.status(404).json({ error: 'ملف الطيار غير موجود.' });
  const linkedEmployee = rider.employee_id ? (db.data.employees || []).find(emp => emp.id === Number(rider.employee_id) && Number(emp.branch_id || db.data.default_branch_id) === Number(req.branchId)) : null;
  const table = linkedEmployee ? 'employee_transactions' : 'delivery_rider_transactions';
  const source = (db.data[table] || []).find(row => row.id === Number(req.params.transactionId) && (linkedEmployee ? row.employee_id === linkedEmployee.id : row.rider_id === rider.id));
  if (!source) return res.status(404).json({ error: 'حركة الطيار غير موجودة.' });
  if (source.reversed_by) return res.status(409).json({ error: 'تم إلغاء هذه الحركة من قبل.' });
  const inverseType = source.type === 'custody_given' ? 'custody_return' : source.type === 'custody_return' ? 'custody_given' : source.type === 'advance' ? 'settlement' : 'advance';
  const cashDirection = ['advance', 'custody_given'].includes(inverseType) ? 'out' : 'in';
  const inverse = { id: db.nextId(table), branch_id: req.branchId, ...(linkedEmployee ? { employee_id: linkedEmployee.id } : { rider_id: rider.id }), type: inverseType, amount: Number(source.amount || 0), notes: `قيد عكسي للحركة ${source.id}: ${String(req.body?.notes || '').slice(0, 240)}`, reversed_transaction_id: source.id, transaction_date: businessDateToday(), created_at: nowStr(), user_id: req.authUser.id };
  const committed = db.transaction([table, 'cash_transactions', 'cash_audit_chain', 'audit_logs'], () => {
    const cashConfirmation = cashDirection === 'out' ? requireCashBalanceConfirmation(req, res, Number(source.amount || 0)) : { negative: false };
    if (!cashConfirmation) return null;
    source.reversed_by = inverse.id;
    db.data[table].push(inverse);
    addFinanceTransaction('cash_transactions', { type: `rider_${inverseType}_reversal`, amount: Number(source.amount || 0), direction: cashDirection, reference_id: `RIDER-${rider.id}-${inverse.id}`, notes: `قيد عكسي للحركة ${source.id} — ${rider.name}`, user_id: req.authUser.id, branch_id: req.branchId, ...cashConfirmationFields(cashConfirmation) });
    db.logAudit(req.authUser.id, 'إلغاء حركة طيار بقيد عكسي', table, inverse.id, `${rider.name}: ${source.id}`, { save: false });
    return inverse;
  });
  if (!committed) return;
  res.status(201).json(inverse);
});
app.post('/api/delivery/riders', (req, res) => {
  const name = String(req.body?.name || '').trim(); const phone = String(req.body?.phone || '').trim();
  if (!name) return res.status(400).json({ error: 'اسم الطيار مطلوب.' });
  if (phone && (db.data.delivery_riders || []).some(row => row.phone === phone && row.is_active !== false)) return res.status(409).json({ error: 'رقم الهاتف مسجل لطيار آخر.' });
  const rider = {
    id: db.nextId('delivery_riders'), branch_id: req.branchId, name, phone,
    national_id: String(req.body?.national_id || '').trim().slice(0, 40),
    vehicle_type: String(req.body?.vehicle_type || '').trim().slice(0, 60),
    plate_number: String(req.body?.plate_number || '').trim().slice(0, 40),
    employee_id: Number(req.body?.employee_id) || null,
    notes: String(req.body?.notes || '').trim().slice(0, 500),
    default_delivery_fee: Math.max(0, Number(req.body?.default_delivery_fee || 0)),
    default_delivery_wage: Math.max(0, Number(req.body?.default_delivery_wage || 0)),
    is_active: true, created_at: nowStr(), updated_at: nowStr()
  };
  db.data.delivery_riders.push(rider); db.save(); db.logAudit(req.authUser.id, 'إضافة طيار توصيل', 'delivery_riders', rider.id, name); res.status(201).json(rider);
});
app.put('/api/delivery/riders/:id', (req, res) => {
  const rider = (db.data.delivery_riders || []).find(row => row.id === Number(req.params.id) && Number(row.branch_id || db.data.default_branch_id) === Number(req.branchId));
  if (!rider) return res.status(404).json({ error: 'ملف الطيار غير موجود.' });
  const name = String(req.body?.name ?? rider.name ?? '').trim();
  const phone = String(req.body?.phone ?? rider.phone ?? '').trim();
  if (!name) return res.status(400).json({ error: 'اسم الطيار مطلوب.' });
  const nextActive = req.body?.is_active === undefined ? rider.is_active !== false : req.body.is_active !== false;
  if (phone && nextActive && (db.data.delivery_riders || []).some(row => row.id !== rider.id && row.phone === phone && row.is_active !== false)) return res.status(409).json({ error: 'رقم الهاتف مسجل لطيار نشط آخر.' });
  Object.assign(rider, {
    name, phone,
    national_id: String(req.body?.national_id ?? rider.national_id ?? '').trim().slice(0, 40),
    vehicle_type: String(req.body?.vehicle_type ?? rider.vehicle_type ?? '').trim().slice(0, 60),
    plate_number: String(req.body?.plate_number ?? rider.plate_number ?? '').trim().slice(0, 40),
    employee_id: Number(req.body?.employee_id ?? rider.employee_id) || null,
    notes: String(req.body?.notes ?? rider.notes ?? '').trim().slice(0, 500),
    default_delivery_fee: Math.max(0, Number(req.body?.default_delivery_fee ?? rider.default_delivery_fee ?? 0)),
    default_delivery_wage: Math.max(0, Number(req.body?.default_delivery_wage ?? rider.default_delivery_wage ?? 0)),
    is_active: nextActive, updated_at: nowStr()
  });
  db.save();
  db.logAudit(req.authUser.id, 'تعديل ملف طيار توصيل', 'delivery_riders', rider.id, `${rider.name}${rider.is_active ? '' : ' (معطل)'}`);
  res.json(rider);
});
app.delete('/api/delivery/riders/:id', (req, res) => {
  const rider = (db.data.delivery_riders || []).find(row => row.id === Number(req.params.id) && Number(row.branch_id || db.data.default_branch_id) === Number(req.branchId));
  if (!rider) return res.status(404).json({ error: 'ملف الطيار غير موجود.' });
  rider.is_active = false; rider.updated_at = nowStr(); db.save();
  db.logAudit(req.authUser.id, 'تعطيل ملف طيار توصيل', 'delivery_riders', rider.id, rider.name);
  res.json({ message: 'تم تعطيل ملف الطيار مع الاحتفاظ بسجل طلباته وعهدته.' });
});
app.get('/api/delivery/orders', (req, res) => {
  const rows = branchStockFilter(db.data.delivery_assignments || [], req.branchId).map(row => { const sale = db.data.sales.find(item => item.id === row.sale_id); const customer = db.data.customers.find(item => item.id === sale?.customer_id); return { ...row, sale: sale ? { ...sale, customer_name: customer?.name || 'عميل', customer_phone: customer?.phone || '', delivery_address: sale.delivery_address || row.delivery_address || '' } : null, rider: (db.data.delivery_riders || []).find(rider => rider.id === row.rider_id) }; }).filter(row => row.sale && Number(row.sale.branch_id || db.data.default_branch_id) === Number(req.branchId));
  const from = req.query.from ? new Date(req.query.from) : null; const to = req.query.to ? new Date(`${req.query.to}T23:59:59`) : null;
  res.json(rows.filter(row => (!from || new Date(row.created_at) >= from) && (!to || new Date(row.created_at) <= to)).sort((a, b) => b.id - a.id));
});
app.post('/api/delivery/orders/:saleId/assign', (req, res) => {
  const sale = db.data.sales.find(row => row.id === Number(req.params.saleId));
  const rider = (db.data.delivery_riders || []).find(row => row.id === Number(req.body?.rider_id) && Number(row.branch_id || db.data.default_branch_id) === Number(req.branchId) && row.is_active !== false);
  if (!sale || Number(sale.branch_id || db.data.default_branch_id) !== Number(req.branchId) || sale.order_type !== 'توصيل') return res.status(400).json({ error: 'الفاتورة غير موجودة أو ليست طلب توصيل.' });
  if (!rider) return res.status(400).json({ error: 'اختر طياراً نشطاً.' });
  const existing = (db.data.delivery_assignments || []).find(row => row.sale_id === sale.id && row.status !== 'cancelled');
  if (existing) {
    const previousRiderId = existing.rider_id || null;
    if (previousRiderId === rider.id && existing.status !== 'unassigned') return res.status(409).json({ error: 'تم تسجيل الطلب لهذا الطيار من قبل.' });
    if (!Array.isArray(existing.assignment_history)) existing.assignment_history = [];
    existing.assignment_history.push({ from_rider_id: previousRiderId, to_rider_id: rider.id, changed_by: req.authUser.id, changed_at: nowStr() });
    existing.rider_id = rider.id; existing.status = 'assigned'; existing.assigned_at = nowStr(); existing.updated_at = nowStr();
    sale.delivery_rider_id = rider.id; db.save(); db.logAudit(req.authUser.id, 'تغيير طيار طلب توصيل', 'delivery_assignments', existing.id, `${sale.invoice_number}: ${previousRiderId || 'غير مُسنَد'} ← ${rider.name}`); return res.json(existing);
  }
  const row = { id: db.nextId('delivery_assignments'), branch_id: req.branchId, sale_id: sale.id, rider_id: rider.id, status: 'assigned', assigned_at: nowStr(), assignment_history: [{ from_rider_id: null, to_rider_id: rider.id, changed_by: req.authUser.id, changed_at: nowStr() }], delivery_address: sale.delivery_address || '', delivery_fee_customer: Number(sale.delivery_fee_customer || 0), delivery_fee_rider: Number(sale.delivery_fee_rider || 0), rider_fee_status: 'unpaid', tracking_token: crypto.randomBytes(24).toString('base64url'), rider_token: crypto.randomBytes(24).toString('base64url'), cash_collected: 0, cash_settled: 0, notes: String(req.body?.notes || '').slice(0, 500), created_at: nowStr(), updated_at: nowStr() };
  sale.delivery_rider_id = rider.id; db.data.delivery_assignments.push(row); db.save(); db.logAudit(req.authUser.id, 'تعيين طلب توصيل', 'delivery_assignments', row.id, `${sale.invoice_number} ← ${rider.name}`); res.status(201).json(row);
});
app.put('/api/delivery/orders/:id/status', (req, res) => {
  const row = (db.data.delivery_assignments || []).find(item => item.id === Number(req.params.id) && Number(item.branch_id || db.data.default_branch_id) === Number(req.branchId));
  if (!row) return res.status(404).json({ error: 'طلب التوصيل غير موجود.' });
  const sale = db.data.sales.find(item => item.id === row.sale_id); const next = String(req.body?.status || '');
  if (row.status === 'delivered' || row.status === 'cancelled') return res.status(400).json({ error: 'الطلب مغلق بالفعل.' });
  if (!['dispatched', 'delivered', 'cancelled'].includes(next)) return res.status(400).json({ error: 'حالة التوصيل غير صالحة.' });
  let collected = 0;
  if (next === 'delivered') {
    collected = Number(req.body?.cash_collected || 0); const due = Math.max(0, Number(sale.total || 0) - Number(sale.paid_amount || 0));
    if (!Number.isFinite(collected) || collected < 0 || collected > due) return res.status(400).json({ error: `المبلغ المحصل يجب أن يكون بين صفر والمتبقي ${due.toFixed(2)}.` });
    if (collected > 0) {
      sale.paid_amount = Number((Number(sale.paid_amount || 0) + collected).toFixed(2));
      if (sale.customer_id > 1) { const customer = db.data.customers.find(item => item.id === sale.customer_id); if (customer) customer.balance = Math.max(0, Number((Number(customer.balance || 0) - collected).toFixed(2))); }
      addFinanceTransaction('cash_transactions', { type: 'delivery_collection', amount: collected, direction: 'in', reference_id: sale.invoice_number, notes: `تحصيل طيار التوصيل`, user_id: req.authUser.id });
      row.cash_collected = Number((Number(row.cash_collected || 0) + collected).toFixed(2));
    }
    row.delivered_at = nowStr();
  }
  row.status = next; row.updated_at = nowStr(); row.notes = req.body?.notes == null ? row.notes : String(req.body.notes).slice(0, 500);
  db.save(); db.logAudit(req.authUser.id, 'تحديث حالة توصيل', 'delivery_assignments', row.id, `${sale.invoice_number}: ${next}; تحصيل ${collected}`); res.json({ assignment: row, sale });
});
app.get('/api/delivery/settlements', (req, res) => {
  const riders = branchStockFilter(db.data.delivery_riders || [], req.branchId);
  res.json(riders.map(rider => { const rows = branchStockFilter(db.data.delivery_assignments || [], req.branchId).filter(row => row.rider_id === rider.id); const collected = rows.reduce((sum, row) => sum + Number(row.cash_collected || 0), 0); const settled = rows.reduce((sum, row) => sum + Number(row.cash_settled || 0), 0); return { rider_id: rider.id, rider_name: rider.name, collected: Number(collected.toFixed(2)), settled: Number(settled.toFixed(2)), outstanding: Number((collected - settled).toFixed(2)), deliveries: rows.filter(row => row.status === 'delivered').length }; }));
});
app.post('/api/delivery/settlements', (req, res) => {
  const rider = (db.data.delivery_riders || []).find(row => row.id === Number(req.body?.rider_id) && Number(row.branch_id || db.data.default_branch_id) === Number(req.branchId)); const amount = Number(req.body?.amount);
  const outstanding = branchStockFilter(db.data.delivery_assignments || [], req.branchId).filter(row => row.rider_id === rider?.id).reduce((sum, row) => sum + Number(row.cash_collected || 0) - Number(row.cash_settled || 0), 0);
  if (!rider || !Number.isFinite(amount) || amount <= 0 || amount > outstanding + 0.001) return res.status(400).json({ error: `اختر طياراً ومبلغاً لا يتجاوز العهدة المفتوحة ${Math.max(0, outstanding).toFixed(2)}.` });
  let remaining = amount;
  for (const row of branchStockFilter(db.data.delivery_assignments || [], req.branchId).filter(item => item.rider_id === rider.id && Number(item.cash_collected) > Number(item.cash_settled || 0)).sort((a, b) => a.id - b.id)) { const due = Number(row.cash_collected) - Number(row.cash_settled || 0); const part = Math.min(due, remaining); row.cash_settled = Number((Number(row.cash_settled || 0) + part).toFixed(2)); remaining = Number((remaining - part).toFixed(2)); if (remaining <= 0.001) break; }
  const settlement = { id: db.nextId('delivery_settlements'), rider_id: rider.id, amount: Number(amount.toFixed(2)), user_id: req.authUser.id, created_at: nowStr() }; db.data.delivery_settlements.push(settlement);
  addFinanceTransaction('cash_transactions', { type: 'delivery_rider_settlement', amount: settlement.amount, direction: 'in', reference_id: `DRV-${settlement.id}`, notes: `توريد عهدة الطيار ${rider.name}`, user_id: req.authUser.id });
  db.save(); db.logAudit(req.authUser.id, 'تقفيل عهدة طيار', 'delivery_settlements', settlement.id, `${rider.name}: ${settlement.amount}`); res.status(201).json(settlement);
});

app.get('/api/purchase-orders', (req, res) => {
  const rows = branchStockFilter(db.data.purchase_orders || [], req.branchId).map(order => ({
    ...order,
    supplier_name: db.data.suppliers.find(supplier => supplier.id === order.supplier_id)?.name || 'مورد عام',
    items: (db.data.purchase_order_items || []).filter(item => item.purchase_order_id === order.id).map(item => ({ ...item, product_name: db.data.products.find(product => product.id === item.product_id)?.name || 'منتج غير معروف' }))
  }));
  res.json(rows.sort((a, b) => b.id - a.id));
});

app.post('/api/purchase-orders', (req, res) => {
  const supplierId = Number(req.body.supplier_id || 1);
  if (!db.data.suppliers.some(supplier => supplier.id === supplierId)) return res.status(400).json({ error: 'المورد المحدد غير موجود.' });
  const error = validatePurchaseOrderItems(req.body.items);
  if (error) return res.status(400).json({ error });
  const id = db.nextId('purchase_orders');
  const total = Number(req.body.items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_cost), 0).toFixed(2));
  const order = { id, branch_id: req.branchId, order_number: `PO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(id).padStart(4, '0')}`, supplier_id: supplierId, user_id: req.authUser.id, total, status: 'draft', notes: String(req.body.notes || '').trim().slice(0, 300), created_at: nowStr(), updated_at: nowStr() };
  db.data.purchase_orders.push(order);
  for (const item of req.body.items) db.data.purchase_order_items.push({ id: db.nextId('purchase_order_items'), branch_id: req.branchId, purchase_order_id: id, product_id: Number(item.product_id), quantity: Number(item.quantity), unit_cost: Number(item.unit_cost), lot_number: String(item.lot_number || '').trim().slice(0, 80), production_date: item.production_date || '', expiry_date: item.expiry_date || '' });
  db.save();
  db.logAudit(req.authUser.id, 'إنشاء أمر شراء', 'purchase_orders', id, `إنشاء ${order.order_number} بإجمالي ${total} ج.م`);
  res.status(201).json({ ...order, items: db.data.purchase_order_items.filter(item => item.purchase_order_id === id) });
});

app.put('/api/purchase-orders/:id', (req, res) => {
  const order = (db.data.purchase_orders || []).find(row => row.id === Number(req.params.id) && Number(row.branch_id || db.data.default_branch_id) === Number(req.branchId));
  if (!order) return res.status(404).json({ error: 'أمر الشراء غير موجود.' });
  if (order.status === 'received') return res.status(400).json({ error: 'تم استلام هذا الأمر ولا يمكن تغيير حالته.' });
  const nextStatus = String(req.body.status || '');
  if (!['approved', 'cancelled'].includes(nextStatus) || order.status === 'cancelled') return res.status(400).json({ error: 'حالة أمر الشراء غير صالحة.' });
  order.status = nextStatus; order.updated_at = nowStr();
  db.save(); db.logAudit(req.authUser.id, nextStatus === 'approved' ? 'اعتماد أمر شراء' : 'إلغاء أمر شراء', 'purchase_orders', order.id, `${order.order_number}: ${nextStatus}`);
  res.json(order);
});

app.post('/api/purchase-orders/:id/receive', (req, res) => {
  const order = (db.data.purchase_orders || []).find(row => row.id === Number(req.params.id) && Number(row.branch_id || db.data.default_branch_id) === Number(req.branchId));
  if (!order) return res.status(404).json({ error: 'أمر الشراء غير موجود.' });
  if (order.status !== 'approved') return res.status(400).json({ error: 'اعتمد أمر الشراء قبل استلامه.' });
  const items = (db.data.purchase_order_items || []).filter(item => item.purchase_order_id === order.id);
  const validationError = validatePurchaseOrderItems(items);
  if (validationError) return res.status(400).json({ error: validationError });
  const total = Number(items.reduce((sum, item) => sum + item.quantity * item.unit_cost, 0).toFixed(2));
  const paid = Number(req.body.paid_amount || 0);
  if (!Number.isFinite(paid) || paid < 0 || paid > total) return res.status(400).json({ error: 'المدفوع يجب أن يكون بين صفر وإجمالي أمر الشراء.' });
  const purchase = { id: db.nextId('purchases'), branch_id: req.branchId, supplier_id: order.supplier_id, user_id: req.authUser.id, total, paid_amount: Number(paid.toFixed(2)), remaining_amount: Number((total - paid).toFixed(2)), purchase_order_id: order.id, created_at: nowStr() };
  const committedReceipt = db.transaction(['purchase_orders', 'purchases', 'purchase_order_items', 'purchase_items', 'products', 'branch_inventory', 'stock_movements', 'suppliers', 'supplier_transactions', 'cash_transactions', 'cash_audit_chain', 'audit_logs', 'warehouse_inventory', 'warehouse_stock_movements'], () => {
  const cashConfirmation = paid > 0 ? requireCashBalanceConfirmation(req, res, paid) : { negative: false };
  if (!cashConfirmation) return null;
  db.data.purchases.push(purchase);
  for (const item of items) {
    const product = db.data.products.find(row => row.id === item.product_id);
    setBranchQuantity(req.branchId, product.id, branchQuantity(req.branchId, product.id) + item.quantity); product.cost_price = item.unit_cost;
    if (item.expiry_date && (!product.expiry_date || item.expiry_date < product.expiry_date)) { product.production_date = item.production_date; product.expiry_date = item.expiry_date; }
    product.updated_at = nowStr();
    db.data.purchase_items.push({ id: db.nextId('purchase_items'), branch_id: req.branchId, purchase_id: purchase.id, product_id: item.product_id, quantity: item.quantity, remaining_quantity: item.quantity, lot_number: item.lot_number || `LOT-${purchase.id}-${item.product_id}`, unit_cost: item.unit_cost, production_date: item.production_date, expiry_date: item.expiry_date, purchase_order_id: order.id });
    db.data.stock_movements.push({ id: db.nextId('stock_movements'), branch_id: req.branchId, product_id: product.id, type: 'purchase', quantity: item.quantity, reference_id: `PUR-${purchase.id}`, created_at: nowStr() });
  }
  const supplier = db.data.suppliers.find(row => row.id === order.supplier_id);
  supplier.balance = Number(supplier.balance || 0) + purchase.remaining_amount;
  addFinanceTransaction('supplier_transactions', { supplier_id: supplier.id, type: 'purchase', debit: total, credit: paid, reference_id: `PUR-${purchase.id}`, notes: `استلام أمر شراء ${order.order_number}` });
  if (paid > 0) addFinanceTransaction('cash_transactions', { type: 'purchase', amount: paid, direction: 'out', reference_id: `PUR-${purchase.id}`, notes: `سداد أمر شراء ${order.order_number}`, user_id: req.authUser.id, ...cashConfirmationFields(cashConfirmation) });
  order.status = 'received'; order.purchase_id = purchase.id; order.received_at = nowStr(); order.updated_at = nowStr();
  db.logAudit(req.authUser.id, 'استلام أمر شراء', 'purchase_orders', order.id, `استلام ${order.order_number} بفاتورة ${purchase.id}`, { save: false });
   return { order, purchase };
   }, connection => postPurchaseToAccounting({ ...purchase }, db.data.purchase_items.filter(item => Number(item.purchase_id) === Number(purchase.id)), connection));
  if (!committedReceipt) return;
  res.status(201).json(committedReceipt);
});

app.post('/api/purchases', (req, res) => {
  const { supplier_id, user_id, items } = req.body;
  if (!items || !items.length) {
    return res.status(400).json({ error: 'فاتورة الشراء تتطلب صنفاً واحداً على الأقل' });
  }

  for (const it of items) {
    const prod = db.data.products.find(p => p.id === Number(it.product_id));
    if (!prod) return res.status(400).json({ error: `المنتج رقم ${it.product_id} غير موجود` });
    if (!Number.isInteger(Number(it.quantity)) || Number(it.quantity) <= 0 || !Number.isFinite(Number(it.unit_cost)) || Number(it.unit_cost) < 0) {
      return res.status(400).json({ error: 'كمية الشراء أو سعر التكلفة غير صحيح' });
    }
    const dateError = productDateError(it.production_date || '', it.expiry_date || '');
    if (dateError) return res.status(400).json({ error: dateError });
  }

  let total = 0;
  items.forEach(it => {
    total += it.quantity * it.unit_cost;
  });

  const purchase = {
    id: db.nextId('purchases'),
    branch_id: req.branchId,
    supplier_id: supplier_id ? parseInt(supplier_id) : 1,
    user_id: user_id ? parseInt(user_id) : 1,
    total: parseFloat(total.toFixed(2)),
    paid_amount: Math.max(0, Math.min(parseFloat(req.body.paid_amount) || 0, parseFloat(total.toFixed(2)))),
    created_at: nowStr()
  };
  const committedPurchase = db.transaction(['purchases', 'purchase_items', 'products', 'branch_inventory', 'stock_movements', 'suppliers', 'supplier_transactions', 'cash_transactions', 'cash_audit_chain', 'audit_logs', 'warehouse_inventory', 'warehouse_stock_movements'], () => {
  const cashConfirmation = purchase.paid_amount > 0 ? requireCashBalanceConfirmation(req, res, purchase.paid_amount) : { negative: false };
  if (!cashConfirmation) return null;
  purchase.remaining_amount = parseFloat((purchase.total - purchase.paid_amount).toFixed(2));
  db.data.purchases.push(purchase);

  for (const it of items) {
    const prod = db.data.products.find(p => p.id === it.product_id);
    if (prod) {
      const quantityBefore = branchQuantity(req.branchId, prod.id);
      const oldCost = Number(prod.cost_price) || 0;
      const receivedQuantity = parseInt(it.quantity);
      // Weighted average cost uses the positive on-hand quantity at the
      // receiving branch. Zero/negative stock has no positive cost basis, so
      // the incoming unit cost becomes the new average. Sale price is never
      // touched here.
      const costBasisQuantity = Math.max(0, quantityBefore);
      const nextCost = costBasisQuantity > 0
        ? Number((((costBasisQuantity * oldCost) + (receivedQuantity * Number(it.unit_cost))) / (costBasisQuantity + receivedQuantity)).toFixed(4))
        : Number(Number(it.unit_cost).toFixed(4));
      setBranchQuantity(req.branchId, prod.id, quantityBefore + receivedQuantity);
      prod.cost_price = nextCost;
      if (it.expiry_date && (!prod.expiry_date || it.expiry_date < prod.expiry_date)) {
        prod.production_date = it.production_date || '';
        prod.expiry_date = it.expiry_date;
      } else if (it.production_date && !prod.production_date) {
        prod.production_date = it.production_date;
      }
      prod.updated_at = nowStr();

      db.data.purchase_items.push({
        id: db.nextId('purchase_items'),
        branch_id: req.branchId,
        purchase_id: purchase.id,
        product_id: prod.id,
        quantity: parseInt(it.quantity),
        remaining_quantity: parseInt(it.quantity),
        lot_number: String(it.lot_number || `LOT-${purchase.id}-${prod.id}`).trim().slice(0, 80),
        unit_cost: parseFloat(it.unit_cost),
        wac_quantity_before: quantityBefore,
        wac_cost_before: oldCost,
        wac_cost_after: nextCost,
        production_date: it.production_date || '',
        expiry_date: it.expiry_date || ''
      });

      db.data.stock_movements.push({
        id: db.nextId('stock_movements'),
        branch_id: req.branchId,
        product_id: prod.id,
        type: 'purchase',
        quantity: parseInt(it.quantity),
        reference_id: `PUR-${purchase.id}`,
        created_at: nowStr()
      });

      db.logAudit(user_id, 'تحديث متوسط تكلفة الشراء المرجح', 'products', prod.id, {
        purchase_id: purchase.id,
        product_id: prod.id,
        quantity_before: quantityBefore,
        received_quantity: receivedQuantity,
        purchase_unit_cost: Number(it.unit_cost),
        old_cost_price: oldCost,
        new_cost_price: nextCost,
        sale_price_unchanged: Number(prod.sale_price)
      }, { save: false });
    }
  }

  const supplier = db.data.suppliers.find(s => s.id === purchase.supplier_id);
  if (supplier) {
    supplier.balance = (supplier.balance || 0) + purchase.remaining_amount;
    addFinanceTransaction('supplier_transactions', {
      supplier_id: supplier.id,
      type: 'purchase',
      debit: purchase.total,
      credit: purchase.paid_amount,
      reference_id: `PUR-${purchase.id}`,
      notes: `فاتورة شراء ${purchase.id}`
    });
  }
  if (purchase.paid_amount > 0) {
    addFinanceTransaction('cash_transactions', { type: 'purchase', amount: purchase.paid_amount, direction: 'out', reference_id: `PUR-${purchase.id}`, notes: 'سداد شراء', user_id, ...cashConfirmationFields(cashConfirmation) });
  }

  db.logAudit(user_id, 'فاتورة شراء', 'purchases', purchase.id, `تسجيل فاتورة شراء رقم ${purchase.id} بقيمة ${purchase.total} ج.م`, { save: false });
   return purchase;
   }, connection => postPurchaseToAccounting({ ...purchase }, db.data.purchase_items.filter(item => Number(item.purchase_id) === Number(purchase.id)), connection));
  if (!committedPurchase) return;
  res.status(201).json(committedPurchase);
});

app.put('/api/purchases/:id', (req, res) => {
  const purchase = db.data.purchases.find(p => p.id === Number(req.params.id) && Number(p.branch_id || db.data.default_branch_id) === Number(req.branchId));
  if (!purchase || Number(purchase.branch_id || db.data.default_branch_id) !== Number(req.branchId) || purchase.status === 'cancelled') return res.status(404).json({ error: 'فاتورة الشراء غير موجودة' });
  if (Array.isArray(req.body.items)) {
    const replacementItems = req.body.items;
    if (!replacementItems.length) return res.status(400).json({ error: 'يجب أن تحتوي فاتورة الشراء على صنف واحد على الأقل.' });
    for (const item of replacementItems) {
      if (!db.data.products.some(product => Number(product.id) === Number(item.product_id))) return res.status(400).json({ error: `المنتج رقم ${item.product_id} غير موجود.` });
      if (!Number.isInteger(Number(item.quantity)) || Number(item.quantity) <= 0 || !Number.isFinite(Number(item.unit_cost)) || Number(item.unit_cost) < 0) return res.status(400).json({ error: 'كمية الشراء أو سعر التكلفة غير صحيح.' });
      const dateError = productDateError(item.production_date || '', item.expiry_date || '');
      if (dateError) return res.status(400).json({ error: dateError });
    }
    const previousItems = db.data.purchase_items.filter(item => Number(item.purchase_id) === Number(purchase.id) && !item.wac_reversed);
    const oldTotal = Number(purchase.total) || 0;
    const oldPaid = Number(purchase.paid_amount) || 0;
    const oldRemaining = Number(purchase.remaining_amount ?? Math.max(0, oldTotal - oldPaid)) || 0;
    const replacementTotal = Number(replacementItems.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_cost), 0).toFixed(2));
    const requestedPaid = req.body.paid_amount === undefined ? Math.min(oldPaid, replacementTotal) : Number(req.body.paid_amount);
    if (!Number.isFinite(requestedPaid) || requestedPaid < 0 || requestedPaid > replacementTotal) return res.status(400).json({ error: 'قيمة المدفوع غير صحيحة.' });
    const paidIncrease = Number((requestedPaid - oldPaid).toFixed(2));
    for (const item of previousItems) {
      if (Number(item.remaining_quantity ?? item.quantity) < Number(item.quantity)) return res.status(409).json({ error: `لا يمكن تعديل الفاتورة بعد استخدام تشغيلة ${item.lot_number || item.id}. ألغِ الفاتورة ثم سجّل شراءً جديداً.` });
      const product = db.data.products.find(row => Number(row.id) === Number(item.product_id));
      if (!product || branchQuantity(req.branchId, item.product_id) < Number(item.quantity)) return res.status(409).json({ error: `رصيد ${product?.name || 'الصنف'} لا يسمح بعكس فاتورة الشراء.` });
    }
    const affectedProductIds = new Set([...previousItems.map(item => Number(item.product_id)), ...replacementItems.map(item => Number(item.product_id))]);
    const laterPurchaseExists = db.data.purchase_items.some(item => affectedProductIds.has(Number(item.product_id)) && Number(item.branch_id || db.data.default_branch_id) === Number(req.branchId) && !item.wac_reversed && Number(item.purchase_id) > Number(purchase.id) && db.data.purchases.some(row => Number(row.id) === Number(item.purchase_id) && row.status !== 'cancelled'));
    if (laterPurchaseExists) return res.status(409).json({ error: 'لا يمكن تعديل أصناف فاتورة لها مشتريات أحدث لنفس الصنف. ألغِها بعد التأكد من المخزون ثم سجّل فاتورة جديدة.' });
    const committedEdit = db.transaction(['purchases', 'purchase_items', 'products', 'branch_inventory', 'stock_movements', 'suppliers', 'supplier_transactions', 'cash_transactions', 'cash_audit_chain', 'audit_logs', 'warehouse_inventory', 'warehouse_stock_movements'], () => {
    const cashConfirmation = paidIncrease > 0 ? requireCashBalanceConfirmation(req, res, paidIncrease) : { negative: false };
    if (!cashConfirmation) return null;
    const oldProductIds = [...new Set(previousItems.map(item => Number(item.product_id)))];
    for (const item of previousItems) {
      const product = db.data.products.find(row => Number(row.id) === Number(item.product_id));
      setBranchQuantity(req.branchId, item.product_id, branchQuantity(req.branchId, item.product_id) - Number(item.quantity));
      item.wac_reversed = true;
      item.wac_reversed_at = nowStr();
      item.remaining_quantity = 0;
      db.data.stock_movements.push({ id: db.nextId('stock_movements'), branch_id: req.branchId, product_id: Number(item.product_id), type: 'adjustment', quantity: -Number(item.quantity), reference_id: `EDIT-PUR-${purchase.id}`, created_at: nowStr() });
      if (product) product.updated_at = nowStr();
    }
    for (const productId of oldProductIds) {
      const product = db.data.products.find(row => Number(row.id) === productId);
      const baseline = recomputeProductWacForBranch(productId, req.branchId);
      if (product && baseline !== null) product.cost_price = baseline;
    }

    const newProductIds = new Set();
    for (const item of replacementItems) {
      const product = db.data.products.find(row => Number(row.id) === Number(item.product_id));
      const quantity = Number(item.quantity);
      const unitCost = Number(item.unit_cost);
      const quantityBefore = branchQuantity(req.branchId, product.id);
      const oldCost = Number(product.cost_price) || 0;
      const basis = Math.max(0, quantityBefore);
      const newCost = basis > 0 ? Number((((basis * oldCost) + (quantity * unitCost)) / (basis + quantity)).toFixed(4)) : Number(unitCost.toFixed(4));
      setBranchQuantity(req.branchId, product.id, quantityBefore + quantity);
      product.cost_price = newCost;
      product.updated_at = nowStr();
      const row = { id: db.nextId('purchase_items'), branch_id: req.branchId, purchase_id: purchase.id, product_id: product.id, quantity, remaining_quantity: quantity, lot_number: String(item.lot_number || `LOT-${purchase.id}-${product.id}`).trim().slice(0, 80), unit_cost: unitCost, wac_quantity_before: quantityBefore, wac_cost_before: oldCost, wac_cost_after: newCost, wac_edit_replacement: true, production_date: item.production_date || '', expiry_date: item.expiry_date || '' };
      db.data.purchase_items.push(row);
      db.data.stock_movements.push({ id: db.nextId('stock_movements'), branch_id: req.branchId, product_id: product.id, type: 'purchase', quantity, reference_id: `PUR-${purchase.id}`, created_at: nowStr() });
      db.logAudit(req.body.current_user_id, 'تحديث متوسط تكلفة الشراء المرجح', 'products', product.id, { purchase_id: purchase.id, product_id: product.id, quantity_before: quantityBefore, received_quantity: quantity, purchase_unit_cost: unitCost, old_cost_price: oldCost, new_cost_price: newCost, sale_price_unchanged: Number(product.sale_price), edit: true }, { save: false });
      newProductIds.add(Number(product.id));
    }
    for (const productId of newProductIds) {
      const product = db.data.products.find(row => Number(row.id) === productId);
      const latestCost = recomputeProductWacForBranch(productId, req.branchId);
      if (product && latestCost !== null) product.cost_price = latestCost;
    }
    purchase.total = replacementTotal;
    purchase.paid_amount = Number(requestedPaid.toFixed(2));
    purchase.remaining_amount = Number((purchase.total - purchase.paid_amount).toFixed(2));
    const supplier = db.data.suppliers.find(row => Number(row.id) === Number(purchase.supplier_id));
    if (supplier) supplier.balance = Math.max(0, (Number(supplier.balance) || 0) + purchase.remaining_amount - oldRemaining);
    const totalDelta = purchase.total - oldTotal;
    const paidDelta = purchase.paid_amount - oldPaid;
    if (totalDelta !== 0) addFinanceTransaction('supplier_transactions', { supplier_id: purchase.supplier_id, type: 'purchase_items_edit', debit: Math.max(0, totalDelta), credit: Math.max(0, -totalDelta), reference_id: `PUR-${purchase.id}`, notes: 'تعديل أصناف فاتورة شراء' });
    if (paidDelta !== 0) {
      addFinanceTransaction('cash_transactions', { type: 'purchase_payment_edit', amount: Math.abs(paidDelta), direction: paidDelta > 0 ? 'out' : 'in', reference_id: `PUR-${purchase.id}`, notes: 'تعديل مدفوع فاتورة شراء', user_id: req.authUser.id, ...cashConfirmationFields(cashConfirmation) });
      addFinanceTransaction('supplier_transactions', { supplier_id: purchase.supplier_id, type: 'purchase_payment_edit', debit: paidDelta < 0 ? -paidDelta : 0, credit: paidDelta > 0 ? paidDelta : 0, reference_id: `PUR-${purchase.id}`, notes: 'تعديل مدفوع فاتورة شراء' });
    }
    purchase.updated_at = nowStr();
    db.logAudit(req.body.current_user_id, 'تعديل أصناف فاتورة شراء', 'purchases', purchase.id, `تعديل أصناف فاتورة الشراء ${purchase.id}`, { save: false });
    return purchase;
    });
    if (!committedEdit) return;
    return res.json(committedEdit);
  }
  const nextPaid = Number(req.body.paid_amount);
  if (!Number.isFinite(nextPaid) || nextPaid < 0 || nextPaid > purchase.total) return res.status(400).json({ error: 'قيمة المدفوع غير صحيحة' });
  const committedPayment = db.transaction(['purchases', 'suppliers', 'cash_transactions', 'cash_audit_chain', 'supplier_transactions', 'audit_logs'], () => {
  const oldPaid = purchase.paid_amount || 0;
  const paidIncrease = Number((nextPaid - oldPaid).toFixed(2));
  const cashConfirmation = paidIncrease > 0 ? requireCashBalanceConfirmation(req, res, paidIncrease) : { negative: false };
  if (!cashConfirmation) return null;
  const oldRemaining = purchase.remaining_amount || Math.max(0, purchase.total - (purchase.paid_amount || 0));
  purchase.paid_amount = parseFloat(nextPaid.toFixed(2));
  purchase.remaining_amount = parseFloat((purchase.total - purchase.paid_amount).toFixed(2));
  const supplier = db.data.suppliers.find(s => s.id === purchase.supplier_id);
  if (supplier) supplier.balance = Math.max(0, (supplier.balance || 0) + purchase.remaining_amount - oldRemaining);
  const deltaPaid = purchase.paid_amount - oldPaid;
  if (deltaPaid !== 0) addFinanceTransaction('cash_transactions', { type: 'purchase_payment_edit', amount: Math.abs(deltaPaid), direction: deltaPaid > 0 ? 'out' : 'in', reference_id: `PUR-${purchase.id}`, notes: 'تعديل مدفوع فاتورة شراء', user_id: req.authUser.id, ...cashConfirmationFields(cashConfirmation) });
  if (deltaPaid !== 0) addFinanceTransaction('supplier_transactions', { supplier_id: purchase.supplier_id, type: 'purchase_payment_edit', debit: deltaPaid < 0 ? -deltaPaid : 0, credit: deltaPaid > 0 ? deltaPaid : 0, reference_id: `PUR-${purchase.id}`, notes: 'تعديل مدفوع فاتورة شراء' });
  db.logAudit(req.body.current_user_id, 'تعديل فاتورة شراء', 'purchases', purchase.id, `تعديل المدفوع للفاتورة ${purchase.id}`, { save: false });
  return purchase;
  });
  if (!committedPayment) return;
  res.json(committedPayment);
});

function recomputeProductWacForBranch(productId, branchId) {
  const rows = db.data.purchase_items
    .filter(item => Number(item.product_id) === Number(productId) && Number(item.branch_id || db.data.default_branch_id) === Number(branchId))
    .map(item => ({ item, purchase: db.data.purchases.find(row => Number(row.id) === Number(item.purchase_id)) }))
    .filter(row => row.purchase)
    .sort((a, b) => String(a.purchase.created_at || '').localeCompare(String(b.purchase.created_at || ''))
      || Number(a.purchase.id) - Number(b.purchase.id) || Number(a.item.id) - Number(b.item.id));
  const first = rows.find(row => Number.isFinite(Number(row.item.wac_cost_before)));
  if (!first) return null;
  let cost = Number(first.item.wac_cost_before) || 0;
  let cancelledQuantityBefore = 0;
  const purchaseIdsWithReplacements = new Set(rows.filter(row => row.item.wac_edit_replacement).map(row => Number(row.item.purchase_id)));
  for (const { item, purchase } of rows) {
    const quantity = Number(item.quantity) || 0;
    if (item.wac_reversed) { if (!purchaseIdsWithReplacements.has(Number(item.purchase_id))) cancelledQuantityBefore += quantity; continue; }
    if (purchase.status === 'cancelled') { cancelledQuantityBefore += quantity; continue; }
    const recordedStock = Number(item.wac_quantity_before);
    if (!Number.isFinite(recordedStock)) continue;
    const basis = Math.max(0, recordedStock - cancelledQuantityBefore);
    const unitCost = Number(item.unit_cost) || 0;
    cost = basis > 0
      ? Number((((basis * cost) + (quantity * unitCost)) / (basis + quantity)).toFixed(4))
      : Number(unitCost.toFixed(4));
  }
  return cost;
}

app.delete('/api/purchases/:id', (req, res) => {
  const purchase = db.data.purchases.find(p => p.id === Number(req.params.id) && Number(p.branch_id || db.data.default_branch_id) === Number(req.branchId));
  if (!purchase || Number(purchase.branch_id || db.data.default_branch_id) !== Number(req.branchId) || purchase.status === 'cancelled') return res.status(404).json({ error: 'فاتورة الشراء غير موجودة أو ملغاة' });
  const items = db.data.purchase_items.filter(i => i.purchase_id === purchase.id && !i.wac_reversed);
  for (const item of items) {
    const product = db.data.products.find(p => p.id === item.product_id);
    if (!product || branchQuantity(req.branchId, item.product_id) < item.quantity) return res.status(400).json({ error: `لا يمكن حذف الفاتورة لأن مخزون [${product?.name || 'منتج'}] استُخدم بعد الشراء` });
  }
  const previousCosts = new Map(items.map(item => [Number(item.product_id), Number(db.data.products.find(row => Number(row.id) === Number(item.product_id))?.cost_price) || 0]));
  items.forEach(item => {
    const product = db.data.products.find(p => p.id === item.product_id);
    setBranchQuantity(req.branchId, product.id, branchQuantity(req.branchId, product.id) - item.quantity);
    db.data.stock_movements.push({ id: db.nextId('stock_movements'), branch_id: req.branchId, product_id: product.id, type: 'adjustment', quantity: -item.quantity, reference_id: `CANCEL-PUR-${purchase.id}`, created_at: nowStr() });
  });
  purchase.status = 'cancelled';
  for (const productId of new Set(items.map(item => item.product_id))) {
    const product = db.data.products.find(p => p.id === productId);
    if (!product) continue;
    const oldCost = previousCosts.get(Number(productId)) || 0;
    const restoredCost = recomputeProductWacForBranch(productId, req.branchId);
    if (restoredCost !== null) {
      product.cost_price = restoredCost;
      product.updated_at = nowStr();
      db.logAudit(req.query.current_user_id, 'عكس تحديث متوسط تكلفة الشراء المرجح', 'products', product.id, {
        purchase_id: purchase.id,
        product_id: product.id,
        old_cost_price: oldCost,
        new_cost_price: restoredCost,
        sale_price_unchanged: Number(product.sale_price)
      }, { save: false });
    }
    const activeDatedItems = db.data.purchase_items
      .filter(item => item.product_id === productId && Number(item.branch_id || db.data.default_branch_id) === Number(req.branchId) && item.expiry_date)
      .filter(item => db.data.purchases.some(entry => entry.id === item.purchase_id && Number(entry.branch_id || db.data.default_branch_id) === Number(req.branchId) && entry.status !== 'cancelled'))
      .sort((a, b) => String(a.expiry_date).localeCompare(String(b.expiry_date)));
    if (activeDatedItems.length) {
      product.production_date = activeDatedItems[0].production_date || '';
      product.expiry_date = activeDatedItems[0].expiry_date;
    } else if (items.some(item => item.product_id === productId && item.expiry_date === product.expiry_date)) {
      product.production_date = '';
      product.expiry_date = '';
    }
  }
  const supplier = db.data.suppliers.find(s => s.id === purchase.supplier_id);
  if (supplier) supplier.balance = Math.max(0, (supplier.balance || 0) - (purchase.remaining_amount || 0));
  if (purchase.paid_amount > 0) addFinanceTransaction('cash_transactions', { type: 'purchase_cancel', amount: purchase.paid_amount, direction: 'in', reference_id: `PUR-${purchase.id}`, notes: 'إلغاء فاتورة شراء', user_id: req.authUser.id });
  db.logAudit(req.query.current_user_id, 'حذف فاتورة شراء', 'purchases', purchase.id, `إلغاء فاتورة الشراء ${purchase.id}`, { save: false });
  db.save(['purchases', 'purchase_items', 'products', 'branch_inventory', 'stock_movements', 'suppliers', 'cash_transactions', 'cash_audit_chain', 'audit_logs', 'warehouse_inventory', 'warehouse_stock_movements']);
  res.json({ message: 'تم إلغاء فاتورة الشراء وإرجاع أثرها على المخزون والحسابات' });
});

// ---- أوامر الشغل والخدمات (غسيل، ترزية، صيانة) ----
const SERVICE_ORDER_TYPES = new Set(['غسيل', 'ترزية', 'صيانة', 'أخرى']);
const SERVICE_ORDER_STATUSES = new Set(['received', 'in_progress', 'ready', 'delivered']);
app.get('/api/service-orders', (req, res) => {
  const rows = branchStockFilter(db.data.service_orders || [], req.branchId).map(order => ({
    ...order,
    customer_name: db.data.customers.find(customer => customer.id === Number(order.customer_id))?.name || 'عميل نقدي',
    customer_phone: db.data.customers.find(customer => customer.id === Number(order.customer_id))?.phone || '',
    user_name: db.data.users.find(user => user.id === Number(order.user_id))?.name || 'موظف'
  }));
  res.json(rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))));
});
app.post('/api/service-orders', (req, res) => {
  const type = String(req.body?.type || '').trim();
  const description = String(req.body?.description || '').trim();
  const customerId = Number(req.body?.customer_id || 1);
  const total = Number(req.body?.total ?? 0);
  const deposit = Number(req.body?.deposit || 0);
  const dueDate = String(req.body?.due_date || '').slice(0, 10);
  if (!SERVICE_ORDER_TYPES.has(type) || !description || description.length > 500) return res.status(400).json({ error: 'نوع الخدمة ووصف العمل مطلوبان.' });
  if (!Number.isFinite(total) || total < 0 || total > 1000000000 || !Number.isFinite(deposit) || deposit < 0 || deposit > total) return res.status(400).json({ error: 'الإجمالي أو العربون غير صحيح.' });
  if (!db.data.customers.some(customer => customer.id === customerId)) return res.status(400).json({ error: 'العميل المحدد غير موجود.' });
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return res.status(400).json({ error: 'تاريخ التسليم غير صحيح.' });
  const id = db.nextId('service_orders');
  const order = { id, branch_id: req.branchId, order_number: `JOB-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(id).padStart(4, '0')}`, type, description, customer_id: customerId, user_id: req.authUser.id, total: Number(total.toFixed(2)), deposit: Number(deposit.toFixed(2)), paid_amount: Number(deposit.toFixed(2)), remaining_amount: Number((total - deposit).toFixed(2)), due_date: dueDate, status: 'received', payments: [], created_at: nowStr(), updated_at: nowStr() };
  if (deposit > 0) order.payments.push({ amount: order.deposit, method: String(req.body?.payment_method || 'نقدي'), created_at: order.created_at, user_id: req.authUser.id, type: 'deposit' });
  db.data.service_orders.push(order);
  if (deposit > 0) addFinanceTransaction('cash_transactions', { type: 'service_order_deposit', amount: order.deposit, direction: 'in', reference_id: order.order_number, notes: `عربون أمر شغل ${type}`, user_id: req.authUser.id, shift_id: openCashierShift(req.authUser.id)?.id || null });
  if (customerId > 1) {
    const customer = db.data.customers.find(item => item.id === customerId);
    customer.balance = Number((Number(customer.balance || 0) + order.remaining_amount).toFixed(2));
    addFinanceTransaction('customer_transactions', { customer_id: customerId, type: 'service_order', debit: order.total, credit: order.deposit, reference_id: order.order_number, notes: `أمر شغل ${type}: ${description}` });
  }
  db.save();
  db.logAudit(req.authUser.id, 'إنشاء أمر شغل', 'service_orders', id, `${order.order_number} — ${type} — ${order.total} ج.م`);
  res.status(201).json(order);
});
app.put('/api/service-orders/:id', (req, res) => {
  const order = db.data.service_orders.find(row => row.id === Number(req.params.id) && Number(row.branch_id || db.data.default_branch_id) === Number(req.branchId));
  if (!order) return res.status(404).json({ error: 'أمر الشغل غير موجود.' });
  const status = String(req.body?.status || order.status);
  if (!SERVICE_ORDER_STATUSES.has(status)) return res.status(400).json({ error: 'حالة أمر الشغل غير صحيحة.' });
  order.status = status;
  order.updated_at = nowStr();
  db.save();
  db.logAudit(req.authUser.id, 'تحديث حالة أمر شغل', 'service_orders', order.id, `${order.order_number} — ${status}`);
  res.json(order);
});
app.post('/api/service-orders/:id/payments', (req, res) => {
  const order = db.data.service_orders.find(row => row.id === Number(req.params.id) && Number(row.branch_id || db.data.default_branch_id) === Number(req.branchId));
  if (!order) return res.status(404).json({ error: 'أمر الشغل غير موجود.' });
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > Number(order.remaining_amount || 0)) return res.status(400).json({ error: 'قيمة السداد يجب أن تكون أكبر من صفر ولا تتجاوز المتبقي.' });
  const value = Number(amount.toFixed(2));
  const payment = { amount: value, method: String(req.body?.method || 'نقدي'), created_at: nowStr(), user_id: req.authUser.id, type: 'payment' };
  if (!Array.isArray(order.payments)) order.payments = [];
  order.payments.push(payment);
  order.paid_amount = Number((Number(order.paid_amount || 0) + value).toFixed(2));
  order.remaining_amount = Number(Math.max(0, Number(order.total) - order.paid_amount).toFixed(2));
  order.updated_at = payment.created_at;
  addFinanceTransaction('cash_transactions', { type: 'service_order_payment', amount: value, direction: 'in', reference_id: order.order_number, notes: `تحصيل أمر شغل ${order.type}`, user_id: req.authUser.id, shift_id: openCashierShift(req.authUser.id)?.id || null });
  if (Number(order.customer_id) > 1) {
    const customer = db.data.customers.find(item => item.id === Number(order.customer_id));
    if (customer) customer.balance = Number(Math.max(0, Number(customer.balance || 0) - value).toFixed(2));
    addFinanceTransaction('customer_transactions', { customer_id: Number(order.customer_id), type: 'service_order_payment', debit: 0, credit: value, reference_id: order.order_number, notes: 'سداد أمر شغل' });
  }
  db.save();
  db.logAudit(req.authUser.id, 'تحصيل أمر شغل', 'service_orders', order.id, `${order.order_number} — ${value} ج.م`);
  res.status(201).json({ order, payment });
});

// ---- عقود التقسيط وجدول الاستحقاق ----
app.get('/api/installments', (req, res) => {
  const rows = branchStockFilter(db.data.installment_contracts || [], req.branchId).map(contract => ({
    ...contract,
    customer_name: db.data.customers.find(customer => customer.id === Number(contract.customer_id))?.name || '',
    invoice_number: db.data.sales.find(sale => sale.id === Number(contract.sale_id))?.invoice_number || ''
  }));
  res.json(rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))));
});
app.post('/api/installments', (req, res) => {
  const sale = db.data.sales.find(row => row.id === Number(req.body?.sale_id) && Number(row.branch_id || db.data.default_branch_id) === Number(req.branchId));
  if (!sale || Number(sale.customer_id) <= 1) return res.status(400).json({ error: 'اختر فاتورة غير مسددة لعميل مسجل.' });
  if ((db.data.installment_contracts || []).some(contract => Number(contract.sale_id) === sale.id)) return res.status(409).json({ error: 'تم إعداد جدول تقسيط لهذه الفاتورة بالفعل.' });
  const balance = Number((Number(sale.total || 0) - Number(sale.paid_amount || 0) - Number(sale.additional_paid_amount || 0)).toFixed(2));
  const count = Number(req.body?.count);
  const frequency = String(req.body?.frequency || 'monthly');
  const firstDue = String(req.body?.first_due_date || '').slice(0, 10);
  if (balance <= 0) return res.status(400).json({ error: 'الفاتورة ليس عليها مبلغ متبقٍ للتقسيط.' });
  if (!Number.isInteger(count) || count < 1 || count > 120) return res.status(400).json({ error: 'عدد الأقساط يجب أن يكون من 1 إلى 120.' });
  if (!['weekly', 'monthly'].includes(frequency)) return res.status(400).json({ error: 'دورية الأقساط غير صحيحة.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(firstDue) || Number.isNaN(Date.parse(`${firstDue}T00:00:00Z`))) return res.status(400).json({ error: 'تاريخ أول قسط غير صحيح.' });
  const baseCents = Math.floor(Math.round(balance * 100) / count);
  const remainder = Math.round(balance * 100) - baseCents * count;
  const first = new Date(`${firstDue}T00:00:00Z`);
  const schedule = Array.from({ length: count }, (_, index) => {
    let due = new Date(first);
    if (frequency === 'weekly') due.setUTCDate(due.getUTCDate() + index * 7);
    else {
      const day = first.getUTCDate();
      due.setUTCDate(1);
      due.setUTCMonth(due.getUTCMonth() + index);
      const lastDay = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 0)).getUTCDate();
      due.setUTCDate(Math.min(day, lastDay));
    }
    return { id: index + 1, due_date: due.toISOString().slice(0, 10), amount: Number(((baseCents + (index < remainder ? 1 : 0)) / 100).toFixed(2)), paid_amount: 0, status: 'due' };
  });
  const id = db.nextId('installment_contracts');
  const contract = { id, branch_id: req.branchId, contract_number: `INS-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(id).padStart(4, '0')}`, sale_id: sale.id, customer_id: Number(sale.customer_id), total: balance, paid_amount: 0, remaining_amount: balance, frequency, schedule, payments: [], status: 'active', created_at: nowStr(), created_by: req.authUser.id };
  db.data.installment_contracts.push(contract);
  db.save();
  db.logAudit(req.authUser.id, 'إنشاء جدول تقسيط', 'installment_contracts', id, `${contract.contract_number} — ${count} قسط — ${balance} ج.م`);
  res.status(201).json(contract);
});
app.post('/api/installments/:id/payments', (req, res) => {
  const contract = db.data.installment_contracts.find(row => row.id === Number(req.params.id));
  if (!contract) return res.status(404).json({ error: 'عقد التقسيط غير موجود.' });
  const installmentId = Number(req.body?.installment_id);
  const installment = contract.schedule.find(row => row.id === installmentId);
  const amount = Number(req.body?.amount);
  const remainingDue = installment ? Number((installment.amount - installment.paid_amount).toFixed(2)) : 0;
  if (!installment || !Number.isFinite(amount) || amount <= 0 || amount > remainingDue) return res.status(400).json({ error: 'قيمة السداد لا تتجاوز باقي القسط المحدد.' });
  const value = Number(amount.toFixed(2));
  const payment = { id: contract.payments.length + 1, installment_id: installment.id, amount: value, method: String(req.body?.method || 'نقدي'), created_at: nowStr(), user_id: req.authUser.id };
  contract.payments.push(payment);
  installment.paid_amount = Number((installment.paid_amount + value).toFixed(2));
  installment.status = installment.paid_amount >= installment.amount ? 'paid' : 'partial';
  installment.paid_at = payment.created_at;
  contract.paid_amount = Number((contract.paid_amount + value).toFixed(2));
  contract.remaining_amount = Number(Math.max(0, contract.total - contract.paid_amount).toFixed(2));
  if (contract.remaining_amount === 0) contract.status = 'completed';
  const sale = db.data.sales.find(row => row.id === contract.sale_id);
  if (sale) sale.additional_paid_amount = Number((Number(sale.additional_paid_amount || 0) + value).toFixed(2));
  const customer = db.data.customers.find(row => row.id === contract.customer_id);
  if (customer) customer.balance = Number(Math.max(0, Number(customer.balance || 0) - value).toFixed(2));
  addFinanceTransaction('customer_transactions', { customer_id: contract.customer_id, type: 'installment_payment', debit: 0, credit: value, reference_id: contract.contract_number, notes: `سداد القسط ${installment.id}` });
  addFinanceTransaction('cash_transactions', { type: 'installment_payment', amount: value, direction: 'in', reference_id: contract.contract_number, notes: `تحصيل قسط رقم ${installment.id}`, user_id: req.authUser.id, shift_id: openCashierShift(req.authUser.id)?.id || null });
  db.save();
  db.logAudit(req.authUser.id, 'تحصيل قسط', 'installment_contracts', contract.id, `${contract.contract_number} — ${value} ج.م`);
  res.status(201).json({ contract, installment, payment });
});

// ----------------------------------------------------
// Stock Movements & Inventory Adjustment
// ----------------------------------------------------
app.get('/api/stock-movements', (req, res) => {
  const movements = branchStockFilter(db.data.stock_movements, req.branchId).map(m => {
    const prod = db.data.products.find(p => p.id === m.product_id);
    return {
      ...m,
      product_name: prod ? prod.name : 'منتج غير معروف',
      product_barcode: prod ? prod.barcode : ''
    };
  });
  res.json(movements.reverse().slice(0, 100));
});

app.post('/api/inventory/adjust', (req, res) => {
  const { product_id, quantity, reason, current_user_id } = req.body;
  const prod = db.data.products.find(p => p.id === parseInt(product_id));
  if (!prod) return res.status(404).json({ error: 'المنتج غير موجود' });

  if (!Number.isInteger(Number(quantity)) || Number(quantity) < 0) {
    return res.status(400).json({ error: 'كمية المخزون يجب أن تكون رقماً صحيحاً غير سالب' });
  }

  const oldQty = branchQuantity(req.branchId, prod.id);
  const newQty = parseInt(quantity);
  const diff = newQty - oldQty;
  setBranchQuantity(req.branchId, prod.id, newQty);
  prod.updated_at = nowStr();

  db.data.stock_movements.push({
    id: db.nextId('stock_movements'), branch_id: req.branchId,
    product_id: prod.id,
    type: 'adjustment',
    quantity: diff,
    reference_id: reason || 'تسوية جرد دوري',
    created_at: nowStr()
  });

  db.save(['products', 'branch_inventory', 'stock_movements', 'audit_logs', 'warehouse_inventory', 'warehouse_stock_movements']);
  db.logAudit(current_user_id, 'تسوية مخزنية', 'products', prod.id, `تسوية رصيد ${prod.name} من ${oldQty} إلى ${newQty}. السبب: ${reason || 'جرد'}`);
  res.json({ message: 'تم تحديث رصيد المخزون بنجاح', product: prod });
});

// ----------------------------------------------------
// Audit Logs
// ----------------------------------------------------
app.get('/api/audit-logs', (req, res) => {
  const logs = db.data.audit_logs.map(log => {
    const user = db.data.users.find(u => u.id === log.user_id);
    return {
      ...log,
      user_name: log.user_id === null || log.user_id === undefined ? 'بدون حساب' : user ? user.name : 'النظام'
    };
  });
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const requestedOffset = Number.parseInt(req.query.offset, 10);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 200) : 200;
  const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
  res.set('X-Pagination-Total', String(logs.length));
  res.set('X-Pagination-Offset', String(offset));
  res.set('X-Pagination-Limit', String(limit));
  res.set('X-Pagination-Has-More', String(offset + limit < logs.length));
  res.json(logs.slice(offset, offset + limit));
});

// ----------------------------------------------------
// Dashboard & Financial Reports
// ----------------------------------------------------
app.get('/api/dashboard', (req, res) => {
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const thisMonthPrefix = new Date().toISOString().slice(0, 7);

  // Sales today
  // Returned invoices remain in history but are removed from active sales totals.
  const branchSales = branchStockFilter(db.data.sales, req.branchId);
  const branchSaleIds = new Set(branchSales.map(sale => sale.id));
  const branchSaleItems = (db.data.sale_items || []).filter(item => branchSaleIds.has(item.sale_id));
  const salesToday = branchSales.filter(s => s.created_at.startsWith(todayPrefix) && s.status !== 'returned');
  const todayTotalSales = salesToday.reduce((sum, s) => sum + s.total, 0);
  const todayInvoicesCount = salesToday.length;

  // Sales this month
  const salesMonth = branchSales.filter(s => s.created_at.startsWith(thisMonthPrefix) && s.status !== 'returned');
  const monthTotalSales = salesMonth.reduce((sum, s) => sum + s.total, 0);

  // Profit calculation (SPEC-KIT rule: actual sale_price - cost_price * quantity)
  let todayProfit = 0;
  for (const s of salesToday) {
    const items = branchSaleItems.filter(item => item.sale_id === s.id);
    for (const it of items) {
      const profitPerItem = (it.unit_price - (it.cost_price || 0)) * it.quantity;
      todayProfit += (profitPerItem - (it.discount || 0));
    }
  }

  let monthProfit = 0;
  for (const s of salesMonth) {
    const items = branchSaleItems.filter(item => item.sale_id === s.id);
    for (const it of items) {
      const profitPerItem = (it.unit_price - (it.cost_price || 0)) * it.quantity;
      monthProfit += (profitPerItem - (it.discount || 0));
    }
  }

  // Low stock products alert
  const lowStockProducts = db.data.products.map(product => { const stock=getBranchInventoryRow(req.branchId,product.id); const cat=db.data.categories.find(c=>c.id===product.category_id); return {id:product.id,name:product.name,category:cat?.name||'',quantity:Number(stock?.quantity||0),min_stock:Number(stock?.min_stock||0),is_out_of_stock:Number(stock?.quantity||0)===0}; }).filter(product=>product.quantity<=product.min_stock);

  // Top selling products
  const productSalesMap = {};
  branchSaleItems.forEach(it => {
    productSalesMap[it.product_id] = (productSalesMap[it.product_id] || 0) + it.quantity;
  });

  const topSelling = Object.keys(productSalesMap)
    .map(pid => {
      const prod = db.data.products.find(p => p.id === parseInt(pid));
      return {
        id: pid,
        name: prod ? prod.name : 'غير محدد',
        total_sold: productSalesMap[pid],
        sale_price: prod ? prod.sale_price : 0
      };
    })
    .sort((a, b) => b.total_sold - a.total_sold)
    .slice(0, 5);

  // Last 7 days sales data for chart
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const daySales = branchSales
      .filter(s => s.created_at.startsWith(dateStr))
      .reduce((sum, s) => sum + s.total, 0);
    last7Days.push({
      date: dateStr,
      dayName: d.toLocaleDateString('ar-EG', { weekday: 'short' }),
      total: daySales
    });
  }

  res.json({
    summary_cards: {
      today_sales: parseFloat(todayTotalSales.toFixed(2)),
      today_profit: parseFloat(todayProfit.toFixed(2)),
      today_invoices_count: todayInvoicesCount
    },
    today_sales: parseFloat(todayTotalSales.toFixed(2)),
    today_profit: parseFloat(todayProfit.toFixed(2)),
    today_invoices_count: todayInvoicesCount,
    month_sales: parseFloat(monthTotalSales.toFixed(2)),
    month_profit: parseFloat(monthProfit.toFixed(2)),
    total_products_count: db.data.products.length,
    low_stock_count: lowStockProducts.length,
    low_stock_products: lowStockProducts,
    top_selling: topSelling,
    last_7_days: last7Days
  });
});

app.get('/api/alerts/owner', (req, res) => {
  const alerts = [];
  const today = new Date(`${businessDateToday()}T00:00:00.000Z`);
  for (const product of db.data.products) {
    const stock=getBranchInventoryRow(req.branchId,product.id); if(Number(stock?.quantity||0)<=Number(stock?.min_stock||0)) alerts.push({type:'low_stock',product_id:product.id,name:product.name,message:`مخزون منخفض: ${product.name} (${stock?.quantity||0} متبقي)`});
    const productLots = db.data.purchase_items.filter(item => Number(item.branch_id || db.data.default_branch_id) === Number(req.branchId) && item.product_id === product.id && Object.prototype.hasOwnProperty.call(item, 'remaining_quantity') && Number(item.remaining_quantity) > 0 && item.expiry_date);
    if (productLots.length) {
      for (const lot of productLots) {
        const days = getDaysUntilExpiry(lot.expiry_date);
        if (days !== null && days <= EXPIRY_WARNING_DAYS) alerts.push({ type: 'expiry', product_id: product.id, lot_id: lot.id, lot_number: lot.lot_number || '', quantity: lot.remaining_quantity, days, message: days < 0 ? `تشغيلة منتهية: ${product.name} (${lot.lot_number || lot.id})` : `تشغيلة ${product.name} (${lot.lot_number || lot.id}) تنتهي خلال ${days} يوم` });
      }
    } else {
      const daysToExpiry = getDaysUntilExpiry(product.expiry_date);
      if (daysToExpiry !== null && daysToExpiry <= EXPIRY_WARNING_DAYS) alerts.push({ type: 'expiry', product_id: product.id, name: product.name, days: daysToExpiry, message: daysToExpiry < 0 ? `منتهي الصلاحية: ${product.name}` : `قارب انتهاء الصلاحية: ${product.name} خلال ${daysToExpiry} يوم` });
    }
    if (Number(stock?.quantity || 0) > 0) {
      const soldItems = db.data.sale_items.filter(item => item.product_id === product.id && Number(item.branch_id || db.data.default_branch_id) === Number(req.branchId));
      const latestSale = soldItems.map(item => db.data.sales.find(sale => sale.id === item.sale_id)?.created_at).filter(Boolean).sort().at(-1);
      const lastActivity = latestSale || product.created_at;
      if (lastActivity) {
        const daysSinceSale = Math.floor((today - new Date(String(lastActivity).slice(0, 10) + 'T00:00:00')) / 86400000);
        if (daysSinceSale >= 90) alerts.push({ type: 'dead_stock', product_id: product.id, name: product.name, days: daysSinceSale, message: `بضاعة راكدة: ${product.name} بلا بيع منذ ${daysSinceSale} يوم` });
      }
    }
    const purchaseCosts = db.data.purchase_items.filter(item => Number(item.branch_id || db.data.default_branch_id) === Number(req.branchId) && item.product_id === product.id).map(item => ({ cost: Number(item.unit_cost), date: db.data.purchases.find(purchase => purchase.id === item.purchase_id)?.created_at || '', purchase_id: Number(item.purchase_id) })).filter(item => item.cost > 0).sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.purchase_id - a.purchase_id);
    if (purchaseCosts.length >= 2 && purchaseCosts[1].cost > 0 && purchaseCosts[0].cost >= purchaseCosts[1].cost * 1.2) {
      const percent = Math.round((purchaseCosts[0].cost / purchaseCosts[1].cost - 1) * 100);
      alerts.push({ type: 'cost_increase', product_id: product.id, increase_percent: percent, message: `زيادة تكلفة ${product.name} بنسبة ${percent}% مقارنة بآخر توريد سابق` });
    }
  }
  const walletAlerts = listWalletAlerts(db.storageAdapter.connection, {
    unrestricted: isUnrestrictedAccount(req.authUser),
    branchId: req.branchId,
    unresolvedOnly: true
  });
  for (const alert of walletAlerts) {
    alerts.push({
      type: 'wallet_alert',
      alert_id: alert.id,
      severity: alert.threshold_type,
      wallet_id: alert.wallet_id,
      wallet_name: alert.wallet_name,
      wallet_number: alert.wallet_number,
      threshold_type: alert.threshold_type,
      consumed_percent: alert.consumed_percent,
      period: alert.period,
      message: `تنبيه محفظة ${alert.wallet_name} - ${alert.wallet_number}: استهلاك ${Number(alert.consumed_percent).toFixed(2)}% (${alert.threshold_type})`
    });
  }
  const smsNotifications = listSmsNotifications(db.storageAdapter.connection, {
    unrestricted: isUnrestrictedAccount(req.authUser),
    branchId: req.branchId
  });
  for (const message of smsNotifications.messages) {
    alerts.push({
      type: 'sms_message',
      sms_id: message.id,
      severity: message.status === 'mismatched' ? 'critical' : 'warning',
      wallet_id: message.wallet_id,
      wallet_name: message.wallet_name,
      wallet_number: message.wallet_number,
      message: `رسالة SMS جديدة لمحفظة ${message.wallet_name || ''} ${message.wallet_number || ''}: ${message.raw_text || ''}`
    });
  }
  for (const pending of smsNotifications.pending.filter(row => ['waiting', 'expired'].includes(row.status))) {
    alerts.push({
      type: 'sms_pending',
      pending_id: pending.id,
      severity: pending.status === 'expired' ? 'critical' : 'warning',
      wallet_id: pending.wallet_id,
      wallet_name: pending.wallet_name,
      wallet_number: pending.wallet_number,
      sale_id: pending.sale_id,
      message: pending.status === 'expired'
        ? `⏰ انتهت مهلة الدفع للمحفظة ${pending.wallet_name} - ${pending.wallet_number}`
        : `دفعة معلقة للمحفظة ${pending.wallet_name} - ${pending.wallet_number} بقيمة ${Number(pending.expected_amount).toFixed(2)} ج.م.`
    });
  }
  res.json({ generated_at: nowStr(), count: alerts.length, alerts: alerts.slice(0, 100) });
});

app.post('/api/assistant/ask', (req, res) => {
  const question = String(req.body?.question || '').trim().slice(0, 300);
  if (question.length < 2) return res.status(400).json({ error: 'اكتب سؤالاً واضحاً عن بيانات النشاط.' });
  const q = normalizeCatalogText(question).replace(/[أإآ]/g, 'ا');
  const products = db.data.products || [];
  const stopWords = new Set(['كم', 'مخزون', 'رصيد', 'متبقي', 'كمية', 'ناقص', 'النواقص', 'الصنف', 'صنف', 'دواء', 'الدواء', 'من', 'عن', 'في', 'ما', 'هو', 'هي', 'عندي', 'لدي']);
  const questionTokens = q.split(/[\s،,؟?؛;:.!()\[\]{}]+/).map(token => token.replace(/^ال/, '')).filter(token => token.length >= 3 && !stopWords.has(token));
  const productMatchScore = product => [product.name, product.generic_name, product.scientific_name, product.barcode]
    .filter(Boolean)
    .flatMap(value => normalizeCatalogText(value).replace(/[أإآ]/g, 'ا').split(/[\s،,؟?؛;:.!()\[\]{}]+/))
    .map(token => token.replace(/^ال/, ''))
    .filter(token => token.length >= 3)
    .reduce((score, token) => score + (questionTokens.some(queryToken => queryToken === token || (queryToken.length >= 4 && token.length >= 4 && (queryToken.includes(token) || token.includes(queryToken)))) ? 1 : 0), 0);
  const matchedProduct = products
    .map(product => ({ product, score: productMatchScore(product) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.product;
  let answer = ''; let rows = [];
  if (/مخزون|رصيد|متبقي|كمية|ناقص/.test(q)) {
    if (matchedProduct) { const qty=branchQuantity(req.branchId,matchedProduct.id),min=Number(getBranchInventoryRow(req.branchId,matchedProduct.id)?.min_stock||0); answer=`المخزون المسجل للصنف ${matchedProduct.name}: ${qty} ${matchedProduct.unit||'وحدة'}، والحد الأدنى ${min}.`; rows=[{product_id:matchedProduct.id,name:matchedProduct.name,quantity:qty,min_stock:min}]; }
    else { rows=products.map(product=>({product,quantity:branchQuantity(req.branchId,product.id),min_stock:Number(getBranchInventoryRow(req.branchId,product.id)?.min_stock||0)})).filter(row=>row.quantity<=row.min_stock).slice(0,30).map(row=>({product_id:row.product.id,name:row.product.name,quantity:row.quantity,min_stock:row.min_stock})); answer = rows.length ? `وجدت ${rows.length} صنفاً عند حد النقص أو أقل.` : 'لا توجد أصناف عند حد النقص المسجل حالياً.'; }
  } else if (/صلاحيت|تنتهي|منتهي/.test(q)) {
    rows = (db.data.purchase_items || []).filter(lot => Number(lot.branch_id || db.data.default_branch_id) === Number(req.branchId) && Number(lot.remaining_quantity ?? lot.quantity) > 0 && lot.expiry_date && getDaysUntilExpiry(lot.expiry_date) <= EXPIRY_WARNING_DAYS).map(lot => ({ name: products.find(product => product.id === lot.product_id)?.name || 'صنف', lot_number: lot.lot_number || '', quantity: lot.remaining_quantity ?? lot.quantity, expiry_date: lot.expiry_date, days: getDaysUntilExpiry(lot.expiry_date) })).sort((a, b) => a.days - b.days).slice(0, 30);
    answer = rows.length ? `هناك ${rows.length} تشغيلة تنتهي خلال ${EXPIRY_WARNING_DAYS} يوماً أو منتهية.` : 'لا توجد تشغيلات مسجلة تقترب صلاحيتها خلال 30 يوماً.';
  } else if (/اكثر مبيع|الأكثر مبيع|مبيعات صنف|مباع/.test(q)) {
    const totals = new Map(); for (const item of db.data.sale_items || []) totals.set(item.product_id, (totals.get(item.product_id) || 0) + Number(item.quantity || 0));
    rows = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, quantity]) => ({ name: products.find(product => product.id === id)?.name || 'صنف محذوف', quantity }));
    if (matchedProduct) { const quantity = totals.get(matchedProduct.id) || 0; answer = `إجمالي الكمية المباعة من ${matchedProduct.name} في السجل: ${quantity}.`; rows = [{ name: matchedProduct.name, quantity }]; }
    else answer = rows.length ? 'هذه أعلى الأصناف مبيعاً حسب فواتير النظام المسجلة.' : 'لا توجد مبيعات مسجلة بعد.';
  } else if (/عميل|العملاء|مديون|آجل/.test(q)) {
    const digits = q.replace(/\D/g, '');
    const matchedCustomer = (db.data.customers || []).find(customer => Number(customer.id) !== 1 && ((customer.name && q.includes(normalizeCatalogText(customer.name))) || (digits.length >= 7 && String(customer.phone || '').replace(/\D/g, '').includes(digits))));
    if (matchedCustomer) { answer = `الرصيد المسجل للعميل ${matchedCustomer.name}: ${Number(matchedCustomer.balance || 0).toFixed(2)} ج.م.`; rows = [{ name: matchedCustomer.name, phone: matchedCustomer.phone || '', balance: Number(matchedCustomer.balance || 0) }]; }
    else if (matchedProduct) answer = 'اكتب اسم العميل أو رقم هاتفه في السؤال لمعرفة حسابه.';
    else { const customers = (db.data.customers || []).filter(customer => Number(customer.id) !== 1 && Number(customer.balance || 0) > 0).sort((a, b) => Number(b.balance) - Number(a.balance)); rows = customers.slice(0, 30).map(customer => ({ name: customer.name, phone: customer.phone || '', balance: Number(customer.balance || 0) })); answer = `إجمالي أرصدة العملاء المدينة: ${customers.reduce((sum, customer) => sum + Number(customer.balance || 0), 0).toFixed(2)} ج.م.`; }
  } else {
    answer = 'أستطيع الإجابة من بيانات النظام عن مخزون صنف، النواقص، التشغيلات والصلاحية، أعلى المبيعات، وأرصدة العملاء. جرّب: كم مخزون (اسم الصنف)؟';
  }
  res.json({ question, answer, rows, generated_at: nowStr(), source: 'بيانات النشاط' });
});

app.get('/api/shifts/current', (req, res) => {
  const shift = openCashierShift(req.authUser.id, req.branchId);
  res.json(shift ? { ...shift, expected_cash: expectedCashForShift(shift) } : null);
});

app.get('/api/dashboard/branch-cash-summary', (req, res) => {
  if (!isUnrestrictedAccount(req.authUser)) return res.status(403).json({ error: 'ملخص خزائن جميع الفروع متاح لمالك النظام أو حساب admin فقط.' });
  ensureFinanceTables();
  const branches = (db.data.branches || []).filter(branch => !branch.deleted_at);
  const byBranch = new Map(branches.map(branch => [Number(branch.id), {
    branch_id: Number(branch.id), branch_name: String(branch.name || ''), is_active: branch.is_active !== false,
    cash_balance: 0, expenses: 0, recent_expenses: []
  }]));
  for (const row of db.data.cash_transactions || []) {
    const branchId = Number(row.branch_id || db.data.default_branch_id || 1);
    const summary = byBranch.get(branchId);
    if (!summary) continue;
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) continue;
    summary.cash_balance += row.direction === 'out' ? -amount : amount;
    if (row.type === 'expense') {
      summary.expenses += amount;
      summary.recent_expenses.push({
        amount: Number(amount.toFixed(2)),
        description: String(row.notes || 'مصروف غير موصوف').slice(0, 240),
        created_at: String(row.created_at || '').slice(0, 40)
      });
      if (summary.recent_expenses.length > 8) summary.recent_expenses.shift();
    }
  }
  const rows = [...byBranch.values()].map(row => ({
    ...row,
    cash_balance: Number(row.cash_balance.toFixed(2)),
    expenses: Number(row.expenses.toFixed(2)),
    recent_expenses: row.recent_expenses
  }));
  res.json({
    total_cash_balance: Number(rows.reduce((sum, row) => sum + row.cash_balance, 0).toFixed(2)),
    total_expenses: Number(rows.reduce((sum, row) => sum + row.expenses, 0).toFixed(2)),
    branches: rows
  });
});

app.get('/api/shifts', (req, res) => {
  const canViewAll = req.authUser.is_owner || userHasPermission(req.authUser, 'system_settings');
  const rows = db.data.cashier_shifts
    .filter(shift => Number(shift.branch_id || db.data.default_branch_id) === Number(req.branchId) && (canViewAll || shift.user_id === req.authUser.id))
    .map(shift => ({ ...shift, expected_cash: shift.status === 'open' ? expectedCashForShift(shift) : shift.expected_cash }));
  res.json(rows.sort((a, b) => String(b.opened_at).localeCompare(String(a.opened_at))));
});

app.post('/api/shifts/open', (req, res) => {
  const openingCash = Number(req.body.opening_cash);
  if (!Number.isFinite(openingCash) || openingCash < 0 || openingCash > 1e9) return res.status(400).json({ error: 'رصيد بداية الوردية غير صحيح.' });
  if (openCashierShift(req.authUser.id, req.branchId)) return res.status(409).json({ error: 'لديك وردية مفتوحة بالفعل.' });
  let shift;
  let auditEntry;
  try {
    ({ shift, auditEntry } = db.transaction(['cashier_shifts', 'cash_audit_chain', 'audit_logs'], () => {
      shift = { id: db.nextId('cashier_shifts'), branch_id: req.branchId, user_id: req.authUser.id, status: 'open', opening_cash: Number(openingCash.toFixed(2)), opened_at: nowStr(), closed_at: null, closing_cash: null, expected_cash: null, difference: null };
      db.data.cashier_shifts.push(shift);
      auditEntry = appendCashAudit({ actor_id: req.authUser.id, action: 'فتح وردية كاشير', shift_id: shift.id, branch_id: req.branchId, opening_cash: shift.opening_cash });
      db.logAudit(req.authUser.id, 'فتح وردية كاشير', 'cashier_shifts', shift.id, `تم فتح الوردية؛ سجل التدقيق المشفر ${auditEntry.entry_hash.slice(0, 16)}`, { save: false });
      return { shift, auditEntry };
    }));
  } catch (error) { return res.status(500).json({ error: `تعذر حفظ الوردية بأمان: ${error.message}` }); }
  res.status(201).json({ ...shift, expected_cash: expectedCashForShift(shift) });
});

app.post('/api/shifts/:id/close', (req, res) => {
  const shift = db.data.cashier_shifts.find(item => item.id === Number(req.params.id));
  if (!shift || Number(shift.branch_id || db.data.default_branch_id) !== Number(req.branchId)) return res.status(404).json({ error: 'الوردية غير موجودة في هذا الفرع.' });
  if (shift.user_id !== req.authUser.id && !req.authUser.is_owner && !userHasPermission(req.authUser, 'system_settings')) return res.status(403).json({ error: 'لا تملك صلاحية إغلاق وردية مستخدم آخر.' });
  if (shift.status !== 'open') return res.status(409).json({ error: 'الوردية مغلقة بالفعل.' });
  const closingCash = Number(req.body.closing_cash);
  if (!Number.isFinite(closingCash) || closingCash < 0 || closingCash > 1e9) return res.status(400).json({ error: 'الرصيد الفعلي عند الإغلاق غير صحيح.' });
  let expectedCash;
  let auditEntry;
  try {
    ({ expectedCash, auditEntry } = db.transaction(['cashier_shifts', 'cash_audit_chain', 'audit_logs'], () => {
      expectedCash = expectedCashForShift(shift);
      shift.status = 'closed'; shift.closed_at = nowStr();
      shift.closing_cash = Number(closingCash.toFixed(2));
      shift.expected_cash = expectedCash;
      shift.difference = Number((shift.closing_cash - expectedCash).toFixed(2));
      auditEntry = appendCashAudit({ actor_id: req.authUser.id, action: 'إغلاق وردية كاشير', shift_id: shift.id, branch_id: req.branchId, expected_cash: expectedCash, closing_cash: shift.closing_cash, difference: shift.difference });
      db.logAudit(req.authUser.id, 'إغلاق وردية كاشير', 'cashier_shifts', shift.id, `تم إغلاق الوردية؛ سجل التدقيق المشفر ${auditEntry.entry_hash.slice(0, 16)}`, { save: false });
      return { expectedCash, auditEntry };
    }));
  } catch (error) { return res.status(500).json({ error: `تعذر إغلاق الوردية بأمان: ${error.message}` }); }
  res.json(shift);
});

app.get('/api/finance/summary', (req, res) => {
  ensureFinanceTables();
  const branchCash=branchStockFilter(db.data.cash_transactions,req.branchId); const branchCustomerLedger=branchStockFilter(db.data.customer_transactions,req.branchId); const branchSupplierLedger=branchStockFilter(db.data.supplier_transactions,req.branchId);
  const cashBalance=branchCash.reduce((sum,t)=>sum+(t.direction==='out'?-t.amount:t.amount),0);
  const customerDebt=branchCustomerLedger.reduce((sum,row)=>sum+Number(row.debit||0)-Number(row.credit||0),0);
  const supplierDebt=branchSupplierLedger.reduce((sum,row)=>sum+Number(row.debit||0)-Number(row.credit||0),0);
  res.json({
    cash_balance: parseFloat(cashBalance.toFixed(2)),
    customer_debt: parseFloat(customerDebt.toFixed(2)),
    supplier_debt: parseFloat(supplierDebt.toFixed(2)),
    external_debt: parseFloat((customerDebt + supplierDebt).toFixed(2)),
    cash_transactions: branchCash.slice().reverse().slice(0,100)
  });
});

app.get('/api/expenses', (req, res) => {
  ensureFinanceTables();
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const validDate = value => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
  if (!validDate(from) || !validDate(to) || (from && to && from > to)) {
    return res.status(400).json({ error: 'نطاق التاريخ غير صحيح.' });
  }
  const expenses = branchStockFilter(db.data.cash_transactions, req.branchId)
    .filter(item => item.type === 'expense')
    .filter(item => {
      const day = String(item.created_at || '').slice(0, 10);
      return (!from || day >= from) && (!to || day <= to);
    })
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || Number(b.id || 0) - Number(a.id || 0));
  res.json(expenses);
});

// Cash receipts/payments are first-class cash movements. They stay separate
// from sales and expenses so the shift reconciliation can include them once.
app.get('/api/cash-transactions', (req, res) => {
  ensureFinanceTables();
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const validDate = value => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
  if (!validDate(from) || !validDate(to) || (from && to && from > to)) return res.status(400).json({ error: 'نطاق التاريخ غير صحيح.' });
  const rows = branchStockFilter(db.data.cash_transactions, req.branchId)
    .filter(row => ['cash_receipt', 'owner_deposit', 'cash_payment'].includes(row.type))
    .filter(row => { const day = String(row.created_at || '').slice(0, 10); return (!from || day >= from) && (!to || day <= to); })
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || Number(b.id || 0) - Number(a.id || 0));
  res.json(rows);
});

app.post('/api/cash-transfers', (req, res) => {
  const fromBranchId = Number(req.body?.from_branch_id);
  const toBranchId = Number(req.body?.to_branch_id);
  const amount = Number(req.body?.amount);
  const description = String(req.body?.description || '').trim().slice(0, 240);
  const canTransferAcrossBranches = req.authUser.is_owner || userHasPermission(req.authUser, 'system_settings');
  const allowedBranchIds = canTransferAcrossBranches
    ? new Set(db.data.branches.filter(row => row.is_active !== false).map(row => Number(row.id)))
    : new Set((req.authUser.branch_ids?.length ? req.authUser.branch_ids : [req.authUser.branch_id || req.branchId]).map(Number));
  if (!Number.isInteger(fromBranchId) || !Number.isInteger(toBranchId) || fromBranchId === toBranchId) return res.status(400).json({ error: 'اختر خزنتين مختلفتين.' });
  if (!allowedBranchIds.has(fromBranchId) || !allowedBranchIds.has(toBranchId)) return res.status(403).json({ error: 'لا تملك صلاحية التحويل بين هذين الفرعين.' });
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9 || !description) return res.status(400).json({ error: 'أدخل بياناً ومبلغ تحويل صالحاً.' });
  const transferId = `TRF-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    const committed = db.transaction(['cash_transactions', 'cash_audit_chain', 'audit_logs'], () => {
      const cashConfirmation = requireCashBalanceConfirmation(req, res, amount, fromBranchId);
      if (!cashConfirmation) return null;
      addFinanceTransaction('cash_transactions', { type: 'cash_transfer_out', amount: Number(amount.toFixed(2)), direction: 'out', reference_id: transferId, notes: description, user_id: req.authUser.id, branch_id: fromBranchId, ...cashConfirmationFields(cashConfirmation) });
      addFinanceTransaction('cash_transactions', { type: 'cash_transfer_in', amount: Number(amount.toFixed(2)), direction: 'in', reference_id: transferId, notes: description, user_id: req.authUser.id, branch_id: toBranchId });
      db.logAudit(req.authUser.id, 'تحويل بين الخزائن', 'cash_transactions', transferId, `${fromBranchId} -> ${toBranchId}: ${amount}${cashConfirmation.negative ? `; NEGATIVE_BALANCE_CONFIRMED after=${cashConfirmation.after}` : ''}`, { save: false });
       return true;
     }, connection => postCashTransferToAccounting({ reference_id: transferId, amount, description, from_branch_id: fromBranchId, to_branch_id: toBranchId, created_by: req.authUser.id, created_at: nowStr() }, connection));
    if (!committed) return;
  } catch (error) { return res.status(500).json({ error: `تعذر حفظ التحويل النقدي بأمان: ${error.message}` }); }
  res.status(201).json({ transfer_id: transferId, from_branch_id: fromBranchId, to_branch_id: toBranchId, amount: Number(amount.toFixed(2)), cash_balance_after: Number((cashBalanceForBranch(fromBranchId)).toFixed(2)) });
});

app.post('/api/cash-transactions', (req, res) => {
  ensureFinanceTables();
  const type = String(req.body?.type || '');
  const description = String(req.body?.description || '').trim().slice(0, 240);
  const amount = Number(req.body?.amount);
  if (!['cash_receipt', 'owner_deposit', 'cash_payment'].includes(type)) return res.status(400).json({ error: 'نوع الحركة النقدية غير صحيح.' });
  if (type === 'owner_deposit' && !isUnrestrictedAccount(req.authUser)) return res.status(403).json({ error: 'إيداع مالك النشاط متاح لمالك النظام أو حساب admin فقط.' });
  if (!description) return res.status(400).json({ error: 'بيان الحركة مطلوب.' });
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) return res.status(400).json({ error: 'أدخل مبلغاً أكبر من صفر وبحد أقصى مليار.' });
  let row;
  let auditEntry;
  const action = type === 'owner_deposit' ? 'إيداع من صاحب المحل' : type === 'cash_receipt' ? 'سند قبض نقدي' : 'سند صرف نقدي';
  try {
    const committed = db.transaction(['cash_transactions', 'cash_audit_chain', 'audit_logs'], () => {
      const cashConfirmation = type === 'cash_payment' ? requireCashBalanceConfirmation(req, res, amount) : { negative: false };
      if (!cashConfirmation) return null;
      const shift = openCashierShift(req.authUser.id, req.branchId);
      row = addFinanceTransaction('cash_transactions', {
        type, amount: Number(amount.toFixed(2)), direction: type === 'cash_payment' ? 'out' : 'in',
        reference_id: `${type === 'cash_payment' ? 'PAY' : type === 'owner_deposit' ? 'OWN' : 'RCV'}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        notes: description, user_id: req.authUser.id, shift_id: shift?.id || null, ...cashConfirmationFields(cashConfirmation)
      });
      auditEntry = db.data.cash_audit_chain.at(-1);
      db.logAudit(req.authUser.id, action, 'cash_transactions', row.id, `تم تسجيل الحركة؛ سجل التدقيق المشفر ${auditEntry.entry_hash.slice(0, 16)}`, { save: false });
       return { row, auditEntry };
     }, connection => postCashTransactionToAccounting(row, connection));
    if (!committed) return;
    ({ row, auditEntry } = committed);
  } catch (error) { return res.status(500).json({ error: `تعذر حفظ السند بأمان: ${error.message}` }); }
  if (!row) return;
  res.status(201).json(row);
});

app.get('/api/cash-audit', (req, res) => {
  if (!req.authUser.is_owner && !userHasPermission(req.authUser, 'system_settings')) return res.status(403).json({ error: 'عرض سجل تدقيق الخزينة متاح للمالك أو مدير النظام.' });
  const result = readAndVerifyCashAudit();
  res.status(result.valid ? 200 : 409).json(result);
});

app.post('/api/expenses', (req, res) => {
  const { description, amount } = req.body;
  const value = Number(amount);
  if (!String(description || '').trim() || !Number.isFinite(value) || value <= 0) {
    return res.status(400).json({ error: 'أدخل بيان المصروف وقيمة صحيحة أكبر من صفر.' });
  }
  ensureFinanceTables();
  let expense;
  let row;
  try {
    ({ expense, row } = db.transaction(['cash_transactions', 'cash_audit_chain', 'audit_logs'], () => {
      const cashConfirmation = requireCashBalanceConfirmation(req, res, value);
      if (!cashConfirmation) return null;
      expense = { type: 'expense', amount: Number(value.toFixed(2)), direction: 'out', reference_id: `EXP-${Date.now()}`, notes: String(description).trim(), user_id: req.authUser.id, shift_id: openCashierShift(req.authUser.id)?.id || null, ...cashConfirmationFields(cashConfirmation) };
      addFinanceTransaction('cash_transactions', expense);
      row = db.data.cash_transactions.at(-1);
      const auditEntry = db.data.cash_audit_chain.at(-1);
      db.logAudit(req.authUser.id, 'تسجيل مصروف', 'cash_transactions', row.id, `${expense.notes} — ${expense.amount} ج.م؛ سجل التدقيق المشفر ${auditEntry.entry_hash.slice(0, 16)}`, { save: false });
       return { expense, row };
     }, connection => postExpenseToAccounting(row, connection)));
  } catch (error) { return res.status(500).json({ error: `تعذر تسجيل المصروف بأمان: ${error.message}` }); }
  if (!row) return;
  res.status(201).json(row);
});

// ----------------------------------------------------
// System Backup & Restore
// ----------------------------------------------------
app.use('/api/backup', (req, res, next) => {
  if (req.method !== 'GET' || req.path !== '/') return next();
  const send = res.send;
  res.send = function sendFullCatalogBackup() {
    res.send = send;
    return send.call(this, JSON.stringify(db.getFullSnapshot(), null, 2));
  };
  next();
});

app.get('/api/backup', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=rawda_backup_${new Date().toISOString().slice(0,10)}.json`);
  res.send(JSON.stringify(db.data, null, 2));
});

app.get('/api/backup/sqlite', async (req, res) => {
  const temporary = path.join(userDataDir, 'backups', `.manual-export-${process.pid}-${crypto.randomBytes(6).toString('hex')}.sqlite`);
  try {
    await copySqliteDatabase(db.getDatabasePath(), temporary, { catalogRows: db.getBusinessCatalog() });
    if (!fs.existsSync(temporary)) throw new Error(`ملف التصدير المؤقت غير موجود: ${temporary}`);
    const stat = fs.statSync(temporary);
    res.type('application/vnd.sqlite3');
    res.setHeader('Content-Disposition', `attachment; filename=system_pos_backup_${new Date().toISOString().slice(0, 10)}.sqlite`);
    res.setHeader('Content-Length', String(stat.size));
    const stream = fs.createReadStream(temporary);
    res.once('finish', () => { try { fs.unlinkSync(temporary); } catch {} });
    stream.once('error', error => { try { fs.unlinkSync(temporary); } catch {} if (!res.headersSent) res.status(500).json({ error: 'تعذر تصدير قاعدة SQLite.', ...(process.env.NODE_ENV === 'test' ? { detail: error.message } : {}) }); });
    stream.pipe(res);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    console.error('SQLite backup export failed:', error.message);
    res.status(500).json({ error: 'تعذر تصدير قاعدة SQLite.', ...(process.env.NODE_ENV === 'test' ? { detail: error.message } : {}) });
  }
});

async function restoreSqliteBuffer(buffer, authUser) {
  const temporary = path.join(userDataDir, 'backups', `.restore-candidate-${process.pid}-${crypto.randomBytes(6).toString('hex')}.sqlite`);
  let rollbackSnapshot = null;
  let restoreStarted = false;
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 100) throw new Error('ملف SQLite المرسل فارغ أو غير صالح.');
    fs.mkdirSync(path.dirname(temporary), { recursive: true });
    fs.writeFileSync(temporary, buffer, { flag: 'wx' });
    const restoredData = validateSqliteDatabase(temporary);
    // Older schema versions may not contain collections introduced later.
    // Fill only absent keys from the current schema defaults, preserving every
    // persisted collection and its product-image payloads.
    for (const [key, value] of Object.entries(db.data)) {
      if (Object.hasOwn(restoredData, key)) continue;
      restoredData[key] = Array.isArray(value) ? [] : JSON.parse(JSON.stringify(value));
    }
    if (restoredData.products.some(row => !row || !Number.isInteger(Number(row.id)))
      || restoredData.categories.some(row => !row || !Number.isInteger(Number(row.id)))
      || restoredData.users.some(row => !row || !Number.isInteger(Number(row.id)) || !row.username || typeof row.password_hash !== 'string')) {
      throw new Error('ملف SQLite يحتوي بيانات أساسية غير صالحة.');
    }
    const currentOwner = db.data.users.find(user => user.is_owner);
    if (currentOwner && !restoredData.users.some(user => user.username === OWNER_USERNAME)) restoredData.users.push(currentOwner);
    const auditId = restoredData.audit_logs.reduce((max, row) => Math.max(max, Number(row?.id) || 0), 0) + 1;
    restoredData.audit_logs.unshift({ id: auditId, user_id: authUser?.id || null, action: 'استعادة نسخة احتياطية', entity: 'system', entity_id: 1, details: 'تمت استعادة قاعدة SQLite بنجاح من ملف خارجي', created_at: nowStr() });
    rollbackSnapshot = JSON.parse(JSON.stringify(db.data));
    rollbackSnapshot.business_catalog = db.getBusinessCatalog();
    await scheduledBackups.createSafetyBackup();
    restoreStarted = true;
    db.restoreFullSnapshot(restoredData);
    if (process.env.NODE_ENV === 'test' && process.env.SYSTEM_TEST_FAIL_RESTORE_AFTER_COMMIT === '1') throw new Error('Injected restore failure after snapshot commit for rollback verification.');
    db.ensureSchema();
    const integrity = db.storageAdapter.quickCheck();
    if (integrity !== 'ok') throw new Error(`Restored database quick_check failed: ${integrity}`);
    const missingGroups = Object.keys(rollbackSnapshot).filter(key => !Object.hasOwn(db.data, key));
    if (missingGroups.length) throw new Error(`Restored database is missing collections: ${missingGroups.join(', ')}`);
    return { message: 'تم استعادة النسخة الاحتياطية بنجاح', safety_backup_created: true };
  } catch (error) {
    console.error('SQLite restore failed:', error.message);
    if (restoreStarted && rollbackSnapshot) {
      try { db.restoreFullSnapshot(rollbackSnapshot); db.ensureSchema(); }
      catch (rollbackError) { console.error('SQLite restore rollback failed:', rollbackError.message); }
    }
    error.restoreMessage = 'فشل في التحقق من نسخة SQLite أو استعادتها.';
    throw error;
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}

app.post('/api/restore-sqlite', express.raw({ type: 'application/vnd.sqlite3', limit: '1gb' }), async (req, res) => {
  try { res.json(await restoreSqliteBuffer(req.body, req.authUser)); }
  catch (error) { console.error('SQLite restore failed:', error.message); res.status(400).json({ error: error.restoreMessage || 'فشل في التحقق من نسخة SQLite أو استعادتها.' }); }
});

app.post('/api/restore', async (req, res) => {
  try {
    const backupData = req.body;
    const requiredTables = ['products', 'categories', 'users'];
    const optionalTables = ['customers', 'suppliers', 'sales', 'sale_items', 'sale_returns', 'sale_return_items', 'suspended_sales', 'loyalty_transactions', 'cashier_shifts', 'cash_audit_chain', 'service_orders', 'installment_contracts', 'promotions', 'purchase_orders', 'purchase_order_items', 'delivery_riders', 'delivery_assignments', 'delivery_settlements', 'delivery_rider_transactions', 'waste_records', 'purchases', 'purchase_items', 'customer_transactions', 'supplier_transactions', 'cash_transactions', 'stock_movements', 'employees', 'employee_transactions', 'attendance', 'audit_logs'];
    if (!backupData || typeof backupData !== 'object' || Array.isArray(backupData)
      || requiredTables.some(table => !Array.isArray(backupData[table]))
      || optionalTables.some(table => backupData[table] !== undefined && !Array.isArray(backupData[table]))) {
      return res.status(400).json({ error: 'ملف النسخة الاحتياطية غير صالح' });
    }
    const restoredData = JSON.parse(JSON.stringify(backupData));
    if (restoredData.business_catalog_snapshot) {
      restoredData.business_catalog = db.readAutomaticCatalogSnapshot(restoredData.business_catalog_snapshot, path.join(userDataDir, 'backups'));
      delete restoredData.business_catalog_snapshot;
    }
    for (const table of optionalTables) if (!Array.isArray(restoredData[table])) restoredData[table] = [];
    if (!restoredData.loyalty_settings || typeof restoredData.loyalty_settings !== 'object') restoredData.loyalty_settings = { enabled: false, spend_per_point: 10 };
    if (restoredData.products.some(product => !product || !Number.isInteger(Number(product.id)))) {
      return res.status(400).json({ error: 'ملف النسخة الاحتياطية يحتوي على أصناف غير صالحة.' });
    }
    const barcodes = new Set();
    for (const product of restoredData.products) {
      const barcode = String(product.barcode || '').trim();
      if (barcode && barcodes.has(barcode)) return res.status(400).json({ error: `الباركود مكرر داخل النسخة الاحتياطية: ${barcode}` });
      if (barcode) barcodes.add(barcode);
    }
    if (restoredData.categories.some(category => !category || !Number.isInteger(Number(category.id)))) {
      return res.status(400).json({ error: 'ملف النسخة الاحتياطية يحتوي على تصنيفات غير صالحة.' });
    }
    if (restoredData.users.some(user => !user || !Number.isInteger(Number(user.id)) || !user.username || typeof user.password_hash !== 'string')) {
      return res.status(400).json({ error: 'ملف النسخة الاحتياطية يحتوي على مستخدمين غير صالحين.' });
    }
    for (const user of restoredData.users) {
      if (!isPasswordHash(user.password_hash)) user.password_hash = await passwordHashAsync(user.password_hash);
    }
    const existingOwner = db.data.users.find(user => user.is_owner);
    if (existingOwner && !restoredData.users.some(user => user.username === OWNER_USERNAME)) restoredData.users.push(existingOwner);
    let maxAuditId = 0;
    for (const entry of restoredData.audit_logs) { const id = Number(entry?.id) || 0; if (id > maxAuditId) maxAuditId = id; }
    restoredData.audit_logs.unshift({
      id: maxAuditId + 1,
      user_id: req.authUser.id,
      action: 'استعادة نسخة احتياطية',
      entity: 'system',
      entity_id: 1,
      details: 'تمت استعادة قاعدة البيانات بنجاح من ملف خارجي',
      created_at: nowStr()
    });
    await scheduledBackups.createSafetyBackup();
    db.restoreFullSnapshot(restoredData);
    db.ensureSchema();
    res.json({ message: 'تم استعادة النسخة الاحتياطية بنجاح' });
  } catch (err) {
    console.error('Backup restore failed:', err.message);
    res.status(500).json({ error: 'فشل في معالجة النسخة الاحتياطية' });
  }
});

// ----------------------------------------------------
// System Network & Multi-Device Access Info
// ----------------------------------------------------
app.get('/api/network-info', (req, res) => {
  const localIP = getLocalIP();
  const config = readRuntimeConfig();
  res.json({
    local_ip: localIP,
    port: PORT,
    host: HOST,
    local_url: `http://localhost:${PORT}`,
    network_url: localIP ? `${NETWORK_SCHEME}://${localIP}:${NETWORK_PORT}` : 'الجهاز غير متصل بشبكة محلية',
    camera_secure: HTTPS_ENABLED,
    ca_download_url: HTTPS_ENABLED && TLS_CA_PATH && localIP ? `${NETWORK_SCHEME}://${localIP}:${NETWORK_PORT}/local-network-root-ca.cer` : '',
    public_url: String(config.public_url || ''),
    backup_secondary_path: String(config.backup_secondary_path || ''),
    trust_proxy: TRUST_PROXY
  });
});

if (HTTPS_ENABLED && TLS_CA_PATH) {
  app.get('/local-network-root-ca.cer', (_req, res) => {
    res.setHeader('Content-Type', 'application/pkix-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="local-network-root-ca.cer"');
    res.sendFile(path.resolve(TLS_CA_PATH));
  });
}

app.get('/api/config', (req, res) => {
  const licenseStatus = getEffectiveLicenseStatus();
  const localIP = getLocalIP();
  const businessProfile = readBusinessProfile();
  const result = {
    app_name: 'SYSTEM لإدارة حسابات بضاعتك',
    business_profile: businessProfile,
    port: PORT,
    contact_phone: businessProfile.phone || '',
    local_ip: localIP,
    local_url: `http://localhost:${PORT}`,
    network_url: localIP ? `${NETWORK_SCHEME}://${localIP}:${NETWORK_PORT}` : 'الجهاز غير متصل بشبكة محلية',
    camera_secure: HTTPS_ENABLED,
    ca_download_url: HTTPS_ENABLED && TLS_CA_PATH && localIP ? `${NETWORK_SCHEME}://${localIP}:${NETWORK_PORT}/local-network-root-ca.cer` : ''
  };
  if (licenseStatus.trial) {
    result.trial_build = true;
    result.trial_expires_at = licenseStatus.expiresAt;
    result.trial_active = licenseStatus.active;
    result.trial_hours_remaining = licenseStatus.hoursRemaining;
  }
  if (req.authUser && userHasPermission(req.authUser, 'system_settings')) {
    result.host = HOST;
    result.database_path = db.getDatabasePath();
  }
  res.json(result);
});

// Stable settings API used by the settings-master UI. The older config route
// remains available for existing clients.
app.get('/api/business-profile', (req, res) => {
  if (!requireAdmin(req.authUser?.id, res)) return;
  res.json({ business_profile: readBusinessProfile() });
});

app.post('/api/config/business-profile/initial', (req, res) => {
  try {
    if (readBusinessProfile().is_configured) return res.status(409).json({ error: 'تم إعداد بيانات النشاط بالفعل. سجّل الدخول لتعديلها من الإعدادات.' });
    const businessName = String(req.body?.business_name || '').trim();
    const ownerName = String(req.body?.owner_name || '').trim();
    const ownerUsername = String(req.body?.owner_username || '').trim();
    const ownerPassword = String(req.body?.owner_password || '');
    const activity = String(req.body?.activity || '').trim();
    const address = String(req.body?.address || '').trim();
    const phone = String(req.body?.phone || '').trim();
    if (!businessName || businessName.length > 100) return res.status(400).json({ error: 'اكتب اسم النشاط بحد أقصى 100 حرف.' });
    if (!ownerUsername || !/^[A-Za-z0-9_.-]{3,50}$/.test(ownerUsername)) return res.status(400).json({ error: 'اسم مستخدم المالك يجب أن يكون من 3 إلى 50 حرفاً إنجليزياً أو رقماً.' });
    if (ownerPassword.length < 8 || ownerPassword.length > 128) return res.status(400).json({ error: 'كلمة مرور المالك يجب أن تكون من 8 إلى 128 حرفاً.' });
    if (DEFAULT_BOOTSTRAP_PASSWORDS.includes(ownerPassword.toLocaleLowerCase()) || ownerPassword.toLocaleLowerCase() === ownerUsername.toLocaleLowerCase()) return res.status(400).json({ error: 'اختر كلمة مرور مالك غير افتراضية ومختلفة عن اسم المستخدم.' });
    if (ownerName.length > 100 || activity.length > 100 || address.length > 250 || phone.length > 30) return res.status(400).json({ error: 'أحد حقول بيانات النشاط أطول من الحد المسموح.' });
    const phoneDigits = phone.replace(/[^0-9]/g, '');
    if (phone && (phoneDigits.length < 7 || phoneDigits.length > 15)) return res.status(400).json({ error: 'أدخل رقم هاتف صحيحاً من 7 إلى 15 رقماً.' });
    let logoData = '';
    if (req.body?.logo_data_url) {
      const match = String(req.body.logo_data_url).match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) return res.status(400).json({ error: 'صيغة الشعار غير مدعومة. استخدم PNG أو JPG أو WebP.' });
      const bytes = Buffer.from(match[2], 'base64');
      if (!bytes.length || bytes.length > 4 * 1024 * 1024) return res.status(400).json({ error: 'حجم الشعار يجب ألا يتجاوز 4 ميجابايت.' });
      const signatureValid = match[1] === 'png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : match[1] === 'jpeg'
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!signatureValid) return res.status(400).json({ error: 'محتوى الصورة لا يطابق نوع الملف المحدد.' });
      logoData = String(req.body.logo_data_url);
    }
    const ownerAccount = db.data.users.find(user => user.username === STANDARD_ADMIN_USERNAME)
      || db.data.users.find(user => user.username === ownerUsername);
    if (!ownerAccount) return res.status(500).json({ error: 'تعذر تجهيز حساب المالك الأول.' });
    const conflictingUser = db.data.users.find(user => user !== ownerAccount && user.username === ownerUsername);
    if (conflictingUser) return res.status(409).json({ error: 'اسم مستخدم المالك مستخدم بالفعل.' });
    ownerAccount.username = ownerUsername;
    ownerAccount.name = ownerName || ownerAccount.name || 'مالك النظام';
    ownerAccount.password_hash = passwordHash(ownerPassword);
    ownerAccount.must_change_password = false;
    ownerAccount.bootstrap_password_initialized = true;
    ownerAccount.is_owner = true;
    ownerAccount.role = 'admin';
    ownerAccount.permissions = [...ADMIN_PERMISSIONS];
    ownerAccount.is_active = true;
    db.data.business_profile = { business_name: businessName, owner_name: ownerName, activity, address, phone, logo_data_url: logoData };
    db.save();
    const profile = readBusinessProfile();
    res.json({ message: 'تم حفظ بيانات النشاط.', business_profile: profile });
  } catch (error) {
    res.status(500).json({ error: 'تعذر حفظ بيانات النشاط: ' + error.message });
  }
});

app.all(['/api/config/business-profile', '/api/business-profile'], (req, res) => {
  if (!['PUT', 'POST'].includes(req.method)) return res.status(405).json({ error: 'طريقة الطلب غير مدعومة.' });
  try {
    if (!requireAdmin(req.authUser?.id, res)) return;
    const current = readBusinessProfile();
    const businessName = String(req.body?.business_name ?? '').trim();
    const ownerName = String(req.body?.owner_name ?? current.owner_name ?? '').trim();
    const activity = String(req.body?.activity ?? '').trim();
    const address = String(req.body?.address ?? '').trim();
    const phone = String(req.body?.phone ?? current.phone ?? '').trim();
    const email = String(req.body?.email ?? current.email ?? '').trim();
    const currency = String(req.body?.currency ?? current.currency ?? 'EGP').trim().toUpperCase();
    const currencySymbol = String(req.body?.currency_symbol ?? current.currency_symbol ?? 'ج.م').trim();
    const timezone = String(req.body?.timezone ?? current.timezone ?? 'Africa/Cairo').trim();
    const language = String(req.body?.language ?? current.language ?? 'ar').trim();
    if (!businessName || businessName.length > 100) return res.status(400).json({ error: 'اكتب اسم النشاط بحد أقصى 100 حرف.' });
    if (ownerName.length > 100 || activity.length > 100 || address.length > 250 || phone.length > 30 || email.length > 160 || currency.length > 8 || currencySymbol.length > 8 || timezone.length > 64) return res.status(400).json({ error: 'أحد حقول بيانات النشاط أطول من الحد المسموح.' });
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'أدخل بريداً إلكترونياً صحيحاً.' });
    if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'رمز العملة يجب أن يتكون من 3 أحرف.' });
    if (!['ar', 'en'].includes(language)) return res.status(400).json({ error: 'لغة النظام غير مدعومة.' });
    const phoneDigits = phone.replace(/[^0-9]/g, '');
    if (phone && (phoneDigits.length < 7 || phoneDigits.length > 15)) return res.status(400).json({ error: 'أدخل رقم تواصل صحيحاً من 7 إلى 15 رقماً.' });
    const previous = db.data.business_profile && typeof db.data.business_profile === 'object' ? db.data.business_profile : {};
    let logoData = String(previous.logo_data_url || '');
    if (req.body?.remove_logo === true) logoData = '';
    if (req.body?.logo_data_url) {
      const match = String(req.body.logo_data_url).match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) return res.status(400).json({ error: 'صيغة اللوجو غير مدعومة. استخدم PNG أو JPG أو WebP.' });
      const bytes = Buffer.from(match[2], 'base64');
      if (!bytes.length || bytes.length > 4 * 1024 * 1024) return res.status(400).json({ error: 'حجم اللوجو يجب ألا يتجاوز 4 ميجابايت.' });
      const signatureValid = match[1] === 'png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : match[1] === 'jpeg'
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!signatureValid) return res.status(400).json({ error: 'محتوى الصورة لا يطابق نوع الملف المحدد.' });
      logoData = String(req.body.logo_data_url);
    }
    db.data.business_profile = { business_name: businessName, owner_name: ownerName, activity, address, phone, email, currency, currency_symbol: currencySymbol, timezone, language, logo_data_url: logoData };
    db.save();
    db.logAudit(req.authUser.id, 'تعديل بيانات النشاط', 'system', 1, `تم تحديث بيانات ${businessName}`);
    const profile = readBusinessProfile();
    res.json({ message: 'تم حفظ بيانات النشاط.', business_profile: profile, contact_phone: profile.phone });
  } catch (error) {
    res.status(500).json({ error: 'تعذر حفظ بيانات النشاط: ' + error.message });
  }
});

app.post('/api/config/contact-phone', (req, res) => {
  try {
    const { phone, current_user_id } = req.body;
    if (!requireAdmin(current_user_id, res)) return;
    const normalized = String(phone || '').trim();
    const digits = normalized.replace(/[^0-9]/g, '');
    if (digits.length < 7 || digits.length > 15) return res.status(400).json({ error: 'أدخل رقم تواصل صحيحاً من 7 إلى 15 رقماً.' });
    const configPath = process.env.RAWDA_CONFIG_PATH || path.join(__dirname, 'config.json');
    const config = readRuntimeConfig();
    config.contact_phone = normalized;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    db.logAudit(current_user_id, 'تغيير رقم التواصل', 'system', 1, 'تم تحديث رقم التواصل الظاهر في الدخول والفواتير');
    res.json({ message: 'تم حفظ رقم التواصل.', contact_phone: normalized });
  } catch (err) {
    res.status(500).json({ error: 'تعذر حفظ رقم التواصل: ' + err.message });
  }
});

app.post('/api/config/db-path', (req, res) => {
  try {
    const { path: newPath, current_user_id, allow_risky_path } = req.body;
    if (!requireAdmin(current_user_id, res)) return;
    if (!newPath) return res.status(400).json({ error: 'المسار مطلوب' });
    const location = classifyDatabaseLocation(newPath);
    if (location.risky && allow_risky_path !== true) return res.status(409).json({ error: `الموقع قد يتزامن أو ينقطع (${location.reasons.join('، ')}). اختر مجلد userData المحلي أو أكّد المتابعة من نافذة النظام.` });
    const result = db.setDatabasePath(newPath, current_user_id);
    res.json({ message: 'تم تغيير مسار حفظ قاعدة البيانات ونقل البيانات بنجاح', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/config/network', (req, res) => {
  try {
    const { port, host, public_url, trust_proxy, current_user_id } = req.body;
    const user = db.data.users.find(u => u.id === Number(current_user_id));
    if (!user || (!user.is_owner && !userHasPermission(user, 'system_settings'))) return res.status(403).json({ error: 'تعديل إعدادات الشبكة غير مسموح لهذا المستخدم.' });

    const nextPort = Number(port);
    const nextHost = String(host || '').trim();
    if (!Number.isInteger(nextPort) || nextPort < 1024 || nextPort > 65535) {
      return res.status(400).json({ error: 'المنفذ يجب أن يكون رقماً صحيحاً بين 1024 و65535' });
    }
    if (!nextHost || !/^[a-zA-Z0-9.:-]+$/.test(nextHost)) {
      return res.status(400).json({ error: 'عنوان الاستماع غير صالح' });
    }
    let nextPublicUrl = '';
    if (String(public_url || '').trim()) {
      let parsed;
      try { parsed = new URL(String(public_url).trim()); } catch (_) { return res.status(400).json({ error: 'رابط الوصول العام غير صالح.' }); }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
        return res.status(400).json({ error: 'اكتب رابطًا عامًا بصيغة HTTPS مثل https://pos.example.com دون مسار إضافي.' });
      }
      nextPublicUrl = parsed.origin;
    }
    let nextTrustProxy;
    try { nextTrustProxy = normalizeTrustProxy(trust_proxy === undefined ? runtimeConfig.trust_proxy : trust_proxy); }
    catch (error) { return res.status(400).json({ error: error.message }); }

    let config = {};
    const configPath = process.env.RAWDA_CONFIG_PATH || path.join(__dirname, 'config.json');
    if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.port = nextPort;
    config.host = nextHost;
    config.public_url = nextPublicUrl;
    config.trust_proxy = nextTrustProxy;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    db.logAudit(current_user_id, 'تعديل إعدادات الشبكة', 'system', 1, `تغيير عنوان الاستماع إلى ${nextHost} والمنفذ إلى ${nextPort}؛ proxy=${JSON.stringify(nextTrustProxy)}؛ public_url=${nextPublicUrl || '(فارغ)'}`);
    res.json({ message: 'تم حفظ إعدادات الشبكة. أعد تشغيل التطبيق لتطبيقها.', port: nextPort, host: nextHost, public_url: nextPublicUrl, trust_proxy: nextTrustProxy, restart_required: true });
  } catch (err) {
    res.status(500).json({ error: `تعذر حفظ إعدادات الشبكة: ${err.message}` });
  }
});

// Unknown API routes must stay JSON 404s instead of falling through to the single-page app.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'مسار API غير موجود' });
});

// Serve frontend main page
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Keep the desktop loopback HTTP listener; expose a separate TLS listener for LAN browsers.
serverProfile('all-routes-registered-before-listen');
if (process.env.RAWDA_PROFILE === '1') console.error(`[PROFILE] server memory-before-listen: ${JSON.stringify(process.memoryUsage())}`);
let listener = app.listen(PORT, HOST, () => {
  const localIP = getLocalIP();
  const publicUrl = process.env.RAWDA_PUBLIC_URL || `${NETWORK_SCHEME}://${localIP}:${NETWORK_PORT}`;
  console.log(`===================================================================`);
  console.log(`SYSTEM لإدارة حسابات بضاعتك يعمل الآن!`);
  console.log(`💻 على هذا الجهاز (المحلي): http://localhost:${PORT}`);
  console.log(`📱 رابط المتصفح/الموبايل: ${publicUrl}`);
  console.log(`🔒 HTTPS/SSL للشبكة: ${HTTPS_ENABLED ? `مفعّل على المنفذ ${TLS_PORT}` : 'غير مفعّل؛ يلزم إعداد شهادة موثوقة لفتح الكاميرا من متصفح الهاتف'}`);
  console.log(`📁 مكان حفظ قاعدة البيانات النشط: ${db.getDatabasePath()}`);
  console.log(`===================================================================`);
});
if (HTTPS_ENABLED) {
  tlsListener = https.createServer(HTTPS_OPTIONS, app);
  tlsListener.listen(TLS_PORT, TLS_HOST, () => {
    const localIP = getLocalIP();
    console.log(`📱 رابط LAN الآمن: https://${localIP}:${TLS_PORT}`);
  });
}

let shuttingDownForBackup = false;
function backupAndStopServer() {
  if (shuttingDownForBackup) return;
  shuttingDownForBackup = true;
  clearInterval(dailyBackupTimer);
  const finishShutdown = async () => {
    let databaseClosed = false;
    const closeDatabaseAndExit = async () => {
      if (databaseClosed) return;
      databaseClosed = true;
      try { await googleDriveBackup.stop(); } catch (error) { console.error('Google Drive worker stop failed:', error.message); }
      try { scheduledBackups.stop?.(); } catch (error) { console.error('Scheduled backup stop failed:', error.message); }
      try { db.close(); } catch (error) { console.error('SQLite close failed:', error.message); }
      process.exit(0);
    };
    try {
      await new Promise(resolve => setImmediate(resolve));
      const pendingBackup = flushCoalescedSaleBackup();
      if (pendingBackup) await Promise.allSettled([pendingBackup]);
      await Promise.allSettled([...automaticBackupTasks]);
      try { await scheduledBackups.createBackup('close'); }
      catch (error) { console.error('Close-time scheduled backup failed:', error.message); }
      // Persist the encrypted local outbox before exit, but never wait for Google or the network.
      await scheduledBackups.flushCloudPreparation();
    } catch (error) {
      console.error('Shutdown preparation failed:', error.stack || error.message);
    } finally {
      const servers = [listener, tlsListener].filter(Boolean);
      const listening = servers.filter(server => server.listening);
      if (!listening.length) { closeDatabaseAndExit(); return; }
      let remaining = listening.length;
      const stopWhenDone = () => { remaining -= 1; if (!remaining) closeDatabaseAndExit(); };
      for (const server of servers) { if (server.listening) server.close(stopWhenDone); else stopWhenDone(); }
      setTimeout(closeDatabaseAndExit, 5000).unref();
    }
  };
  void finishShutdown();
}
process.once('SIGTERM', backupAndStopServer);
process.once('SIGINT', backupAndStopServer);
if (typeof process.send === 'function') {
  process.on('message', message => {
    if (receiveElectronHostResponse(message)) return;
    if (message && message.type === 'backup-and-exit') backupAndStopServer();
  });
}

function rebindLicensedListeners() {
  HOST = LICENSED_HOST;
  TLS_HOST = '0.0.0.0';
  const restartHttp = () => { listener = app.listen(PORT, HOST); };
  if (listener?.listening) listener.close(restartHttp); else restartHttp();
  if (HTTPS_ENABLED) {
    const restartTls = () => { tlsListener = https.createServer(HTTPS_OPTIONS, app); tlsListener.listen(TLS_PORT, TLS_HOST); };
    if (tlsListener?.listening) tlsListener.close(restartTls); else restartTls();
  }
}

// Appended user-management compatibility endpoint. Existing routes above are unchanged.
// Exposes the permissions catalog at the requested stable URL.
const userPermissionsCatalogAlias = express.Router();
userPermissionsCatalogAlias.get('/', (req, res) => {
  if (!requireGranular(req, res, 'users.manage_permissions')) return;
  const connection = db.storageAdapter.connection;
  const permissions = connection.prepare('SELECT id,code,name_ar,category FROM permissions ORDER BY category,code').all();
  const role_defaults = connection.prepare('SELECT role,permission_id,granted FROM role_defaults').all();
  res.json({ permissions, role_defaults });
});
app.use('/api/permissions', userPermissionsCatalogAlias);
// The existing API JSON 404 and SPA fallbacks precede this appended block.
// Move only the newly-added layer ahead of those fallbacks; no existing route is edited.
const appendedPermissionsLayer = app._router.stack.pop();
const apiFallbackIndices = app._router.stack
  .map((layer, index) => ({ layer, index }))
  .filter(({ layer }) => !layer.route && layer.regexp?.test('/api/__unmatched__'))
  .map(({ index }) => index);
const fallbackIndex = apiFallbackIndices.length ? Math.max(...apiFallbackIndices) : app._router.stack.findIndex(layer => layer.route?.path === '*');
app._router.stack.splice(fallbackIndex < 0 ? app._router.stack.length : fallbackIndex, 0, appendedPermissionsLayer);

// Appended duplicate-username contract guard; the original POST handler remains untouched.
const duplicateUsernameGuard = express.Router();
duplicateUsernameGuard.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const username = String(req.body?.username || '').trim();
  if (username && db.data.users.some(user => String(user.username || '').toLocaleLowerCase() === username.toLocaleLowerCase())) {
    return res.status(409).json({ error: 'اسم المستخدم موجود مسبقاً' });
  }
  next();
});
app.use('/api/users', duplicateUsernameGuard);
const appendedDuplicateGuardLayer = app._router.stack.pop();
const usersPostIndex = app._router.stack.findIndex(layer => layer.route?.path === '/api/users' && layer.route.methods?.post);
app._router.stack.splice(usersPostIndex < 0 ? app._router.stack.length : usersPostIndex, 0, appendedDuplicateGuardLayer);

// Appended atomic permissions writer. The original PUT handler remains unchanged.
const atomicUserPermissionsRoute = express.Router();
atomicUserPermissionsRoute.put('/:id/permissions', (req, res) => {
  if (!requireGranular(req, res, 'users.manage_permissions')) return;
  const user = db.data.users.find(row => Number(row.id) === Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'المستخدم غير موجود.' });
  const connection = db.storageAdapter.connection;
  const overrides = Array.isArray(req.body?.overrides) ? req.body.overrides : [];
  const permissionRows = connection.prepare('SELECT id,code FROM permissions').all();
  const idsByCode = new Map(permissionRows.map(row => [String(row.code), Number(row.id)]));
  const normalized = overrides.map(item => ({ code: String(item?.code || ''), granted: item?.granted === true || Number(item?.granted) === 1 ? 1 : 0 }));
  if (normalized.some(item => !idsByCode.has(item.code))) return res.status(400).json({ error: 'توجد صلاحية غير معروفة.' });
  const uniqueCodes = new Set(normalized.map(item => item.code));
  if (uniqueCodes.size !== normalized.length) return res.status(400).json({ error: 'لا يمكن تكرار الصلاحية في الطلب.' });
  const constraints = req.body?.constraints || {};
  const maxDiscount = Number(constraints.max_discount_percent ?? 100);
  const maxInvoice = Number(constraints.max_invoice_amount ?? 0);
  const canDelete = constraints.can_delete_invoice === true || Number(constraints.can_delete_invoice) === 1 ? 1 : 0;
  if (!Number.isFinite(maxDiscount) || maxDiscount < 0 || maxDiscount > 100 || !Number.isFinite(maxInvoice) || maxInvoice < 0) return res.status(400).json({ error: 'قيود المستخدم غير صالحة.' });
  try {
    connection.exec('BEGIN IMMEDIATE');
    connection.prepare('DELETE FROM user_permissions WHERE user_id=?').run(Number(user.id));
    const insert = connection.prepare('INSERT INTO user_permissions(user_id,permission_id,granted,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)');
    for (const item of normalized) insert.run(Number(user.id), idsByCode.get(item.code), item.granted);
    const savedCount = Number(connection.prepare('SELECT COUNT(*) AS count FROM user_permissions WHERE user_id=?').get(Number(user.id)).count);
    if (savedCount !== normalized.length) throw new Error(`تم حفظ ${savedCount} صلاحيات من أصل ${normalized.length}`);
    connection.prepare('INSERT INTO permission_constraints(user_id,max_discount_percent,max_invoice_amount,can_delete_invoice,updated_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET max_discount_percent=excluded.max_discount_percent,max_invoice_amount=excluded.max_invoice_amount,can_delete_invoice=excluded.can_delete_invoice,updated_at=CURRENT_TIMESTAMP').run(Number(user.id), maxDiscount, maxInvoice, canDelete);
    connection.exec('COMMIT');
    db.logAudit(req.authUser.id, 'تعديل صلاحيات مستخدم', 'user_permissions', user.id, { saved_count: savedCount, requested_count: normalized.length, constraints: { max_discount_percent: maxDiscount, max_invoice_amount: maxInvoice, can_delete_invoice: canDelete } });
    return res.json({ user_id: user.id, permissions: granularPermissionsForUser(user), constraints: permissionConstraintsForUser(user), saved_count: savedCount });
  } catch (error) {
    try { connection.exec('ROLLBACK'); } catch (_) {}
    return res.status(500).json({ error: `تعذر حفظ صلاحيات المستخدم atomically: ${error.message}` });
  }
});
app.use('/api/users', atomicUserPermissionsRoute);
const appendedAtomicPermissionsLayer = app._router.stack.pop();
const oldPermissionsPutIndex = app._router.stack.findIndex(layer => layer.route?.path === '/api/users/:id/permissions' && layer.route.methods?.put);
app._router.stack.splice(oldPermissionsPutIndex < 0 ? app._router.stack.length : oldPermissionsPutIndex, 0, appendedAtomicPermissionsLayer);

// Appended active-users view. The original GET /api/users remains unchanged below.
const activeUsersViewRoute = express.Router();
activeUsersViewRoute.get('/', (req, res) => {
  const unrestricted = isUnrestrictedAccount(req.authUser);
  const callerBranches = new Set(unrestricted ? db.data.branches.map(branch => Number(branch.id)) : getUserBranchIds(req.authUser));
  const users = db.data.users
    .filter(u => u.is_active !== false && !u.is_owner && u.is_hidden !== true && (unrestricted || getUserBranchIds(u).some(branchId => callerBranches.has(branchId))))
    .map(u => ({
      id: u.id, name: u.name, username: u.username, role: u.role,
      permissions: granularPermissionsForUser(u),
      allowed_tabs: Array.isArray(u.allowed_tabs) ? u.allowed_tabs : null,
      branch_id: u.branch_id ?? db.data.default_branch_id,
      branch_ids: getUserBranchIds(u),
      branch_names: getUserBranchIds(u).map(branchId => db.data.branches.find(branch => Number(branch.id) === branchId)?.name).filter(Boolean),
      branch_name: db.data.branches.find(branch => branch.id === Number(u.branch_id))?.name || 'الفرع الرئيسي',
      is_active: u.is_active, created_at: u.created_at
    }));
  res.json(users);
});
app.use('/api/users', activeUsersViewRoute);
const appendedActiveUsersLayer = app._router.stack.pop();
const oldUsersGetIndex = app._router.stack.findIndex(layer => layer.route?.path === '/api/users' && layer.route.methods?.get);
app._router.stack.splice(oldUsersGetIndex < 0 ? app._router.stack.length : oldUsersGetIndex, 0, appendedActiveUsersLayer);

// Appended effective-permissions API. Existing user routes remain unchanged.
const { effectivePermissionsForUser } = require('./user-permissions-effective');
const effectiveUsersApiRoute = express.Router();
effectiveUsersApiRoute.get('/:id/permissions', (req, res) => {
  if (!requireGranular(req, res, 'users.manage_permissions')) return;
  const user = db.data.users.find(row => Number(row.id) === Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'المستخدم غير موجود.' });
  const effective = effectivePermissionsForUser(db.storageAdapter.connection, user);
  res.json({ user_id: user.id, role: user.role, permissions: effective.details, effective_codes: effective.codes, source: effective.source, constraints: permissionConstraintsForUser(user) });
});
effectiveUsersApiRoute.get('/', (req, res) => {
  const unrestricted = isUnrestrictedAccount(req.authUser);
  const callerBranches = new Set(unrestricted ? db.data.branches.map(branch => Number(branch.id)) : getUserBranchIds(req.authUser));
  const users = db.data.users
    .filter(u => u.is_active !== false && !u.is_owner && u.is_hidden !== true && (unrestricted || getUserBranchIds(u).some(branchId => callerBranches.has(branchId))))
    .map(u => {
      const effective = effectivePermissionsForUser(db.storageAdapter.connection, u);
      return {
        id: u.id, name: u.name, username: u.username, role: u.role,
        permissions: effective.codes,
        allowed_tabs: Array.isArray(u.allowed_tabs) ? u.allowed_tabs : null,
        branch_id: u.branch_id ?? db.data.default_branch_id,
        branch_ids: getUserBranchIds(u),
        branch_names: getUserBranchIds(u).map(branchId => db.data.branches.find(branch => Number(branch.id) === branchId)?.name).filter(Boolean),
        branch_name: db.data.branches.find(branch => branch.id === Number(u.branch_id))?.name || 'الفرع الرئيسي',
        is_active: u.is_active, created_at: u.created_at
      };
    });
  res.json(users);
});
app.use('/api/users', effectiveUsersApiRoute);
const appendedEffectiveUsersLayer = app._router.stack.pop();
const existingUserApiIndices = app._router.stack
  .map((layer, index) => ({ layer, index }))
  .filter(({ layer }) => layer.handle === activeUsersViewRoute
    || layer.route?.path === '/api/users/:id/permissions'
    || (layer.route?.path === '/api/users' && layer.route.methods?.get))
  .map(({ index }) => index);
const firstUserApiIndex = existingUserApiIndices.length ? Math.min(...existingUserApiIndices) : app._router.stack.length;
app._router.stack.splice(firstUserApiIndex, 0, appendedEffectiveUsersLayer);




