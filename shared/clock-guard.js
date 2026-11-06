'use strict';

const cp = require('node:child_process');

function defaultRunner(script) {
  try {
    return cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 4000, windowsHide: true }).trim();
  } catch { return ''; }
}

function getWindowsInstallDate(opts = {}) {
  const run = opts.runPowerShell || defaultRunner;
  const raw = run(
    '(Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion").InstallDate'
  );
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

function getLastBootTime(opts = {}) {
  const run = opts.runPowerShell || defaultRunner;
  const raw = run(
    '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString("o")'
  );
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

function check(opts = {}) {
  const now = opts.now || Date.now();
  const installDate = getWindowsInstallDate(opts);
  const lastBoot = getLastBootTime(opts);

  const issues = [];
  if (installDate && now < installDate - 3600000) {
    issues.push('clock-before-windows-install');
  }
  if (lastBoot && now < lastBoot - 600000) {
    issues.push('clock-before-last-boot');
  }

  return {
    ok: issues.length === 0,
    issues,
    now,
    windowsInstallDate: installDate,
    lastBootTime: lastBoot
  };
}

module.exports = { check, getWindowsInstallDate, getLastBootTime };
