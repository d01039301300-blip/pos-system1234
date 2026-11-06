'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { seedHardwareProfilesForBranch } = require('./migrations/011-hardware-profiles');

const PROFILE_TYPES = new Set(['printer_invoice', 'printer_report', 'printer_a4', 'cash_drawer', 'scale', 'scanner']);
const CONNECTION_TYPES = new Set(['usb', 'network', 'serial', 'windows_spooler', 'hid', 'mock']);
const mockScales = new Map();

function parseJson(value, fallback = {}) { try { return JSON.parse(value); } catch (_) { return fallback; } }
function rowToProfile(row) { return { ...row, connection_details: parseJson(row.connection_details), settings: parseJson(row.settings), is_default: Boolean(row.is_default), is_active: Boolean(row.is_active), is_mock: Boolean(row.is_mock) }; }
function listProfiles(connection, { branchId, unrestricted, type } = {}) {
  const rows = connection.prepare('SELECT * FROM hardware_profiles ORDER BY branch_id, profile_type, id').all();
  const scopedToBranch = Number.isInteger(Number(branchId)) && Number(branchId) > 0;
  return rows.filter(row => ((unrestricted && !scopedToBranch) || Number(row.branch_id) === Number(branchId)) && (!type || row.profile_type === type)).map(rowToProfile);
}
function mockOutputRoot() { return path.resolve(process.env.RAWDA_MOCK_OUTPUT_DIR || path.join(process.cwd(), 'mock-output')); }
function writeMock(kind, content) {
  const folder = path.join(mockOutputRoot(), kind); fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  fs.writeFileSync(file, String(content || ''), 'utf8'); return file;
}
function unrestrictedOnly(req, res, isUnrestrictedAccount) { if (!isUnrestrictedAccount(req.authUser)) { res.status(403).json({ error: 'إدارة أجهزة النظام متاحة للمالك فقط.' }); return false; } return true; }

