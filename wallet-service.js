'use strict';

const WALLET_TYPES = new Set(['vodafone', 'instapay', 'bank', 'other']);
const WALLET_TRANSACTION_TYPES = new Set(['deposit', 'withdraw', 'transfer_in', 'transfer_out', 'sale']);
const THRESHOLDS = [
  { type: 'warning', value: 0.80 },
  { type: 'critical', value: 0.95 },
  { type: 'full', value: 1.00 }
];

function amount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Number(parsed.toFixed(2));
}

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function businessDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(value);
}

function assertDate(value, label) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label} يجب أن يكون بصيغة YYYY-MM-DD.`);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) throw new Error(`${label} غير صالح.`);
  return text;
}

function normalizePeriod(input, fromValue, toValue) {
  const rawType = typeof input === 'object' && input !== null ? input.type : input;
  const type = String(rawType || '').trim().toLowerCase() || 'daily';
  const today = businessDate();
  if (type === 'daily') return { type, from: today, to: today, key: `D:${today}` };
  if (type === 'monthly') {
    const month = today.slice(0, 7);
    return { type, from: `${month}-01`, to: today, key: `M:${month}` };
  }
  if (type !== 'custom') throw new Error('نوع الفترة يجب أن يكون daily أو monthly أو custom.');
  const from = assertDate(typeof input === 'object' && input !== null ? input.from : fromValue, 'بداية الفترة');
  const to = assertDate(typeof input === 'object' && input !== null ? input.to : toValue, 'نهاية الفترة');
  if (from > to) throw new Error('بداية الفترة يجب ألا تتجاوز نهايتها.');
  return { type, from, to, key: `C:${from}:${to}` };
}

function walletError(message, code = 'WALLET_VALIDATION') {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

function conflictError(message) {
  const error = new Error(message);
  error.code = 'WALLET_CONFLICT';
  error.statusCode = 409;
  return error;
}

function walletRow(connection, walletId) {
  const row = connection.prepare(`
    SELECT w.*, a.code AS account_code, a.name_ar AS account_name
    FROM wallets w JOIN accounts a ON a.id=w.account_id
    WHERE w.id=?
  `).get(Number(walletId));
  return row || null;
}

function assertWalletScope(wallet, scope = {}) {
  if (!wallet) throw walletError('المحفظة غير موجودة.', 'WALLET_NOT_FOUND');
  if (scope.branchId && !scope.unrestricted && Number(wallet.branch_id) !== Number(scope.branchId)) {
    const error = new Error('المحفظة غير موجودة في فرع المستخدم.');
    error.statusCode = 403;
    error.code = 'WALLET_BRANCH_FORBIDDEN';
    throw error;
  }
  if (scope.requireActive && Number(wallet.is_active) !== 1) throw walletError('المحفظة غير نشطة.');
  return wallet;
}

function listWallets(connection, scope = {}) {
  const clauses = [];
  const params = [];
  if (!scope.unrestricted) { clauses.push('w.branch_id=?'); params.push(Number(scope.branchId)); }
  if (scope.branchId && scope.unrestricted && scope.branchFilter) { clauses.push('w.branch_id=?'); params.push(Number(scope.branchFilter)); }
  if (scope.walletId) { clauses.push('w.id=?'); params.push(Number(scope.walletId)); }
  if (scope.activeOnly !== false) clauses.push('w.is_active=1');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return connection.prepare(`
    SELECT w.*, a.code AS account_code, a.name_ar AS account_name
    FROM wallets w JOIN accounts a ON a.id=w.account_id ${where}
    ORDER BY w.branch_id, w.name, w.id
  `).all(...params);
}

function nextAccountCode(connection) {
  const rows = connection.prepare("SELECT code FROM accounts WHERE code LIKE '1130.%'").all();
  const max = rows.reduce((value, row) => {
    const match = String(row.code || '').match(/^1130\.(\d{3})$/);
    return match ? Math.max(value, Number(match[1])) : value;
  }, 0);
  if (max >= 999) throw new Error('تم الوصول إلى الحد الأقصى لحسابات المحافظ الإلكترونية.');
  return `1130.${String(max + 1).padStart(3, '0')}`;
}

function createWallet(connection, input) {
  const name = String(input.name || '').trim().slice(0, 120);
  const walletNumber = String(input.wallet_number || '').trim().slice(0, 80);
  const walletType = String(input.wallet_type || '').trim().toLowerCase();
  const branchId = Number(input.branch_id);
  const depositLimit = amount(input.deposit_limit);
  const withdrawLimit = amount(input.withdraw_limit);
  const feePercent = amount(input.fee_percent || 0);
  if (!name || !walletNumber) throw walletError('اسم المحفظة ورقمها مطلوبان.');
  if (!WALLET_TYPES.has(walletType)) throw walletError('نوع المحفظة غير صالح.');
  if (!Number.isInteger(branchId) || branchId < 1) throw walletError('الفرع المحدد غير صالح.');
  if (depositLimit <= 0 || withdrawLimit <= 0) throw walletError('حدا الإيداع والسحب يجب أن يكونا أكبر من صفر.');
  if (feePercent < 0 || feePercent > 100) throw walletError('نسبة الرسوم يجب أن تكون بين 0 و100.');
  const duplicate = connection.prepare('SELECT id FROM wallets WHERE branch_id=? AND wallet_number=?').get(branchId, walletNumber);
  if (duplicate) throw conflictError('رقم المحفظة موجود بالفعل في هذا الفرع.');
  const parent = connection.prepare('SELECT id FROM accounts WHERE code=? AND is_active=1').get('1130');
  if (!parent) throw new Error('حساب المحافظ الإلكترونية 1130 غير مهيأ.');
  const accountCode = nextAccountCode(connection);
  const accountResult = connection.prepare(`
    INSERT INTO accounts(code,name_ar,name_en,type,parent_id,level,is_postable,is_active)
    VALUES (?,?,?,?,?,?,1,1)
  `).run(accountCode, `${name} — ${walletNumber}`, name, 'asset', parent.id, 4);
  const accountId = Number(accountResult.lastInsertRowid);
  const result = connection.prepare(`
    INSERT INTO wallets(name,wallet_number,wallet_type,branch_id,account_id,balance,deposit_limit,withdraw_limit,fee_percent,is_active,alert_threshold_warning,alert_threshold_critical,created_at,updated_at)
    VALUES (?,?,?,?,?,0,?,?,?,1,0.80,0.95,?,?)
  `).run(name, walletNumber, walletType, branchId, accountId, depositLimit, withdrawLimit, feePercent, nowSql(), nowSql());
  return walletRow(connection, Number(result.lastInsertRowid));
}

function updateWallet(connection, walletId, input) {
  const wallet = walletRow(connection, walletId);
  if (!wallet) throw walletError('المحفظة غير موجودة.', 'WALLET_NOT_FOUND');
  const name = input.name === undefined ? wallet.name : String(input.name || '').trim().slice(0, 120);
  const walletNumber = input.wallet_number === undefined ? wallet.wallet_number : String(input.wallet_number || '').trim().slice(0, 80);
  const walletType = input.wallet_type === undefined ? wallet.wallet_type : String(input.wallet_type || '').trim().toLowerCase();
  const depositLimit = input.deposit_limit === undefined ? Number(wallet.deposit_limit) : amount(input.deposit_limit);
  const withdrawLimit = input.withdraw_limit === undefined ? Number(wallet.withdraw_limit) : amount(input.withdraw_limit);
  const feePercent = input.fee_percent === undefined ? Number(wallet.fee_percent) : amount(input.fee_percent);
  if (!name || !walletNumber || !WALLET_TYPES.has(walletType)) throw walletError('بيانات المحفظة غير صالحة.');
  if (depositLimit <= 0 || withdrawLimit <= 0) throw walletError('حدا الإيداع والسحب يجب أن يكونا أكبر من صفر.');
  if (feePercent < 0 || feePercent > 100) throw walletError('نسبة الرسوم يجب أن تكون بين 0 و100.');
  const duplicate = connection.prepare('SELECT id FROM wallets WHERE branch_id=? AND wallet_number=? AND id<>?').get(wallet.branch_id, walletNumber, wallet.id);
  if (duplicate) throw conflictError('رقم المحفظة موجود بالفعل في هذا الفرع.');
  connection.prepare(`
    UPDATE wallets SET name=?, wallet_number=?, wallet_type=?, deposit_limit=?, withdraw_limit=?, fee_percent=?, updated_at=? WHERE id=?
  `).run(name, walletNumber, walletType, depositLimit, withdrawLimit, feePercent, nowSql(), wallet.id);
  connection.prepare('UPDATE accounts SET name_ar=?, name_en=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(`${name} — ${walletNumber}`, name, wallet.account_id);
  return walletRow(connection, wallet.id);
}

function softDeleteWallet(connection, walletId) {
  const wallet = walletRow(connection, walletId);
  if (!wallet) throw walletError('المحفظة غير موجودة.', 'WALLET_NOT_FOUND');
  connection.prepare('UPDATE wallets SET is_active=0, updated_at=? WHERE id=?').run(nowSql(), wallet.id);
  connection.prepare('UPDATE accounts SET is_active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(wallet.account_id);
  return walletRow(connection, wallet.id);
}

function getRecipients(connection, branchId) {
  const rows = connection.prepare(`
    SELECT json_extract(payload,'$.id') AS id, json_extract(payload,'$.branch_id') AS branch_id, json_extract(payload,'$.is_owner') AS is_owner, json_extract(payload,'$.username') AS username, json_extract(payload,'$.role') AS role
    FROM storage_rows WHERE collection='users'
  `).all();
  return rows.filter(row => Number(row.is_owner) === 1 || (row.username === 'admin' && row.role === 'admin') || Number(row.branch_id) === Number(branchId)).map(row => Number(row.id)).filter(Number.isInteger);
}

function thresholdLimit(wallet, type) {
  return type === 'withdraw' || type === 'transfer_out' ? Number(wallet.withdraw_limit) : Number(wallet.deposit_limit);
}

function thresholdTypes(type) {
  return type === 'withdraw' || type === 'transfer_out' ? ['withdraw', 'transfer_out'] : ['deposit', 'transfer_in', 'sale'];
}

function checkWalletThresholds(connection, walletId, options = {}) {
  const wallet = walletRow(connection, walletId);
  if (!wallet) throw walletError('المحفظة غير موجودة.', 'WALLET_NOT_FOUND');
  const movementType = String(options.type || 'deposit');
  const period = options.period || normalizePeriod('daily');
  const types = thresholdTypes(movementType);
  const placeholders = types.map(() => '?').join(',');
  const consumed = Number(connection.prepare(`
    SELECT COALESCE(SUM(amount),0) AS total FROM wallet_transactions
    WHERE wallet_id=? AND type IN (${placeholders}) AND created_at>=? AND created_at<=?
  `).get(wallet.id, ...types, `${period.from} 00:00:00`, `${period.to} 23:59:59`).total || 0);
  const limit = thresholdLimit(wallet, movementType);
  const ratio = limit > 0 ? consumed / limit : 0;
  const recipients = JSON.stringify(getRecipients(connection, wallet.branch_id));
  const alerts = [];
  for (const threshold of THRESHOLDS) {
    if (ratio + 0.0000001 < threshold.value) continue;
    const result = connection.prepare(`
      INSERT OR IGNORE INTO wallet_alerts(wallet_id,branch_id,threshold_type,consumed_percent,period,notified_users,created_at,is_resolved)
      VALUES (?,?,?,?,?,?,?,0)
    `).run(wallet.id, wallet.branch_id, threshold.type, Number((ratio * 100).toFixed(2)), period.key, recipients, nowSql());
    if (Number(result.changes) > 0) {
      const alert = connection.prepare('SELECT * FROM wallet_alerts WHERE id=?').get(Number(result.lastInsertRowid));
      alerts.push(alert);
      console.log(`[WALLET_ALERT] wallet=${wallet.id} threshold=${threshold.type} percent=${(ratio * 100).toFixed(2)} period=${period.key}`);
    }
  }
  return { consumed: amount(consumed), limit: amount(limit), consumed_percent: Number((ratio * 100).toFixed(2)), period, alerts };
}

function applyWalletMovement(connection, input) {
  const wallet = assertWalletScope(walletRow(connection, input.wallet_id), { requireActive: true });
  const type = String(input.type || '');
  if (!WALLET_TRANSACTION_TYPES.has(type)) throw walletError('نوع حركة المحفظة غير صالح.');
  const value = amount(input.amount);
  const fee = amount(input.fee || 0);
  const referenceId = String(input.reference_id || '').trim().slice(0, 160);
  const idempotencyKey = String(input.idempotency_key || '').trim().slice(0, 180);
  if (value <= 0) throw walletError('مبلغ الحركة يجب أن يكون أكبر من صفر.');
  if (fee < 0) throw walletError('رسوم الحركة غير صالحة.');
  if (!referenceId || !idempotencyKey) throw walletError('reference_id و idempotency_key مطلوبان.');
  const existing = connection.prepare('SELECT * FROM wallet_transactions WHERE idempotency_key=?').get(idempotencyKey);
  if (existing) {
    if (Number(existing.wallet_id) !== Number(wallet.id) || existing.type !== type || Math.abs(Number(existing.amount) - value) > 0.009) throw conflictError('مفتاح العملية مستخدم لحركة مختلفة.');
    return { wallet: walletRow(connection, wallet.id), transaction: existing, already_processed: true, threshold: null, alerts: [] };
  }
  const period = input.period || normalizePeriod('daily');
  const limit = thresholdLimit(wallet, type);
  const types = thresholdTypes(type);
  const placeholders = types.map(() => '?').join(',');
  const consumed = Number(connection.prepare(`
    SELECT COALESCE(SUM(amount),0) AS total FROM wallet_transactions
    WHERE wallet_id=? AND type IN (${placeholders}) AND created_at>=? AND created_at<=?
  `).get(wallet.id, ...types, `${period.from} 00:00:00`, `${period.to} 23:59:59`).total || 0);
  const projected = amount(consumed + value);
  if (projected > amount(limit) + 0.009) throw walletError(`تجاوز الحد المسموح للمحفظة في الفترة المحددة. المستهلك ${projected.toFixed(2)} ج.م من أصل ${amount(limit).toFixed(2)} ج.م.`, 'WALLET_LIMIT_EXCEEDED');
  const isOut = type === 'withdraw' || type === 'transfer_out';
  if (isOut && Number(wallet.balance) + 0.009 < value) throw walletError('رصيد المحفظة غير كافٍ.', 'WALLET_INSUFFICIENT_BALANCE');
  const nextBalance = amount(Number(wallet.balance) + (isOut ? -value : value));
  connection.prepare('UPDATE wallets SET balance=?, updated_at=? WHERE id=?').run(nextBalance, nowSql(), wallet.id);
  const result = connection.prepare(`
    INSERT INTO wallet_transactions(wallet_id,branch_id,type,amount,fee,reference_id,idempotency_key,user_id,created_at,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(wallet.id, wallet.branch_id, type, value, fee, referenceId, idempotencyKey, Number(input.user_id) || null, nowSql(), String(input.notes || '').slice(0, 300));
  const transaction = connection.prepare('SELECT * FROM wallet_transactions WHERE id=?').get(Number(result.lastInsertRowid));
  const threshold = checkWalletThresholds(connection, wallet.id, { type, period });
  return { wallet: walletRow(connection, wallet.id), transaction, already_processed: false, threshold, alerts: threshold.alerts };
}

