'use strict';

const fp = require('./device-fingerprint');
const ts = require('./trial-state');
const cg = require('./clock-guard');
const vm = require('./vm-detector');
const lv = require('./license-verify');
const lp = require('./license-path');

function evaluate(opts = {}) {
  const now = opts.now || Date.now();
  const fpData = opts.fpData || fp.compute(true);

  if (!fpData.stable || !fpData.deviceHash) {
    return { state: 'error', reason: 'fingerprint-unstable',
             missing: Object.entries(fpData.sources).filter(([,v]) => !v).map(([k]) => k) };
  }

  const vmResult = opts.vmResult || vm.detect();
  if (vmResult.isVM) {
    return { state: 'blocked', reason: 'virtual-machine', vmType: vmResult.type };
  }

  const clock = cg.check({ now });
  if (!clock.ok) {
    return { state: 'tampered', reason: 'clock-anomaly', issues: clock.issues };
  }

  const savedLicense = lp.loadLicense();
  if (savedLicense) {
    const verify = lv.verifyLicense(savedLicense, fpData, { now });
    if (verify.valid) {
      return {
        state: 'licensed',
        type: verify.type,
        customer: savedLicense.customer || null,
        issuedAt: savedLicense.issued_at || null,
        deviceHash: fpData.deviceHash
      };
    }
    return { state: 'invalid-license', reason: verify.reason, detail: verify };
  }

  const trial = ts.loadOrInit(fpData.deviceHash, { now });
  if (trial.status === 'trial') {
    return {
      state: 'trial',
      daysLeft: trial.days_left,
      firstLaunch: trial.state.first_launch,
      deviceHash: fpData.deviceHash
    };
  }
  if (trial.status === 'expired') {
    return { state: 'expired', deviceHash: fpData.deviceHash };
  }
  if (trial.status === 'tampered') {
    return { state: 'tampered', reason: trial.reason, deviceHash: fpData.deviceHash };
  }
  return { state: 'error', reason: trial.reason || 'unknown' };
}

function deviceIdForDisplay(fpData) {
  if (!fpData || !fpData.stable) return null;
  const payload = Buffer.concat([
    Buffer.from(fpData.cpu, 'hex'),
    Buffer.from(fpData.bios, 'hex'),
    Buffer.from(fpData.disk, 'hex')
  ]);
  return 'SPOS-' + payload.toString('base64');
}

module.exports = { evaluate, deviceIdForDisplay };
