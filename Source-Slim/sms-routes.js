'use strict';

const os = require('os');

const {
  PLAY_STORE_URL,
  PENDING_TTL_MINUTES,
  extractToken,
  checkRateLimit,
  deviceByToken,
  createDevice,
  listDevices,
  unpairDevice,
  expirePending,
  createPending,
  pendingForSale,
  prepareReceivePlan,
  commitReceive,
  prepareManualPlan,
  commitManualPayment,
  closeSaleForWallet,
  walletSnapshot,
  listMessages,
  listPending,
  listNotifications
} = require('./sms-service');
const { walletRow, assertWalletScope, postWalletDeposit, postWalletWithdraw } = require('./wallet-service');

function registerSmsRoutes({ app, db, isUnrestrictedAccount }) {
  const unrestricted = req => Boolean(isUnrestrictedAccount(req.authUser));
  const scope = req => ({ branchId: Number(req.branchId), unrestricted: unrestricted(req) });
  const sendError = (res, error) => res.status(Number(error.statusCode) || 500).json({ error: error.message, code: error.code || 'SMS_ERROR' });
  const baseUrl = req => {
    const interfaces = os.networkInterfaces();
    const ip = Object.values(interfaces).flat().find(entry => entry && (entry.family === 'IPv4' || entry.family === 4) && !entry.internal && /^(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(entry.address))?.address;
    return `http://${ip || req.hostname}:${req.socket.localPort || 3000}`;
  };

  app.post('/api/sms/devices', (req, res) => {
    if (!unrestricted(req)) return res.status(403).json({ error: 'ربط أجهزة SMS متاح للمالك فقط.' });
    try {
      const wallet = assertWalletScope(walletRow(db.storageAdapter.connection, Number(req.body?.wallet_id)), { unrestricted: true, requireActive: true });
      const device = db.withSqlTransaction(connection => createDevice(connection, { wallet_id: wallet.id, device_name: req.body?.device_name }));
      res.status(201).json({ device_token: device.device_token, device, instructions_ar: 'انسخ URL أو امسح QR داخل تطبيق SMS to URL Forwarder، ثم فعّل Forwarding.' });
    } catch (error) { sendError(res, error); }
  });

  app.get('/api/sms/devices', (req, res) => {
    try { res.json({ devices: listDevices(db.storageAdapter.connection, { ...scope(req), branchFilter: unrestricted(req) ? Number(req.query.branch_id) || null : null }) }); }
    catch (error) { sendError(res, error); }
  });

  app.post('/api/sms/devices/:id/unpair', (req, res) => {
    if (!unrestricted(req)) return res.status(403).json({ error: 'فصل أجهزة SMS متاح للمالك فقط.' });
    try { res.json({ device: db.withSqlTransaction(connection => unpairDevice(connection, Number(req.params.id), scope(req))), message: 'تم فصل الجهاز.' }); }
    catch (error) { sendError(res, error); }
  });

  app.get('/api/sms/setup', (req, res) => {
    if (!unrestricted(req)) return res.status(403).json({ error: 'إعداد SMS متاح للمالك فقط.' });
    const devices = listDevices(db.storageAdapter.connection, { ...scope(req) }).map(device => ({
      ...device,
      base_url: `${baseUrl(req)}/api/sms/receive?token=${encodeURIComponent(device.device_token)}`
    }));
    res.json({ devices, play_store_url: PLAY_STORE_URL, instructions_ar: ['حمّل تطبيق SMS to URL Forwarder من Play Store.', 'ولّد Token لكل جهاز من داخل النظام.', 'انسخ URL الكامل أو امسح QR داخل التطبيق.', 'فعّل Forwarding واستخدم فلتر رسائل المحفظة.'] });
  });

  function receiveSms(req, res) {
    const body = req.body || {};
    const token = extractToken(req, body);
    if (!token) return res.status(401).json({ error: 'رمز جهاز SMS مطلوب.', code: 'SMS_TOKEN_REQUIRED' });
    try {
      checkRateLimit(token);
      const receivedAt = (() => { const date = new Date(body.timestamp || Date.now()); return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 19).replace('T', ' ') : date.toISOString().slice(0, 19).replace('T', ' '); })();
      const connection = db.storageAdapter.connection;
      const plan = prepareReceivePlan(connection, token, body.sender, body.message, receivedAt);
      if (plan.duplicate) return res.status(200).json({ duplicate: true, idempotent: true, sms: plan.sms });
      if (plan.kind === 'matched') {
        const sale = db.data.sales.find(row => Number(row.id) === Number(plan.pending.sale_id));
        if (!sale) return res.status(404).json({ error: 'الفاتورة المعلقة غير موجودة.' });
        const wallet = walletRow(connection, plan.device.wallet_id);
        let paymentRow;
        const result = db.transaction(['sales', 'sale_payments'], () => {
          paymentRow = closeSaleForWallet(db, sale, wallet, plan.parsed.parsed_amount, 'matched');
          return { sale_id: sale.id };
        }, transactionConnection => commitReceive(transactionConnection, db, plan, paymentRow));
        return res.status(200).json({ ...result, message: `تم استلام ${Number(plan.parsed.parsed_amount).toFixed(2)} من ${plan.parsed.parsed_phone || 'العميل'}.` });
      }
      const result = db.withSqlTransaction(transactionConnection => commitReceive(transactionConnection, db, plan, null));
      return res.status(202).json({ ...result, message: plan.kind === 'mismatched_amount' || plan.kind === 'wrong_wallet' ? 'تم استلام SMS بمشكلة مطابقة ويحتاج مراجعة.' : 'تم استلام SMS ويحتاج مراجعة يدوية.' });
    } catch (error) { return sendError(res, error); }
  }

  app.post(['/api/sms/receive', '/api/sms/receive/:token'], receiveSms);

  app.get('/api/sms/messages', (req, res) => {
    try {
      const messages = listMessages(db.storageAdapter.connection, req.query, scope(req));
      const requestedLimit = Number.parseInt(req.query.limit, 10);
      const requestedOffset = Number.parseInt(req.query.offset, 10);
      const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 200) : messages.length;
      const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
      res.set('X-Pagination-Total', String(messages.length));
      res.set('X-Pagination-Offset', String(offset));
      res.set('X-Pagination-Limit', String(limit));
      res.set('X-Pagination-Has-More', String(offset + limit < messages.length));
      res.json({ messages: messages.slice(offset, offset + limit), count: messages.length, offset, limit, has_more: offset + limit < messages.length });
    } catch (error) { sendError(res, error); }
  });

  app.get('/api/sms/pending', (req, res) => {
    try { res.json({ pending: listPending(db.storageAdapter.connection, scope(req)) }); }
    catch (error) { sendError(res, error); }
  });

  app.post('/api/sms/messages/:id/process', (req, res) => {
    const action = String(req.body?.action || '').trim();
    const message = db.storageAdapter.connection.prepare(`SELECT m.*,w.branch_id FROM sms_messages m LEFT JOIN sms_devices d ON d.device_token=m.device_token LEFT JOIN wallets w ON w.id=COALESCE(m.matched_wallet_id,d.wallet_id) WHERE m.id=?`).get(Number(req.params.id));
    if (!message) return res.status(404).json({ error: 'رسالة SMS غير موجودة.' });
    if (!unrestricted(req) && Number(message.branch_id) !== Number(req.branchId)) return res.status(403).json({ error: 'رسالة SMS غير موجودة في فرع المستخدم.' });
    if (action === 'ignore') {
      db.withSqlTransaction(connection => connection.prepare(`UPDATE sms_messages SET status='ignored',notes=? WHERE id=?`).run(String(req.body?.notes || 'تم تجاهل الرسالة.').slice(0, 300), message.id));
      return res.json({ message: 'تم تجاهل رسالة SMS.' });
    }
    if (action === 'match_sale') {
      return manualPayment(req, res, Number(req.body?.wallet_id || message.matched_wallet_id), { sale_id: req.body?.sale_id, amount: req.body?.amount || message.parsed_amount, txn_id: req.body?.txn_id || `sms-${message.id}`, notes: req.body?.notes || `مطابقة يدوية للرسالة ${message.id}` }, message.id);
    }
    if (action === 'record_payment' || action === 'expense') {
      const walletId = Number(req.body?.wallet_id || message.matched_wallet_id);
      const value = Number(req.body?.amount || message.parsed_amount);
      if (!Number.isInteger(walletId) || !Number.isFinite(value) || value <= 0) return res.status(400).json({ error: 'المحفظة والمبلغ مطلوبان.' });
      try {
        const result = db.withSqlTransaction(connection => action === 'record_payment'
          ? postWalletDeposit(connection, { wallet_id: walletId, amount: value, source_account_code: '1110', reference_id: `SMS-${message.id}`, idempotency_key: `sms:record:${message.id}`, user_id: req.authUser.id, notes: `دفعة SMS ${message.id}` })
          : postWalletWithdraw(connection, { wallet_id: walletId, amount: value, destination_account_code: '1110', reference_id: `SMS-${message.id}`, idempotency_key: `sms:expense:${message.id}`, user_id: req.authUser.id, notes: `مصروف SMS ${message.id}` }));
        db.storageAdapter.connection.prepare(`UPDATE sms_messages SET status='manual',matched_wallet_id=?,notes=? WHERE id=?`).run(walletId, action === 'record_payment' ? 'تم تسجيلها كدفعة.' : 'تم تسجيلها كمصروف.', message.id);
        return res.json({ ...result, message: 'تمت معالجة رسالة SMS يدوياً.' });
      } catch (error) { return sendError(res, error); }
    }
    return res.status(400).json({ error: 'الإجراء غير صالح.' });
  });

  function manualPayment(req, res, walletId, body, messageId = null) {
    if (!Number.isInteger(Number(walletId)) || Number(walletId) < 1) return res.status(400).json({ error: 'wallet_id مطلوب.' });
    if (!String(body.txn_id || '').trim()) return res.status(400).json({ error: 'رقم العملية مطلوب للتأكيد اليدوي.' });
    try {
      const plan = prepareManualPlan(db.storageAdapter.connection, db, { wallet_id: walletId, sale_id: body.sale_id, amount: body.amount, txn_id: body.txn_id, notes: body.notes });
      if (plan.existingEntry) return res.status(200).json({ already_processed: true, sale: plan.sale, entry: plan.existingEntry });
      const sale = plan.sale;
      let paymentRow;
      const result = db.transaction(['sales', 'sale_payments'], () => {
        paymentRow = closeSaleForWallet(db, sale, plan.wallet, plan.value, 'manual');
        return { sale_id: sale.id };
      }, connection => {
        const committed = commitManualPayment(connection, db, plan, paymentRow);
        if (messageId) connection.prepare(`UPDATE sms_messages SET status='manual',matched_sale_id=?,matched_wallet_id=?,notes=? WHERE id=?`).run(sale.id, plan.wallet.id, 'تمت المطابقة اليدوية.', messageId);
        return committed;
      });
      return res.status(200).json({ ...result, message: 'تم التأكيد اليدوي وإغلاق الفاتورة.' });
    } catch (error) { return sendError(res, error); }
  }

  app.post('/api/wallets/:walletId/manual-payment', (req, res) => {
    return manualPayment(req, res, Number(req.params.walletId), req.body || null);
  });

  app.post('/api/sales/:id/await-wallet-payment', (req, res) => {
    const sale = db.data.sales.find(row => Number(row.id) === Number(req.params.id));
    if (!sale || Number(sale.branch_id || db.data.default_branch_id) !== Number(req.branchId)) return res.status(404).json({ error: 'الفاتورة غير موجودة في هذا الفرع.' });
    try {
      const wallet = assertWalletScope(walletRow(db.storageAdapter.connection, Number(req.body?.wallet_id)), { branchId: req.branchId, unrestricted: false, requireActive: true });
      let result;
      db.transaction(['sales'], () => {
        sale.payment_status = 'awaiting_wallet_payment'; sale.wallet_payment_status = 'waiting'; sale.wallet_id = wallet.id; sale.paid_amount = 0; sale.remaining_amount = sale.total; sale.updated_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
        return sale;
      }, connection => { result = createPending(connection, { sale_id: sale.id, wallet_id: wallet.id, expected_amount: sale.total, notes: 'بانتظار تحويل SMS.' }); return result; });
      res.status(result.already_exists ? 200 : 201).json({ pending: result.pending, already_exists: result.already_exists, display: { wallet_name: wallet.name, wallet_number: wallet.wallet_number, amount: sale.total, expires_at: result.pending.expires_at } });
    } catch (error) { sendError(res, error); }
  });

  app.get('/api/sales/:id/wallet-payment-status', (req, res) => {
    const sale = db.data.sales.find(row => Number(row.id) === Number(req.params.id));
    if (!sale || Number(sale.branch_id || db.data.default_branch_id) !== Number(req.branchId)) return res.status(404).json({ error: 'الفاتورة غير موجودة في هذا الفرع.' });
    try {
      expirePending(db.storageAdapter.connection);
      const pending = pendingForSale(db.storageAdapter.connection, sale.id);
      res.json({ sale_id: sale.id, sale_status: sale.payment_status || sale.status || 'open', pending });
    } catch (error) { sendError(res, error); }
  });

  app.post('/api/sales/:id/cancel-wallet-payment', (req, res) => {
    const sale = db.data.sales.find(row => Number(row.id) === Number(req.params.id));
    if (!sale || Number(sale.branch_id || db.data.default_branch_id) !== Number(req.branchId)) return res.status(404).json({ error: 'الفاتورة غير موجودة في هذا الفرع.' });
    try {
      const pending = pendingForSale(db.storageAdapter.connection, sale.id);
      if (!pending || !['waiting','expired'].includes(pending.status)) return res.status(409).json({ error: 'لا توجد دفعة معلقة قابلة للإلغاء.' });
      sale.status = 'cancelled'; sale.payment_status = 'cancelled'; sale.wallet_payment_status = 'cancelled'; sale.cancelled_at = new Date().toISOString().slice(0, 19).replace('T', ' '); sale.updated_at = sale.cancelled_at;
      db.transaction(['sales'], () => ({ sale_id: sale.id }), connection => { connection.prepare(`UPDATE pending_wallet_payments SET status='expired',notes=? WHERE id=?`).run('ألغى المستخدم الفاتورة.', pending.id); });
      res.json({ sale, message: 'تم إلغاء الفاتورة المعلقة.' });
    } catch (error) { sendError(res, error); }
  });

  app.get('/api/sms/notifications', (req, res) => {
    try { res.json(listNotifications(db.storageAdapter.connection, scope(req))); }
    catch (error) { sendError(res, error); }
  });
}

module.exports = { registerSmsRoutes };
