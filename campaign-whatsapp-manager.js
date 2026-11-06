'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function normalizeEgyptMobile(value) {
  let digits = String(value ?? '').trim().replace(/[\s()+.-]/g, '');
  if (!digits) return { valid: false, reason: 'empty' };
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('20')) digits = `0${digits.slice(2)}`;
  if (!/^01[0125]\d{8}$/.test(digits)) return { valid: false, reason: 'invalid' };
  return { valid: true, local: digits, international: `+20${digits.slice(1)}` };
}

function classifyRecipients(customers) {
  const seen = new Set();
  const valid = [];
  let invalid = 0;
  let duplicate = 0;
  for (const customer of Array.isArray(customers) ? customers : []) {
    const phone = normalizeEgyptMobile(customer?.phone);
    if (!phone.valid) { if (phone.reason === 'empty') invalid += 1; else invalid += 1; continue; }
    if (seen.has(phone.international)) { duplicate += 1; continue; }
    seen.add(phone.international);
    valid.push({ id: customer.id, name: String(customer.name || ''), phone: phone.international });
  }
  return { recipients: valid, valid: valid.length, invalid, duplicate };
}

function createCampaignManager({ userDataPath, readConfig = () => ({}), loadBaileys = () => require('@whiskeysockets/baileys'), encodeQr, fetchImpl = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random, logger = console } = {}) {
  if (!userDataPath) throw new Error('مسار بيانات المستخدم مطلوب لإدارة جلسة WhatsApp.');
  const sessionPath = path.resolve(userDataPath, 'whatsapp-session');
  const jobs = new Map();
  let socket = null;
  let state = { status: 'offline', qr: null, error: '' };

  const updateState = (next) => { state = { ...state, ...next }; };
  const getStatus = () => ({ status: state.status, qr: state.qr, error: state.error });
  const getJob = id => {
    const job = jobs.get(String(id));
    if (!job) return null;
    const { controller, ...view } = job;
    return { ...view, events: [...job.events] };
  };

  async function connectWhatsApp() {
    if (socket && state.status === 'connected') return getStatus();
    updateState({ status: 'connecting', qr: null, error: '' });
    try {
      const baileys = await loadBaileys();
      const makeSocket = baileys.default || baileys.makeWASocket;
      if (typeof makeSocket !== 'function' || typeof baileys.useMultiFileAuthState !== 'function') throw new Error('واجهة مكتبة Baileys غير متوافقة.');
      fs.mkdirSync(sessionPath, { recursive: true });
      const auth = await baileys.useMultiFileAuthState(sessionPath);
      socket = makeSocket({ auth: auth.state, printQRInTerminal: false, browser: ['SYSTEM', 'Desktop', '1.0.1'] });
      socket.ev.on('creds.update', auth.saveCreds);
      socket.ev.on('connection.update', async update => {
        if (update.qr) {
          let qr = update.qr;
          try { qr = await (encodeQr || (value => require('qrcode').toDataURL(value)))(update.qr); } catch (error) { updateState({ error: `تعذر عرض QR: ${error.message}` }); }
          updateState({ status: 'qr', qr, error: '' });
        }
        if (update.connection === 'open') updateState({ status: 'connected', qr: null, error: '' });
        if (update.connection === 'close') { socket = null; updateState({ status: 'offline', qr: null, error: update.lastDisconnect?.error?.message || 'انقطع اتصال WhatsApp.' }); }
      });
      return getStatus();
    } catch (error) {
      socket = null;
      const message = `تعذر تحميل أو ربط WhatsApp: ${error.message}`;
      updateState({ status: 'error', qr: null, error: message });
      logger.error?.(message);
      throw new Error(message);
    }
  }

  async function clearWhatsAppSession() {
    try { if (socket) { try { await socket.logout?.(); } catch (_) { socket.end?.(new Error('Session cleared')); } } }
    finally {
      socket = null;
      fs.rmSync(sessionPath, { recursive: true, force: true });
      updateState({ status: 'offline', qr: null, error: '' });
    }
    return getStatus();
  }

  function checkSmsConfig() {
    const config = readConfig() || {};
    const apiKey = String(config.API_KEY || '').trim();
    const senderId = String(config.SENDER_ID || '').trim();
    const apiUrl = String(config.SMS_API_URL || '').trim();
    if (!apiKey || !senderId || !apiUrl) throw new Error('إعدادات SMS غير مكتملة');
    let parsed;
    try { parsed = new URL(apiUrl); } catch (_) { throw new Error('عنوان SMS_API_URL غير صالح'); }
    if (parsed.protocol !== 'https:') throw new Error('يجب أن يستخدم SMS_API_URL اتصال HTTPS');
    if (typeof fetchImpl !== 'function') throw new Error('الاتصال بالإنترنت غير متاح لإرسال SMS.');
    return { apiKey, senderId, apiUrl };
  }

  function startCampaign({ recipients, message, channel = 'sms', dryRun = true, minDelaySec, maxDelaySec } = {}) {
    const cleanedMessage = String(message || '').trim();
    if (!cleanedMessage) throw new Error('اكتب نص الرسالة أولاً.');
    if (!['sms', 'whatsapp'].includes(channel)) throw new Error('قناة الإرسال غير صالحة.');
    if (!dryRun && channel === 'sms') checkSmsConfig();
    if (!dryRun && channel === 'whatsapp' && (!socket || state.status !== 'connected')) throw new Error('اربط WhatsApp أولاً قبل الإرسال.');
    const unique = new Map();
    for (const recipient of Array.isArray(recipients) ? recipients : []) {
      const normalized = normalizeEgyptMobile(recipient?.phone);
      if (normalized.valid && !unique.has(normalized.international)) unique.set(normalized.international, { ...recipient, phone: normalized.international });
    }
    const list = [...unique.values()];
    const config = readConfig() || {};
    const min = Math.max(0, Number(minDelaySec ?? config.MIN_DELAY_SEC ?? 5));
    const max = Math.max(min, Number(maxDelaySec ?? config.MAX_DELAY_SEC ?? 12));
    const id = crypto.randomUUID();
    const job = { id, channel, dryRun: Boolean(dryRun), total: list.length, sent: 0, failed: 0, planned: 0, stopped: false, stopRequested: false, status: 'running', events: [], controller: new AbortController() };
    jobs.set(id, job);
    const record = (recipient, result) => job.events.push({ at: new Date().toISOString(), recipientId: recipient.id, phone: recipient.phone, ...result });
    job.done = (async () => {
      let baileysSocket = socket;
      try {
        if (!job.dryRun && channel === 'whatsapp' && !baileysSocket) throw new Error('اربط WhatsApp أولاً قبل الإرسال.');
        const sms = !job.dryRun && channel === 'sms' ? checkSmsConfig() : null;
        for (let index = 0; index < list.length; index += 1) {
          if (job.stopRequested) break;
          const recipient = list[index];
          if (job.dryRun) {
            job.planned += 1;
            record(recipient, { status: 'planned', message: 'dry-run: لم يتم إرسال الرسالة' });
          } else if (channel === 'sms') {
            try {
              const response = await fetchImpl(sms.apiUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${sms.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: sms.senderId, to: recipient.phone, message: cleanedMessage }), signal: job.controller.signal });
              if (!response.ok) throw new Error(`SMS Gateway أعاد HTTP ${response.status}`);
              job.sent += 1; record(recipient, { status: 'sent' });
            } catch (error) { if (job.stopRequested && error.name === 'AbortError') break; job.failed += 1; record(recipient, { status: 'failed', message: error.message }); }
          } else {
            try {
              await baileysSocket.sendMessage(`${recipient.phone.slice(1)}@s.whatsapp.net`, { text: cleanedMessage });
              job.sent += 1; record(recipient, { status: 'sent' });
            } catch (error) { job.failed += 1; record(recipient, { status: 'failed', message: error.message }); }
          }
          if (channel === 'whatsapp' && index < list.length - 1 && !job.stopRequested) {
            const delay = Math.floor(min + random() * (max - min + 1));
            job.events[job.events.length - 1].delay_seconds = delay;
            if (!job.dryRun) await Promise.race([sleep(delay * 1000), new Promise(resolve => job.controller.signal.addEventListener('abort', resolve, { once: true }))]);
          }
        }
      } catch (error) { job.failed += Math.max(0, job.total - job.sent - job.failed - job.planned); record({ id: null, phone: '' }, { status: 'failed', message: error.message }); }
      job.stopped = job.stopRequested;
      job.status = job.stopRequested ? 'stopped' : 'completed';
      return getJob(id);
    })();
    return { id, total: job.total, status: job.status };
  }

  function stopCampaign(id) {
    const job = jobs.get(String(id));
    if (!job || job.status !== 'running') return false;
    job.stopRequested = true;
    job.controller.abort();
    return true;
  }

  return { normalizeEgyptMobile, classifyRecipients, connectWhatsApp, clearWhatsAppSession, getWhatsAppStatus: getStatus, startCampaign, getJob, stopCampaign, sessionPath };
}

module.exports = { normalizeEgyptMobile, classifyRecipients, createCampaignManager };
