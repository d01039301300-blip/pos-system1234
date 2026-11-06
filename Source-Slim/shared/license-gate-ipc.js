'use strict';

const { ipcMain } = require('electron');
const fp = require('./device-fingerprint');
const status = require('./license-status');
const lv = require('./license-verify');
const lp = require('./license-path');

let _lastStatus = null;

function install() {
  ipcMain.handle('license:get-status', async () => {
    _lastStatus = status.evaluate();
    return {
      ..._lastStatus,
      deviceId: status.deviceIdForDisplay(fp.compute(true))
    };
  });

  ipcMain.handle('license:activate', async (_evt, licenseJson) => {
    if (!licenseJson || typeof licenseJson !== 'object') {
      return { ok: false, reason: 'invalid-json' };
    }
    const fpData = fp.compute(true);
    if (!fpData.stable) return { ok: false, reason: 'fingerprint-unstable' };

    const verify = lv.verifyLicense(licenseJson, fpData, { now: Date.now() });
    if (!verify.valid) {
      return { ok: false, reason: verify.reason, detail: verify };
    }

    try {
      lp.saveLicense(licenseJson);
    } catch (e) {
      return { ok: false, reason: 'save-failed', detail: e.message };
    }

    _lastStatus = status.evaluate();
    return { ok: true, status: _lastStatus };
  });

  ipcMain.handle('license:quit', async () => {
    const { app } = require('electron');
    app.quit();
    return { ok: true };
  });

  return _lastStatus;
}

function shouldBlock() {
  _lastStatus = status.evaluate();
  const s = _lastStatus.state;
  return {
    blocked: !(s === 'trial' || s === 'licensed'),
    status: _lastStatus
  };
}

module.exports = { install, shouldBlock, getLast: () => _lastStatus };
