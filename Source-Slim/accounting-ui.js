'use strict';

(function accountingUi(root) {
  const money = value => `${Number(value || 0).toFixed(2)} ج.م`;
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  const toast = (message, tone = 'info') => typeof root.showAppToast === 'function' ? root.showAppToast(message, { tone }) : console.log(`[ACCOUNTING_UI_TOAST] ${message}`);
  let accounts = [];
  let originalSwitchTab = null;

  function sectionMarkup() {
    return `<section id="accounting-workspace" class="accounting-workspace hidden" dir="rtl" aria-labelledby="accounting-workspace-title">
      <header class="accounting-page-header">
        <div><span class="accounting-eyebrow">PHASE 2 · ACCOUNTING CORE</span><h1 id="accounting-workspace-title">المركز المحاسبي</h1><p>دفتر اليومية والأستاذ والتقارير مبنية من journal_lines فقط.</p></div>
        <div class="accounting-health" id="accounting-health-status">جاري فحص الجداول…</div>
      </header>
      <nav class="accounting-tabs" aria-label="شاشات المحاسبة">
        <button type="button" data-accounting-view="accounts">دليل الحسابات</button>
        <button type="button" data-accounting-view="journal">دفتر اليومية</button>
        <button type="button" data-accounting-view="ledger">دفتر الأستاذ</button>
        <button type="button" data-accounting-view="trial">ميزان المراجعة</button>
        <button type="button" data-accounting-view="income">قائمة الدخل</button>
        <button type="button" data-accounting-view="balance">الميزانية</button>
        <button type="button" data-accounting-view="party">كشف طرف</button>
        <button type="button" data-accounting-view="cash">الخزائن والبنوك</button>
        <button type="button" data-accounting-view="wallets">المحافظ الإلكترونية</button>
      </nav>
      <div class="accounting-view" data-accounting-panel="accounts">
        <div class="accounting-grid-two">
          <article class="accounting-card"><div class="accounting-card-title"><h2>شجرة الحسابات</h2><button type="button" data-accounting-refresh="accounts">تحديث</button></div><div id="accounting-account-tree" class="accounting-tree"></div></article>
          <article class="accounting-card"><div class="accounting-card-title"><h2>إضافة حساب</h2></div><form id="accounting-account-form" class="accounting-form">
            <label>الكود<input name="code" required pattern="[0-9]{3,10}" placeholder="مثال 5500"></label>
            <label>اسم الحساب<input name="name_ar" required placeholder="اسم عربي"></label>
            <label>الاسم الإنجليزي<input name="name_en" placeholder="Account name"></label>
            <label>النوع<select name="type" required><option value="asset">أصل</option><option value="liability">التزام</option><option value="equity">حقوق ملكية</option><option value="revenue">إيراد</option><option value="expense">مصروف</option></select></label>
            <label>الحساب الأب<input name="parent_code" placeholder="اختياري"></label>
            <label class="accounting-check"><input name="is_postable" type="checkbox" checked> حساب قابل للترحيل</label>
            <button class="accounting-primary" type="submit">حفظ الحساب</button><p id="accounting-account-status" class="accounting-status" role="status"></p>
          </form></article>
        </div>
      </div>
      <div class="accounting-view hidden" data-accounting-panel="journal">
        <article class="accounting-card"><div class="accounting-card-title"><h2>دفتر اليومية العام</h2><button type="button" data-accounting-refresh="journal">تحديث</button></div>
          <form id="accounting-journal-filter" class="accounting-filter"><input name="from" type="date"><input name="to" type="date"><input name="q" placeholder="بحث بالقيد أو المرجع"><button class="accounting-primary">تصفية</button></form>
          <div id="accounting-journal-list" class="accounting-journal-list"></div>
        </article>
        <article class="accounting-card"><div class="accounting-card-title"><h2>قيد يدوي</h2><span class="accounting-muted">يُحفظ فقط إذا تساوى المدين والدائن</span></div>
          <form id="accounting-manual-form" class="accounting-form"><label>التاريخ<input name="entry_date" type="date" required></label><label>البيان<input name="description" required placeholder="بيان القيد"></label><label>مرجع اختياري<input name="reference_id" placeholder="MANUAL-…"></label><div id="accounting-manual-lines" class="accounting-manual-lines"></div><div class="accounting-form-actions"><button type="button" id="accounting-add-line">إضافة سطر</button><button class="accounting-primary">ترحيل القيد</button></div><p id="accounting-manual-status" class="accounting-status" role="status"></p></form>
        </article>
      </div>
      <div class="accounting-view hidden" data-accounting-panel="ledger"><article class="accounting-card"><div class="accounting-card-title"><h2>دفتر الأستاذ</h2><button type="button" data-accounting-refresh="ledger">تحديث</button></div><form id="accounting-ledger-filter" class="accounting-filter"><select name="account_code" id="accounting-ledger-account"></select><input name="from" type="date"><input name="to" type="date"><button class="accounting-primary">عرض</button></form><div id="accounting-ledger-summary" class="accounting-summary-strip"></div><div class="accounting-table-wrap"><table><thead><tr><th>التاريخ</th><th>القيد</th><th>المرجع</th><th>مدين</th><th>دائن</th><th>الرصيد</th></tr></thead><tbody id="accounting-ledger-body"></tbody></table></div></article></div>
      <div class="accounting-view hidden" data-accounting-panel="trial"><article class="accounting-card"><div class="accounting-card-title"><h2>ميزان المراجعة</h2><span><button type="button" data-accounting-refresh="trial">تحديث</button><button type="button" data-accounting-print="trial">طباعة A4</button></span></div><form id="accounting-trial-filter" class="accounting-filter"><input name="from" type="date"><input name="to" type="date"><button class="accounting-primary">عرض</button></form><div id="accounting-trial-summary" class="accounting-summary-strip"></div><div class="accounting-table-wrap"><table><thead><tr><th>الكود</th><th>الحساب</th><th>مدين</th><th>دائن</th><th>الرصيد</th></tr></thead><tbody id="accounting-trial-body"></tbody></table></div></article></div>
      <div class="accounting-view hidden" data-accounting-panel="income"><article class="accounting-card"><div class="accounting-card-title"><h2>قائمة الدخل</h2><span><button type="button" data-accounting-refresh="income">تحديث</button><button type="button" data-accounting-print="income">طباعة A4</button></span></div><form id="accounting-income-filter" class="accounting-filter"><input name="from" type="date"><input name="to" type="date"><button class="accounting-primary">عرض</button></form><div id="accounting-income-summary" class="accounting-report-hero"></div><div class="accounting-table-wrap"><table><thead><tr><th>الكود</th><th>الحساب</th><th>النوع</th><th>القيمة</th></tr></thead><tbody id="accounting-income-body"></tbody></table></div></article></div>
      <div class="accounting-view hidden" data-accounting-panel="balance"><article class="accounting-card"><div class="accounting-card-title"><h2>الميزانية العمومية</h2><span><button type="button" data-accounting-refresh="balance">تحديث</button><button type="button" data-accounting-print="balance">طباعة A4</button></span></div><form id="accounting-balance-filter" class="accounting-filter"><input name="to" type="date"><button class="accounting-primary">عرض</button></form><div id="accounting-balance-summary" class="accounting-report-hero"></div><div class="accounting-table-wrap"><table><thead><tr><th>الكود</th><th>الحساب</th><th>النوع</th><th>الرصيد</th></tr></thead><tbody id="accounting-balance-body"></tbody></table></div></article></div>
      <div class="accounting-view hidden" data-accounting-panel="party"><article class="accounting-card"><div class="accounting-card-title"><h2>كشف حساب عميل أو مورد</h2><button type="button" data-accounting-refresh="party">تحديث</button></div><form id="accounting-party-filter" class="accounting-filter"><select name="party_type"><option value="customer">عميل</option><option value="supplier">مورد</option></select><input name="party_id" type="number" min="1" required placeholder="المعرّف"><input name="from" type="date"><input name="to" type="date"><button class="accounting-primary">عرض</button></form><div id="accounting-party-summary" class="accounting-summary-strip"></div><div class="accounting-table-wrap"><table><thead><tr><th>التاريخ</th><th>القيد</th><th>المرجع</th><th>مدين</th><th>دائن</th></tr></thead><tbody id="accounting-party-body"></tbody></table></div></article></div>
      <div class="accounting-view hidden" data-accounting-panel="cash"><article class="accounting-card"><div class="accounting-card-title"><h2>الخزائن والبنوك</h2><button type="button" data-accounting-refresh="cash">تحديث</button></div><div id="accounting-cash-balances" class="accounting-cash-grid"></div><form id="accounting-cash-form" class="accounting-form accounting-cash-form"><label>نوع الحركة<select name="type"><option value="deposit">إيداع</option><option value="withdrawal">سحب/مصروف</option><option value="transfer">تحويل بين الحسابات</option></select></label><label>المبلغ<input name="amount" type="number" min="0.01" step="0.01" required></label><label>البيان<input name="description" required></label><label>من حساب<input name="from_account_code" value="1110"></label><label>إلى حساب<input name="to_account_code" value="1120"></label><button class="accounting-primary">حفظ الحركة</button><p id="accounting-cash-status" class="accounting-status" role="status"></p></form></article></div>
       <div class="accounting-view hidden" data-accounting-panel="wallets"><div id="wallets-ui-root"></div></div>
    </section>`;
  }

  async function api(url, options) {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const data = await response.json().catch(() => ({}));
    console.log(`[ACCOUNTING_UI] ${options?.method || 'GET'} ${url}`, data);
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function setStatus(id, message, error = false) {
    const node = document.getElementById(id);
    if (node) { node.textContent = message || ''; node.classList.toggle('is-error', error); }
  }

  function renderTree(nodes) {
    return nodes.map(node => `<details class="accounting-tree-node" ${node.level <= 1 ? 'open' : ''}><summary><span class="accounting-code">${escapeHtml(node.code)}</span><strong>${escapeHtml(node.name_ar)}</strong><small>${node.is_postable ? 'قابل للترحيل' : 'تجميعي'}</small></summary>${node.children?.length ? `<div class="accounting-tree-children">${renderTree(node.children)}</div>` : ''}</details>`).join('');
  }

  async function loadAccounts() {
    const data = await api('/api/accounting/accounts');
    accounts = data.rows || [];
    document.getElementById('accounting-account-tree').innerHTML = renderTree(data.tree || []);
    const options = accounts.filter(row => row.is_postable && row.is_active).map(row => `<option value="${escapeHtml(row.code)}">${escapeHtml(row.code)} — ${escapeHtml(row.name_ar)}</option>`).join('');
    document.getElementById('accounting-ledger-account').innerHTML = `<option value="">اختر الحساب</option>${options}`;
    renderManualLines();
  }

  function accountOptions() {
    return `<option value="">الحساب</option>${accounts.filter(row => row.is_postable && row.is_active).map(row => `<option value="${escapeHtml(row.code)}">${escapeHtml(row.code)} — ${escapeHtml(row.name_ar)}</option>`).join('')}`;
  }

  function renderManualLines() {
    const host = document.getElementById('accounting-manual-lines');
    if (!host) return;
    if (!host.children.length) host.innerHTML = [0, 1].map(() => manualLineMarkup()).join('');
    host.querySelectorAll('select[name="account_code"]').forEach(select => { const value = select.value; select.innerHTML = accountOptions(); select.value = value; });
  }

  function manualLineMarkup() {
    return `<div class="accounting-manual-line"><select name="account_code" required>${accountOptions()}</select><input name="debit" type="number" min="0" step="0.01" placeholder="مدين"><input name="credit" type="number" min="0" step="0.01" placeholder="دائن"><input name="description" placeholder="البيان"><button type="button" data-remove-account-line aria-label="حذف السطر">×</button></div>`;
  }

  function formQuery(id) {
    const form = document.getElementById(id);
    return new URLSearchParams(new FormData(form)).toString();
  }

  async function loadJournal() {
    const data = await api(`/api/accounting/journal?${formQuery('accounting-journal-filter')}`);
    const host = document.getElementById('accounting-journal-list');
    host.innerHTML = data.entries?.length ? data.entries.map(entry => `<article class="accounting-entry"><header><strong>${escapeHtml(entry.entry_number)}</strong><span>${escapeHtml(entry.entry_date)} · ${escapeHtml(entry.reference_type)}:${escapeHtml(entry.reference_id)}</span><b>${money(entry.total_debit)}</b></header><p>${escapeHtml(entry.description)}</p><div class="accounting-table-wrap"><table><thead><tr><th>الحساب</th><th>مدين</th><th>دائن</th><th>البيان</th></tr></thead><tbody>${entry.lines.map(line => `<tr><td>${escapeHtml(line.account_code)} — ${escapeHtml(line.account_name)}</td><td>${money(line.debit)}</td><td>${money(line.credit)}</td><td>${escapeHtml(line.description)}</td></tr>`).join('')}</tbody></table></div></article>`).join('') : '<div class="accounting-empty">لا توجد قيود مطابقة.</div>';
  }

  async function loadLedger() {
    const query = formQuery('accounting-ledger-filter');
    if (!new URLSearchParams(query).get('account_code')) return setStatus('accounting-ledger-summary', 'اختر حساباً أولاً.', true);
    const data = await api(`/api/accounting/ledger?${query}`);
    document.getElementById('accounting-ledger-summary').innerHTML = `<span>الرصيد الافتتاحي: <b>${money(data.opening_balance)}</b></span><span>الرصيد الختامي: <b>${money(data.closing_balance)}</b></span>`;
    document.getElementById('accounting-ledger-body').innerHTML = data.rows?.length ? data.rows.map(row => `<tr><td>${escapeHtml(row.entry_date)}</td><td>${escapeHtml(row.entry_number)}</td><td>${escapeHtml(row.reference_id)}</td><td>${money(row.debit)}</td><td>${money(row.credit)}</td><td>${money(row.running_balance)}</td></tr>`).join('') : '<tr><td colspan="6" class="accounting-empty">لا توجد حركات.</td></tr>';
  }

  async function loadTrial() {
    const data = await api(`/api/accounting/trial-balance?${formQuery('accounting-trial-filter')}`);
    document.getElementById('accounting-trial-summary').innerHTML = `<span>إجمالي المدين: <b>${money(data.total_debit)}</b></span><span>إجمالي الدائن: <b>${money(data.total_credit)}</b></span><strong class="${data.balanced ? 'is-ok' : 'is-error'}">${data.balanced ? 'متوازن' : 'غير متوازن'}</strong>`;
    document.getElementById('accounting-trial-body').innerHTML = data.rows.map(row => `<tr><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.name_ar)}</td><td>${money(row.debit)}</td><td>${money(row.credit)}</td><td>${money(row.balance)}</td></tr>`).join('');
  }

  async function loadIncome() {
    const data = await api(`/api/accounting/income-statement?${formQuery('accounting-income-filter')}`);
    document.getElementById('accounting-income-summary').innerHTML = `<span>الإيرادات <b>${money(data.revenue)}</b></span><span>المصروفات <b>${money(data.expenses)}</b></span><strong>صافي الدخل: ${money(data.net_income)}</strong>`;
    document.getElementById('accounting-income-body').innerHTML = data.rows.map(row => `<tr><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.name_ar)}</td><td>${row.type === 'revenue' ? 'إيراد' : 'مصروف'}</td><td>${money(row.balance)}</td></tr>`).join('');
  }

  async function loadBalance() {
    const data = await api(`/api/accounting/balance-sheet?${formQuery('accounting-balance-filter')}`);
    document.getElementById('accounting-balance-summary').innerHTML = `<span>الأصول <b>${money(data.assets)}</b></span><span>الالتزامات + حقوق الملكية <b>${money(data.liabilities_plus_equity)}</b></span><strong class="${data.balanced ? 'is-ok' : 'is-error'}">${data.balanced ? 'المعادلة متوازنة' : 'المعادلة غير متوازنة'}</strong>`;
    document.getElementById('accounting-balance-body').innerHTML = data.rows.filter(row => ['asset','liability','equity'].includes(row.type)).map(row => `<tr><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.name_ar)}</td><td>${escapeHtml(row.type)}</td><td>${money(row.balance)}</td></tr>`).join('');
  }

  async function loadParty() {
    const params = new URLSearchParams(formQuery('accounting-party-filter'));
    if (!params.get('party_id')) return;
    const data = await api(`/api/accounting/party-ledger?${params}`);
    document.getElementById('accounting-party-summary').innerHTML = `<span>مدين: <b>${money(data.total_debit)}</b></span><span>دائن: <b>${money(data.total_credit)}</b></span><strong>الرصيد: ${money(data.balance)}</strong>`;
    document.getElementById('accounting-party-body').innerHTML = data.rows?.length ? data.rows.map(row => `<tr><td>${escapeHtml(row.entry_date)}</td><td>${escapeHtml(row.entry_number)}</td><td>${escapeHtml(row.reference_id)}</td><td>${money(row.debit)}</td><td>${money(row.credit)}</td></tr>`).join('') : '<tr><td colspan="5" class="accounting-empty">لا توجد حركات للطرف.</td></tr>';
  }

  async function loadCash() {
    const data = await api('/api/accounting/cash-banks');
    document.getElementById('accounting-cash-balances').innerHTML = data.rows.map(row => `<div><span>${escapeHtml(row.code)} — ${escapeHtml(row.name_ar)}</span><strong>${money(row.balance)}</strong></div>`).join('');
  }

  async function loadHealth() {
    const data = await api('/api/accounting/health');
    const node = document.getElementById('accounting-health-status');
    node.textContent = data.ok ? `SQL v${data.user_version} · ${data.posted_entries} قيد مرحّل` : 'تحتاج قاعدة المحاسبة إلى تهيئة';
    node.classList.toggle('is-ok', data.ok);
  }

  function printAccountingView(view) {
    const panel = document.querySelector(`[data-accounting-panel="${view}"]`);
    if (!panel) return toast('افتح التقرير أولاً قبل الطباعة.', 'error');
    const title = panel.querySelector('h2')?.textContent || 'تقرير محاسبي';
    const form = panel.querySelector('form');
    const period = form ? [...form.querySelectorAll('input[type="date"]')].map(input => input.value).filter(Boolean).join(' — ') : '';
    const storeName = document.getElementById('receipt-business-name')?.textContent || 'System POS';
    const printWindow = root.open('', '_blank', 'noopener,noreferrer');
    if (!printWindow) return toast('اسمح بفتح نافذة الطباعة ثم أعد المحاولة.', 'error');
    printWindow.document.write(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>@page{size:A4;margin:12mm}body{font-family:Cairo,Arial,sans-serif;color:#111;margin:0}header{border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:14px}h1{font-size:20px;margin:0 0 5px}p{margin:2px 0;color:#555;font-size:12px}.no-print,form,button{display:none!important}.accounting-card-title{display:none}.accounting-summary-strip,.accounting-report-hero{display:flex;gap:25px;padding:10px 0;font-weight:bold}.accounting-table-wrap{overflow:visible}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #aaa;padding:6px;text-align:right}th{background:#eee}.signature{margin-top:38px;display:flex;justify-content:space-between}</style></head><body><header><h1>${escapeHtml(storeName)}</h1><h2>${escapeHtml(title)}</h2><p>الفترة: ${escapeHtml(period || 'كل الفترات')}</p><p>تاريخ الطباعة: ${escapeHtml(new Date().toLocaleString('ar-EG-u-nu-latn'))}</p></header><main>${panel.innerHTML}</main><div class="signature"><span>إعداد التقرير: __________</span><span>التوقيع: __________</span></div><script>window.onload=()=>{window.print();window.onafterprint=()=>window.close()}</script></body></html>`);
    printWindow.document.close();
    console.log(`[PRINT_A4] report=${view} title=${title}`);
  }

  async function loadView(view) {
    try {
      if (view === 'accounts') await loadAccounts();
      if (view === 'journal') await loadJournal();
      if (view === 'ledger') await loadLedger();
      if (view === 'trial') await loadTrial();
      if (view === 'income') await loadIncome();
      if (view === 'balance') await loadBalance();
      if (view === 'party') await loadParty();
       if (view === 'cash') await loadCash();
       if (view === 'wallets') await root.WalletsUI?.load();
      console.log(`[ACCOUNTING_UI] screen=${view} loaded`);
    } catch (error) { console.error(`[ACCOUNTING_UI_ERROR] screen=${view}`, error); toast(error.message, 'error'); }
  }

  function selectView(view) {
    document.querySelectorAll('[data-accounting-view]').forEach(button => button.classList.toggle('active', button.dataset.accountingView === view));
    document.querySelectorAll('[data-accounting-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.accountingPanel !== view));
    void loadView(view);
  }

  function open(view = 'accounts') {
    if (typeof originalSwitchTab === 'function') originalSwitchTab('reports');
    document.querySelectorAll('.tab-content').forEach(panel => panel.classList.add('hidden'));
    const section = document.getElementById('accounting-workspace');
    if (!section) return;
    section.classList.remove('hidden');
    document.body.classList.add('accounting-screen-active');
    selectView(view);
    void loadHealth();
  }

  function bind() {
    const main = document.querySelector('#app-shell main');
    if (!main || document.getElementById('accounting-workspace')) return;
    main.insertAdjacentHTML('beforeend', sectionMarkup());
    document.querySelectorAll('[data-accounting-view]').forEach(button => button.addEventListener('click', () => selectView(button.dataset.accountingView)));
    document.querySelectorAll('[data-accounting-refresh]').forEach(button => button.addEventListener('click', () => void loadView(button.dataset.accountingRefresh)));
    document.querySelectorAll('[data-accounting-print]').forEach(button => button.addEventListener('click', () => printAccountingView(button.dataset.accountingPrint)));
    document.getElementById('accounting-account-form').addEventListener('submit', async event => { event.preventDefault(); try { const body = Object.fromEntries(new FormData(event.currentTarget)); body.is_postable = event.currentTarget.is_postable.checked; await api('/api/accounting/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); setStatus('accounting-account-status', 'تم حفظ الحساب.'); event.currentTarget.reset(); await loadAccounts(); } catch (error) { setStatus('accounting-account-status', error.message, true); } });
    document.getElementById('accounting-add-line').addEventListener('click', () => document.getElementById('accounting-manual-lines').insertAdjacentHTML('beforeend', manualLineMarkup()));
    document.getElementById('accounting-manual-lines').addEventListener('click', event => { if (event.target.matches('[data-remove-account-line]') && event.currentTarget.children.length > 2) event.target.closest('.accounting-manual-line').remove(); });
    document.getElementById('accounting-manual-form').addEventListener('submit', async event => { event.preventDefault(); try { const body = Object.fromEntries(new FormData(event.currentTarget)); body.lines = [...event.currentTarget.querySelectorAll('.accounting-manual-line')].map(line => Object.fromEntries(new FormData(line))); await api('/api/accounting/journal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); setStatus('accounting-manual-status', 'تم ترحيل القيد بنجاح.'); await loadJournal(); } catch (error) { setStatus('accounting-manual-status', error.message, true); } });
    for (const [formId, loader] of [['accounting-journal-filter', loadJournal], ['accounting-ledger-filter', loadLedger], ['accounting-trial-filter', loadTrial], ['accounting-income-filter', loadIncome], ['accounting-balance-filter', loadBalance], ['accounting-party-filter', loadParty]]) document.getElementById(formId).addEventListener('submit', event => { event.preventDefault(); void loader(); });
    document.getElementById('accounting-cash-form').addEventListener('submit', async event => { event.preventDefault(); try { const body = Object.fromEntries(new FormData(event.currentTarget)); await api('/api/accounting/cash-transactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); setStatus('accounting-cash-status', 'تم حفظ الحركة وترحيلها.'); await loadCash(); } catch (error) { setStatus('accounting-cash-status', error.message, true); } });
    originalSwitchTab = root.switchTab;
    if (typeof originalSwitchTab === 'function') root.switchTab = function wrappedSwitchTab(tabId) { document.getElementById('accounting-workspace')?.classList.add('hidden'); document.body.classList.remove('accounting-screen-active'); return originalSwitchTab.apply(this, arguments); };
    root.openAccountingWorkspace = open;
    root.printAccountingView = printAccountingView;
    root.AccountingUI = { open, selectView, loadView, printAccountingView };
    console.log('[ACCOUNTING_UI] initialized');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, { once: true }); else bind();
})(window);
