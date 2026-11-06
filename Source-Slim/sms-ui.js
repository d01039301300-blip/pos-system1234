'use strict';

(function smsUi(root) {
  const state = { setup: null, pendingTimer: null, pendingSale: null };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const toast = (message, tone = 'info') => root.showAppToast?.(message, { tone });
  const api = async (url, options = {}) => {
    const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'تعذر تنفيذ العملية.');
    return data;
  };

  async function copyText(value, label) {
    try { await navigator.clipboard.writeText(String(value || '')); toast(`تم نسخ ${label}.`, 'success'); }
    catch (_) { toast('تعذر النسخ تلقائياً؛ حدّد النص وانسخه يدوياً.', 'error'); }
  }

  function drawQr(node, text) {
    node.innerHTML = '';
    if (!root.QRCode) { node.textContent = text; return; }
    new root.QRCode(node, { text, width: 180, height: 180, correctLevel: root.QRCode.CorrectLevel.M });
  }

  function renderSetup(data) {
    const host = document.getElementById('sms-ui-root');
    if (!host) return;
    state.setup = data;
    const devices = data.devices || [];
    host.innerHTML = `<div class="sms-setup-grid"><div class="sms-setup-card"><div class="sms-card-kicker">SMS FORWARDING</div><h3>ربط الموبايل بالمحفظة</h3><p>${esc(data.instructions_ar?.[0] || 'اربط جهازاً لاستقبال إشعارات التحويل تلقائياً.')}</p><div class="sms-device-form"><input id="sms-device-name" placeholder="اسم الجهاز" maxlength="120"><select id="sms-device-wallet">${(root.__walletsCache || []).map(wallet => `<option value="${wallet.id}">${esc(wallet.name)} - ${esc(wallet.wallet_number)}</option>`).join('')}</select><button type="button" class="settings-master-btn" data-sms-action="create">توليد Token</button></div></div><div class="sms-setup-card"><div class="sms-card-kicker">DEVICES</div><h3>الأجهزة المرتبطة</h3><div class="sms-device-list">${devices.length ? devices.map((device, index) => { const url = device.base_url; return `<article class="sms-device-row"><div><strong>${esc(device.device_name)}</strong><span>${esc(device.wallet_name)} - ${esc(device.wallet_number)}</span><code>${esc(device.device_token)}</code></div><div class="sms-device-tools"><div class="sms-qr" id="sms-qr-${index}"></div><label>URL كامل<input readonly dir="ltr" value="${esc(url)}"></label><button type="button" class="sms-copy-btn" data-sms-copy="${esc(url)}" data-sms-copy-label="الرابط">نسخ URL</button><button type="button" class="sms-copy-btn" data-sms-copy="${esc(device.device_token)}" data-sms-copy-label="Token">نسخ Token</button><button type="button" class="sms-unpair-btn" data-sms-unpair="${device.id}">فصل الجهاز</button></div></article>`; }).join('') : '<div class="sms-empty">لا توجد أجهزة مرتبطة بعد.</div>'}</div></div></div>`;
    devices.forEach((device, index) => drawQr(host.querySelector(`#sms-qr-${index}`), device.base_url));
    host.onclick = async event => {
      const copy = event.target.closest('[data-sms-copy]');
      if (copy) return copyText(copy.dataset.smsCopy, copy.dataset.smsCopyLabel || 'النص');
      const unpair = event.target.closest('[data-sms-unpair]');
      if (unpair) { try { await api(`/api/sms/devices/${unpair.dataset.smsUnpair}/unpair`, { method: 'POST', body: '{}' }); toast('تم فصل الجهاز.', 'success'); await load(); } catch (error) { toast(error.message, 'error'); } return; }
      if (event.target.closest('[data-sms-action="create"]')) {
        try { const name = host.querySelector('#sms-device-name').value.trim(); const walletId = Number(host.querySelector('#sms-device-wallet').value); await api('/api/sms/devices', { method: 'POST', body: JSON.stringify({ device_name: name, wallet_id: walletId }) }); toast('تم توليد Token وربط الجهاز.', 'success'); await load(); } catch (error) { toast(error.message, 'error'); }
      }
    };
  }

  async function load() {
    const host = document.getElementById('sms-ui-root');
    if (!host) return;
    try {
      const [setup, wallets] = await Promise.all([api('/api/sms/setup'), api('/api/wallets')]);
      root.__walletsCache = (wallets.wallets || []).filter(wallet => Number(wallet.is_active) === 1);
      renderSetup(setup);
    } catch (error) { host.innerHTML = `<div class="sms-error">${esc(error.message)}</div>`; }
  }

  function closePending() {
    if (state.pendingTimer) clearInterval(state.pendingTimer);
    state.pendingTimer = null;
    document.getElementById('sms-pending-modal')?.remove();
    state.pendingSale = null;
  }

  function renderPendingStatus(payload) {
    const modal = document.getElementById('sms-pending-modal');
    if (!modal) return;
    const pending = payload.pending;
    const status = pending?.status || '';
    const expired = status === 'expired';
    const statusText = expired ? '⏰ انتهت المهلة' : status === 'waiting' ? 'بانتظار وصول التحويل...' : status === 'matched' || payload.sale_status === 'paid' ? 'تم استلام الدفع' : status;
    modal.querySelector('[data-pending-status]').textContent = statusText;
    modal.querySelector('[data-pending-status]').className = `sms-pending-status ${expired ? 'expired' : status === 'waiting' ? 'waiting' : 'success'}`;
    modal.querySelector('[data-pending-actions]').innerHTML = expired
      ? '<button type="button" data-pending-action="manual">تأكيد يدوي</button><button type="button" data-pending-action="switch">تحويل لطريقة دفع أخرى</button><button type="button" class="danger" data-pending-action="cancel">إلغاء الفاتورة</button>'
      : '<button type="button" class="secondary" data-pending-action="cancel-close">إغلاق</button>';
    if (status === 'matched' || payload.sale_status === 'paid') {
      toast(`تم الدفع عبر ${pending.wallet_name || ''} - ${pending.wallet_number || ''}.`, 'success');
      setTimeout(closePending, 500);
    }
  }

  async function pollPending() {
    if (!state.pendingSale) return;
    try { renderPendingStatus(await api(`/api/sales/${state.pendingSale.id}/wallet-payment-status`)); }
    catch (error) { console.warn('[sms] pending poll failed', error.message); }
  }

  function openPendingModal(payload) {
    const sale = payload.sale || payload;
    const pending = payload.pending || {};
    state.pendingSale = { id: Number(sale.id), walletId: Number(pending.wallet_id || sale.wallet_id), total: Number(sale.total || pending.expected_amount || 0) };
    document.getElementById('sms-pending-modal')?.remove();
    const modal = document.createElement('div'); modal.id = 'sms-pending-modal'; modal.className = 'sms-modal-backdrop';
    modal.innerHTML = `<section class="sms-pending-dialog" role="dialog" aria-modal="true"><header><div><span>WALLET PAYMENT</span><h3>بانتظار الدفع</h3></div><button type="button" data-pending-action="close" aria-label="إغلاق">×</button></header><div class="sms-pending-body"><div class="sms-pending-wallet"><strong>${esc(pending.wallet_name || 'المحفظة الإلكترونية')}</strong><span>${esc(pending.wallet_number || '')}</span></div><div class="sms-pending-amount">${Number(sale.total || pending.expected_amount || 0).toFixed(2)} ج.م</div><p data-pending-status class="sms-pending-status waiting">بانتظار وصول التحويل...</p><small>رقم الفاتورة: ${esc(sale.invoice_number || sale.id)}</small><div data-pending-actions class="sms-pending-actions"></div></div></section>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', event => { const action = event.target.closest('[data-pending-action]')?.dataset.pendingAction; if (!action) return; if (action === 'close' || action === 'cancel-close') return closePending(); if (action === 'manual') return openManualPayment(); if (action === 'switch') { closePending(); root.posOpenPaymentModal?.(); return; } if (action === 'cancel') return cancelPending(); });
    void pollPending();
    state.pendingTimer = setInterval(pollPending, 3000);
  }

  function openManualPayment() {
    const host = document.createElement('div'); host.className = 'sms-modal-backdrop'; host.id = 'sms-manual-modal';
    host.innerHTML = `<section class="sms-pending-dialog"><header><div><span>MANUAL FALLBACK</span><h3>تأكيد يدوي للدفع</h3></div><button type="button" data-manual-close>×</button></header><form class="sms-manual-form"><label>رقم العملية<input name="txn_id" required maxlength="160" placeholder="TXN-..."></label><label>ملاحظات<textarea name="notes" maxlength="300"></textarea></label><div class="sms-pending-actions"><button type="submit">تأكيد وإغلاق الفاتورة</button><button type="button" class="secondary" data-manual-close>إلغاء</button></div></form></section>`;
    document.body.appendChild(host);
    host.querySelectorAll('[data-manual-close]').forEach(node => node.addEventListener('click', () => host.remove()));
    host.querySelector('form').addEventListener('submit', async event => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await api(`/api/wallets/${state.pendingSale.walletId}/manual-payment`, { method: 'POST', body: JSON.stringify({ sale_id: state.pendingSale.id, amount: state.pendingSale.total, txn_id: form.get('txn_id'), notes: form.get('notes') }) }); host.remove(); toast('تم التأكيد اليدوي وإغلاق الفاتورة.', 'success'); closePending(); } catch (error) { toast(error.message, 'error'); } });
  }

  async function cancelPending() {
    try { await api(`/api/sales/${state.pendingSale.id}/cancel-wallet-payment`, { method: 'POST', body: '{}' }); toast('تم إلغاء الفاتورة المعلقة.', 'success'); closePending(); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function processMessage(id, action, payload = {}) {
    try { await api(`/api/sms/messages/${id}/process`, { method: 'POST', body: JSON.stringify({ action, ...payload }) }); toast(action === 'ignore' ? 'تم تجاهل رسالة SMS.' : 'تمت معالجة رسالة SMS.', 'success'); await root.refreshPhase1Notifications?.(); }
    catch (error) { toast(error.message, 'error'); }
  }

  function startPolling() { if (state.polling) return; state.polling = setInterval(() => { if (document.visibilityState !== 'hidden') void root.refreshPhase1Notifications?.(); }, 3000); }
  root.SmsUI = { load, openPendingModal, openManualPayment, processMessage, startPolling, copyText };
  startPolling();
})(window);
