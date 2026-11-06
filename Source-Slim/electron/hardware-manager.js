'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

let thermalPrinter = null;
try { thermalPrinter = require('node-thermal-printer'); }
catch (error) { console.warn('[HW] node-thermal-printer unavailable:', error.message); }

let serialport = null;
try { serialport = require('serialport'); }
catch (error) { console.warn('[HW] serialport unavailable:', error.message); }

let hid = null;
try { hid = require('node-hid'); }
catch (error) { console.warn('[HW] node-hid unavailable:', error.message); }

const scaleStates = new Map();
const scaleStreams = new Map();
let scannerValue = '';
let streamSequence = 0;

function mockRoot(app) {
  return process.env.RAWDA_MOCK_OUTPUT_DIR
    ? path.resolve(process.env.RAWDA_MOCK_OUTPUT_DIR)
    : path.join(app.getPath('userData'), 'mock-output');
}

function mockState(profileId = 'default') {
  const key = String(profileId);
  if (!scaleStates.has(key)) scaleStates.set(key, { weight: 0, unit: 'kg', stable: true });
  return scaleStates.get(key);
}

function decodePayload(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload && typeof payload === 'object' && payload.type === 'Buffer' && Array.isArray(payload.data)) return Buffer.from(payload.data);
  if (typeof payload === 'string') return payload.startsWith('base64:') ? Buffer.from(payload.slice(7), 'base64') : Buffer.from(payload, 'utf8');
  return Buffer.from(JSON.stringify(payload || {}), 'utf8');
}

function writeMockPrinter(app, document, filename = '') {
  const folder = path.join(mockRoot(app), 'printer');
  fs.mkdirSync(folder, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = String(filename || `print-${stamp}.txt`).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const target = path.join(folder, safeName.endsWith('.txt') ? safeName : `${safeName}.txt`);
  fs.writeFileSync(target, String(document ?? ''), 'utf8');
  return target;
}

function writeMockDrawer(app, source = 'manual') {
  const folder = mockRoot(app);
  fs.mkdirSync(folder, { recursive: true });
  const target = path.join(folder, 'drawer.log');
  fs.appendFileSync(target, `${new Date().toISOString()} source=${source} pulse=1b700019fa\n`, 'utf8');
  return target;
}

async function listPrinters(sender) {
  if (typeof sender?.getPrintersAsync !== 'function') return [];
  return sender.getPrintersAsync();
}

function printSpooler(sender, options = {}) {
  return new Promise((resolve, reject) => {
    if (typeof sender?.print !== 'function') return reject(new Error('خدمة Windows Spooler غير متاحة.'));
    sender.print({
      silent: Boolean(options.silent),
      deviceName: String(options.deviceName || ''),
      printBackground: true,
      copies: Math.min(3, Math.max(1, Number(options.copies) || 1)),
      pageSize: options.pageSize || 'A4',
      margins: { marginType: 'none' }
    }, (success, failureReason) => success ? resolve({ ok: true, mode: 'spooler' }) : reject(new Error(failureReason || 'فشلت مهمة الطباعة.')));
  });
}

async function printEscpos(app, sender, options = {}) {
  const payload = decodePayload(options.payload);
  if (!thermalPrinter) {
    try { return await printSpooler(sender, options); }
    catch (_) { return { ok: true, mode: 'mock', path: writeMockPrinter(app, payload.toString('utf8'), options.filename) }; }
  }
  try {
    const printer = new thermalPrinter.Printer({ type: thermalPrinter.types?.EPSON, interface: options.interface || '' });
    printer.raw(payload);
    if (options.cut !== false) printer.cut();
    if (options.drawer) printer.raw(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]));
    await printer.execute();
    return { ok: true, mode: 'escpos' };
  } catch (error) {
    try { return await printSpooler(sender, options); }
    catch (_) { return { ok: true, mode: 'mock', fallback: error.message, path: writeMockPrinter(app, payload.toString('utf8'), options.filename) }; }
  }
}

function printNetwork(options = {}) {
  const host = String(options.host || '').trim();
  const port = Number(options.port || 9100);
  if (!host || !net.isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('عنوان شبكة الطابعة أو المنفذ غير صالح.');
  const payload = decodePayload(options.payload);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timeout = setTimeout(() => socket.destroy(new Error('انتهت مهلة الاتصال بالطابعة.')), Math.min(15000, Math.max(500, Number(options.timeoutMs) || 5000)));
    socket.once('error', error => { clearTimeout(timeout); reject(error); });
    socket.once('connect', () => socket.end(payload));
    socket.once('close', hadError => { clearTimeout(timeout); if (!hadError) resolve({ ok: true, mode: 'network' }); });
  });
}

