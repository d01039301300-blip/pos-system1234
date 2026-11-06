'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = 'SystemPOS';

function appDataDir() {
  const base = process.env.APPDATA
    || (process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Roaming')
      : path.join(os.homedir(), '.config'));
  return path.join(base, APP_DIR);
}

function licensePath() {
  return path.join(appDataDir(), 'license.json');
}

function ensureDir() {
  fs.mkdirSync(appDataDir(), { recursive: true });
  return appDataDir();
}

function saveLicense(obj) {
  ensureDir();
  fs.writeFileSync(licensePath(), JSON.stringify(obj, null, 2), 'utf8');
  return licensePath();
}

function loadLicense() {
  try {
    return JSON.parse(fs.readFileSync(licensePath(), 'utf8'));
  } catch { return null; }
}

function deleteLicense() {
  try { fs.unlinkSync(licensePath()); return true; } catch { return false; }
}

module.exports = { appDataDir, licensePath, ensureDir, saveLicense, loadLicense, deleteLicense };
