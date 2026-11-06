'use strict';

const PAYMENT_METHOD_ALIASES = new Map([
  ['cash', 'نقدي'],
  ['نقدي', 'نقدي'],
  ['card', 'بطاقة'],
  ['visa', 'بطاقة'],
  ['بطاقة', 'بطاقة'],
  ['دفع آجل', 'دفع آجل'],
  ['آجل', 'دفع آجل'],
  ['credit', 'دفع آجل'],
  ['deferred', 'دفع آجل'],
  ['محفظة إلكترونية', 'محفظة إلكترونية'],
  ['محفظة', 'محفظة إلكترونية'],
  ['wallet', 'محفظة إلكترونية'],
  ['e-wallet', 'محفظة إلكترونية'],
  ['e_wallet', 'محفظة إلكترونية']
]);

function normalizePaymentMethod(value) {
  const normalized = PAYMENT_METHOD_ALIASES.get(String(value || '').trim());
  if (!normalized) throw new Error('طريقة الدفع غير صالحة. اختر نقدي أو بطاقة أو دفع آجل أو محفظة إلكترونية.');
  return normalized;
}

function normalizePaymentSplits(input, total) {
  if (!Array.isArray(input) || input.length < 2) throw new Error('الدفع المختلط يحتاج طريقتي دفع على الأقل.');
  const rows = input.map((entry, index) => {
    const method = normalizePaymentMethod(entry?.method);
    const amount = Number(entry?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`قيمة الدفعة رقم ${index + 1} غير صحيحة.`);
    const details = entry?.method_details || {};
    const walletId = Number(details.wallet_id || entry?.wallet_id);
    if (method === 'محفظة إلكترونية' && (!Number.isInteger(walletId) || walletId < 1)) throw new Error(`اختر محفظة للدفعة رقم ${index + 1}.`);
    return { method, amount: Number(amount.toFixed(2)), ...(method === 'محفظة إلكترونية' ? { method_details: { wallet_id: walletId } } : {}) };
  });
  if (new Set(rows.map(row => row.method)).size < 2) throw new Error('اختر طريقتي دفع مختلفتين على الأقل للدفع المختلط.');
  const allocated = Number(rows.reduce((sum, row) => sum + row.amount, 0).toFixed(2));
  const expected = Number(Number(total).toFixed(2));
  if (Math.abs(allocated - expected) > 0.009) throw new Error(`مجموع الدفعات يجب أن يساوي إجمالي الفاتورة (${expected.toFixed(2)}).`);
  const cashPaid = Number(rows.filter(row => row.method === 'نقدي').reduce((sum, row) => sum + row.amount, 0).toFixed(2));
  const cardPaid = Number(rows.filter(row => row.method === 'بطاقة').reduce((sum, row) => sum + row.amount, 0).toFixed(2));
  const walletPaid = Number(rows.filter(row => row.method === 'محفظة إلكترونية').reduce((sum, row) => sum + row.amount, 0).toFixed(2));
  const creditAmount = Number(rows.filter(row => row.method === 'دفع آجل').reduce((sum, row) => sum + row.amount, 0).toFixed(2));
  return { rows, allocated, cashPaid, cardPaid, walletPaid, creditAmount };
}

// Phase 2 accounting hook: the surrounding SQLite transaction is supplied by the storage layer.
// Journal rows will be added here after the accounting migration; throwing from this hook rolls back the sale.
function postSaleToAccounting(saleObject, paymentRows, connection) {
  if (!connection) throw new Error('لم يتم تمرير اتصال SQLite إلى نقطة ربط المحاسبة.');
  if (!Array.isArray(paymentRows) || paymentRows.length === 0) return;
  console.log(`[ACCOUNTING_PLACEHOLDER] sale=${saleObject.invoice_number} splits=${paymentRows.length} phase=2`);
}

module.exports = { normalizePaymentMethod, normalizePaymentSplits, postSaleToAccounting };