function walletFee(wallet, suppliedFee, value) {
  if (suppliedFee !== undefined && suppliedFee !== null && suppliedFee !== '') return amount(suppliedFee);
  return amount(value * Number(wallet.fee_percent || 0) / 100);
}

function postWalletDeposit(connection, input) {
  const wallet = assertWalletScope(walletRow(connection, input.wallet_id), { requireActive: true });
  const sourceAccount = ['1110', '1120'].includes(String(input.source_account_code || '1110')) ? String(input.source_account_code || '1110') : '1110';
  const movement = applyWalletMovement(connection, { ...input, type: 'deposit', fee: 0 });
  if (movement.already_processed) return movement;
  const { createJournalEntry } = require('./accounting');
  movement.entry = createJournalEntry(connection, {
    entry_date: movement.transaction.created_at,
    description: `إيداع في محفظة ${wallet.name}`,
    reference_type: 'wallet_deposit',
    reference_id: input.idempotency_key,
    branch_id: wallet.branch_id,
    created_by: input.user_id,
    lines: [
      { account_code: wallet.account_code, debit: amount(input.amount), description: `إيداع ${wallet.name}` },
      { account_code: sourceAccount, credit: amount(input.amount), description: 'مصدر إيداع المحفظة' }
    ]
  });
  return movement;
}

