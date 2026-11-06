'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TRIAL_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const TRIAL_SECRET = (() => {
  const dir = process.env.RAWDA_DATA_DIR || path.join(os.homedir(), '.system-pos');
  const keyFile = path.join(dir, 'trial.key');
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(keyFile)) {
      const key = fs.readFileSync(keyFile, 'utf8').trim();
      if (key.length >= 32) return key;
    }
    const key = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(keyFile, key, { encoding: 'utf8', mode: 0o600 });
    return key;
  } catch (_) { return crypto.randomBytes(32).toString('base64url'); }
})();
const LICENSE_TEXT_PREFIX = 'SYSTEM-LICENSE-1:';
const PUBLIC_KEY_PATH = path.join(__dirname, 'license-public.pem');
const REGISTRY_KEY = String.raw`HKCU\Software\GeneralBusinessPOS\LocalTrial`;
const LEGACY_REGISTRY_KEY = String.raw`HKCU\Software\Wija\GeneralBusinessPOSTrial`;

function getMachineId() {
  const cpuModel = os.cpus()[0]?.model || '';
  const source = [os.hostname(), os.platform(), cpuModel].join('|');
  return crypto.createHash('sha256').update(source).digest('hex').slice(0, 32).toUpperCase();
}

function canonicalize(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalize(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function encodeLicenseText(license) { return LICENSE_TEXT_PREFIX + Buffer.from(JSON.stringify(license), 'utf8').toString('base64url'); }
function parseLicenseText(text) {
  const value = String(text || '').trim();
  if (value.length > 16384) throw new Error('مفتاح التفعيل أكبر من الحد المسموح.');
  if (!value.startsWith(LICENSE_TEXT_PREFIX)) throw new Error('صيغة مفتاح التفعيل غير صحيحة.');
  let license;
  try { license = JSON.parse(Buffer.from(value.slice(LICENSE_TEXT_PREFIX.length), 'base64url').toString('utf8')); }
  catch (_) { throw new Error('تعذر قراءة مفتاح التفعيل.'); }
  if (!license || typeof license !== 'object' || Array.isArray(license)) throw new Error('صيغة مفتاح التفعيل غير صحيحة.');
  return license;
}
function verifyOfflineLicense(license, deviceId = getMachineId(), publicKey = readPublicKey(), now = Date.now()) {
  if (!license?.payload || typeof license.signature !== 'string') return { active: false, reason: 'ملف الترخيص غير صالح.' };
  let validSignature = false;
  try { validSignature = crypto.verify('sha256', Buffer.from(canonicalize(license.payload)), publicKey, Buffer.from(license.signature, 'base64')); } catch (_) {}
  if (!validSignature) return { active: false, reason: 'التوقيع غير صالح.' };
  if (license.payload.expiresAt) {
    const expiry = Date.parse(license.payload.expiresAt);
    if (!Number.isFinite(expiry)) return { active: false, reason: 'تاريخ انتهاء الترخيص غير صالح.' };
    if (now > expiry) return { active: false, reason: 'انتهت صلاحية الترخيص.' };
  }
  const devices = Array.isArray(license.payload.deviceIds) ? license.payload.deviceIds : [];
  if (devices.length !== 1 || devices[0] !== deviceId) return { active: false, reason: 'هذا الترخيص مخصص لجهاز واحد مختلف.' };
  return { active: true, mode: 'offline', customer: license.payload.customer || '', seats: 1, deviceId };
}
function activateLicenseText(text, deviceId, publicKey, persist, now = Date.now()) {
  let license;
  try { license = parseLicenseText(text); } catch (error) { return { active: false, reason: error.message }; }
  const status = verifyOfflineLicense(license, deviceId, publicKey, now);
  if (!status.active) return status;
  if (typeof persist === 'function') persist(license);
  return status;
}
function trialStateSignature(state, secret = TRIAL_SECRET) {
  const payload = JSON.stringify({ machineId: state.machineId, startedAt: state.startedAt, expiresAt: state.expiresAt, lastSeenAt: state.lastSeenAt });
  return crypto.createHmac('sha256', secret).update(String(state.machineId)).update(payload).digest('hex');
}
function createTrialState(machineId, now = Date.now(), secret = TRIAL_SECRET) {
  const state = { machineId, startedAt: now, expiresAt: now + TRIAL_DURATION_MS, lastSeenAt: now };
  state.signature = trialStateSignature(state, secret);
  return state;
}
function evaluateTrialState(state, machineId, now = Date.now(), secret = TRIAL_SECRET) {
  if (!state || state.machineId !== machineId) return { active: false, reason: 'بيانات التجربة غير صالحة لهذا الجهاز.' };
  const expected = trialStateSignature(state, secret); const actual = String(state.signature || '');
  const a = Buffer.from(expected); const b = Buffer.from(actual);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { active: false, reason: 'بيانات التجربة غير صالحة لهذا الجهاز.' };
  if (now < Number(state.lastSeenAt)) return { active: false, reason: 'ساعة Windows أُعيدت إلى وقت سابق؛ لا يمكن متابعة التجربة.' };
  const maxExpiry = Number(state.startedAt) + TRIAL_DURATION_MS;
  if (!Number.isFinite(maxExpiry) || Number(state.expiresAt) > maxExpiry) return { active: false, reason: 'بيانات التجربة غير صالحة لهذا الجهاز.' };
  if (now >= Number(state.expiresAt)) {
    const updated = { ...state, lastSeenAt: Math.max(now, Number(state.lastSeenAt)) };
    updated.signature = trialStateSignature(updated, secret);
    return { active: false, trial: true, expired: true, startedAt: Number(state.startedAt), expiresAt: Number(state.expiresAt), daysRemaining: 0, reason: 'انتهت الفترة التجريبية المجانية البالغة 30 يوماً. أدخل كود التفعيل لمتابعة الاستخدام.', state: updated };
  }
  const updated = { ...state, lastSeenAt: now }; updated.signature = trialStateSignature(updated, secret);
  return { active: true, trial: true, startedAt: Number(updated.startedAt), expiresAt: Number(updated.expiresAt), daysRemaining: Math.max(1, Math.ceil((Number(updated.expiresAt) - now) / (24 * 60 * 60 * 1000))), hoursRemaining: Math.max(1, Math.ceil((Number(updated.expiresAt) - now) / 3600000)), state: updated };
}
function readPublicKey() {
  return fs.readFileSync(PUBLIC_KEY_PATH, 'utf8');
}

function platformDataDir() {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'GeneralBusinessPOS');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'GeneralBusinessPOS');
  if (process.platform === 'win32') return path.join(os.homedir(), 'AppData', 'Roaming', 'GeneralBusinessPOS');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'GeneralBusinessPOS');
}

