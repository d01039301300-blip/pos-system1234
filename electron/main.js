const { app, BrowserWindow, dialog, ipcMain, shell, safeStorage, session, Menu, Tray, nativeImage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const license = require('../license');
const { resolveElectronStoragePaths } = require('./storage-paths');
const { isAllowedExternalUrl, isAllowedAppNavigation } = require('./external-url');
const { findFreePort, firstRunDatabasePath, classifyDatabaseLocation, needsDatabaseLocationSelection, isDatabaseLocationAvailable, localFallbackDatabasePath, startupErrorDialog, isNonFatalNavigationAbort, appendOutputTail, formatStartupFailure } = require('./startup-runtime');
const licenseGateIpc = require('../shared/license-gate-ipc');
const { registerHardwareIpc, diagnoseHardware } = require('./hardware-manager');

if (process.platform === 'win32') app.setAppUserModelId('com.generalbusiness.pos');
app.commandLine.appendSwitch('lang', 'en-GB');
const electronStoragePaths = resolveElectronStoragePaths({ appDataPath: app.getPath('appData'), isPackaged: app.isPackaged, env: process.env });
app.setPath('userData', electronStoragePaths.userDataPath);
Object.assign(process.env, electronStoragePaths.env);
license.configureDataDir(electronStoragePaths.userDataPath);
const DEV_LICENSE_BYPASS = process.env.NODE_ENV === 'development';

let PORT = 3000;
let TLS_PORT = PORT + 1000;
let serverProcess;
let serverProcessListeners = null;
let serverOutputTail = { stdout: '', stderr: '' };
let serverShutdownRequested = false;
let mainWindow;
let licenseWindow = null;
let backupBlockerInstalled = false;
let startupLogFile = '';
let currentTrialStatus = null;
let trialExpiryTimer = null;
let trialWatchTimer = null;
let startupInProgress = true;
let startupFailureDialogOpen = false;
let mainWindowCleanup = null;
let isQuitting = false;
let splashWindow = null;
let splashStartedAt = 0;
let splashLanguage = 'ar';
let splashCloseTimer = null;
let systemTray = null;
let databaseLocationRequest = null;

function savedUiLanguage() {
  // Intentionally ignored: unsupported saved language falls back to Arabic
  try {
    const data = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'ui-language.json'), 'utf8'));
    return data.language === 'en' ? 'en' : 'ar';
  } catch (_) { return 'ar'; }
}
function updateSplash(stage, message = '') {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  const labels = splashLanguage === 'en'
    ? { database: 'Preparing database', server: 'Starting local service', interface: 'Loading interface', ready: 'Ready' }
    : { database: 'تهيئة قاعدة البيانات', server: 'تشغيل الخادم', interface: 'تحميل الواجهة', ready: 'جاهز' };
  const steps = { database: 25, server: 55, interface: 82, ready: 100 };
  splashWindow.webContents.executeJavaScript(`(()=>{const p=document.querySelector('#progress');const s=document.querySelector('#stage');if(p)p.style.width=${steps[stage] || 0}+'%';if(s)s.textContent=${JSON.stringify(message || labels[stage] || labels.database)};})()`).catch(() => {});
}
function showStartupSplash() {
  splashStartedAt = Date.now();
  splashLanguage = savedUiLanguage();
  const logoPath = path.join(__dirname, '..', 'assets', 'system-primary-logo.png');
  let logo = '';
  // Intentionally ignored: optional splash logo may be unavailable
  try { logo = `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`; } catch (_) {}
  const copy = splashLanguage === 'en'
    ? ['SYSTEM — برنامج مبيعات متكامل', 'المبرمج: خالد ويجا — 01039301300', 'Preparing database']
    : ['SYSTEM — برنامج مبيعات متكامل', 'المبرمج: خالد ويجا — 01039301300', 'تهيئة قاعدة البيانات'];
  const html = `<!doctype html><html lang="${splashLanguage}" dir="${splashLanguage === 'en' ? 'ltr' : 'rtl'}"><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;width:100vw;height:100vh;display:grid;place-items:center;background:radial-gradient(ellipse at center,#263538 0,#11191c 70%);color:#fff;font-family:Segoe UI,Tahoma,sans-serif;overflow:hidden}main{text-align:center;width:84%;padding:28px 26px 24px;border:1px solid #ffffff35;border-radius:22px;background:#ffffff0d;backdrop-filter:blur(14px);box-shadow:0 18px 60px #0008}img{width:112px;height:112px;object-fit:contain;filter:drop-shadow(0 0 13px #e9ad5666);animation:glow 2.6s ease-in-out infinite alternate}h1{font-size:26px;margin:14px 0 8px}p{margin:6px 0;color:#f2d9af;font-size:16px;font-weight:600}#stage{margin-top:19px;color:#fff;font-size:14px}#track{height:8px;border-radius:9px;background:#ffffff24;overflow:hidden;margin-top:10px}#progress{height:100%;width:3%;border-radius:9px;background:linear-gradient(90deg,#9d001f,#f0526d);transition:width .28s ease}@keyframes glow{to{filter:drop-shadow(0 0 24px #ffd482aa);transform:scale(1.025)}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}</style><main><img src="${logo}" alt="SYSTEM"><h1>${copy[0]}</h1><p>${copy[1]}</p><div id="stage">${copy[2]}</div><div id="track"><div id="progress"></div></div></main></html>`;
  splashWindow = new BrowserWindow({ width: 620, height: 420, frame: false, resizable: false, center: true, show: false, alwaysOnTop: true, backgroundColor: '#11191c', icon: path.join(__dirname, '..', 'assets', 'system-app-icon.png'), webPreferences: { contextIsolation: true, sandbox: true } });
  splashWindow.setMenu(null);
  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => splashWindow?.show()).catch(error => logStartup(`Splash load failed: ${error.message}`));
  splashWindow.once('closed', () => { splashWindow = null; });
}

function ensureSystemTray() {
  if (systemTray && !systemTray.isDestroyed()) return;
  const iconPath = path.join(__dirname, '..', 'assets', 'system-app-icon.ico');
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) { logStartup(`Tray icon could not be loaded: ${iconPath}`); return; }
  systemTray = new Tray(icon);
  systemTray.setToolTip('SYSTEM — برنامج مبيعات متكامل');
  systemTray.setContextMenu(Menu.buildFromTemplate([
    { label: 'فتح SYSTEM', click: () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: 'خروج', click: () => app.quit() }
  ]));
  systemTray.on('double-click', () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } });
}
function destroySystemTray() {
  if (systemTray && !systemTray.isDestroyed()) systemTray.destroy();
  systemTray = null;
}
async function closeStartupSplash() {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  updateSplash('ready');
  const wait = Math.max(0, 1500 - (Date.now() - splashStartedAt));
  if (splashCloseTimer) clearTimeout(splashCloseTimer);
  await new Promise(resolve => { splashCloseTimer = setTimeout(resolve, wait); });
  if (!splashWindow || splashWindow.isDestroyed()) return;
  // Intentionally ignored: splash transition is cosmetic
  try { await splashWindow.webContents.executeJavaScript("document.querySelector('main').style.transition='opacity .28s ease';document.querySelector('main').style.opacity='0'"); } catch (_) {}
  await new Promise(resolve => setTimeout(resolve, 300));
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
}