function postWalletWithdraw(connection, input) {
  const wallet = assertWalletScope(walletRow(connection, input.wallet_id), { requireActive: true });
  const value = amount(input.amount);
  const fee = walletFee(wallet, input.fee, value);
  const sourceAccount = ['1110', '1120'].includes(String(input.destination_account_code || '1110')) ? String(input.destination_account_code || '1110') : '1110';
  const movement = applyWalletMovement(connection, { ...input, type: 'withdraw', fee });
  if (movement.already_processed) return movement;
  const { createJournalEntry } = require('./accounting');
  const lines = [
    { account_code: sourceAccount, debit: value, description: 'المبلغ المسحوب من المحفظة' },
    { account_code: wallet.account_code, credit: value, description: `سحب من محفظة ${wallet.name}` }
  ];
  if (fee > 0) {
    lines.splice(1, 0, { account_code: sourceAccount, debit: fee, description: 'رسوم سحب المحفظة' });
    lines.push({ account_code: '4900', credit: fee, description: 'إيراد رسوم المحفظة' });
  }
  movement.entry = createJournalEntry(connection, {
    entry_date: movement.transaction.created_at,
    description: `سحب من محفظة ${wallet.name}`,
    reference_type: 'wallet_withdraw',
    reference_id: input.idempotency_key,
    branch_id: wallet.branch_id,
    created_by: input.user_id,
    lines
  });
  return movement;
}

