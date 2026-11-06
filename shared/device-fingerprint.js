'use strict';

const crypto = require('node:crypto');
const cp = require('node:child_process');

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache = null;
let _cacheTs = 0;

const BAD_SERIALS = new Set([
  '', 'to be filled by o.e.m.', 'default string',
  '0', 'none', 'n/a', 'oem', 'not available', 'unknown',
  'system serial number', 'chassis serial number'
]);

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function isGood(s) {
  if (!s) return false;
  const t = String(s).toLowerCase().trim();
  return t.length >= 4 && !BAD_SERIALS.has(t);
}

function defaultRunner(script) {
  try {
    return cp.execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script
    ], { encoding: 'utf8', timeout: 6000, windowsHide: true }).trim();
  } catch { return ''; }
}

function compute(force = false, opts = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheTs < CACHE_TTL_MS) return _cache;
  const run = opts.runPowerShell || defaultRunner;

  const cpuRaw = run('(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty ProcessorId)');
  const biosRaw = run('(Get-CimInstance Win32_ComputerSystemProduct | Select-Object -ExpandProperty UUID)');
  const diskRaw = run('(Get-CimInstance Win32_DiskDrive | Where-Object { $_.Index -eq 0 } | Select-Object -First 1 -ExpandProperty SerialNumber)');
  const mbRaw = run('(Get-CimInstance Win32_BaseBoard | Select-Object -First 1 -ExpandProperty SerialNumber)');

  const cpu = isGood(cpuRaw) ? sha256('cpu:' + cpuRaw) : null;
  const bios = isGood(biosRaw) ? sha256('bios:' + biosRaw) : null;
  const disk = isGood(diskRaw) ? sha256('disk:' + diskRaw) : null;
  const mb = isGood(mbRaw) ? sha256('mb:' + mbRaw) : null;

  const core = [cpu, bios, disk].filter(Boolean);
  const deviceHash = core.length === 3 ? sha256(core.join('|')) : null;

  _cache = {
    cpu, bios, disk, mb, deviceHash,
    stable: core.length === 3,
    sources: { cpu: !!cpu, bios: !!bios, disk: !!disk, mb: !!mb }
  };
  _cacheTs = now;
  return _cache;
}

function compare(fpA, fpB) {
  if (!fpA || !fpB) return { match: 0, total: 0, valid: false };
  let match = 0, total = 0;
  for (const k of ['cpu', 'bios', 'disk']) {
    if (fpA[k] && fpB[k]) {
      total++;
      if (fpA[k] === fpB[k]) match++;
    }
  }
  return { match, total, valid: match >= 2 && total >= 2 };
}

module.exports = { compute, compare, sha256, _cache: () => { _cache = null; _cacheTs = 0; } };
