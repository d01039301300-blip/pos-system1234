'use strict';

const ACCOUNT_CODES = Object.freeze({
  cash: '1110',
  bank: '1120',
  receivable: '1200',
  inventory: '1300',
  payable: '2100',
  vat: '2200',
  capital: '3100',
  retainedEarnings: '3200',
  sales: '4100',
  otherIncome: '4900',
  cogs: '5100',
  miscellaneousExpense: '5900'
});

const WALLET_PAYMENT_METHODS = new Set(['محفظة إلكترونية', 'محفظة', 'wallet', 'e-wallet', 'e_wallet']);

const PAYMENT_ACCOUNT_CODES = Object.freeze({
  'نقدي': ACCOUNT_CODES.cash,
  cash: ACCOUNT_CODES.cash,
  'بطاقة': ACCOUNT_CODES.bank,
  card: ACCOUNT_CODES.bank,
  visa: ACCOUNT_CODES.bank,
  'دفع آجل': ACCOUNT_CODES.receivable,
  آجل: ACCOUNT_CODES.receivable,
  credit: ACCOUNT_CODES.receivable,
  deferred: ACCOUNT_CODES.receivable
});

function amount(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return 0;
  return Number(parsed.toFixed(2));
}

function dateOnly(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/u);
  return match ? match[1] : new Date().toISOString().slice(0, 10);
}

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function readStorageValue(connection, key) {
  const row = connection.prepare('SELECT payload FROM storage_values WHERE key=?').get(String(key));
  if (!row) return null;
  try { return JSON.parse(row.payload); } catch { return null; }
}

function accountByCode(connection, code) {
  const row = connection.prepare('SELECT id, code, name_ar, name_en, type, is_postable, is_active FROM accounts WHERE code=?').get(String(code));
  if (!row || Number(row.is_active) !== 1) throw new Error(`الحساب ${code} غير موجود أو غير نشط.`);
  if (Number(row.is_postable) !== 1) throw new Error(`الحساب ${code} حساب تجميعي ولا يقبل القيود.`);
  return row;
}

function paymentAccountCode(method) {
  const key = String(method || '').trim();
  const code = PAYMENT_ACCOUNT_CODES[key];
  if (code) return code;
  console.warn(`[ACCOUNTING_WARN] unknown payment method=${key || '(empty)'} default_account=1110`);
  return ACCOUNT_CODES.cash;
}

function duplicateReferenceError(referenceType, referenceId) {
  const error = new Error(`القيد موجود بالفعل للمرجع ${referenceType}:${referenceId}.`);
  error.code = 'ACCOUNTING_DUPLICATE_REFERENCE';
  error.reference_type = referenceType;
  error.reference_id = String(referenceId);
  return error;
}

