'use strict';

const crypto = require('crypto');
const {
  walletRow,
  assertWalletScope,
  applyWalletMovement,
  nowSql
} = require('./wallet-service');
const { postSaleToAccounting } = require('./accounting');

const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.smsto.url';
const SMS_RETENTION_DAYS = 90;
const PENDING_TTL_MINUTES = 10;
const SMS_RATE_LIMIT = 10;
const rateWindow = new Map();

function sqlDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return nowSql();
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function amount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function parseSms(rawText) {
  const text = String(rawText || '').trim();
  const amountMatch = text.match(/(\d[\d.,]*)\s*(جنيه|ج\.م|EGP|LE)(?=\s|$|[،,.])/i);
  const phoneMatch = text.match(/01\d{9}/);
  const txnMatch = text.match(/(?:رقم العملية|عملية رقم|Ref|TXN)[:\s#]*([A-Za-z0-9]+)/i);
  const normalizedAmount = amountMatch ? amount(amountMatch[1].includes('.') && amountMatch[1].includes(',') ? amountMatch[1].replace(/,/g, '') : amountMatch[1].replace(',', '.')) : null;
  return {
    parsed_amount: normalizedAmount,
    parsed_phone: phoneMatch ? phoneMatch[0] : null,
    parsed_txn_id: txnMatch ? txnMatch[1] : null,
    direction: /\bمن\b/u.test(text) ? 'in' : /إلى|لدى/u.test(text) ? 'out' : 'unknown'
  };
}

function messageHash(sender, rawText, receivedAt) {
  return crypto.createHash('sha256').update(`${String(sender || '')}\n${String(rawText || '')}\n${String(receivedAt || '')}`).digest('hex');
}

function extractToken(req, body = {}) {
  return String(body.token || req.query?.token || req.get('X-Device-Token') || req.params?.token || '').trim();
}

function checkRateLimit(token) {
  const now = Date.now();
  const active = (rateWindow.get(token) || []).filter(stamp => now - stamp < 60000);
  if (active.length >= SMS_RATE_LIMIT) {
    const error = new Error('تم تجاوز حد رسائل SMS. حاول بعد دقيقة.');
    error.statusCode = 429;
    error.code = 'SMS_RATE_LIMITED';
    throw error;
  }
  active.push(now);
  rateWindow.set(token, active);
}

function deviceByToken(connection, token, { activeOnly = true } = {}) {
  const activeClause = activeOnly ? 'AND d.is_active=1 AND w.is_active=1' : '';
  return connection.prepare(`
    SELECT d.*, w.name AS wallet_name, w.wallet_number, w.wallet_type, w.branch_id, w.account_id, a.code AS account_code
    FROM sms_devices d JOIN wallets w ON w.id=d.wallet_id LEFT JOIN accounts a ON a.id=w.account_id
    WHERE d.device_token=? ${activeClause}
  `).get(token) || null;
}

function createDevice(connection, input) {
  const wallet = assertWalletScope(walletRow(connection, Number(input.wallet_id)), { unrestricted: true, requireActive: true });
  const token = crypto.randomUUID();
  const name = String(input.device_name || '').trim().slice(0, 120);
  if (!name) throw new Error('اسم الجهاز مطلوب.');
  const result = connection.prepare(`
    INSERT INTO sms_devices(wallet_id,device_token,device_name,last_seen_at,is_active,created_at)
    VALUES (?,?,?,?,1,?)
  `).run(wallet.id, token, name, null, sqlDate());
  return { id: Number(result.lastInsertRowid), wallet_id: wallet.id, device_token: token, device_name: name, is_active: 1, created_at: sqlDate(), wallet_name: wallet.name, wallet_number: wallet.wallet_number };
}

function listDevices(connection, scope = {}) {
  const clauses = ['d.is_active=1'];
  const params = [];
  if (!scope.unrestricted) { clauses.push('w.branch_id=?'); params.push(Number(scope.branchId)); }
  if (scope.branchFilter) { clauses.push('w.branch_id=?'); params.push(Number(scope.branchFilter)); }
  return connection.prepare(`
    SELECT d.id,d.wallet_id,d.device_token,d.device_name,d.last_seen_at,d.is_active,d.created_at,
           w.name AS wallet_name,w.wallet_number,w.wallet_type,w.branch_id
    FROM sms_devices d JOIN wallets w ON w.id=d.wallet_id
    WHERE ${clauses.join(' AND ')} ORDER BY w.branch_id,w.name,d.id
  `).all(...params);
}

function unpairDevice(connection, id, scope = {}) {
  const row = connection.prepare(`SELECT d.*,w.branch_id FROM sms_devices d JOIN wallets w ON w.id=d.wallet_id WHERE d.id=?`).get(Number(id));
  if (!row) { const error = new Error('جهاز SMS غير موجود.'); error.statusCode = 404; throw error; }
  if (!scope.unrestricted && Number(row.branch_id) !== Number(scope.branchId)) { const error = new Error('جهاز SMS غير موجود في فرع المستخدم.'); error.statusCode = 403; throw error; }
  connection.prepare('UPDATE sms_devices SET is_active=0 WHERE id=?').run(row.id);
  return { ...row, is_active: 0 };
}

function expirePending(connection, at = sqlDate()) {
  return connection.prepare(`UPDATE pending_wallet_payments SET status='expired', notes=CASE WHEN notes='' THEN 'انتهت مهلة الانتظار.' ELSE notes END WHERE status='waiting' AND expires_at<=?`).run(at).changes;
}

function cleanupRetention(connection) {
  const cutoff = new Date(Date.now() - SMS_RETENTION_DAYS * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  connection.prepare(`DELETE FROM sms_messages WHERE received_at<? AND status IN ('matched','mismatched','manual','ignored')`).run(cutoff);
  connection.prepare(`DELETE FROM pending_wallet_payments WHERE status IN ('expired','matched','mismatched','manual') AND created_at<?`).run(cutoff);
}

function pendingForWallet(connection, walletId, at = sqlDate()) {
  return connection.prepare(`SELECT p.*,w.name AS wallet_name,w.wallet_number,w.wallet_type,w.branch_id FROM pending_wallet_payments p JOIN wallets w ON w.id=p.wallet_id WHERE p.wallet_id=? AND p.status='waiting' AND p.expires_at>? ORDER BY p.created_at,p.id LIMIT 1`).get(Number(walletId), at) || null;
}

function pendingForSale(connection, saleId) {
  return connection.prepare('SELECT * FROM pending_wallet_payments WHERE sale_id=?').get(Number(saleId)) || null;
}

function createPending(connection, input) {
  const existing = pendingForSale(connection, input.sale_id);
  if (existing) return { pending: existing, already_exists: true };
  const expiresAt = input.expires_at || sqlDate(Date.now() + PENDING_TTL_MINUTES * 60000);
  const result = connection.prepare(`INSERT INTO pending_wallet_payments(sale_id,wallet_id,expected_amount,status,created_at,expires_at,notes) VALUES (?,?,?,'waiting',?,?,?)`).run(Number(input.sale_id), Number(input.wallet_id), amount(input.expected_amount), sqlDate(), expiresAt, String(input.notes || '').slice(0, 300));
  return { pending: connection.prepare('SELECT * FROM pending_wallet_payments WHERE id=?').get(Number(result.lastInsertRowid)), already_exists: false };
}

function walletSnapshot(wallet) {
  return { wallet_id: wallet.id, name: wallet.name, wallet_number: wallet.wallet_number, wallet_type: wallet.wallet_type, fee: 0 };
}

function addSalePayment(db, sale, wallet, amountValue, methodDetails = walletSnapshot(wallet)) {
  const existing = db.data.sale_payments.find(row => Number(row.sale_id) === Number(sale.id) && row.method === 'محفظة إلكترونية');
  if (existing) return existing;
  const row = { id: db.nextId('sale_payments'), sale_id: sale.id, branch_id: sale.branch_id, method: 'محفظة إلكترونية', amount: amount(amountValue), method_details: methodDetails, created_at: sqlDate() };
  db.data.sale_payments.push(row);
  return row;
}

function closeSaleForWallet(db, sale, wallet, value, status) {
  sale.paid_amount = amount(value);
  sale.change_amount = 0;
  sale.remaining_amount = 0;
  sale.payment_method = 'محفظة إلكترونية';
  sale.payment_status = 'paid';
  sale.wallet_payment_status = status;
  sale.updated_at = sqlDate();
  return addSalePayment(db, sale, wallet, value);
}

function prepareReceivePlan(connection, token, sender, rawText, receivedAt) {
  const device = deviceByToken(connection, token);
  if (!device) { const error = new Error('رمز جهاز SMS غير صالح أو غير نشط.'); error.statusCode = 401; error.code = 'SMS_DEVICE_UNAUTHORIZED'; throw error; }
  const parsed = parseSms(rawText);
  const hash = messageHash(sender, rawText, receivedAt);
  const duplicate = connection.prepare('SELECT * FROM sms_messages WHERE device_token=? AND message_hash=?').get(token, hash);
  if (duplicate) return { duplicate: true, device, parsed, hash, sms: duplicate };
  const pending = parsed.parsed_amount === null ? null : pendingForWallet(connection, device.wallet_id, receivedAt);
  let kind = 'manual';
  let candidate = pending;
  if (!parsed.parsed_amount) kind = 'new';
  else if (pending && Math.abs(Number(pending.expected_amount) - Number(parsed.parsed_amount)) <= 0.009) kind = 'matched';
  else if (pending) kind = 'mismatched_amount';
  else {
    const other = connection.prepare(`SELECT p.*,w.name AS wallet_name,w.wallet_number FROM pending_wallet_payments p JOIN wallets w ON w.id=p.wallet_id WHERE p.status='waiting' AND p.expires_at>? AND w.branch_id=? AND p.wallet_id<>? ORDER BY p.created_at,p.id LIMIT 1`).get(receivedAt, device.branch_id, device.wallet_id);
    if (other) { kind = 'wrong_wallet'; candidate = other; }
  }
  return { duplicate: false, token, device, parsed, hash, sender: String(sender || '').slice(0, 120), rawText: String(rawText || '').slice(0, 2000), receivedAt, kind, pending: candidate };
}

function insertSmsRow(connection, plan) {
  const status = plan.kind === 'matched' ? 'matched' : plan.kind === 'mismatched_amount' || plan.kind === 'wrong_wallet' ? 'mismatched' : plan.kind === 'new' ? 'new' : 'manual';
  const notes = plan.kind === 'mismatched_amount'
    ? `مبلغ مختلف: توقع ${Number(plan.pending.expected_amount).toFixed(2)}، جاء ${Number(plan.parsed.parsed_amount).toFixed(2)}`
    : plan.kind === 'wrong_wallet'
      ? `دفعة دخلت ${plan.device.wallet_name} بينما الفاتورة تنتظر ${plan.pending.wallet_name}`
      : '';
  const result = connection.prepare(`INSERT OR IGNORE INTO sms_messages(device_token,sender,raw_text,received_at,direction,parsed_amount,parsed_phone,parsed_txn_id,status,matched_sale_id,matched_wallet_id,message_hash,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(plan.token, plan.sender, plan.rawText, plan.receivedAt, plan.parsed.direction, plan.parsed.parsed_amount, plan.parsed.parsed_phone, plan.parsed.parsed_txn_id, status, null, plan.device.wallet_id, plan.hash, notes);
  const sms = connection.prepare('SELECT * FROM sms_messages WHERE device_token=? AND message_hash=?').get(plan.token, plan.hash);
  connection.prepare('UPDATE sms_devices SET last_seen_at=? WHERE id=?').run(plan.receivedAt, plan.device.id);
  return { sms, inserted: Number(result.changes) > 0, status, notes };
}

function commitReceive(connection, db, plan, paymentRow = null) {
  expirePending(connection, plan.receivedAt);
  cleanupRetention(connection);
  const inserted = insertSmsRow(connection, plan);
  if (!inserted.inserted) return { sms: inserted.sms, duplicate: true, status: inserted.sms.status };
  if (plan.kind === 'matched') {
    const currentPending = pendingForSale(connection, plan.pending.sale_id);
    if (!currentPending || currentPending.status !== 'waiting') throw new Error('الدفعة المعلقة تغيرت قبل المطابقة.');
    const sale = db.data.sales.find(row => Number(row.id) === Number(plan.pending.sale_id));
    if (!sale) throw new Error('فاتورة الدفعة المعلقة غير موجودة.');
    const wallet = walletRow(connection, plan.device.wallet_id);
    const movement = applyWalletMovement(connection, { wallet_id: wallet.id, branch_id: wallet.branch_id, type: 'sale', amount: plan.parsed.parsed_amount, fee: 0, reference_id: sale.invoice_number || String(sale.id), idempotency_key: `sms:${inserted.sms.id}`, user_id: sale.user_id, notes: `تحصيل SMS للفاتورة ${sale.invoice_number || sale.id}` });
    postSaleToAccounting({ ...sale, items: db.data.sale_items.filter(row => Number(row.sale_id) === Number(sale.id)) }, [paymentRow], connection, { skipWalletMovement: true });
    connection.prepare(`UPDATE pending_wallet_payments SET status='matched',matched_sms_id=?,notes=? WHERE id=?`).run(inserted.sms.id, 'تمت المطابقة تلقائياً.', currentPending.id);
    connection.prepare(`UPDATE sms_messages SET status='matched',matched_sale_id=?,matched_wallet_id=?,notes=? WHERE id=?`).run(sale.id, wallet.id, 'تمت مطابقة الدفعة وإغلاق الفاتورة.', inserted.sms.id);
    return { sms: connection.prepare('SELECT * FROM sms_messages WHERE id=?').get(inserted.sms.id), pending: connection.prepare('SELECT * FROM pending_wallet_payments WHERE id=?').get(currentPending.id), movement, matched: true };
  }
  if (plan.pending && (plan.kind === 'mismatched_amount' || plan.kind === 'wrong_wallet')) {
    connection.prepare(`UPDATE pending_wallet_payments SET status='mismatched',matched_sms_id=?,notes=? WHERE id=? AND status='waiting'`).run(inserted.sms.id, inserted.notes, plan.pending.id);
  }
  return { sms: inserted.sms, pending: plan.pending || null, matched: false };
}

function prepareManualPlan(connection, db, input) {
  const sale = db.data.sales.find(row => Number(row.id) === Number(input.sale_id));
  if (!sale) { const error = new Error('الفاتورة غير موجودة.'); error.statusCode = 404; throw error; }
  const wallet = assertWalletScope(walletRow(connection, Number(input.wallet_id)), { branchId: sale.branch_id, unrestricted: false, requireActive: true });
  const value = amount(input.amount);
  if (value === null || Math.abs(value - Number(sale.total)) > 0.009) throw new Error('مبلغ التأكيد اليدوي يجب أن يساوي إجمالي الفاتورة.');
  const pending = pendingForSale(connection, sale.id);
  const existingEntry = connection.prepare('SELECT id,entry_number FROM journal_entries WHERE reference_type=? AND reference_id=?').get('sales', String(sale.invoice_number || sale.id));
  return { sale, wallet, value, pending, existingEntry, txnId: String(input.txn_id || '').trim().slice(0, 160), notes: String(input.notes || '').trim().slice(0, 300) };
}

function commitManualPayment(connection, db, plan, paymentRow) {
  if (plan.existingEntry) return { already_processed: true, sale: plan.sale, entry: plan.existingEntry };
  const movement = applyWalletMovement(connection, { wallet_id: plan.wallet.id, branch_id: plan.wallet.branch_id, type: 'sale', amount: plan.value, fee: 0, reference_id: plan.sale.invoice_number || String(plan.sale.id), idempotency_key: `manual:${plan.txnId || plan.sale.id}`, user_id: plan.sale.user_id, notes: plan.notes || `تأكيد يدوي للفاتورة ${plan.sale.invoice_number || plan.sale.id}` });
  const entry = postSaleToAccounting({ ...plan.sale, items: db.data.sale_items.filter(row => Number(row.sale_id) === Number(plan.sale.id)) }, [paymentRow], connection, { skipWalletMovement: true });
  if (plan.pending) connection.prepare(`UPDATE pending_wallet_payments SET status='manual',matched_sms_id=NULL,notes=? WHERE id=?`).run(plan.notes || 'تم التأكيد اليدوي.', plan.pending.id);
  return { already_processed: Boolean(movement.already_processed), sale: plan.sale, movement, entry };
}

function listMessages(connection, query = {}, scope = {}) {
  const clauses = ['1=1']; const params = [];
  if (!scope.unrestricted) { clauses.push('w.branch_id=?'); params.push(Number(scope.branchId)); }
  if (query.status) { clauses.push('m.status=?'); params.push(String(query.status)); }
  if (query.wallet_id) { clauses.push('w.id=?'); params.push(Number(query.wallet_id)); }
  if (query.since) { clauses.push('m.received_at>?'); params.push(String(query.since)); }
  if (query.from) { clauses.push('m.received_at>=?'); params.push(`${query.from} 00:00:00`); }
  if (query.to) { clauses.push('m.received_at<=?'); params.push(`${query.to} 23:59:59`); }
  return connection.prepare(`SELECT m.*,w.id AS wallet_id,w.name AS wallet_name,w.wallet_number,w.wallet_type,w.branch_id FROM sms_messages m LEFT JOIN sms_devices d ON d.device_token=m.device_token LEFT JOIN wallets w ON w.id=COALESCE(m.matched_wallet_id,d.wallet_id) WHERE ${clauses.join(' AND ')} ORDER BY m.received_at DESC,m.id DESC LIMIT 200`).all(...params);
}

function listPending(connection, scope = {}) {
  expirePending(connection);
  const clauses = ['1=1']; const params = [];
  if (!scope.unrestricted) { clauses.push('w.branch_id=?'); params.push(Number(scope.branchId)); }
  return connection.prepare(`SELECT p.*,w.name AS wallet_name,w.wallet_number,w.wallet_type,w.branch_id FROM pending_wallet_payments p JOIN wallets w ON w.id=p.wallet_id WHERE ${clauses.join(' AND ')} ORDER BY p.status='waiting' DESC,p.created_at DESC`).all(...params);
}

function listNotifications(connection, scope = {}) {
  const messages = listMessages(connection, { status: 'new' }, scope).concat(listMessages(connection, { status: 'mismatched' }, scope));
  const pending = listPending(connection, scope);
  return { messages, pending, count: messages.length + pending.filter(row => ['waiting','expired'].includes(row.status)).length };
}

module.exports = {
  PLAY_STORE_URL,
  SMS_RETENTION_DAYS,
  PENDING_TTL_MINUTES,
  extractToken,
  checkRateLimit,
  parseSms,
  messageHash,
  deviceByToken,
  createDevice,
  listDevices,
  unpairDevice,
  expirePending,
  cleanupRetention,
  pendingForWallet,
  pendingForSale,
  createPending,
  walletSnapshot,
  addSalePayment,
  closeSaleForWallet,
  prepareReceivePlan,
  commitReceive,
  prepareManualPlan,
  commitManualPayment,
  listMessages,
  listPending,
  listNotifications
};