function detachServerProcessListeners() {
  if (!serverProcess || !serverProcessListeners) return;
  const listeners = serverProcessListeners;
  serverProcess.stdout?.off('data', listeners.stdout);
  serverProcess.stderr?.off('data', listeners.stderr);
  serverProcess.off('message', listeners.message);
  serverProcess.off('error', listeners.error);
  serverProcess.off('exit', listeners.exit);
  serverProcessListeners = null;
}

function cleanupMainWindowListeners() {
  if (typeof mainWindowCleanup === 'function') mainWindowCleanup();
  mainWindowCleanup = null;
}

function stopTrialTimers() {
  if (trialExpiryTimer) clearTimeout(trialExpiryTimer);
  if (trialWatchTimer) clearInterval(trialWatchTimer);
  trialExpiryTimer = null;
  trialWatchTimer = null;
}

function logStartup(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  // Intentionally ignored: startup logging must not block application startup
  try {
    const folder = app.getPath('userData');
    fs.mkdirSync(folder, { recursive: true });
    startupLogFile = path.join(folder, 'startup.log');
    fs.appendFileSync(startupLogFile, line + '\n', 'utf8');
  } catch (_) {}
  console.log(line);
}

const ERROR_LOG_MAX_BYTES = 5 * 1024 * 1024;
const ERROR_LOG_ROTATIONS = 4;
const errorLogPath = () => path.join(app.getPath('userData'), 'error.log');
function sanitizeErrorLogText(value) {
  return String(value ?? '')
    .replace(/password\s*[=:]\s*[^\s,;&]+/giu, 'password=***')
    .replace(/(token|session[_-]?id)\s*[=:]\s*[^\s,;&]+/giu, '$1=***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, 'Bearer ***')
    .slice(0, 12000);
}
function sanitizeErrorLogEntry(entry = {}) {
  return {
    ts: sanitizeErrorLogText(entry.ts || new Date().toISOString()),
    level: sanitizeErrorLogText(entry.level || 'error'),
    type: sanitizeErrorLogText(entry.type || 'main.error'),
    message: sanitizeErrorLogText(entry.message),
    source: sanitizeErrorLogText(entry.source),
    line: Number(entry.line || 0) || 0,
    stack: sanitizeErrorLogText(entry.stack)
  };
}
function rotateErrorLogIfNeeded(nextBytes) {
  const target = errorLogPath();
  let currentSize = 0;
  try { currentSize = fs.statSync(target).size; } catch (err) { console.error('[1.16-B][main]', err); }
  if (currentSize + nextBytes <= ERROR_LOG_MAX_BYTES) return;
  for (let index = ERROR_LOG_ROTATIONS; index >= 1; index -= 1) {
    const source = index === 1 ? target : `${target}.${index - 1}`;
    const destination = `${target}.${index}`;
    try {
      if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
      if (fs.existsSync(source)) fs.renameSync(source, destination);
    } catch (err) { console.error('[1.16-B][main]', err); }
  }
}
function appendErrorLog(entry) {
  const safeEntry = sanitizeErrorLogEntry(entry);
  const line = `${JSON.stringify(safeEntry)}\n`;
  try {
    const target = errorLogPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    rotateErrorLogIfNeeded(Buffer.byteLength(line, 'utf8'));
    fs.appendFileSync(target, line, 'utf8');
    return true;
  } catch (err) { console.error('[1.16-B][main]', err); return false; }
}

const ALLOWED_SERVER_SECRET_NAMES = new Set(['google-drive-oauth-tokens', 'google-drive-encryption-key', 'google-drive-backup-password']);
function replyToServerHostRequest(requestId, result, error = '') {
  if (!serverProcess?.connected || !requestId) return;
  serverProcess.send({ type: 'electron-host-response', request_id: requestId, result, error: error ? String(error).slice(0, 500) : '' }, sendError => {
    if (sendError) logStartup(`Secure cloud service IPC response failed: ${sendError.message}`);
  });
}
async function handleServerHostRequest(message) {
  if (!message || message.type !== 'electron-host-request' || typeof message.request_id !== 'string') return;
  try {
    if (message.action === 'open-google-drive-auth') {
      const url = new URL(String(message.url || ''));
      if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth'
        || !/^[\w.-]+\.apps\.googleusercontent\.com$/u.test(url.searchParams.get('client_id') || '')
        || url.searchParams.get('scope') !== 'https://www.googleapis.com/auth/drive.file'
        || url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('Rejected an invalid Google OAuth URL.');
      await shell.openExternal(url.toString());
      replyToServerHostRequest(message.request_id, { opened: true });
      return;
    }
    if (message.action === 'hardware-diagnose') {
      replyToServerHostRequest(message.request_id, await diagnoseHardware());
      return;
    }
    if (message.action === 'secure-secret') {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('OS-protected secure storage is unavailable.');
      const name = String(message.name || '');
      if (!ALLOWED_SERVER_SECRET_NAMES.has(name)) throw new Error('Rejected an unapproved secure-storage key.');
      const secretDir = path.join(app.getPath('userData'), 'secure-cloud-secrets');
      const secretPath = path.join(secretDir, `${name}.bin`);
      if (message.operation === 'get') {
        if (!fs.existsSync(secretPath)) { replyToServerHostRequest(message.request_id, { value: null }); return; }
        const value = safeStorage.decryptString(fs.readFileSync(secretPath));
        replyToServerHostRequest(message.request_id, { value });
        return;
      }
      if (message.operation === 'set') {
        const value = String(message.value || '');
        if (!value || Buffer.byteLength(value, 'utf8') > 65536) throw new Error('Secure-storage value is empty or too large.');
        fs.mkdirSync(secretDir, { recursive: true });
        const temporary = `${secretPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporary, safeStorage.encryptString(value), { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, secretPath);
        replyToServerHostRequest(message.request_id, { saved: true });
        return;
      }
      if (message.operation === 'delete') {
        try { fs.unlinkSync(secretPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        replyToServerHostRequest(message.request_id, { deleted: true });
        return;
      }
      throw new Error('Rejected an unknown secure-storage operation.');
    }
    throw new Error('Rejected an unknown server host request.');
  } catch (error) {
    logStartup(`Secure cloud host request failed (${String(message.action || 'unknown')}): ${error.message}`);
    replyToServerHostRequest(message.request_id, null, error.message);
  }
}

function windowsDriveType(drive) {
  if (process.platform !== 'win32') return null;
  // Intentionally ignored: drive type detection is optional
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='${drive}'\").DriveType`], { encoding: 'utf8', windowsHide: true, timeout: 2500 }).trim();
    return Number(output) || null;
  } catch (_) { return null; }
}

async function confirmDatabaseLocation(parentWindow, selectedPath, defaultDirectory = app.getPath('userData')) {
  const location = classifyDatabaseLocation(selectedPath, { driveType: windowsDriveType });
  if (!location.risky) return { path: selectedPath, continued: false };
  const defaultPath = firstRunDatabasePath(defaultDirectory);
  const choice = await dialog.showMessageBox(parentWindow, {
    type: 'warning', title: 'موقع قاعدة البيانات قد لا يكون آمناً',
    message: 'الموقع المحدد قد يتزامن سحابياً أو ينقطع أثناء الكتابة.',
    detail: `المسار: ${selectedPath}\nسبب التحذير: ${location.reasons.join('، ')}\nالمجلد المحلي المقترح: ${defaultPath}`,
    buttons: ['استخدام الافتراضي', 'متابعة رغم ذلك'], defaultId: 0, cancelId: 0, noLink: true
  });
  if (choice.response === 0) return { path: defaultPath, continued: false };
  return { path: selectedPath, continued: true };
}

function showDatabaseLocationWindow(parentWindow, defaultDirectory) {
  return new Promise((resolve, reject) => {
    const picker = new BrowserWindow({
      width: 760,
      height: 520,
      minWidth: 680,
      minHeight: 460,
      resizable: false,
      modal: true,
      parent: parentWindow,
      show: false,
      title: 'SYSTEM — اختيار مكان حفظ البيانات',
      backgroundColor: '#090a0f',
      icon: path.join(__dirname, '..', 'build', 'icon.ico'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'database-location-preload.js')
      }
    });
    databaseLocationRequest = { window: picker, parentWindow, resolve, reject };
    picker.once('closed', () => {
      if (databaseLocationRequest?.window === picker) {
        databaseLocationRequest = null;
        reject(new Error('تم إغلاق شاشة اختيار مجلد حفظ البيانات.'));
      }
    });
    picker.loadFile(path.join(__dirname, 'database-location.html'), { query: { defaultDirectory } })
      .then(() => { if (!picker.isDestroyed()) { picker.show(); picker.focus(); } })
      .catch(error => { databaseLocationRequest = null; reject(error); });
  });
}
function rememberServerOutput(stream, chunk) {
  const text = String(chunk || '');
  serverOutputTail[stream] = appendOutputTail(serverOutputTail[stream], text);
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (const line of lines) logStartup(`Server ${stream}: ${line}`);
}
async function showStartupFailureDialog(reason) {
  if (startupFailureDialogOpen || !app.isReady()) return;
  startupFailureDialogOpen = true;
  try {
    let response;
    do {
      const details = formatStartupFailure({ reason, stdout: serverOutputTail.stdout, stderr: serverOutputTail.stderr });
      const options = startupErrorDialog(details, startupLogFile);
      const result = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      response = result.response;
      if (response === 1) {
        const openError = startupLogFile ? await shell.openPath(startupLogFile) : 'لم يُنشأ ملف startup.log بعد.';
        if (openError) logStartup(`Could not open startup.log: ${openError}`);
      }
    } while (response === 1);
    if (response === 0) {
      logStartup('User selected startup retry.');
      const oldWindow = mainWindow;
      mainWindow = null;
      if (oldWindow && !oldWindow.isDestroyed()) oldWindow.destroy();
      if (serverProcess && serverProcess.exitCode === null && !serverProcess.killed) {
        serverProcess.kill();
        await Promise.race([new Promise(resolve => serverProcess.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1500))]);
      }
      startupFailureDialogOpen = false;
      startupInProgress = true;
      try { await createWindow(); }
      catch (error) { logStartup(`Startup retry failed: ${error.stack || error.message}`); await showStartupFailureDialog(error.message || String(error)); }
      return;
    }
    logStartup('User selected exit after startup failure.');
    app.quit();
  } catch (error) { logStartup(`Startup error dialog failed: ${error.stack || error.message}`); app.quit(); }
  finally { startupFailureDialogOpen = false; }
}
async function loadStartupUrl(url, stage) {
  logStartup(`Stage: loadURL begin (${stage}): ${url}`);
  try {
    await mainWindow.loadURL(url);
    logStartup(`Stage: loadURL succeeded (${stage}): ${url}`);
    return true;
  } catch (error) {
    if (isNonFatalNavigationAbort(error)) {
      logStartup(`Stage: loadURL superseded without fatal error (${stage}): ${url}; ${error.message}`);
      return false;
    }
    logStartup(`Stage: loadURL failed (${stage}): ${url}; ${error.message}`);
    throw error;
  }
}
try {
  require('../campaign-whatsapp-manager');
  logStartup('Campaign manager module loaded.');
} catch (error) {
  logStartup(`Campaign manager unavailable; application startup continues: ${error.stack || error.message}`);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else app.on('second-instance', () => mainWindow?.focus());

licenseGateIpc.install();
registerHardwareIpc({ app, ipcMain });

function createLicenseWindow() {
  licenseWindow = new BrowserWindow({
    width: 640, height: 720,
    resizable: false,
    title: 'System POS — الترخيص',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'license-gate-preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  });
  licenseWindow.loadFile(path.join(__dirname, '..', 'license-gate.html'));
  licenseWindow.on('closed', () => { licenseWindow = null; });
}

ipcMain.on('license:proceed', () => {
  if (licenseWindow && !licenseWindow.isDestroyed()) licenseWindow.close();
  createWindow().catch(error => {
    logStartup(`Startup after license gate failed: ${error.stack || error.message}`);
    showStartupFailureDialog(error.message || String(error));
  });
});

process.on('uncaughtException', error => {
  appendErrorLog({ type: 'uncaughtException', message: error?.message || error, stack: error?.stack || '' });
  logStartup(`Uncaught exception: ${error.stack || error.message}`);
  if (mainWindow) showStartupFailureDialog(error.message || String(error));
});
process.on('unhandledRejection', reason => {
  appendErrorLog({ type: 'unhandledRejection', message: reason?.message || reason, stack: reason?.stack || '' });
  logStartup(`Unhandled rejection: ${reason?.stack || reason}`);
  if (mainWindow) showStartupFailureDialog(reason?.message || String(reason));
});

ipcMain.handle('append-error-log', (_event, entry = {}) => appendErrorLog(entry));

ipcMain.handle('choose-database-folder', async () => {
  const result = await dialog.showOpenDialog({
    title: 'اختيار مجلد حفظ قاعدة بيانات نقطة البيع',
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? '' : result.filePaths[0];
});

ipcMain.handle('confirm-database-path', async (_event, selectedPath) => {
  const result = await confirmDatabaseLocation(mainWindow, String(selectedPath || ''), app.getPath('userData'));
  return result;
});

ipcMain.handle('open-database-folder', async (_event, filePath) => {
  if (!filePath) return false;
  const folder = ['.sqlite', '.db'].includes(path.extname(filePath).toLowerCase()) ? path.dirname(filePath) : filePath;
  await shell.openPath(folder);
  return true;
});

ipcMain.handle('database-location-browse', async (event) => {
  const request = databaseLocationRequest;
  if (!request || request.window.isDestroyed() || event.sender !== request.window.webContents) return { canceled: true };
  const result = await dialog.showOpenDialog(request.window, {
    title: 'اختيار مجلد حفظ بياناتك',
    message: 'اختر المجلد الذي سيحتوي على database.sqlite.',
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? { canceled: true } : { canceled: false, directoryPath: result.filePaths[0] };
});

ipcMain.handle('database-location-confirm', async (event, directoryPath) => {
  const request = databaseLocationRequest;
  if (!request || request.window.isDestroyed() || event.sender !== request.window.webContents) return { ok: false, error: 'انتهت جلسة اختيار المجلد.' };
  const selectedDirectory = path.resolve(String(directoryPath || '').trim());
  if (!selectedDirectory) return { ok: false, error: 'اختر مجلداً صالحاً.' };
  try {
    fs.mkdirSync(selectedDirectory, { recursive: true });
    const selectedLocation = await confirmDatabaseLocation(request.parentWindow, firstRunDatabasePath(app.getPath('userData'), selectedDirectory), app.getPath('userData'));
    const result = { ok: true, databasePath: selectedLocation.path, continued: selectedLocation.continued };
    request.resolve(result);
    databaseLocationRequest = null;
    if (!request.window.isDestroyed()) request.window.close();
    return result;
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('database-location-cancel', (event) => {
  const request = databaseLocationRequest;
  if (!request || request.window.isDestroyed() || event.sender !== request.window.webContents) return { ok: true };
  request.reject(new Error('تم إلغاء اختيار مجلد حفظ البيانات.'));
  databaseLocationRequest = null;
  request.window.close();
  return { ok: true };
});

ipcMain.handle('business-catalog-open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'اختيار كتالوج SYSTEM أو كتالوج الأدوية',
    properties: ['openFile'],
    filters: [{ name: 'ملفات الكتالوج (*.json)', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const filePath = result.filePaths[0];
  const lowerName = path.basename(filePath).toLowerCase();
  const isSystemCatalog = lowerName.endsWith('.system-catalog.json');
  const isMedicineCatalog = lowerName === 'medicine-catalog.json' || lowerName.endsWith('.medicine-catalog.json');
  if (!isSystemCatalog && !isMedicineCatalog) {
    return { error: 'اختر ملف SYSTEM المنتهي بـ .system-catalog.json أو ملف الأدوية medicine-catalog.json.' };
  }
  const stat = fs.statSync(filePath);
  const maxBytes = isMedicineCatalog ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
  if (stat.size > maxBytes) return { error: `حجم ملف الكتالوج أكبر من ${maxBytes / (1024 * 1024)} ميجابايت.` };
  return { name: path.basename(filePath), content: fs.readFileSync(filePath, 'utf8') };
});


function getMachineId() { return license.getMachineId(); }
function getEffectiveLicenseStatus() {
  const status = license.getStatus();
  return DEV_LICENSE_BYPASS
    ? { ...status, active: true, trial: false, licensed: true, state: 'licensed', reason: 'development-bypass' }
    : status;
}
function ensureTrialActive() { return getEffectiveLicenseStatus(); }
async function getLicenseStatus() { return getEffectiveLicenseStatus(); }
function writeUserConfig(update) {
  const dir = app.getPath('userData');
  const file = path.join(dir, 'config.json');
  fs.mkdirSync(dir, { recursive: true });
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { console.error('[1.16-B][main]', err); }
  Object.assign(data, update);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return data;
}
ipcMain.handle('license-device-id', () => getMachineId());
ipcMain.handle('license-status', async () => {
  return getLicenseStatus();
});
const rememberedLoginPath = () => path.join(app.getPath('userData'), 'remembered-login.bin');
ipcMain.handle('remembered-login-get', () => {
  if (!safeStorage.isEncryptionAvailable()) return null;
  // Intentionally ignored: remembered-login path is optional outside Electron
  try {
    const encrypted = fs.readFileSync(rememberedLoginPath());
    const saved = JSON.parse(safeStorage.decryptString(encrypted));
    return { username: String(saved.username || ''), password: String(saved.password || ''), role: String(saved.role || '') };
  } catch (_) { return null; }
});
ipcMain.handle('remembered-login-save', (_event, credentials = {}) => {
  if (!safeStorage.isEncryptionAvailable()) return { saved: false, error: 'تشفير بيانات الدخول غير متاح على هذا الجهاز.' };
  const username = String(credentials.username || '').trim();
  const password = String(credentials.password || '');
  const role = String(credentials.role || '');
  if (!username || !password || !role) return { saved: false, error: 'بيانات الدخول غير مكتملة.' };
  try {
    const target = rememberedLoginPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, safeStorage.encryptString(JSON.stringify({ username, password, role })));
    return { saved: true };
  } catch (error) { return { saved: false, error: `تعذر حفظ بيانات الدخول: ${error.message}` }; }
});
ipcMain.handle('remembered-login-clear', () => {
  try {
    const target = rememberedLoginPath();
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch (error) { logStartup(`Could not clear remembered login: ${error.message}`); }
  return { cleared: true };
});
ipcMain.handle('ui-language-set', (_event, language) => {
  const selected = language === 'en' ? 'en' : 'ar';
  splashLanguage = selected;
  try {
    const target = path.join(app.getPath('userData'), 'ui-language.json');
    fs.writeFileSync(target, JSON.stringify({ language: selected }), 'utf8');
  } catch (error) { logStartup(`Could not persist display language: ${error.message}`); }
  return { language: selected };
});
ipcMain.handle('license-activate-offline', async () => {
  const result = await dialog.showOpenDialog({ title: 'اختيار ملف تفعيل نقطة البيع', properties: ['openFile'], filters: [{ name: 'ملف ترخيص نقطة البيع', extensions: ['json'] }] });
  if (result.canceled || !result.filePaths[0]) return { active: false, canceled: true };
  try {
    const data = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    const status = license.activateLicenseObject(data);
    if (!status.active) return status;
    stopTrialTimers();
    currentTrialStatus = { active: true, trial: false, licensed: true };
    return status;
  } catch (error) { return { active: false, reason: 'تعذر قراءة ملف الترخيص: ' + error.message }; }
});
ipcMain.handle('license-activate-text', async (_event, licenseText) => {
  const status = license.activateTextForDevice(String(licenseText || ''));
  if (status.active) {
    stopTrialTimers();
    currentTrialStatus = { active: true, trial: false, licensed: true };
    if (mainWindow && !mainWindow.isDestroyed()) await loadStartupUrl(`http://localhost:${PORT}`, 'license-activated');
  }
  return { ...status, deviceId: getMachineId() };
});
ipcMain.handle('license-activate-central', async (_event, { serverUrl, licenseKey }) => {
  const base = String(serverUrl || '').trim().replace(/\/$/, '');
  const key = String(licenseKey || '').trim();
  if (!/^https?:\/\//i.test(base) || !key) return { active: false, reason: 'أدخل رابط خادم التفعيل ومفتاح الترخيص.' };
  try {
    const deviceId = getMachineId();
    const response = await fetch(base + '/api/license/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ licenseKey: key, deviceId, deviceName: os.hostname() }), signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    if (!response.ok) return { active: false, reason: data.error || 'رفض خادم التفعيل هذا الجهاز.' };
    writeUserConfig({ license_mode: 'central', license_server: base, license_key: key });
    stopTrialTimers();
    currentTrialStatus = { active: true, trial: false, licensed: true };
    return { ...data, active: true, mode: 'central', deviceId };
  } catch (error) { return { active: false, reason: 'تعذر الاتصال بخادم التفعيل: ' + error.message }; }
});

async function configureRuntimePorts(config, configPath) {
  const originalPort = Number(config.port) || 3000;
  const requestedPort = Number(process.env.PORT);
  PORT = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : await findFreePort(originalPort);
  const requestedTlsPort = Number(config.tls_port) || Math.max(PORT + 1000, 4000);
  TLS_PORT = await findFreePort(requestedTlsPort === PORT ? PORT + 1000 : requestedTlsPort);
  const changed = Number(config.port) !== PORT || Number(config.tls_port) !== TLS_PORT;
  config.port = PORT;
  config.tls_port = TLS_PORT;
  if (changed && configPath) fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  logStartup(`Stage: free runtime ports selected: HTTP=${PORT}; HTTPS=${TLS_PORT}.`);
}

async function chooseDatabaseDirectory(parentWindow) {
  const appDataDir = app.getPath('userData');
  const configPath = path.join(appDataDir, 'config.json');
  logStartup(`Stage: read config.json: ${configPath}`);
  if (electronStoragePaths.testIsolation) {
    fs.mkdirSync(appDataDir, { recursive: true });
    let isolatedConfig = {};
    try { isolatedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (err) { console.error('[1.16-C][main]', err); }
    isolatedConfig.database_path = process.env.RAWDA_DB_PATH;
    isolatedConfig.port = Number(process.env.PORT || isolatedConfig.port || PORT);
    isolatedConfig.host = process.env.HOST || '127.0.0.1';
    isolatedConfig.tls_port = Number(process.env.RAWDA_TLS_PORT || isolatedConfig.tls_port || isolatedConfig.port + 1000);
    logStartup(`Stage: test-isolated database path selected: ${isolatedConfig.database_path}`);
    fs.writeFileSync(configPath, JSON.stringify(isolatedConfig, null, 2), 'utf8');
    return { appDataDir, configPath };
  }
  if (needsDatabaseLocationSelection(configPath)) {
    const legacyCandidates = [
      path.join(path.dirname(appDataDir), 'GeneralBusinessPOS', 'database.sqlite'),
      path.join(path.dirname(appDataDir), 'SystemPOS', 'database.sqlite'),
      path.join(process.cwd(), 'database.sqlite')
    ].filter((candidate, index, all) => fs.existsSync(candidate) && all.indexOf(candidate) === index);
    if (legacyCandidates.length) {
      const legacy = legacyCandidates[0];
      const choice = await dialog.showMessageBox(parentWindow, {
        type: 'question',
        title: 'تم العثور على قاعدة بيانات سابقة',
        message: `تم العثور على قاعدة بيانات سابقة في:\n${legacy}`,
        detail: 'هل تريد استخدامها؟ يمكنك اختيار مجلد آخر لاحقاً من إعدادات قاعدة البيانات.',
        buttons: ['استخدام القاعدة السابقة', 'بدء قاعدة جديدة', 'إلغاء'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      });
      if (choice.response === 2) throw new Error('تم إلغاء اختيار قاعدة البيانات.');
      if (choice.response === 0) {
        fs.mkdirSync(appDataDir, { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({ database_path: legacy, host: '127.0.0.1', port: PORT, tls_port: PORT + 1000 }, null, 2), 'utf8');
        logStartup(`Stage: legacy database selected: ${legacy}`);
        return { appDataDir, configPath };
      }
    }
  }
  if (!needsDatabaseLocationSelection(configPath)) {
    const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let savedDatabasePath = path.resolve(savedConfig.database_path || firstRunDatabasePath(appDataDir));
    const safeChoice = await confirmDatabaseLocation(parentWindow, savedDatabasePath, appDataDir);
    if (safeChoice.path !== savedDatabasePath) {
      savedDatabasePath = safeChoice.path;
      savedConfig.database_path = savedDatabasePath;
      fs.writeFileSync(configPath, JSON.stringify(savedConfig, null, 2), 'utf8');
      logStartup(`Risky saved database path replaced with userData default: ${savedDatabasePath}`);
    } else if (safeChoice.continued) logStartup(`User continued with risky database path: ${savedDatabasePath}`);
    let confirmedLocalFallback = false;
    if (!isDatabaseLocationAvailable(savedDatabasePath)) {
      const localPath = localFallbackDatabasePath(appDataDir);
      logStartup(`Stage: saved database location is unavailable; preserved path=${savedDatabasePath}; proposed local path=${localPath}.`);
      const choice = await dialog.showMessageBox(parentWindow, {
        type: 'warning',
        title: 'قاعدة البيانات المحفوظة غير متاحة',
        message: `تعذر الوصول إلى مسار قاعدة البيانات المحفوظ:\n${savedDatabasePath}`,
        detail: 'لم تُحذف أو تُنقل الملفات القديمة. استخدم قاعدة محلية جديدة فقط إذا أردت المتابعة دون القرص السابق.',
        buttons: ['استخدام قاعدة محلية جديدة', 'إلغاء'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      });
      if (choice.response !== 0) throw new Error(`تم إلغاء التشغيل لأن مسار قاعدة البيانات غير متاح: ${savedDatabasePath}`);
      savedConfig.database_path = localPath;
      confirmedLocalFallback = true;
      logStartup(`Stage: user confirmed new local database path: ${localPath}; saved database was left untouched.`);
    }
    if (confirmedLocalFallback) fs.writeFileSync(configPath, JSON.stringify(savedConfig, null, 2), 'utf8');
    await configureRuntimePorts(savedConfig, configPath);
    logStartup(`Stage: database path selected from config: ${savedConfig.database_path || '(missing)'}`);
    logStartup(`Using existing configuration: ${configPath}`);
    return { appDataDir, configPath };
  }

  logStartup('Stage: no config.json; first-run Glassmorphism database location screen is required.');
  const selectedLocation = await showDatabaseLocationWindow(parentWindow, appDataDir);
  const selectedDir = path.dirname(selectedLocation.databasePath);
  if (selectedLocation.continued) logStartup(`User continued with risky first-run database path: ${selectedLocation.databasePath}`);

  fs.mkdirSync(appDataDir, { recursive: true });
  const firstRunConfig = {
    app_name: 'SYSTEM — برنامج مبيعات متكامل',
    port: 3000,
    host: '0.0.0.0',
    database_path: firstRunDatabasePath(appDataDir, selectedDir),
    allow_network_access: true,
    API_KEY: '',
    SENDER_ID: '',
    SMS_API_URL: '',
    MIN_DELAY_SEC: 5,
    MAX_DELAY_SEC: 12
  };
  await configureRuntimePorts(firstRunConfig, null);
  fs.writeFileSync(configPath, JSON.stringify(firstRunConfig, null, 2), 'utf8');
  logStartup(`Stage: first-run config.json written after location choice: ${configPath}`);
  logStartup(`Saved first-run configuration: ${configPath}; database=${path.join(selectedDir, 'database.sqlite')}`);
  logStartup(`Stage: database path selected: ${firstRunConfig.database_path}`);
  return { appDataDir, configPath };
}

function startServer(storagePaths, trialStatus) {
  detachServerProcessListeners();
  const serverPath = path.join(__dirname, '..', 'server.js');
  const dataDir = storagePaths.appDataDir;
  const configPath = storagePaths.configPath;
  if (!fs.existsSync(configPath)) throw new Error(`ملف الإعداد لم يُنشأ بعد اختيار مكان قاعدة البيانات: ${configPath}`);
  const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  PORT = Number(savedConfig.port || PORT);
  TLS_PORT = Number(savedConfig.tls_port || Math.max(TLS_PORT, PORT + 1));
  const httpPort = PORT;
  const tlsPort = TLS_PORT;
  const databasePath = path.resolve(savedConfig.database_path || firstRunDatabasePath(dataDir));
  serverOutputTail = { stdout: '', stderr: '' };
  const databaseExisted = fs.existsSync(databasePath);
  logStartup(`Stage: database path resolved: ${databasePath}`);
  logStartup(databaseExisted ? 'Stage: database already exists.' : 'Stage: database creation pending in the server process.');
  const tlsDirectory = path.join(dataDir, 'https');
  const tlsPfxPath = path.join(tlsDirectory, 'local-server.pfx');
  const tlsCaPath = path.join(tlsDirectory, 'local-network-root-ca.cer');
  try {
    fs.mkdirSync(tlsDirectory, { recursive: true });
    const interfaces = os.networkInterfaces();
    const lanCandidates = Object.entries(interfaces).flatMap(([name, items]) => (items || []).filter(item => item && item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.') && !item.address.startsWith('127.')).map(item => ({ address: item.address, score: (name === 'Wi-Fi' || /wi-?fi|wireless|wlan/i.test(name) ? 100 : /ethernet|local area connection/i.test(name) ? 60 : 0) + (item.address.startsWith('192.168.') ? 30 : item.address.startsWith('10.') ? 20 : /^172\.(1[6-9]|2\d|3[01])\./.test(item.address) ? 10 : 0) - (/virtual|vethernet|hyper-v|vmware|virtualbox|docker|wsl|loopback|bluetooth/i.test(name) ? 200 : 0) })));
    lanCandidates.sort((a, b) => b.score - a.score);
    const lanIp = lanCandidates[0]?.address || '127.0.0.1';
    let certificateIp = '';
    try { certificateIp = JSON.parse(fs.readFileSync(path.join(tlsDirectory, 'lan-certificate.json'), 'utf8')).ip_address || ''; } catch (_) {}
    if (!fs.existsSync(tlsPfxPath) || !fs.existsSync(tlsCaPath) || certificateIp !== lanIp) {
      const bundledScript = path.join(__dirname, 'generate-local-https.ps1');
      const runtimeScript = path.join(tlsDirectory, 'generate-local-https.ps1');
      fs.writeFileSync(runtimeScript, fs.readFileSync(bundledScript), 'utf8');
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runtimeScript, '-OutputDirectory', tlsDirectory, '-IpAddress', lanIp], { windowsHide: true, stdio: 'ignore', timeout: 60000 });
      logStartup(`Created local HTTPS certificate for ${lanIp}.`);
    }
  } catch (error) {
    console.error('[1.16-C][main]', error);
    logStartup(`Local HTTPS certificate setup failed; LAN camera will remain unavailable: ${error.message}`);
  }
  serverProcess = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      RAWDA_DATA_DIR: dataDir,
      RAWDA_USER_DATA_DIR: dataDir,
      RAWDA_CONFIG_PATH: configPath,
      RAWDA_DB_PATH: savedConfig.database_path || path.join(dataDir, 'database.sqlite'),
      RAWDA_CATALOG_PATH: path.join(path.dirname(savedConfig.database_path || path.join(dataDir, 'database.sqlite')), 'business-catalog.json'),
      RAWDA_TLS_KEY_PATH: '',
      RAWDA_TLS_CERT_PATH: '',
      RAWDA_TLS_PFX_PATH: fs.existsSync(tlsPfxPath) ? tlsPfxPath : '',
      RAWDA_TLS_CA_PATH: fs.existsSync(tlsCaPath) ? tlsCaPath : '',
      RAWDA_TLS_PORT: String(tlsPort),
      RAWDA_TLS_HOST: savedConfig.host || '0.0.0.0',
      RAWDA_SECURE_COOKIES: '0',
      PORT: String(httpPort),
      // The Electron readiness check and the renderer use localhost. Binding
      // to all interfaces keeps those local connections working while also
      // allowing LAN clients to connect in licensed mode.
      HOST: '0.0.0.0'
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  serverProcess.stdout?.setEncoding('utf8');
  serverProcess.stderr?.setEncoding('utf8');
  const onStdout = chunk => rememberServerOutput('stdout', chunk);
  const onStderr = chunk => rememberServerOutput('stderr', chunk);
  const onMessage = message => { void handleServerHostRequest(message); };
  const onError = error => {
    logStartup(`Server process error: ${error.stack || error.message}`);
    const failure = formatStartupFailure({
      reason: `تعذر تشغيل خادم النظام: ${error.message}`,
      databasePath,
      port: PORT,
      exitCode: serverProcess?.exitCode,
      stdout: serverOutputTail.stdout,
      stderr: serverOutputTail.stderr
    });
    showStartupFailureDialog(failure);
  };
  const onExit = (code, signal) => {
    logStartup(`Server process exited: code=${code}, signal=${signal || ''}.`);
    if (serverProcessListeners) serverProcessListeners = null;
  };
  serverProcessListeners = { stdout: onStdout, stderr: onStderr, message: onMessage, error: onError, exit: onExit };
  serverProcess.stdout?.on('data', onStdout);
  serverProcess.stderr?.on('data', onStderr);
  serverProcess.on('message', onMessage);
  serverProcess.on('error', onError);
  serverProcess.on('exit', onExit);
  logStartup(`Stage: server process launched: ${serverPath}; HTTP port=${PORT}; HTTPS port=${TLS_PORT}.`);
}

async function waitForServer() {
  logStartup(`Stage: readiness check started at http://127.0.0.1:${PORT}/api/license/status.`);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/api/license/status`);
      if (response.ok) return true;
    } catch (_) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  return false;
}

function installBackupBlocker() {
  if (backupBlockerInstalled) return;
  backupBlockerInstalled = true;
  const filter = {
    urls: [
      '*://*/api/backup*',
      '*://*/api/restore*',
      '*://*/api/scheduled-backups*',
      '*://*/api/google-drive-backup*'
    ]
  };

  session.defaultSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    const status = licenseGateIpc.getLast();
    const isLicensed = DEV_LICENSE_BYPASS || (status && status.state === 'licensed');

    if (!isLicensed) {
      console.warn(`[11-B2] Blocked backup request: ${details.url} (State: ${status ? status.state : 'unknown'})`);
      callback({ cancel: true });
    } else {
      callback({});
    }
  });
}

async function createWindow() {
  startupInProgress = true;
  logStartup('Stage: application startup begins.');
  showStartupSplash();
  updateSplash('database');
  const startupLicense = await getLicenseStatus();
  let trialStatus = startupLicense.active && !startupLicense.trial
    ? { active: true, trial: false, licensed: true }
    : (startupLicense.trial ? { active: true, trial: true, expiresAt: startupLicense.expiresAt, lastSeenAt: startupLicense.lastSeenAt, hoursRemaining: startupLicense.hoursRemaining } : ensureTrialActive());
  currentTrialStatus = trialStatus;
  if (trialStatus.active && trialStatus.trial && trialStatus.expiresAt) {
    const remaining = Math.max(1, trialStatus.expiresAt - Date.now());
    trialExpiryTimer = setTimeout(async () => {
      const license = await getLicenseStatus();
      if (license.active && !license.trial) { stopTrialTimers(); return; }
      stopTrialTimers();
      currentTrialStatus = { ...currentTrialStatus, active: false, expired: true };
      if (mainWindow && !mainWindow.isDestroyed()) await loadStartupUrl(`http://localhost:${PORT}/activate`, 'trial-expired');
    }, remaining);
    trialWatchTimer = setInterval(async () => {
      const license = await getLicenseStatus();
      if (license.active && !license.trial) { currentTrialStatus = { active: true, trial: false, licensed: true }; stopTrialTimers(); return; }
      const refreshed = ensureTrialActive();
      currentTrialStatus = refreshed;
      if (!refreshed.active) {
        stopTrialTimers();
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.getURL().endsWith('/activate')) await loadStartupUrl(`http://localhost:${PORT}/activate`, 'trial-watch-expired');
      }
    }, 60000);
  }
  logStartup(`Application ready. packaged=${app.isPackaged}; executable=${process.execPath}`);
  // There is no application menu in this product.  An auto-hidden native
  // menu lets Alt move keyboard focus out of the page on Windows, which makes
  // the next keystroke appear to be dropped until Alt is pressed again.
  Menu.setApplicationMenu(null);
  const testWindowSizeMatch = process.env.SYSTEM_TEST_USER_DATA_DIR
    ? /^(\d{3,4})x(\d{3,4})$/.exec(String(process.env.SYSTEM_TEST_WINDOW_SIZE || ''))
    : null;
  const testWindowSize = testWindowSizeMatch
    ? { width: Number(testWindowSizeMatch[1]), height: Number(testWindowSizeMatch[2]) }
    : null;
  mainWindow = new BrowserWindow({
    width: testWindowSize?.width || 1440,
    height: testWindowSize?.height || 900,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    minWidth: 1024,
    minHeight: 560,
    show: false,
    backgroundColor: '#FAFAFA',
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  if (app.isPackaged) mainWindow.webContents.closeDevTools();
  installBackupBlocker();
  mainWindow.setMenu(null);
  mainWindow.setMenuBarVisibility(false);
  logStartup('Stage: main application window created.');
  // Keep the native first-run database-folder picker visible and owned by a
  // visible application window.  The window used to stay hidden forever
  // because it was created with show:false and never shown after startup.
  mainWindow.show();
  mainWindow.focus();
  logStartup('Stage: main application window shown before database selection.');
  const onWindowOpen = ({ url }) => {
    if (isAllowedExternalUrl(url)) shell.openExternal(url).catch(error => logStartup(`Could not open WhatsApp link: ${error.message}`));
    return { action: 'deny' };
  };
  const onWillNavigate = (event, url) => {
    if (isAllowedAppNavigation(url, { port: PORT, tlsPort: TLS_PORT })) return;
    logStartup(`will-navigate blocked by isAllowedAppNavigation: ${url}`);
    event.preventDefault();
    if (isAllowedExternalUrl(url)) shell.openExternal(url).catch(error => logStartup(`Could not open WhatsApp link: ${error.message}`));
  };
  const onWillRedirect = (event, url) => {
    if (isAllowedAppNavigation(url, { port: PORT, tlsPort: TLS_PORT })) return;
    logStartup(`will-redirect blocked by isAllowedAppNavigation: ${url}`);
    event.preventDefault();
  };
  const onDidFailLoad = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    logStartup(`did-fail-load: code=${errorCode}; description=${errorDescription}; url=${validatedURL}; mainFrame=${Boolean(isMainFrame)}.`);
    if (isNonFatalNavigationAbort(errorCode)) {
      logStartup('Navigation abort ERR_ABORTED (-3) is nonfatal.');
      return;
    }
    if (isMainFrame && !startupInProgress) showStartupFailureDialog(`${errorDescription} (${errorCode}) — ${validatedURL}`);
  };
  const onBeforeInput = (event, input) => {
    const opensDevTools = input.key === 'F12' ||
      ((input.control || input.meta) && input.shift && ['I', 'J', 'C'].includes(String(input.key).toUpperCase()));
    if (opensDevTools) event.preventDefault();
  };
  const onRenderGone = (_event, details) => {
    logStartup(`Renderer process gone: ${JSON.stringify(details)}`);
    showStartupFailureDialog(`تعذر عرض واجهة البرنامج: ${JSON.stringify(details)}`);
  };
  mainWindow.webContents.setWindowOpenHandler(onWindowOpen);
  mainWindow.webContents.on('will-navigate', onWillNavigate);
  mainWindow.webContents.on('will-redirect', onWillRedirect);
  mainWindow.webContents.on('did-fail-load', onDidFailLoad);
  if (app.isPackaged) {
    mainWindow.webContents.on('before-input-event', onBeforeInput);
  }
  mainWindow.webContents.on('render-process-gone', onRenderGone);
  const windowRef = mainWindow;
  mainWindowCleanup = () => {
    // `closed` may fire after the native contents has started destruction.
    // Removing each listener defensively keeps this idempotent while still
    // releasing references on every normal close path.
    let webContents;
    try { webContents = windowRef.webContents; } catch (_) { webContents = null; }
    if (!webContents) return;
    for (const [event, listener] of [
      ['will-navigate', onWillNavigate],
      ['will-redirect', onWillRedirect],
      ['did-fail-load', onDidFailLoad],
      ['before-input-event', onBeforeInput],
      ['render-process-gone', onRenderGone]
    ]) {
      // Intentionally ignored: event listener cleanup is best-effort
      try { webContents.off(event, listener); } catch (_) {}
    }
    // Intentionally ignored: window handler cleanup is best-effort
    try { webContents.setWindowOpenHandler(() => ({ action: 'deny' })); } catch (_) {}
  };
  mainWindow.once('closed', () => {
    cleanupMainWindowListeners();
    if (mainWindow === windowRef) mainWindow = null;
  });
  mainWindow.on('close', () => {
    if (!isQuitting) app.quit();
  });
  logStartup('Stage: startup splash skipped; failures use native dialog only.');

  const storagePaths = await chooseDatabaseDirectory(mainWindow);
  logStartup(`Stage: database location/configuration ready: ${storagePaths.configPath}`);
  updateSplash('server');
  startServer(storagePaths, trialStatus);
  logStartup(`Stage: waiting for HTTP server readiness on port ${PORT}.`);
  const ready = await waitForServer();
  if (!ready) {
    const failedDatabasePath = path.resolve(JSON.parse(fs.readFileSync(storagePaths.configPath, 'utf8')).database_path || firstRunDatabasePath(storagePaths.appDataDir));
    const failure = formatStartupFailure({ reason: `انتهت مهلة الجاهزية؛ لم يستجب الخادم على المنفذ ${PORT}.`, databasePath: failedDatabasePath, port: PORT, exitCode: serverProcess?.exitCode, stdout: serverOutputTail.stdout, stderr: serverOutputTail.stderr });
    logStartup(`Startup readiness timed out. ${failure.replace(/\n/g, ' | ')}`);
    await showStartupFailureDialog(failure);
    await closeStartupSplash();
    return;
  }

  const databasePath = path.resolve(JSON.parse(fs.readFileSync(storagePaths.configPath, 'utf8')).database_path || firstRunDatabasePath(storagePaths.appDataDir));
  logStartup(fs.existsSync(databasePath) ? `Stage: database exists after server readiness: ${databasePath}` : `Stage: database missing after server readiness: ${databasePath}`);
  logStartup('Local API server responded successfully. Loading application UI.');
  updateSplash('interface');
  // WebAuthn requires a secure origin and permits localhost for local apps;
  // loopback IP addresses are not valid relying-party origins.
  const appUrl = trialStatus.active || trialStatus.licensed ? `http://localhost:${PORT}` : `http://localhost:${PORT}/activate`;
  const loaded = await loadStartupUrl(appUrl, 'application');
  if (!loaded) {
    startupInProgress = false;
    logStartup('Application navigation was superseded; ERR_ABORTED (-3) treated as nonfatal.');
    await closeStartupSplash();
    return;
  }
  startupInProgress = false;
  logStartup('Application UI loaded.');
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.focus();
  await closeStartupSplash();
  logStartup(`Startup splash closed after ${Date.now() - splashStartedAt}ms.`);
}

function configureCameraPermissions() {
  const cameraPorts = new Set([3000, 3051, Number(PORT), Number(TLS_PORT)].filter(Number.isFinite));
  const isAppOrigin = value => {
    // Intentionally ignored: invalid camera origins must be denied
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol)
        && ['127.0.0.1', 'localhost'].includes(url.hostname)
        && cameraPorts.has(Number(url.port));
    } catch (_) {
      return false;
    }
  };

  session.defaultSession.setPermissionCheckHandler((_webContents, permission, origin) =>
    permission === 'media' && isAppOrigin(origin)
  );
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details?.requestingUrl || webContents?.getURL() || '';
    const requestsVideo = Array.isArray(details?.mediaTypes) && details.mediaTypes.includes('video');
    callback(permission === 'media' && requestsVideo && isAppOrigin(requestingUrl));
  });
}

if (hasSingleInstanceLock) app.whenReady().then(() => {
  logStartup('Stage: Electron app ready; preparing startup services.');
  configureCameraPermissions();
  const gate = DEV_LICENSE_BYPASS
    ? { blocked: false, status: getEffectiveLicenseStatus() }
    : licenseGateIpc.shouldBlock();
  if (gate.blocked) {
    createLicenseWindow();
    return null;
  }
  return createWindow();
}).catch(error => {
  console.error('[1.16-C][main]', error);
  logStartup(`Startup failed: ${error.stack || error.message}`);
  try { splashWindow?.close(); } catch (_) {}
  showStartupFailureDialog(error.message || String(error));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', event => {
  isQuitting = true;
  logStartup('Application is quitting.');
  destroySystemTray();
  if (!serverProcess || serverProcess.killed || serverProcess.exitCode !== null || serverShutdownRequested) return;
  event.preventDefault();
  serverShutdownRequested = true;
  // Allow a just-created encrypted cloud outbox entry to finish writing. The
  // server never waits for a Google Drive/network upload during shutdown.
  const forceExit = setTimeout(() => {
    if (serverProcess && !serverProcess.killed && serverProcess.exitCode === null) serverProcess.kill();
    app.quit();
  }, 30000);
  serverProcess.once('exit', () => { clearTimeout(forceExit); app.quit(); });
  if (serverProcess.connected) serverProcess.send({ type: 'backup-and-exit' }, error => {
    if (error) {
      logStartup(`Scheduled backup shutdown signal failed: ${error.message}`);
      if (serverProcess && !serverProcess.killed) serverProcess.kill();
    }
  });
  else {
    logStartup('Scheduled backup shutdown IPC is unavailable; terminating the server process.');
    serverProcess.kill();
  }
});
