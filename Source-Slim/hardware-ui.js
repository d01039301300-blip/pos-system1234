(function () {
  'use strict';

  const state = { profiles: [], step: 0, wizard: false };
  const steps = [
    { title: 'الطابعات', text: 'تم تجهيز طابعات الفاتورة والتقارير وA4 بوضع Mock. يمكنك اختبار الطباعة الآن.', icon: 'fa-print' },
    { title: 'الدرج النقدي', text: 'سيتم استخدام نبضة ESC/POS عند توفر Native، وإلا سيُسجّل الاختبار في Mock Output.', icon: 'fa-cash-register' },
    { title: 'الميزان والماسح', text: 'اضبط الوزن التجريبي من شاشة الهاردوير، والماسح يعمل عبر إدخال الباركود في POS.', icon: 'fa-scale-balanced' },
    { title: 'الملخص', text: 'اكتمل الإعداد. يمكنك إعادة تشغيل المعالج من تبويب الهاردوير في أي وقت.', icon: 'fa-check-circle' }
  ];

  function toast(message, tone = 'success') {
    if (typeof window.showAppToast === 'function') window.showAppToast(message, { tone });
    else console.log(`[HARDWARE_UI] ${message}`);
  }

  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function labelType(type) {
    return ({ printer_invoice: 'طابعة فاتورة', printer_report: 'طابعة تقارير', printer_a4: 'طابعة A4', cash_drawer: 'درج نقدي', scale: 'ميزان', scanner: 'ماسح' })[type] || type;
  }

  function setBanner(mockMode) {
    const banner = document.getElementById('hardware-mock-banner');
    if (!banner) return;
    banner.classList.toggle('is-native', !mockMode);
    const span = banner.querySelector('span');
    if (span) span.textContent = mockMode ? 'Mock Mode Active — لا توجد أجهزة Native متصلة.' : 'Native Mode — سيتم استخدام ملفات الأجهزة النشطة.';
  }

  function renderProfiles() {
    const body = document.getElementById('hardware-profiles-body');
    if (!body) return;
    body.replaceChildren();
    if (!state.profiles.length) {
      const row = document.createElement('tr');
      row.innerHTML = '<td colspan="5" class="hardware-empty">لا توجد ملفات أجهزة. افتح Setup Wizard للبدء.</td>';
      body.appendChild(row);
      return;
    }
    state.profiles.forEach(profile => {
      const row = document.createElement('tr');
      row.innerHTML = `<td>${labelType(profile.profile_type)}</td><td>${escapeHtml(profile.name || '')}</td><td>${escapeHtml(profile.connection_type || '')}</td><td><span class="hardware-status ${profile.is_active ? 'active' : 'inactive'}">${profile.is_active ? 'نشط' : 'معطل'}${profile.is_mock ? ' · Mock' : ''}</span></td><td><div class="hardware-row-actions"><button type="button" data-hardware-test="${profile.id}">اختبار</button>${profile.is_active ? `<button type="button" data-hardware-disable="${profile.id}">تعطيل</button>` : ''}</div></td>`;
      body.appendChild(row);
    });
    body.querySelectorAll('[data-hardware-test]').forEach(button => button.addEventListener('click', async () => {
      try { const result = await request(`/api/hardware/profiles/${button.dataset.hardwareTest}/test`, { method: 'POST', body: '{}' }); toast(result.message || 'نجح اختبار الجهاز.'); }
      catch (error) { toast(error.message, 'error'); }
    }));
    body.querySelectorAll('[data-hardware-disable]').forEach(button => button.addEventListener('click', async () => {
      try { await request(`/api/hardware/profiles/${button.dataset.hardwareDisable}`, { method: 'DELETE' }); toast('تم تعطيل ملف الجهاز.'); await load(); }
      catch (error) { toast(error.message, 'error'); }
    }));
  }

  function escapeHtml(value) { const div = document.createElement('div'); div.textContent = String(value ?? ''); return div.innerHTML; }

  async function load() {
    try {
      const data = await request('/api/hardware/profiles');
      state.profiles = data.profiles || [];
      setBanner(Boolean(data.mock_mode));
      const mode = document.getElementById('hardware-mode-select');
      if (mode) mode.value = data.mock_mode ? 'mock' : 'auto';
      renderProfiles();
      if (!state.profiles.length && !localStorage.getItem('hardware_wizard_dismissed')) openWizard();
      console.log(`[HARDWARE_UI] profiles=${state.profiles.length} mock_mode=${Boolean(data.mock_mode)}`);
      return data;
    } catch (error) { toast(error.message, 'error'); throw error; }
  }

  async function saveMode() {
    try { const mode = document.getElementById('hardware-mode-select')?.value || 'mock'; await request('/api/hardware/settings', { method: 'POST', body: JSON.stringify({ hardware_mode: mode }) }); toast(`تم حفظ وضع الأجهزة: ${mode}`); await load(); }
    catch (error) { toast(error.message, 'error'); }
  }

  function toggleMode() { const select = document.getElementById('hardware-mode-select'); if (select) { select.value = select.value === 'mock' ? 'auto' : 'mock'; select.focus(); } }

  async function setMockWeight() {
    const weight = Number(document.getElementById('hardware-mock-weight')?.value);
    const unit = document.getElementById('hardware-mock-unit')?.value || 'kg';
    try { const result = await request('/api/hardware/scale/mock', { method: 'POST', body: JSON.stringify({ weight, unit, stable: true }) }); document.getElementById('hardware-mock-weight-status').textContent = `تم ضبط القراءة: ${result.weight.toFixed(3)} ${result.unit}`; toast('تم ضبط قراءة الميزان التجريبي.'); }
    catch (error) { toast(error.message, 'error'); }
  }

  async function testPrinter() { try { const result = await request('/api/hardware/print/test', { method: 'POST', body: '{}' }); toast(`تم اختبار الطابعة Mock: ${result.path}`); } catch (error) { toast(error.message, 'error'); } }
  async function testDrawer() { try { const result = await request('/api/hardware/drawer/test', { method: 'POST', body: '{}' }); toast(`تم اختبار الدرج Mock: ${result.path}`); } catch (error) { toast(error.message, 'error'); } }

  async function diagnose() {
    const output = document.getElementById('hardware-diagnostics-output');
    try { const result = await request('/api/hardware/diagnose'); if (output) { output.hidden = false; output.textContent = JSON.stringify(result, null, 2); } console.log('[HARDWARE_UI] diagnostics', result); toast('اكتمل تشخيص الهاردوير.'); }
    catch (error) { toast(error.message, 'error'); }
  }

  function renderWizard() {
    const body = document.getElementById('hardware-wizard-body');
    const progress = document.getElementById('hardware-wizard-progress');
    const step = steps[state.step];
    if (progress) progress.innerHTML = steps.map((item, index) => `<span class="${index <= state.step ? 'active' : ''}">${index + 1}</span>`).join('');
    if (body) body.innerHTML = `<div class="hardware-wizard-icon"><i class="fa-solid ${step.icon}"></i></div><h3>${step.title}</h3><p>${step.text}</p>`;
  }
  function openWizard() { state.wizard = true; state.step = 0; document.getElementById('modal-hardware-setup')?.classList.remove('hidden'); renderWizard(); }
  function closeWizard() { state.wizard = false; localStorage.setItem('hardware_wizard_dismissed', '1'); document.getElementById('modal-hardware-setup')?.classList.add('hidden'); }
  function nextWizardStep() { if (state.step >= steps.length - 1) return closeWizard(); state.step += 1; renderWizard(); }
  function previousWizardStep() { if (state.step > 0) { state.step -= 1; renderWizard(); } }
  function resetWizard() { localStorage.removeItem('hardware_wizard_dismissed'); openWizard(); }

  window.HardwareUI = { load, saveMode, toggleMode, setMockWeight, testPrinter, testDrawer, diagnose, openWizard, closeWizard, nextWizardStep, previousWizardStep, resetWizard };
})();
