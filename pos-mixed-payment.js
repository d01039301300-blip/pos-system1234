(function () {
  'use strict';

  const METHODS = [
    { value: 'نقدي', label: 'نقدي' },
    { value: 'بطاقة', label: 'بطاقة' },
    { value: 'دفع آجل', label: 'دفع آجل' }
  ];
  let rows = [];

  const getTotal = () => Number(String(document.getElementById('pos-grand-total')?.textContent || '0').replace(/[^0-9.-]/g, '')) || 0;
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));

  function render() {
    const host = document.getElementById('pos-mixed-payment-rows');
    if (!host) return;
    host.innerHTML = rows.map((row, index) => `
      <div class="pos-mixed-row" data-index="${index}">
        <label>الطريقة<select data-mixed-method="${index}">${METHODS.map(method => `<option value="${escapeHtml(method.value)}" ${row.method === method.value ? 'selected' : ''}>${method.label}</option>`).join('')}</select></label>
        <label>المبلغ<input type="number" min="0" step="0.01" inputmode="decimal" data-mixed-amount="${index}" value="${Number(row.amount || 0).toFixed(2)}"></label>
        <button type="button" class="pos-mixed-remove" data-mixed-remove="${index}" aria-label="حذف الدفعة">×</button>
      </div>`).join('');
    host.querySelectorAll('[data-mixed-method]').forEach(select => select.addEventListener('change', event => {
      rows[Number(event.target.dataset.mixedMethod)].method = event.target.value;
      updateStatus();
    }));
    host.querySelectorAll('[data-mixed-amount]').forEach(input => input.addEventListener('input', event => {
      rows[Number(event.target.dataset.mixedAmount)].amount = Number(event.target.value) || 0;
      updateStatus();
    }));
    host.querySelectorAll('[data-mixed-remove]').forEach(button => button.addEventListener('click', () => {
      if (rows.length <= 2) return window.showAppToast?.('يجب الإبقاء على طريقتي دفع على الأقل.');
      rows.splice(Number(button.dataset.mixedRemove), 1);
      render();
    }));
    updateStatus();
  }

  function updateStatus() {
    const total = getTotal();
    const allocated = Number(rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0).toFixed(2));
    const difference = Number((total - allocated).toFixed(2));
    const status = document.getElementById('pos-mixed-payment-status');
    const submit = document.getElementById('pos-mixed-submit');
    const exact = Math.abs(difference) <= 0.009 && new Set(rows.filter(row => Number(row.amount) > 0).map(row => row.method)).size >= 2;
    if (status) {
      status.className = `pos-mixed-status ${exact ? 'is-complete' : difference >= 0 ? 'is-due' : 'is-over'}`;
      status.textContent = exact ? `تم توزيع ${allocated.toFixed(2)} ج.م بالكامل` : difference >= 0 ? `المتبقي: ${difference.toFixed(2)} ج.م` : `العجز: ${Math.abs(difference).toFixed(2)} ج.م`;
    }
    if (submit) submit.disabled = !exact;
  }

  window.openPosMixedPaymentModal = function () {
    if (!getTotal()) return window.showAppToast?.('أضف أصنافاً إلى الفاتورة أولاً.');
    const total = getTotal();
    rows = [{ method: 'نقدي', amount: Number((total / 2).toFixed(2)) }, { method: 'بطاقة', amount: Number((total - total / 2).toFixed(2)) }];
    const totalEl = document.getElementById('pos-mixed-total');
    if (totalEl) totalEl.textContent = `${total.toFixed(2)} ج.م`;
    document.getElementById('pos-mixed-payment-modal')?.classList.remove('hidden');
    render();
  };
  window.closePosMixedPaymentModal = function () { document.getElementById('pos-mixed-payment-modal')?.classList.add('hidden'); };
  window.addPosMixedPaymentRow = function () { rows.push({ method: 'دفع آجل', amount: 0 }); render(); };
  window.submitPosMixedPayment = function () {
    updateStatus();
    const total = getTotal();
    const allocated = Number(rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0).toFixed(2));
    if (Math.abs(allocated - total) > 0.009) return window.showAppToast?.('يجب أن يساوي مجموع الدفعات إجمالي الفاتورة.');
    if (new Set(rows.filter(row => Number(row.amount) > 0).map(row => row.method)).size < 2) return window.showAppToast?.('اختر طريقتي دفع مختلفتين على الأقل.');
    window.__posMixedPaymentSplits = rows.filter(row => Number(row.amount) > 0).map(row => ({ method: row.method, amount: Number(Number(row.amount).toFixed(2)) }));
    window.closePosMixedPaymentModal();
    window.processPosPayment?.(false);
  };
  document.addEventListener('click', event => { if (event.target?.dataset?.mixedClose === 'true') window.closePosMixedPaymentModal(); });
})();
