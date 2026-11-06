'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { compare } = require('./device-fingerprint');

const PUB_KEY_PATH = path.join(__dirname, 'license-public-key.pem');

function loadPublicKey(customPath) {
  const pem = fs.readFileSync(customPath || PUB_KEY_PATH, 'utf8');
  return crypto.createPublicKey(pem);
}

function verifySignature(licenseObj, pubKeyPath) {
  const { sig, ...payload } = licenseObj;
  if (!sig || typeof sig !== 'string') return false;
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = Buffer.from(sig, 'base64');
  try {
    return crypto.verify(null, data, loadPublicKey(pubKeyPath), signature);
  } catch { return false; }
}

function verifyLicense(licenseObj, currentFp, opts = {}) {
  if (!licenseObj || typeof licenseObj !== 'object') {
    return { valid: false, reason: 'malformed' };
  }
  if (licenseObj.v !== 1) return { valid: false, reason: 'bad-version' };
  if (!verifySignature(licenseObj, opts.pubKeyPath)) return { valid: false, reason: 'bad-signature' };

  const fp = licenseObj.fp || {};
  const cmp = compare(fp, currentFp);
  if (!cmp.valid) {
    return { valid: false, reason: 'device-mismatch', match: cmp.match, total: cmp.total };
  }

  const now = opts.now || Date.now();
  if (licenseObj.expires_at) {
    const expiry = Date.parse(licenseObj.expires_at);
    if (!Number.isFinite(expiry)) return { valid: false, reason: 'invalid-expiration' };
    if (now > expiry) return { valid: false, reason: 'trial-expired' };
  }
  return { valid: true, type: licenseObj.type || 'perpetual', fpMatch: cmp };
}

module.exports = { verifyLicense, verifySignature, loadPublicKey, PUB_KEY_PATH };