function postWalletTransfer(connection, input) {
  const fromWallet = assertWalletScope(walletRow(connection, input.from_wallet_id), { requireActive: true });
  const toWallet = assertWalletScope(walletRow(connection, input.to_wallet_id), { requireActive: true });
  if (Number(fromWallet.id) === Number(toWallet.id)) throw walletError('لا يمكن التحويل إلى نفس المحفظة.');
  if (String(input.reference_id || '').trim() === '' || String(input.idempotency_key || '').trim() === '') throw walletError('reference_id و idempotency_key مطلوبان.');
  const out = applyWalletMovement(connection, { ...input, wallet_id: fromWallet.id, type: 'transfer_out', idempotency_key: `${input.idempotency_key}:out` });
  const incoming = applyWalletMovement(connection, { ...input, wallet_id: toWallet.id, type: 'transfer_in', idempotency_key: `${input.idempotency_key}:in` });
  if (out.already_processed && incoming.already_processed) return { from: out, to: incoming, already_processed: true };
  const { createJournalEntry } = require('./accounting');
  const entry = createJournalEntry(connection, {
    entry_date: out.transaction.created_at,
    description: `تحويل من ${fromWallet.name} إلى ${toWallet.name}`,
    reference_type: 'wallet_transfer',
    reference_id: input.idempotency_key,
    branch_id: fromWallet.branch_id,
    created_by: input.user_id,
    lines: [
      { account_code: toWallet.account_code, debit: amount(input.amount), description: `استلام إلى ${toWallet.name}` },
      { account_code: fromWallet.account_code, credit: amount(input.amount), description: `إرسال من ${fromWallet.name}` }
    ]
  });
  return { from: out, to: incoming, entry, already_processed: false };
}