function registerHardwareRoutes({ app, db, isUnrestrictedAccount, requestElectronHost }) {
  const scope = req => ({ branchId: Number(req.branchId || db.data.default_branch_id || 1), unrestricted: Boolean(isUnrestrictedAccount(req.authUser)) });
  const profile = id => db.storageAdapter.connection.prepare('SELECT * FROM hardware_profiles WHERE id=?').get(Number(id));

  app.get('/api/hardware/profiles', (req, res) => {
    const queryBranch = scope(req).unrestricted ? Number(req.query.branch_id) || null : scope(req).branchId;
    res.json({ profiles: listProfiles(db.storageAdapter.connection, { branchId: queryBranch, unrestricted: scope(req).unrestricted, type: req.query.profile_type || '' }), mock_mode: !db.data.system_settings?.hardware_mode || db.data.system_settings.hardware_mode === 'mock' });
  });
  app.post('/api/hardware/profiles', (req, res) => {
    if (!unrestrictedOnly(req, res, isUnrestrictedAccount)) return;
    const type = String(req.body?.profile_type || ''); const connectionType = String(req.body?.connection_type || 'mock');
    if (!PROFILE_TYPES.has(type) || !CONNECTION_TYPES.has(connectionType)) return res.status(400).json({ error: 'نوع ملف الجهاز أو الاتصال غير صالح.' });
    const branchId = Number(req.body?.branch_id || req.branchId); const name = String(req.body?.name || '').trim().slice(0, 120);
    if (!Number.isInteger(branchId) || !name) return res.status(400).json({ error: 'الفرع واسم الجهاز مطلوبان.' });
    const details = req.body?.connection_details && typeof req.body.connection_details === 'object' ? req.body.connection_details : {};
    const settings = req.body?.settings && typeof req.body.settings === 'object' ? req.body.settings : {};
    const result = db.storageAdapter.connection.prepare(`INSERT INTO hardware_profiles (branch_id,profile_type,name,connection_type,connection_details,settings,is_default,is_active,is_mock) VALUES (?,?,?,?,?,?,0,1,?)`).run(branchId, type, name, connectionType, JSON.stringify(details), JSON.stringify(settings), connectionType === 'mock' ? 1 : 0);
    res.status(201).json(rowToProfile(profile(result.lastInsertRowid)));
  });
  app.put('/api/hardware/profiles/:id', (req, res) => {
    if (!unrestrictedOnly(req, res, isUnrestrictedAccount)) return;
    const current = profile(req.params.id); if (!current) return res.status(404).json({ error: 'ملف الجهاز غير موجود.' });
    const name = req.body?.name === undefined ? current.name : String(req.body.name || '').trim().slice(0, 120);
    const active = req.body?.is_active === undefined ? current.is_active : (req.body.is_active ? 1 : 0);
    const details = req.body?.connection_details === undefined ? current.connection_details : JSON.stringify(req.body.connection_details || {});
    const settings = req.body?.settings === undefined ? current.settings : JSON.stringify(req.body.settings || {});
    db.storageAdapter.connection.prepare('UPDATE hardware_profiles SET name=?,connection_details=?,settings=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name, details, settings, active, current.id);
    res.json(rowToProfile(profile(current.id)));
  });
  app.delete('/api/hardware/profiles/:id', (req, res) => {
    if (!unrestrictedOnly(req, res, isUnrestrictedAccount)) return;
    const current = profile(req.params.id); if (!current) return res.status(404).json({ error: 'ملف الجهاز غير موجود.' });
    db.storageAdapter.connection.prepare('UPDATE hardware_profiles SET is_active=0,is_default=0,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(current.id);
    res.json({ success: true, message: 'تم تعطيل ملف الجهاز.' });
  });
  app.post('/api/hardware/profiles/:id/test', (req, res) => {
    const current = profile(req.params.id); if (!current) return res.status(404).json({ error: 'ملف الجهاز غير موجود.' });
    const result = current.is_mock || current.connection_type === 'mock' ? { ok: true, mode: 'mock', profile_id: current.id, message: 'تم اختبار الجهاز التجريبي بنجاح.' } : { ok: false, mode: 'native_pending', profile_id: current.id, message: 'اختبار Native مؤجل حتى Phase 4.' };
    res.json(result);
  });
  app.get('/api/hardware/diagnose', async (req, res) => {
    let native = { serial: [], hid: [], printers: [], mock_mode: true };
    if (typeof requestElectronHost === 'function') { try { native = await requestElectronHost('hardware-diagnose'); } catch (_) {} }
    res.json({ ...native, profiles: listProfiles(db.storageAdapter.connection, scope(req)), mock_mode: Boolean(native.mock_mode || !native.printers?.length) });
  });
  app.get('/api/hardware/scale/read', (req, res) => {
    const key = String(req.query.profile_id || 'default'); res.json({ ...(mockScales.get(key) || { weight: 0, unit: 'kg', stable: true }), source: 'mock' });
  });
  app.post('/api/hardware/scale/mock', (req, res) => {
    const weight = Number(req.body?.weight); if (!Number.isFinite(weight) || weight < 0 || weight > 999999) return res.status(400).json({ error: 'الوزن غير صالح.' });
    const key = String(req.body?.profile_id || 'default'); const state = { weight: Number(weight.toFixed(3)), unit: String(req.body?.unit || 'kg'), stable: req.body?.stable !== false }; mockScales.set(key, state); res.json({ ...state, source: 'mock' });
  });
  app.post('/api/hardware/drawer/test', (_req, res) => res.json({ ok: true, mode: 'mock', path: writeMock('drawer', 'pulse=1b700019fa') }));
  app.post('/api/hardware/print/test', (_req, res) => res.json({ ok: true, mode: 'mock', path: writeMock('printer', 'SYSTEM POS hardware mock print') }));
  app.post('/api/hardware/settings', (req, res) => {
    if (!unrestrictedOnly(req, res, isUnrestrictedAccount)) return;
    const mode = ['auto', 'mock'].includes(String(req.body?.hardware_mode)) ? String(req.body.hardware_mode) : 'mock';
    db.data.system_settings ||= {}; db.data.system_settings.hardware_mode = mode; db.save(['system_settings']); res.json({ hardware_mode: mode });
  });
  app.post('/api/hardware/branches/:branchId/seed-mock', (req, res) => {
    if (!unrestrictedOnly(req, res, isUnrestrictedAccount)) return;
    const count = seedHardwareProfilesForBranch(db.storageAdapter.connection, Number(req.params.branchId)); res.json({ ok: true, branch_id: Number(req.params.branchId), count });
  });
}

module.exports = { registerHardwareRoutes, listProfiles };
