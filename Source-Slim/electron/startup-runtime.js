'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');

function firstRunDatabasePath(userDataPath, selectedDirectory = '') {
  return path.join(selectedDirectory || userDataPath, 'database.sqlite');
}

function classifyDatabaseLocation(value, { env = process.env, driveType = null } = {}) {
  const raw = String(value || '');
  const winPath = path.win32.resolve(raw);
  const reasons = [];
  if (/^(?:\\\\|\/\/)/u.test(raw) || /^\\\\/u.test(winPath)) reasons.push('UNC/network');
  const normalized = winPath.toLowerCase().replace(/\\+/g, '\\');
  const oneDriveRoots = ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer'].map(key => env[key]).filter(Boolean).map(root => path.win32.resolve(root).toLowerCase());
  if (/(?:^|\\)onedrive(?:\s-[^\\]+)?(?:\\|$)/iu.test(winPath) || oneDriveRoots.some(root => normalized === root || normalized.startsWith(`${root}\\`))) reasons.push('OneDrive');
  const drive = /^([a-z]:)\\/iu.exec(winPath)?.[1]?.toUpperCase();
  if (drive && typeof driveType === 'function') {
    const type = driveType(drive);
    if (type === 2 || type === 4 || type === 'removable' || type === 'network') reasons.push(type === 2 || type === 'removable' ? 'removable' : 'network');
  }
  return { risky: reasons.length > 0, reasons, resolvedPath: winPath };
}

function needsDatabaseLocationSelection(configPath) {
  return !fs.existsSync(configPath);
}

function isDatabaseLocationAvailable(databasePath, fsApi = fs) {
  try {
    const target = path.resolve(String(databasePath || ''));
    const parent = path.dirname(target);
    fsApi.accessSync(parent, fsApi.constants.W_OK);
    if (fsApi.existsSync(target)) fsApi.accessSync(target, fsApi.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function localFallbackDatabasePath(userDataPath, exists = fs.existsSync, now = Date.now) {
  const standard = firstRunDatabasePath(userDataPath);
  if (!exists(standard)) return standard;
  return path.join(userDataPath, `database-local-${now()}.sqlite`);
}

function findFreePort(preferredPort = 3000, host = '127.0.0.1') {
  const probe = port => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, host, () => {
      const selected = server.address().port;
      server.close(error => error ? reject(error) : resolve(selected));
    });
  });
  return probe(preferredPort).catch(() => probe(0));
}

function startupErrorDialog(reason, logPath) {
  return {
    type: 'error',
    title: 'تعذر تشغيل النظام',
    message: 'تعذر بدء تشغيل البرنامج.',
    detail: `${String(reason || 'سبب غير محدد')}\n\nملف السجل:\n${String(logPath || 'لم يُحدّد بعد')}`,
    buttons: ['إعادة المحاولة', 'فتح السجل', 'خروج'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  };
}

function isNonFatalNavigationAbort(errorCode) {
  const code = errorCode && typeof errorCode === 'object'
    ? (errorCode.errorCode ?? errorCode.errno ?? errorCode.code)
    : errorCode;
  return Number(code) === -3 || /ERR_ABORTED/i.test(`${String(code || '')} ${String(errorCode?.message || '')}`);
}

function appendOutputTail(current, chunk, maxLength = 16000) {
  return `${String(current || '')}${String(chunk || '')}`.slice(-Math.max(1, Number(maxLength) || 16000));
}

function formatStartupFailure({ reason, databasePath, port, exitCode, stdout, stderr } = {}) {
  return [
    String(reason || 'سبب غير محدد'),
    `قاعدة البيانات: ${String(databasePath || '(غير محدد)')}`,
    `المنفذ: ${String(port || '(غير محدد)')}`,
    `رمز خروج الخادم: ${exitCode === null || exitCode === undefined ? '(ما زال يعمل)' : exitCode}`,
    `آخر stdout:\n${String(stdout || '(لا يوجد)')}`,
    `آخر stderr:\n${String(stderr || '(لا يوجد)')}`
  ].join('\n');
}

module.exports = { firstRunDatabasePath, classifyDatabaseLocation, needsDatabaseLocationSelection, isDatabaseLocationAvailable, localFallbackDatabasePath, findFreePort, startupErrorDialog, isNonFatalNavigationAbort, appendOutputTail, formatStartupFailure };