function postWalletSale(connection, sale, payment) {
  const details = typeof payment.method_details === 'string' ? JSON.parse(payment.method_details || '{}') : (payment.method_details || {});
  const walletId = Number(details.wallet_id || payment.wallet_id);
  if (!Number.isInteger(walletId) || walletId < 1) throw walletError('اختر محفظة صحيحة لعملية البيع.');
  const wallet = assertWalletScope(walletRow(connection, walletId), { branchId: sale.branch_id, unrestricted: false, requireActive: true });
  return applyWalletMovement(connection, {
    wallet_id: wallet.id,
    branch_id: sale.branch_id,
    type: 'sale',
    amount: payment.amount,
    fee: 0,
    reference_id: sale.invoice_number || String(sale.id),
    idempotency_key: `sale:${sale.invoice_number || sale.id}:${walletId}`,
    user_id: sale.user_id,
    notes: `تحصيل فاتورة ${sale.invoice_number || sale.id}`,
    period: normalizePeriod('daily')
  });
}

function listWalletTransactions(connection, options = {}) {
  const clauses = ['wt.created_at>=?', 'wt.created_at<=?'];
  const params = [`${options.from} 00:00:00`, `${options.to} 23:59:59`];
  if (!options.unrestricted) { clauses.push('wt.branch_id=?'); params.push(Number(options.branchId)); }
  if (options.unrestricted && options.branchFilter) { clauses.push('wt.branch_id=?'); params.push(Number(options.branchFilter)); }
  if (options.walletId) { clauses.push('wt.wallet_id=?'); params.push(Number(options.walletId)); }
  if (options.type && WALLET_TRANSACTION_TYPES.has(options.type)) { clauses.push('wt.type=?'); params.push(options.type); }
  return connection.prepare(`
    SELECT wt.*, w.name AS wallet_name, w.wallet_number, w.wallet_type, a.code AS account_code
    FROM wallet_transactions wt JOIN wallets w ON w.id=wt.wallet_id JOIN accounts a ON a.id=w.account_id
    WHERE ${clauses.join(' AND ')} ORDER BY wt.created_at DESC, wt.id DESC
  `).all(...params);
}

