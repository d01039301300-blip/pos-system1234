'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const APP = 'SystemPOS';
const SECRET = 'sp-trial-v1-3a9f8e7d6c5b4a2f';
const TRIAL_DAYS = 30;
const TRIAL_MS = TRIAL_DAYS * 86400 * 1000;

function fileLocs() {
  const out = [];
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, APP, 't.dat'));
  if (process.env.LOCALAPPDATA) out.push(path.join(process.env.LOCALAPPDATA, APP, 't.dat'));
  out.push(path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', APP, 't.dat'));
  out.push(path.join(os.homedir(), '.' + APP.toLowerCase(), 't.dat'));
  out.push(path.join(process.env.TEMP || os.tmpdir(), '.' + APP.toLowerCase() + '.dat'));
  return out;
}

const REG_STATE = ['HKCU\\Software\\' + APP + '\\trial', 'HKLM\\Software\\' + APP + '\\trial'];
const REG_CANARY = ['HKCU\\Software\\' + APP + '\\canary', 'HKLM\\Software\\' + APP + '\\canary'];

function deriveKey(deviceHash) {
  return crypto.createHash('sha256').update(String(deviceHash || 'x') + '|' + SECRET).digest();
}

function encrypt(obj, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const p = Buffer.from(JSON.stringify(obj), 'utf8');
  const e = Buffer.concat([c.update(p), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), e]).toString('base64');
}

function decrypt(b64, key) {
  try {
    const b = Buffer.from(b64, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const p = Buffer.concat([d.update(b.subarray(28)), d.final()]);
    return JSON.parse(p.toString('utf8'));
  } catch { return null; }
}

function regRead(keyPath) {
  try {
    const o = cp.execFileSync('reg.exe', ['query', keyPath, '/ve'], {
      encoding: 'utf8', timeout: 3000, windowsHide: true
    });
    const m = o.match(/REG_SZ\s+(\S+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

function regWrite(keyPath, value) {
  try {
    cp.execFileSync('reg.exe', ['add', keyPath, '/v', '', '/t', 'REG_SZ', '/d', value, '/f'],
      { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function regDelete(keyPath) {
  try {
    cp.execFileSync('reg.exe', ['delete', keyPath, '/f'],
      { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: 'ignore' });
  } catch {}
}

function fileWrite(p, c) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c, 'utf8'); return true; }
  catch { return false; }
}

function fileRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function writeAll(state, deviceHash) {
  const key = deriveKey(deviceHash);
  const blob = encrypt(state, key);
  let n = 0;
  for (const p of fileLocs()) if (fileWrite(p, blob)) n++;
  for (const r of REG_STATE) if (regWrite(r, blob)) n++;
  return n;
}

function readAll(deviceHash) {
  const key = deriveKey(deviceHash);
  const out = [];
  for (const p of fileLocs()) {
    const c = fileRead(p);
    if (c) { const s = decrypt(c, key); if (s) out.push({ src: 'file', path: p, state: s }); }
  }
  for (const r of REG_STATE) {
    const c = regRead(r);
    if (c) { const s = decrypt(c, key); if (s) out.push({ src: 'reg', path: r, state: s }); }
  }
  return out;
}

function writeCanary() {
  let n = 0;
  for (const r of REG_CANARY) if (regWrite(r, '1')) n++;
  return n;
}

function readCanary() {
  for (const r of REG_CANARY) if (regRead(r)) return true;
  return false;
}

function loadOrInit(deviceHash, opts = {}) {
  if (!deviceHash) return { status: 'error', reason: 'no-device-hash' };
  const now = opts.now || Date.now();
  const found = readAll(deviceHash);
  const canary = readCanary();

  if (found.length === 0) {
    if (canary) return { status: 'tampered', reason: 'state-missing-canary-present' };
    const fresh = { v: 1, first_launch: now, last_launch: now, max_seen: now };
    writeAll(fresh, deviceHash);
    writeCanary();
    return { status: 'trial', state: fresh, days_left: TRIAL_DAYS, first: true };
  }

  found.sort((a, b) => (a.state.first_launch || 0) - (b.state.first_launch || 0));
  const auth = found[0].state;
  const maxSeen = Math.max(...found.map(f => f.state.max_seen || 0), now);

  if (now < maxSeen - 86400000) {
    return { status: 'tampered', reason: 'clock-rollback', state: auth };
  }

  const elapsed = now - auth.first_launch;
  if (elapsed > TRIAL_MS) {
    return { status: 'expired', state: auth, days_left: 0 };
  }

  const upd = { ...auth, last_launch: now, max_seen: maxSeen };
  writeAll(upd, deviceHash);
  if (!canary) writeCanary();
  return {
    status: 'trial',
    state: upd,
    days_left: Math.max(0, Math.ceil((TRIAL_MS - elapsed) / 86400000))
  };
}

function wipeAll() {
  for (const p of fileLocs()) { try { fs.unlinkSync(p); } catch {} }
  for (const r of REG_STATE) regDelete(r);
  for (const r of REG_CANARY) regDelete(r);
}

module.exports = {
  TRIAL_DAYS, TRIAL_MS,
  loadOrInit, readAll, writeAll, readCanary, writeCanary, wipeAll,
  _deriveKey: deriveKey, _encrypt: encrypt, _decrypt: decrypt
};