function createJournalEntry(connection, input) {
  const referenceType = String(input.reference_type || '').trim();
  const referenceId = String(input.reference_id || '').trim();
  if (!referenceType || !referenceId) throw new Error('مرجع القيد مطلوب.');
  const existing = connection.prepare('SELECT id, entry_number FROM journal_entries WHERE reference_type=? AND reference_id=?').get(referenceType, referenceId);
  if (existing) throw duplicateReferenceError(referenceType, referenceId);

  const normalizedLines = (input.lines || []).map(line => {
    const debit = amount(line.debit);
    const credit = amount(line.credit);
    if ((debit > 0 && credit > 0) || (debit <= 0 && credit <= 0)) throw new Error('كل سطر قيد يجب أن يكون مديناً أو دائناً فقط.');
    const account = accountByCode(connection, line.account_code);
    return {
      account_id: account.id,
      account_code: account.code,
      debit,
      credit,
      description: String(line.description || input.description || '').slice(0, 300),
      party_type: line.party_type ? String(line.party_type).slice(0, 30) : null,
      party_id: line.party_type && Number.isInteger(Number(line.party_id)) && Number(line.party_id) > 0 ? Number(line.party_id) : null
    };
  }).filter(line => line.debit > 0 || line.credit > 0);
  if (normalizedLines.length < 2) throw new Error('القيد يجب أن يحتوي على سطرين على الأقل.');
  const totalDebit = amount(normalizedLines.reduce((sum, line) => sum + line.debit, 0));
  const totalCredit = amount(normalizedLines.reduce((sum, line) => sum + line.credit, 0));
  if (Math.abs(totalDebit - totalCredit) > 0.009) {
    const error = new Error(`القيد غير متوازن: مدين ${totalDebit.toFixed(2)} ودائن ${totalCredit.toFixed(2)}.`);
    error.code = 'ACCOUNTING_UNBALANCED';
    throw error;
  }

  const entryDate = dateOnly(input.entry_date);
  const counterKey = `journal:${entryDate}`;
  connection.prepare(`
    INSERT INTO accounting_counters(counter_key, current_value) VALUES (?, 1)
    ON CONFLICT(counter_key) DO UPDATE SET current_value=current_value+1
  `).run(counterKey);
  const counter = connection.prepare('SELECT current_value FROM accounting_counters WHERE counter_key=?').get(counterKey);
  const entryNumber = `JE-${entryDate.replace(/-/g, '')}-${String(counter.current_value).padStart(4, '0')}`;
  const createdAt = nowSql();
  const entryResult = connection.prepare(`
    INSERT INTO journal_entries(entry_number, entry_date, description, reference_type, reference_id, branch_id, created_by, is_posted, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    entryNumber,
    entryDate,
    String(input.description || '').slice(0, 500) || 'قيد محاسبي',
    referenceType,
    referenceId,
    Number.isInteger(Number(input.branch_id)) ? Number(input.branch_id) : null,
    Number.isInteger(Number(input.created_by)) ? Number(input.created_by) : null,
    createdAt
  );
  const entryId = Number(entryResult.lastInsertRowid);
  const insertLine = connection.prepare(`
    INSERT INTO journal_lines(entry_id, account_id, debit, credit, description, party_type, party_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const line of normalizedLines) {
    insertLine.run(entryId, line.account_id, line.debit, line.credit, line.description, line.party_type, line.party_id);
  }
  connection.prepare('UPDATE journal_entries SET is_posted=1 WHERE id=?').run(entryId);
  const result = {
    id: entryId,
    entry_number: entryNumber,
    entry_date: entryDate,
    reference_type: referenceType,
    reference_id: referenceId,
    total_debit: totalDebit,
    total_credit: totalCredit,
    balanced: true,
    lines: normalizedLines
  };
  console.log(`[ACCOUNTING_POSTED] ${entryNumber} ref=${referenceType}:${referenceId} debit=${totalDebit.toFixed(2)} credit=${totalCredit.toFixed(2)}`);
  return result;
}

function walletPaymentDetails(payment) {
  if (!payment) return {};
  if (typeof payment.method_details === 'string') {
    try { return JSON.parse(payment.method_details || '{}') || {}; } catch { return {}; }
  }
  return payment.method_details || {};
}

function walletAccountCode(connection, payment, sale) {
  const details = walletPaymentDetails(payment);
  const walletId = Number(details.wallet_id || payment.wallet_id);
  if (!Number.isInteger(walletId) || walletId < 1) throw new Error('محفظة البيع غير محددة.');
  const row = connection.prepare(`
    SELECT w.branch_id, a.code FROM wallets w JOIN accounts a ON a.id=w.account_id
    WHERE w.id=? AND w.is_active=1 AND a.is_active=1
  `).get(walletId);
  if (!row) throw new Error('المحفظة المحددة غير موجودة أو غير نشطة.');
  if (Number(row.branch_id) !== Number(sale.branch_id)) {
    const error = new Error('محفظة البيع يجب أن تتبع فرع الفاتورة.'); error.statusCode = 400; throw error;
  }
  return row.code;
}

function salePaymentLines(sale, paymentRows, connection) {
  const lines = [];
  const total = amount(sale.total);
  if (Array.isArray(paymentRows) && paymentRows.length) {
    for (const payment of paymentRows) {
      const value = amount(payment.amount);
      if (value <= 0) continue;
      const method = String(payment.method || '').trim();
      lines.push({
        account_code: WALLET_PAYMENT_METHODS.has(method) ? walletAccountCode(connection, payment, sale) : paymentAccountCode(method),
        debit: value,
        description: `تحصيل ${method || 'نقدي'} من فاتورة ${sale.invoice_number || sale.id}`,
        party_type: method === 'دفع آجل' || method === 'آجل' || method === 'credit' || method === 'deferred' ? 'customer' : null,
        party_id: method === 'دفع آجل' || method === 'آجل' || method === 'credit' || method === 'deferred' ? sale.customer_id : null
      });
    }
    return lines;
  }
  const paid = Math.min(total, Math.max(0, amount(sale.paid_amount ?? total)));
  const remaining = amount(Math.max(0, total - paid));
  const method = String(sale.payment_method || 'نقدي').trim();
  if (method === 'دفع آجل' || method === 'آجل' || method === 'credit' || method === 'deferred') {
    if (total > 0) lines.push({ account_code: ACCOUNT_CODES.receivable, debit: total, description: `آجل للعميل من فاتورة ${sale.invoice_number || sale.id}`, party_type: 'customer', party_id: sale.customer_id });
    return lines;
  }
  if (paid > 0) lines.push({ account_code: WALLET_PAYMENT_METHODS.has(method) ? walletAccountCode(connection, { method, method_details: sale.wallet_details }, sale) : paymentAccountCode(method), debit: paid, description: `تحصيل ${method || 'نقدي'} من فاتورة ${sale.invoice_number || sale.id}` });
  if (remaining > 0) lines.push({ account_code: ACCOUNT_CODES.receivable, debit: remaining, description: `الرصيد الآجل من فاتورة ${sale.invoice_number || sale.id}`, party_type: 'customer', party_id: sale.customer_id });
  return lines;
}

function saleJournalLines(sale, paymentRows, connection) {
  const lines = salePaymentLines(sale, paymentRows, connection);
  const taxSettings = readStorageValue(connection, 'tax_settings');
  const taxEnabled = taxSettings?.enabled === true;
  const total = amount(sale.total);
  const taxAmount = taxEnabled ? amount(sale.tax_amount) : 0;
  const taxableAmount = amount(Math.max(0, Number(sale.subtotal || sale.total || 0) - Number(sale.discount || 0)));
  const revenueAmount = taxEnabled ? amount(Math.max(0, total - taxAmount)) : total;
  if (taxAmount > 0) lines.push({ account_code: ACCOUNT_CODES.vat, credit: taxAmount, description: `ضريبة مخرجات فاتورة ${sale.invoice_number || sale.id}` });
  if (revenueAmount > 0) lines.push({ account_code: ACCOUNT_CODES.sales, credit: revenueAmount, description: `إيراد مبيعات فاتورة ${sale.invoice_number || sale.id}` });

  let cogs = 0;
  for (const item of Array.isArray(sale.items) ? sale.items : []) {
    if (item.cost_price === null || item.cost_price === undefined || item.cost_price === '') {
      console.warn(`[ACCOUNTING_WARN] sale=${sale.invoice_number || sale.id} item=${item.id || item.product_id} cost_price=NULL; cogs=0`);
      continue;
    }
    cogs += Math.max(0, Number(item.cost_price) || 0) * Math.max(0, Number(item.quantity) || 0);
  }
  cogs = amount(cogs);
  if (cogs > 0) {
    lines.push({ account_code: ACCOUNT_CODES.cogs, debit: cogs, description: `تكلفة مبيعات فاتورة ${sale.invoice_number || sale.id}` });
    lines.push({ account_code: ACCOUNT_CODES.inventory, credit: cogs, description: `خروج مخزون فاتورة ${sale.invoice_number || sale.id}` });
  }
  console.log(`[ACCOUNTING_SALE_BASE] invoice=${sale.invoice_number || sale.id} tax_enabled=${taxEnabled} taxable_amount=${taxableAmount.toFixed(2)} tax=${taxAmount.toFixed(2)} cogs=${cogs.toFixed(2)}`);
  return lines;
}

function postSaleToAccounting(saleObject, paymentRows, connection, options = {}) {
  const referenceId = saleObject.invoice_number || saleObject.id;
  const existing = connection.prepare('SELECT id, entry_number FROM journal_entries WHERE reference_type=? AND reference_id=?').get('sales', String(referenceId));
  if (existing) throw duplicateReferenceError('sales', referenceId);
  const walletMovements = options.skipWalletMovement ? [] : (Array.isArray(paymentRows) ? paymentRows : [])
    .filter(payment => WALLET_PAYMENT_METHODS.has(String(payment.method || '').trim()))
    .map(payment => require('./wallet-service').postWalletSale(connection, saleObject, payment));
  const entry = createJournalEntry(connection, {
    entry_date: saleObject.created_at,
    description: `ترحيل فاتورة بيع ${saleObject.invoice_number || saleObject.id}`,
    reference_type: 'sales',
    reference_id: referenceId,
    branch_id: saleObject.branch_id,
    created_by: saleObject.user_id,
    lines: saleJournalLines(saleObject, paymentRows, connection)
  });
  return walletMovements.length ? { ...entry, wallet_movements: walletMovements } : entry;
}

function postPurchaseToAccounting(purchaseObject, purchaseItems, connection) {
  const total = amount(purchaseObject.total);
  const paid = Math.min(total, Math.max(0, amount(purchaseObject.paid_amount)));
  const remaining = amount(Math.max(0, total - paid));
  const lines = [{ account_code: ACCOUNT_CODES.inventory, debit: total, description: `مخزون فاتورة شراء ${purchaseObject.id}` }];
  if (paid > 0) lines.push({ account_code: ACCOUNT_CODES.cash, credit: paid, description: `سداد نقدي لفاتورة شراء ${purchaseObject.id}` });
  if (remaining > 0) lines.push({ account_code: ACCOUNT_CODES.payable, credit: remaining, description: `آجل المورد لفاتورة شراء ${purchaseObject.id}`, party_type: 'supplier', party_id: purchaseObject.supplier_id });
  const result = createJournalEntry(connection, {
    entry_date: purchaseObject.created_at,
    description: `ترحيل فاتورة شراء ${purchaseObject.id}`,
    reference_type: 'purchase',
    reference_id: `PUR-${purchaseObject.id}`,
    branch_id: purchaseObject.branch_id,
    created_by: purchaseObject.user_id,
    lines
  });
  console.log(`[ACCOUNTING_PURCHASE] purchase=${purchaseObject.id} items=${Array.isArray(purchaseItems) ? purchaseItems.length : 0}`);
  return result;
}

function postExpenseToAccounting(expenseObject, connection) {
  return createJournalEntry(connection, {
    entry_date: expenseObject.created_at,
    description: `مصروف: ${expenseObject.notes || expenseObject.description || expenseObject.reference_id}`,
    reference_type: 'expense',
    reference_id: expenseObject.reference_id,
    branch_id: expenseObject.branch_id,
    created_by: expenseObject.user_id,
    lines: [
      { account_code: ACCOUNT_CODES.miscellaneousExpense, debit: amount(expenseObject.amount), description: expenseObject.notes || 'مصروف متنوع' },
      { account_code: ACCOUNT_CODES.cash, credit: amount(expenseObject.amount), description: 'سداد المصروف من الصندوق' }
    ]
  });
}

function postCashTransactionToAccounting(row, connection) {
  if (!row || row.type === 'sale' || row.type === 'purchase') return null;
  const value = amount(row.amount);
  if (value <= 0) return null;
  const isOut = row.direction === 'out';
  const type = row.type === 'expense' ? 'expense' : 'cash';
  const debitCode = isOut ? ACCOUNT_CODES.miscellaneousExpense : ACCOUNT_CODES.cash;
  const creditCode = isOut ? ACCOUNT_CODES.cash : row.type === 'owner_deposit' ? ACCOUNT_CODES.capital : ACCOUNT_CODES.otherIncome;
  return createJournalEntry(connection, {
    entry_date: row.created_at,
    description: row.notes || 'حركة نقدية',
    reference_type: type,
    reference_id: row.reference_id,
    branch_id: row.branch_id,
    created_by: row.user_id,
    lines: [
      { account_code: debitCode, debit: value, description: row.notes || 'حركة نقدية' },
      { account_code: creditCode, credit: value, description: row.notes || 'حركة نقدية' }
    ]
  });
}

function postCashTransferToAccounting(transfer, connection) {
  const value = amount(transfer.amount);
  return createJournalEntry(connection, {
    entry_date: transfer.created_at,
    description: transfer.description || 'تحويل بين الخزائن',
    reference_type: 'cash_transfer',
    reference_id: transfer.reference_id,
    branch_id: transfer.from_branch_id,
    created_by: transfer.created_by,
    lines: [
      { account_code: transfer.to_account_code || ACCOUNT_CODES.cash, debit: value, description: 'استلام التحويل' },
      { account_code: transfer.from_account_code || ACCOUNT_CODES.cash, credit: value, description: 'إرسال التحويل' }
    ]
  });
}

module.exports = {
  ACCOUNT_CODES,
  PAYMENT_ACCOUNT_CODES,
  createJournalEntry,
  postSaleToAccounting,
  postPurchaseToAccounting,
  postExpenseToAccounting,
  postCashTransactionToAccounting,
  postCashTransferToAccounting,
  paymentAccountCode,
  amount,
  dateOnly
};