function walletReport(connection, options = {}) {
  const transactions = listWalletTransactions(connection, options);
  const sales = transactions.filter(row => row.type === 'sale');
  const transferProfit = transactions
    .filter(row => ['withdraw', 'transfer_in', 'transfer_out'].includes(row.type))
    .reduce((sum, row) => sum + Number(row.fee || 0), 0);
  let salesTotal = sales.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  let cogs = 0;
  if (sales.length) {
    const refs = sales.map(row => row.reference_id);
    const placeholders = refs.map(() => '?').join(',');
    const result = connection.prepare(`
      SELECT COALESCE(SUM(CASE WHEN a.code='4100' THEN jl.credit-jl.debit ELSE 0 END),0) AS sales_total,
             COALESCE(SUM(CASE WHEN a.code='5100' THEN jl.debit-jl.credit ELSE 0 END),0) AS cogs_total
      FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id JOIN accounts a ON a.id=jl.account_id
      WHERE je.reference_type='sales' AND je.reference_id IN (${placeholders})
    `).get(...refs);
    salesTotal = Number(result.sales_total || salesTotal);
    cogs = Number(result.cogs_total || 0);
  }
  const walletRows = listWallets(connection, { unrestricted: options.unrestricted, branchId: options.branchId, branchFilter: options.branchFilter, walletId: options.walletId, activeOnly: true });
  const limits = walletRows.map(wallet => {
    const deposit = Number(connection.prepare(`SELECT COALESCE(SUM(amount),0) total FROM wallet_transactions WHERE wallet_id=? AND type IN ('deposit','transfer_in','sale') AND created_at>=? AND created_at<=?`).get(wallet.id, `${options.from} 00:00:00`, `${options.to} 23:59:59`).total || 0);
    const withdraw = Number(connection.prepare(`SELECT COALESCE(SUM(amount),0) total FROM wallet_transactions WHERE wallet_id=? AND type IN ('withdraw','transfer_out') AND created_at>=? AND created_at<=?`).get(wallet.id, `${options.from} 00:00:00`, `${options.to} 23:59:59`).total || 0);
    return { wallet_id: wallet.id, wallet_name: wallet.name, branch_id: wallet.branch_id, deposit_consumed: amount(deposit), deposit_limit: amount(wallet.deposit_limit), deposit_remaining: amount(Math.max(0, wallet.deposit_limit - deposit)), withdraw_consumed: amount(withdraw), withdraw_limit: amount(wallet.withdraw_limit), withdraw_remaining: amount(Math.max(0, wallet.withdraw_limit - withdraw)) };
  });
  return {
    from: options.from,
    to: options.to,
    transactions,
    limits,
    kpis: {
      sales: amount(salesTotal),
      profit: amount(salesTotal - cogs),
      transfer_profit: amount(transferProfit),
      fees: amount(transferProfit)
    }
  };
}

