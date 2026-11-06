'use strict';

(function walletsUi(root) {
  const state = {
    wallets: [],
    branches: [],
    report: { transactions: [], limits: [], kpis: {} },
    canManage: false,
    mounted: false
  };
  const movementLabels = {
    sale: ['بيع', 'sale'],
    transfer_in: ['تحويل داخل', 'in'],
    transfer_out: ['تحويل خارج', 'out'],
    deposit: ['إيداع', 'deposit'],
    withdraw: ['سحب', 'withdraw']
  };
  const walletTypes = { vodafone: 'Vodafone Cash', instapay: 'InstaPay', bank: 'بنك', other: 'أخرى' };
  const today = () => new Date().toISOString().slice(0, 10);
  const money = value => `${Number(value || 0).toFixed(2)} ج.م`;
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  const toast = (message, tone = 'info') => typeof root.showAppToast === 'function' ? root.showAppToast(message, { tone }) : console.log(`[WALLETS_UI_TOAST] ${message}`);

  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const data = await response.json().catch(() => ({}));
    console.log(`[WALLETS_UI] ${options.method || 'GET'} ${url}`, response.status, data);
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function modalHost() {
    let host = document.getElementById('wallets-modal-root') || document.getElementById('wallets-global-modal-root');
    if (!host) {
      host = document.createElement('div');
      host.id = 'wallets-global-modal-root';
      document.body.appendChild(host);
    }
    return host;
  }

  function branchOptions(selected = '', includeAll = false) {
    const options = includeAll ? '<option value="">كل الفروع</option>' : '';
    return options + state.branches.map(branch => `<option value="${branch.id}" ${String(branch.id) === String(selected) ? 'selected' : ''}>${escapeHtml(branch.name || `فرع ${branch.id}`)}</option>`).join('');
  }

  function walletOptions(selected = '', includeAll = false) {
    const options = includeAll ? '<option value="">كل المحافظ</option>' : '';
    return options + state.wallets.filter(wallet => Number(wallet.is_active) === 1).map(wallet => `<option value="${wallet.id}" ${String(wallet.id) === String(selected) ? 'selected' : ''}>${escapeHtml(wallet.name)} — ${escapeHtml(wallet.wallet_number)}</option>`).join('');
  }

  function mount() {
    const host = document.getElementById('wallets-ui-root');
    if (!host) return false;
    if (state.mounted && host.dataset.walletsMounted === '1') return true;
    host.innerHTML = `
      <section class="wallets-page" aria-labelledby="wallets-page-title">
        <header class="wallets-page-head">
          <div><span class="wallets-eyebrow">E-WALLETS · PHASE B</span><h2 id="wallets-page-title">المحافظ الإلكترونية</h2><p>إدارة الأرصدة، الحركات، الحدود والتنبيهات من المصدر الحقيقي.</p></div>
          <div class="wallets-head-actions"><button type="button" class="wallets-btn wallets-btn-primary" data-wallet-action="add">إضافة محفظة</button><button type="button" class="wallets-btn" data-wallet-action="refresh">تحديث</button></div>
        </header>
        <div class="wallets-kpis" aria-label="مؤشرات المحافظ">
          <article class="wallets-kpi wallets-kpi-sales"><span>إجمالي المبيعات</span><strong id="wallets-kpi-sales">0.00 ج.م</strong><small>عمليات بيع فقط</small></article>
          <article class="wallets-kpi wallets-kpi-profit"><span>أرباح المبيعات</span><strong id="wallets-kpi-profit">0.00 ج.م</strong><small>الإيراد ناقص التكلفة</small></article>
          <article class="wallets-kpi wallets-kpi-fees"><span>أرباح التحويلات</span><strong id="wallets-kpi-fees">0.00 ج.م</strong><small>رسوم السحب والتحويل</small></article>
        </div>
        <form id="wallets-filter-form" class="wallets-filter">
          <label>الفرع<select id="wallets-filter-branch" name="branch_id"></select></label>
          <label>المحفظة<select id="wallets-filter-wallet" name="wallet_id"><option value="">كل المحافظ</option></select></label>
          <label>من<input id="wallets-filter-from" name="from" type="date" value="${today()}"></label>
          <label>إلى<input id="wallets-filter-to" name="to" type="date" value="${today()}"></label>
          <label>نوع العملية<select id="wallets-filter-type" name="type"><option value="">الكل</option><option value="sale">بيع</option><option value="transfer_in">تحويل داخل</option><option value="transfer_out">تحويل خارج</option><option value="deposit">إيداع</option><option value="withdraw">سحب</option></select></label>
          <button type="submit" class="wallets-btn wallets-btn-primary">تصفية</button><button type="button" class="wallets-btn" data-wallet-action="clear-filter">مسح</button>
        </form>
        <div id="wallets-status" class="wallets-status" role="status"></div>
        <section><div class="wallets-section-title"><h3>المحافظ والحدود</h3><span>الأشرطة محسوبة للفترة المختارة</span></div><div id="wallets-grid" class="wallets-grid"></div></section>
        <section class="wallets-report-card"><div class="wallets-section-title"><h3>جدول السقف الائتماني</h3><span>استهلاك الإيداع والسحب</span></div><div class="wallets-table-wrap"><table><thead><tr><th>المحفظة</th><th>إيداع: مستهلك / سقف / باقي</th><th>سحب: مستهلك / سقف / باقي</th></tr></thead><tbody id="wallets-limit-body"></tbody></table></div></section>
        <section class="wallets-report-card"><div class="wallets-section-title"><div><h3>تقرير الحركات</h3><span>بيع · تحويل · إيداع · سحب</span></div><button type="button" class="wallets-btn" data-wallet-action="print-report">طباعة A4</button></div><div class="wallets-table-wrap"><table><thead><tr><th>التاريخ</th><th>المحفظة</th><th>النوع</th><th>المبلغ</th><th>الرسوم</th><th>المرجع</th></tr></thead><tbody id="wallets-transactions-body"></tbody></table></div></section>
        <div id="wallets-modal-root"></div>
      </section>`;
    host.dataset.walletsMounted = '1';
    state.mounted = true;
    bind();
    return true;
  }

  function setStatus(message, error = false) {
    const node = document.getElementById('wallets-status');
    if (node) { node.textContent = message || ''; node.classList.toggle('is-error', error); }
  }

  function printReport() {
    const page = document.querySelector('.wallets-page');
    const printWindow = root.open('', '_blank', 'noopener,noreferrer');
    if (!page || !printWindow) return toast('اسمح بفتح نافذة الطباعة ثم أعد المحاولة.', 'error');
    const from = document.getElementById('wallets-filter-from')?.value || '';
    const to = document.getElementById('wallets-filter-to')?.value || '';
    const storeName = document.getElementById('receipt-business-name')?.textContent || 'System POS';
    printWindow.document.write(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>تقرير المحافظ الإلكترونية</title><style>@page{size:A4;margin:12mm}body{font-family:Cairo,Arial,sans-serif;color:#111;margin:0}.wallets-page{width:100%}.wallets-page-head{border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:12px}.wallets-page-head h2{margin:0}.wallets-page-head p,.wallets-eyebrow,.wallets-head-actions,.wallets-filter,.wallets-grid,.wallets-limit-body,.wallets-btn{display:none!important}.wallets-kpis{display:flex;gap:18px;margin:10px 0}.wallets-kpi{border:1px solid #aaa;padding:8px;flex:1}.wallets-kpi span,.wallets-kpi small{display:block}.wallets-kpi strong{font-size:18px}.wallets-section-title{display:flex;justify-content:space-between;border-bottom:1px solid #111;padding:6px 0}.wallets-table-wrap{overflow:visible}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #aaa;padding:5px;text-align:right}th{background:#eee}.wallets-report-card:first-of-type{display:none}.wallets-report-card{margin-top:12px}</style></head><body><header style="border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:12px"><h1>${escapeHtml(storeName)}</h1><h2>تقرير المحافظ الإلكترونية</h2><p>الفترة: ${escapeHtml([from, to].filter(Boolean).join(' — ') || 'كل الفترات')}</p></header>${page.outerHTML}<footer style="margin-top:35px;display:flex;justify-content:space-between">التوقيع: __________ <span>تاريخ الطباعة: ${new Date().toLocaleString('ar-EG-u-nu-latn')}</span></footer><script>window.onload=()=>{window.print();window.onafterprint=()=>window.close()}</script></body></html>`);
    printWindow.document.close();
    console.log('[PRINT_A4] report=wallets');
  }

  function thresholdClass(percent) {
    if (percent >= 100) return 'is-full';
    if (percent >= 95) return 'is-critical';
    if (percent >= 80) return 'is-warning';
    return 'is-normal';
  }

  function progressMarkup(label, consumed, limit) {
    const ratio = Number(limit) > 0 ? Math.min(100, Number(consumed || 0) / Number(limit) * 100) : 0;
    return `<div class="wallets-progress-row"><div><span>${label}</span><b>${ratio.toFixed(2)}%</b></div><div class="wallets-progress ${thresholdClass(ratio)}"><i style="width:${ratio.toFixed(2)}%"></i></div></div>`;
  }

  function render() {
    const report = state.report || {};
    const kpis = report.kpis || {};
    const byWallet = new Map((report.limits || []).map(row => [Number(row.wallet_id), row]));
    const salesNode = document.getElementById('wallets-kpi-sales');
    const profitNode = document.getElementById('wallets-kpi-profit');
    const feesNode = document.getElementById('wallets-kpi-fees');
    if (salesNode) salesNode.textContent = money(kpis.sales);
    if (profitNode) profitNode.textContent = money(kpis.profit);
    if (feesNode) feesNode.textContent = money(kpis.transfer_profit ?? kpis.fees);
    const grid = document.getElementById('wallets-grid');
    if (grid) {
      grid.innerHTML = state.wallets.length ? state.wallets.map(wallet => {
        const limit = byWallet.get(Number(wallet.id)) || {};
        const depositPercent = Number(limit.deposit_limit) > 0 ? Number(limit.deposit_consumed || 0) / Number(limit.deposit_limit) * 100 : 0;
        const withdrawPercent = Number(limit.withdraw_limit) > 0 ? Number(limit.withdraw_consumed || 0) / Number(limit.withdraw_limit) * 100 : 0;
        const cardClass = thresholdClass(Math.max(depositPercent, withdrawPercent));
        return `<article class="wallet-card ${cardClass}" data-wallet-id="${wallet.id}">
          <header><div class="wallet-card-icon type-${escapeHtml(wallet.wallet_type)}">${wallet.wallet_type === 'vodafone' ? 'V' : wallet.wallet_type === 'instapay' ? 'I' : wallet.wallet_type === 'bank' ? 'B' : 'W'}</div><div><h4>${escapeHtml(wallet.name)}</h4><p>${escapeHtml(wallet.wallet_number)} · ${escapeHtml(walletTypes[wallet.wallet_type] || wallet.wallet_type)}</p></div><span class="wallet-card-status">${Number(wallet.is_active) === 1 ? 'نشطة' : 'غير نشطة'}</span></header>
          <div class="wallet-card-meta"><span>الرصيد</span><strong>${money(wallet.balance)}</strong><span>الفرع ${escapeHtml(wallet.branch_id)}</span></div>
          ${progressMarkup('سقف الإيداع', limit.deposit_consumed, limit.deposit_limit)}
          ${progressMarkup('سقف السحب', limit.withdraw_consumed, limit.withdraw_limit)}
          <footer><button type="button" data-wallet-action="deposit" data-wallet-id="${wallet.id}">إيداع</button><button type="button" data-wallet-action="withdraw" data-wallet-id="${wallet.id}">سحب</button><button type="button" data-wallet-action="transfer" data-wallet-id="${wallet.id}">تحويل</button>${state.canManage ? `<button type="button" class="wallet-danger" data-wallet-action="delete" data-wallet-id="${wallet.id}">تعطيل</button>` : ''}</footer>
        </article>`;
      }).join('') : '<div class="wallets-empty"><span>◌</span><strong>لا توجد محافظ نشطة</strong><small>أضف محفظة لبدء استقبال المدفوعات.</small></div>';
    }
    const limitBody = document.getElementById('wallets-limit-body');
    if (limitBody) limitBody.innerHTML = (report.limits || []).length ? report.limits.map(row => `<tr><td>${escapeHtml(row.wallet_name)}</td><td>${money(row.deposit_consumed)} / ${money(row.deposit_limit)} / ${money(row.deposit_remaining)}</td><td>${money(row.withdraw_consumed)} / ${money(row.withdraw_limit)} / ${money(row.withdraw_remaining)}</td></tr>`).join('') : '<tr><td colspan="3" class="wallets-empty-cell">لا توجد بيانات سقف للفترة.</td></tr>';
    const transactionBody = document.getElementById('wallets-transactions-body');
    if (transactionBody) transactionBody.innerHTML = (report.transactions || []).length ? report.transactions.map(row => {
      const [label, css] = movementLabels[row.type] || [row.type, 'other'];
      return `<tr><td dir="ltr">${escapeHtml(row.created_at)}</td><td>${escapeHtml(row.wallet_name)}<small>${escapeHtml(row.wallet_number)}</small></td><td><span class="wallet-type-badge ${css}">${label}</span></td><td>${money(row.amount)}</td><td>${money(row.fee)}</td><td dir="ltr">${escapeHtml(row.reference_id)}</td></tr>`;
    }).join('') : '<tr><td colspan="6" class="wallets-empty-cell">لا توجد حركات مطابقة.</td></tr>';
    if (root.lucide?.createIcons) root.lucide.createIcons();
  }

  async function loadBranches() {
    const data = await api('/api/branches');
    state.branches = Array.isArray(data.branches) ? data.branches : [];
    state.canManage = Boolean(data.can_manage);
    const branchSelect = document.getElementById('wallets-filter-branch');
    if (branchSelect && !branchSelect.dataset.ready) {
      branchSelect.innerHTML = branchOptions('', state.canManage);
      branchSelect.dataset.ready = '1';
    }
  }

  async function loadWallets() {
    const branch = document.getElementById('wallets-filter-branch')?.value || '';
    const query = branch && state.canManage ? `?branch_id=${encodeURIComponent(branch)}` : '';
    const data = await api(`/api/wallets${query}`);
    state.wallets = Array.isArray(data.wallets) ? data.wallets.filter(wallet => Number(wallet.is_active) === 1) : [];
    const walletSelect = document.getElementById('wallets-filter-wallet');
    if (walletSelect) {
      const current = walletSelect.value;
      walletSelect.innerHTML = walletOptions(current, true);
    }
  }

  async function loadReport() {
    const params = new URLSearchParams();
    const from = document.getElementById('wallets-filter-from')?.value || today();
    const to = document.getElementById('wallets-filter-to')?.value || from;
    const branch = document.getElementById('wallets-filter-branch')?.value || '';
    const wallet = document.getElementById('wallets-filter-wallet')?.value || '';
    const type = document.getElementById('wallets-filter-type')?.value || '';
    params.set('from', from); params.set('to', to);
    if (branch && state.canManage) params.set('branch_id', branch);
    if (wallet) params.set('wallet_id', wallet);
    if (type) params.set('type', type);
    state.report = await api(`/api/wallets/reports?${params}`);
    render();
  }

  async function load() {
    if (!mount()) return;
    try {
      setStatus('جاري تحميل بيانات المحافظ…');
      await loadBranches();
      await loadWallets();
      await loadReport();
      setStatus('تم تحديث بيانات المحافظ من الخادم.');
      console.log('[WALLETS_UI] loaded');
    } catch (error) {
      setStatus(error.message, true);
      toast(error.message, 'error');
      console.error('[WALLETS_UI_ERROR]', error);
    }
  }

  function closeModal() {
    const host = modalHost();
    if (host) host.innerHTML = '';
  }

  function openFormModal(mode, walletId = '') {
    if (!state.wallets.length) {
      api('/api/wallets').then(data => {
        state.wallets = Array.isArray(data.wallets) ? data.wallets.filter(wallet => Number(wallet.is_active) === 1) : [];
        openFormModal(mode, walletId);
      }).catch(error => toast(error.message, 'error'));
      return;
    }
    const host = modalHost();
    if (!host) return;
    const wallet = state.wallets.find(row => Number(row.id) === Number(walletId));
    const isAdd = mode === 'add';
    const isTransfer = mode === 'transfer';
    const title = isAdd ? 'إضافة محفظة' : mode === 'deposit' ? 'إيداع في محفظة' : mode === 'withdraw' ? 'سحب / مصروف من محفظة' : 'تحويل بين المحافظ';
    const form = isAdd
      ? `<label>اسم المحفظة<input name="name" required maxlength="120"></label><label>رقم المحفظة<input name="wallet_number" required maxlength="80"></label><label>النوع<select name="wallet_type"><option value="vodafone">Vodafone</option><option value="instapay">InstaPay</option><option value="bank">بنك</option><option value="other">أخرى</option></select></label><label>الفرع<select name="branch_id" required>${branchOptions(state.branches[0]?.id || '')}</select></label><label>سقف الإيداع<input name="deposit_limit" type="number" min="0" step="0.01" value="0" required></label><label>سقف السحب<input name="withdraw_limit" type="number" min="0" step="0.01" value="0" required></label><label>رسوم السحب %<input name="fee_percent" type="number" min="0" max="100" step="0.01" value="0" required></label>`
      : isTransfer
        ? `<label>من محفظة<select name="from_wallet_id" required>${walletOptions(walletId)}</select></label><label>إلى محفظة<select name="to_wallet_id" required>${walletOptions('')}</select></label><label>المبلغ<input name="amount" type="number" min="0.01" step="0.01" required></label><label class="wallet-field-wide">البيان<input name="notes" maxlength="300" placeholder="بيان التحويل"></label>`
        : `<label>المحفظة<select name="wallet_id" required>${walletOptions(walletId)}</select></label><label>المبلغ<input name="amount" type="number" min="0.01" step="0.01" required></label><label class="wallet-field-wide">البيان<input name="notes" maxlength="300" placeholder="بيان الحركة"></label>`;
    host.innerHTML = `<div class="wallet-modal-backdrop" data-wallet-modal-close="1"><section class="wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-modal-title"><header><div><span>WALLET ACTION</span><h3 id="wallet-modal-title">${title}</h3></div><button type="button" data-wallet-modal-close="1" aria-label="إغلاق">×</button></header><form id="wallet-modal-form" class="wallet-modal-form">${form}<div class="wallet-modal-actions"><button type="button" class="wallets-btn" data-wallet-modal-close="1">إلغاء</button><button type="submit" class="wallets-btn wallets-btn-primary">حفظ</button></div></form></section></div>`;
    host.querySelectorAll('[data-wallet-modal-close]').forEach(node => node.addEventListener('click', event => { if (event.target === node) closeModal(); }));
    host.querySelector('#wallet-modal-form').addEventListener('submit', async event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const idempotencyKey = `wallet-ui-${mode}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      try {
        if (isAdd) await api('/api/wallets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
        else if (isTransfer) await api(`/api/wallets/${values.from_wallet_id}/transfer`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ to_wallet_id: Number(values.to_wallet_id), amount: Number(values.amount), notes: values.notes, reference_id: idempotencyKey, idempotency_key: idempotencyKey }) });
        else await api(`/api/wallets/${values.wallet_id}/ ${mode}`.replace('/ ', '/'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ amount: Number(values.amount), notes: values.notes, reference_id: idempotencyKey, idempotency_key: idempotencyKey }) });
        closeModal();
        toast(isAdd ? 'تمت إضافة المحفظة.' : 'تم حفظ حركة المحفظة بنجاح.', 'success');
        await load();
      } catch (error) { toast(error.message, 'error'); }
    });
  }

  async function requestDelete(button, walletId) {
    if (button.dataset.confirm !== '1') {
      button.dataset.confirm = '1';
      button.textContent = 'تأكيد التعطيل';
      toast('اضغط «تأكيد التعطيل» مرة ثانية لتعطيل المحفظة.', 'warning');
      setTimeout(() => { if (button.isConnected) { delete button.dataset.confirm; button.textContent = 'تعطيل'; } }, 5000);
      return;
    }
    try {
      await api(`/api/wallets/${walletId}`, { method: 'DELETE' });
      toast('تم تعطيل المحفظة.', 'success');
      await load();
    } catch (error) { toast(error.message, 'error'); }
  }

  async function resolveAlert(alertId) {
    try {
      await api(`/api/wallets/alerts/${alertId}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      toast('تم تجاهل تنبيه المحفظة.', 'success');
      if (typeof root.refreshPhase1Notifications === 'function') await root.refreshPhase1Notifications();
    } catch (error) { toast(error.message, 'error'); }
  }

  function bind() {
    const host = document.getElementById('wallets-ui-root');
    if (!host || host.dataset.walletsBound === '1') return;
    host.dataset.walletsBound = '1';
    host.querySelector('#wallets-filter-form').addEventListener('submit', event => { event.preventDefault(); void loadReport(); });
    host.addEventListener('click', event => {
      const action = event.target.closest('[data-wallet-action]')?.dataset.walletAction;
      if (!action) return;
      const walletId = event.target.closest('[data-wallet-action]')?.dataset.walletId || '';
      if (action === 'add') return openFormModal('add');
      if (action === 'print-report') return printReport();
      if (action === 'refresh') return void load();
      if (action === 'clear-filter') { host.querySelector('#wallets-filter-branch').value = ''; host.querySelector('#wallets-filter-wallet').value = ''; host.querySelector('#wallets-filter-type').value = ''; host.querySelector('#wallets-filter-from').value = today(); host.querySelector('#wallets-filter-to').value = today(); return void load(); }
      if (action === 'deposit' || action === 'withdraw' || action === 'transfer') return openFormModal(action, walletId);
      if (action === 'delete') return void requestDelete(event.target.closest('[data-wallet-action]'), walletId);
    });
    host.querySelector('#wallets-filter-branch').addEventListener('change', () => void load());
  }

  function openPosWalletModal() {
    const host = document.getElementById('wallets-pos-modal-root') || (() => { const node = document.createElement('div'); node.id = 'wallets-pos-modal-root'; document.body.appendChild(node); return node; })();
    host.innerHTML = `<div class="wallet-modal-backdrop" data-pos-wallet-close="1"><section class="wallet-modal wallets-pos-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-pos-title"><header><div><span>POS PAYMENT</span><h3 id="wallet-pos-title">اختيار المحفظة الإلكترونية</h3><p class="wallet-pos-hint">سيتم إنشاء فاتورة معلقة حتى يصل تحويل SMS</p></div><button type="button" data-pos-wallet-close="1" aria-label="إغلاق">×</button></header><div class="wallet-pos-options">${state.posWallets?.length ? state.posWallets.filter(wallet => Number(wallet.is_active) === 1).map(wallet => `<button type="button" class="wallet-pos-option" data-pos-wallet-id="${wallet.id}"><strong>${escapeHtml(wallet.name)}</strong><span>${escapeHtml(wallet.wallet_number)}</span><small>الرصيد: ${Number(wallet.balance || 0).toFixed(2)} ج.م</small></button>`).join('') : '<div class="wallets-empty"><span>◌</span><strong>لا توجد محافظ نشطة لهذا الفرع</strong></div>'}</div><div class="wallet-modal-actions"><button type="button" class="wallets-btn" data-pos-wallet-close="1">إلغاء</button></div></section></div>`;
    host.querySelectorAll('[data-pos-wallet-close]').forEach(node => node.addEventListener('click', event => { if (event.target === node) host.innerHTML = ''; }));
    host.querySelectorAll('[data-pos-wallet-id]').forEach(node => node.addEventListener('click', () => {
      const wallet = state.posWallets.find(row => Number(row.id) === Number(node.dataset.posWalletId));
      if (!wallet || Number(wallet.is_active) !== 1) return toast('المحفظة غير متاحة حالياً.', 'error');
      root.__posSelectedWalletId = wallet.id;
      root.__posSelectedWalletSnapshot = { wallet_id: wallet.id, name: wallet.name, wallet_number: wallet.wallet_number, wallet_type: wallet.wallet_type, fee: 0 };
      root.__posWalletAwaitSms = true;
      root.setPosPayment?.('محفظة إلكترونية', document.querySelector('[data-pos-wallet-payment]'));
      host.innerHTML = '';
      toast(`تم اختيار ${wallet.name} - ${wallet.wallet_number}.`, 'success');
    }));
  }

  async function loadPosWallets() {
    try {
      const data = await api('/api/wallets');
      state.posWallets = Array.isArray(data.wallets) ? data.wallets.filter(wallet => Number(wallet.is_active) === 1) : [];
      openPosWalletModal();
    } catch (error) { toast(error.message, 'error'); }
  }

  root.printWalletReport = printReport;
  root.WalletsUI = { load, openFormModal, openMovementModal: openFormModal, openPosWalletModal: loadPosWallets, resolveAlert, loadPosWallets, printReport };
})(window);