function configureDefaultStorage() {
  if (!process.env.RAWDA_DATA_DIR) process.env.RAWDA_DATA_DIR = platformDataDir();
  if (!process.env.RAWDA_CONFIG_PATH) process.env.RAWDA_CONFIG_PATH = path.join(process.env.RAWDA_DATA_DIR, 'config.json');
  if (!process.env.RAWDA_LICENSE_FILE) process.env.RAWDA_LICENSE_FILE = path.join(process.env.RAWDA_DATA_DIR, 'license.json');
  if (!process.env.RAWDA_TRIAL_STATE_PATH) process.env.RAWDA_TRIAL_STATE_PATH = path.join(process.env.RAWDA_DATA_DIR, 'trial-state.json');
  if (!process.env.RAWDA_DB_PATH) process.env.RAWDA_DB_PATH = path.join(process.env.RAWDA_DATA_DIR, 'database.sqlite');
}

function createLicenseManager(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.RAWDA_DATA_DIR || platformDataDir());
  const machineId = options.deviceId || getMachineId();
  const publicKey = options.publicKey || readPublicKey();
  const now = options.now || (() => Date.now());
  const trialFile = path.resolve(options.trialFile || path.join(dataDir, 'trial-state.json'));
  const licenseFile = path.resolve(options.licenseFile || path.join(dataDir, 'license.json'));
  const registry = options.registry || null;
  const isolatedTestRun = Boolean(String(process.env.SYSTEM_TEST_USER_DATA_DIR || '').trim());
  const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };
  const readRegistryState = key => {
    if (isolatedTestRun) return null;
    if (registry && typeof registry.read === 'function') { try { return registry.read(key, 'State') || null; } catch (_) { return null; } }
    if (process.platform !== 'win32') return null;
    try {
      const out = execFileSync('reg.exe', ['query', key, '/v', 'State'], { encoding: 'utf8', windowsHide: true });
      const encoded = out.match(/State\s+REG_SZ\s+([A-Za-z0-9+/=]+)/i)?.[1];
      return encoded ? JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) : null;
    } catch (_) { return null; }
  };
  const writeRegistryState = (key, state) => {
    if (isolatedTestRun) return;
    if (registry && typeof registry.write === 'function') { registry.write(key, 'State', state); return; }
    if (process.platform !== 'win32') return;
    const encoded = Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
    execFileSync('reg.exe', ['add', key, '/v', 'State', '/t', 'REG_SZ', '/d', encoded, '/f'], { windowsHide: true, stdio: 'ignore' });
  };
  const isTrustedState = state => {
    if (!state || state.machineId !== machineId) return false;
    const startedAt = Number(state.startedAt), expiresAt = Number(state.expiresAt), lastSeenAt = Number(state.lastSeenAt);
    if (![startedAt, expiresAt, lastSeenAt].every(Number.isFinite) || expiresAt <= startedAt || lastSeenAt < startedAt || expiresAt > startedAt + TRIAL_DURATION_MS) return false;
    const expected = trialStateSignature(state); const actual = String(state.signature || '');
    const a = Buffer.from(expected); const b = Buffer.from(actual);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const writeTrialState = state => {
    const errors = [];
    try { fs.mkdirSync(path.dirname(trialFile), { recursive: true }); fs.writeFileSync(trialFile, JSON.stringify(state), 'utf8'); } catch (error) { errors.push(error); }
    if (process.platform === 'win32' || registry) {
      for (const key of [REGISTRY_KEY, LEGACY_REGISTRY_KEY]) {
        try { writeRegistryState(key, state); } catch (error) { errors.push(error); }
      }
    }
    return errors;
  };
  const getStatus = () => {
    const time = Number(now());
    const licenseData = readJson(licenseFile);
    const licensed = verifyOfflineLicense(licenseData, machineId, publicKey, time);
    if (licensed.active) return { ...licensed, active: true, trial: false, mode: 'offline', deviceId: machineId };
    if (fs.existsSync(licenseFile) && licenseData) return { active: false, trial: false, mode: 'unlicensed', deviceId: machineId, reason: licensed.reason };
    const candidates = [readJson(trialFile), readRegistryState(REGISTRY_KEY), readRegistryState(LEGACY_REGISTRY_KEY)].filter(isTrustedState);
    if (candidates.some(state => time < Number(state.lastSeenAt))) {
      return { active: true, trial: true, tamper_detected: true, mode: 'trial', deviceId: machineId, reason: 'يرجى ضبط ساعة الجهاز لإتمام البيع' };
    }
    const startedAt = candidates.length ? Math.min(...candidates.map(state => Number(state.startedAt))) : time;
    const expiresAt = startedAt + TRIAL_DURATION_MS;
    const state = createTrialState(machineId, startedAt);
    state.expiresAt = expiresAt;
    state.lastSeenAt = Math.max(startedAt, time);
    state.signature = trialStateSignature(state);
    const persistenceErrors = writeTrialState(state);
    const evaluated = evaluateTrialState(state, machineId, time);
    if (!evaluated.active) {
      if (evaluated.state) writeTrialState(evaluated.state);
      return { ...evaluated, state: undefined, deviceId: machineId, mode: 'unlicensed', persistenceWarning: persistenceErrors.length > 0 };
    }
    return { ...evaluated, state: undefined, mode: 'trial', deviceId: machineId, persistenceWarning: persistenceErrors.length > 0 };
  };
  const activateText = text => activateLicenseText(text, machineId, publicKey, license => {
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = `${licenseFile}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(license, null, 2), 'utf8');
    fs.renameSync(temp, licenseFile);
  }, now());
  const activateObject = value => activateText(encodeLicenseText(value));
  return { dataDir, trialFile, licenseFile, machineId, registryPaths: { local: REGISTRY_KEY, legacy: LEGACY_REGISTRY_KEY, value: 'State' }, getStatus, activateText, activateObject, createTrialState, writeTrialState, isTrustedState };
}
configureDefaultStorage();
let defaultManager = createLicenseManager({ dataDir: process.env.RAWDA_DATA_DIR });
function configureDataDir(dataDir) {
  process.env.RAWDA_DATA_DIR = path.resolve(dataDir);
  process.env.RAWDA_CONFIG_PATH = process.env.RAWDA_CONFIG_PATH || path.join(process.env.RAWDA_DATA_DIR, 'config.json');
  process.env.RAWDA_DB_PATH = process.env.RAWDA_DB_PATH || path.join(process.env.RAWDA_DATA_DIR, 'database.sqlite');
  process.env.RAWDA_LICENSE_FILE = path.join(process.env.RAWDA_DATA_DIR, 'license.json');
  process.env.RAWDA_TRIAL_STATE_PATH = path.join(process.env.RAWDA_DATA_DIR, 'trial-state.json');
  defaultManager = createLicenseManager({ dataDir: process.env.RAWDA_DATA_DIR });
  return defaultManager;
}
function isLicensed() { return Boolean(defaultManager.getStatus().active); }
function getStatus() { return defaultManager.getStatus(); }
function activateTextForDevice(text) { return defaultManager.activateText(text); }
function activateLicenseObject(value) { return defaultManager.activateObject(value); }
function getPublicKey() { return readPublicKey(); }

module.exports = {
  TRIAL_DURATION_MS, LICENSE_TEXT_PREFIX, REGISTRY_KEY, LEGACY_REGISTRY_KEY, getMachineId, canonicalize, encodeLicenseText,
  parseLicenseText, verifyOfflineLicense, activateLicenseText, trialStateSignature, createTrialState, evaluateTrialState,
  createLicenseManager, configureDataDir, configureDefaultStorage, getDataDir: () => defaultManager.dataDir,
  getStatus, isLicensed, activateTextForDevice, activateLicenseObject, getPublicKey
};