function listAlerts(connection, options = {}) {
  const clauses = [];
  const params = [];
  if (!options.unrestricted) { clauses.push('wa.branch_id=?'); params.push(Number(options.branchId)); }
  if (options.unrestricted && options.branchFilter) { clauses.push('wa.branch_id=?'); params.push(Number(options.branchFilter)); }
  if (options.unresolvedOnly) clauses.push('wa.is_resolved=0');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return connection.prepare(`SELECT wa.*, w.name AS wallet_name, w.wallet_number FROM wallet_alerts wa JOIN wallets w ON w.id=wa.wallet_id ${where} ORDER BY wa.is_resolved, wa.created_at DESC, wa.id DESC`).all(...params).map(row => ({ ...row, notified_users: JSON.parse(row.notified_users || '[]') }));
}

function resolveAlert(connection, alertId, scope = {}) {
  const row = connection.prepare('SELECT * FROM wallet_alerts WHERE id=?').get(Number(alertId));
  if (!row) throw walletError('التنبيه غير موجود.', 'WALLET_ALERT_NOT_FOUND');
  if (!scope.unrestricted && Number(row.branch_id) !== Number(scope.branchId)) {
    const error = new Error('التنبيه غير موجود في فرع المستخدم.'); error.statusCode = 403; throw error;
  }
  connection.prepare('UPDATE wallet_alerts SET is_resolved=1 WHERE id=?').run(row.id);
  return connection.prepare('SELECT * FROM wallet_alerts WHERE id=?').get(row.id);
}

module.exports = {
  WALLET_TYPES,
  WALLET_TRANSACTION_TYPES,
  amount,
  nowSql,
  businessDate,
  normalizePeriod,
  walletError,
  conflictError,
  walletRow,
  listWallets,
  assertWalletScope,
  createWallet,
  updateWallet,
  softDeleteWallet,
  checkWalletThresholds,
  applyWalletMovement,
  postWalletDeposit,
  postWalletWithdraw,
  postWalletTransfer,
  postWalletSale,
  walletReport,
  listAlerts,
  resolveAlert
};