function listPorts() {
  return Promise.resolve().then(async () => {
    const serial = serialport?.SerialPort?.list ? await serialport.SerialPort.list() : [];
    const hidDevices = hid?.devices ? hid.devices() : [];
    return { serial, hid: hidDevices, mock_mode: !serialport && !hid };
  });
}

function diagnoseHardware() {
  return listPorts().then(result => ({ ...result, native: { thermalPrinter: Boolean(thermalPrinter), serialport: Boolean(serialport), hid: Boolean(hid) } }));
}

function registerHardwareIpc({ app, ipcMain }) {
  // IPC_TESTED: false — will test in Phase 4 Build
  ipcMain.handle('hardware:list-printers', event => listPrinters(event.sender));
  // IPC_TESTED: false — will test in Phase 4 Build
  ipcMain.handle('hardware:print-spooler', (event, options) => printSpooler(event.sender, options));
  // IPC_TESTED: false — will test in Phase 4 Build
  ipcMain.handle('hardware:print-escpos', (event, options) => printEscpos(app, event.sender, options));
  // IPC_TESTED: false — will test in Phase 4 Build
  ipcMain.handle('hardware:print-network', (_event, options) => printNetwork(options));
  // IPC_TESTED: false — will test in Phase 4 Build
  ipcMain.handle('hardware:print-mock', (_event, options = {}) => ({ ok: true, mode: 'mock', path: writeMockPrinter(app, options.document, options.filename) }));
  // IPC_TESTED: false — will test in Phase 4 Build
  ipcMain.handle('hardware:printer-test', (_event, options = {}) => ({ ok: true, mode: 'mock', path: writeMockPrinter(app, options.document || 'SYSTEM POS printer test', options.filename) }));
  // IPC_TESTED: false — will test in Phase 4 Build
  ipcMain.handle('hardware:open-drawer', (_event, options = {}) => ({ ok: true, mode: 'mock', path: writeMockDrawer(app, options.source || 'manual') }));
  // IPC_TESTED: false — will test in Phase 4 Build
  ipcMain.handle('hardware:drawer-status', () => ({ ok: true, mode: 'mock', available: true }));
  // IPC_TESTED: false — will test in Phase 4 Build
  ipcMain.handle('hardware:list-ports', () => listPorts());
  // IPC_TESTED: false — will test in Phase 4 Build
  ipcMain.handle('hardware:scale-read', (_event, options = {}) => ({ ...mockState(options.profileId), source: 'mock' }));
  // IPC_TESTED: false — will test in Phase 4 Build
  ipcMain.handle('hardware:scale-stream-start', (event, options = {}) => {
    const streamId = `scale-${++streamSequence}`;
    const interval = setInterval(() => event.sender.send('hardware:scale-update', { streamId, ...mockState(options.profileId) }), Math.min(5000, Math.max(250, Number(options.intervalMs) || 1000)));
    scaleStreams.set(streamId, interval);
    return { ok: true, streamId };
  });
  // IPC_TESTED: false — will test in Phase 4 Build
  ipcMain.handle('hardware:scale-stream-stop', (_event, options = {}) => { const timer = scaleStreams.get(String(options.streamId)); if (timer) clearInterval(timer); scaleStreams.delete(String(options.streamId)); return { ok: true }; });
  // IPC_TESTED: false — will test in Phase 4 Build
  ipcMain.handle('hardware:scale-set-weight', (_event, options = {}) => {
    const weight = Number(options.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 999999) throw new Error('وزن الميزان غير صالح.');
    const state = mockState(options.profileId); Object.assign(state, { weight: Number(weight.toFixed(3)), unit: String(options.unit || 'kg'), stable: options.stable !== false }); return { ...state, source: 'mock' };
  });
  // IPC_TESTED: false — will test in Phase 4 Build
  ipcMain.handle('hardware:scale-list-protocols', () => ['auto', 'cas', 'bizerba', 'generic']);
  // IPC_TESTED: false — will test in Phase 4 Build
  ipcMain.handle('hardware:scanner-read', () => ({ value: scannerValue, source: 'manual' }));
  // IPC_TESTED: false — will test in Phase 4 Build
  ipcMain.handle('hardware:scanner-set-value', (_event, options = {}) => { scannerValue = String(options.value || '').slice(0, 120); return { value: scannerValue, source: 'manual' }; });
  // IPC_TESTED: false — will test in Phase 4 Build
  ipcMain.handle('hardware:diagnose', () => diagnoseHardware());
}

module.exports = { registerHardwareIpc, diagnoseHardware, writeMockPrinter, writeMockDrawer };
