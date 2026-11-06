'use strict';

const api = window.licenseGate;
const statusBox = document.getElementById('statusBox');
const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const trialInfo = document.getElementById('trialInfo');
const deviceIdEl = document.getElementById('deviceId');
const copyBtn = document.getElementById('copyBtn');
const activationSection = document.getElementById('activationSection');
const licenseInput = document.getElementById('licenseInput');
const activateBtn = document.getElementById('activateBtn');
const activationMsg = document.getElementById('activationMsg');
const quitBtn = document.getElementById('quitBtn');

function showStatus(state, text, cls) {
  statusBox.className = 'status ' + cls;
  statusBox.textContent = text;
  statusBox.style.display = 'block';
}

async function refresh() {
  const s = await api.getStatus();
  titleEl.textContent = 'System POS';

  if (s.state === 'licensed') {
    subtitleEl.textContent = 'مرخص';
    showStatus('licensed', `البرنامج مرخص باسم: ${s.customer || '—'}`, 'licensed');
    trialInfo.style.display = 'none';
    activationSection.style.display = 'none';
    setTimeout(() => api.proceedToApp(), 800);
    return;
  }

  if (s.state === 'trial') {
    subtitleEl.textContent = 'فترة تجريبية';
    showStatus('trial', `متبقٍ ${s.daysLeft} يوم من الفترة التجريبية`, 'trial');
    deviceIdEl.textContent = s.deviceId || '—';
    trialInfo.style.display = 'block';
    activationSection.style.display = 'block';
    return;
  }

  if (s.state === 'expired') {
    subtitleEl.textContent = 'انتهت الفترة التجريبية';
    showStatus('expired', 'انتهت الفترة التجريبية. يرجى تفعيل البرنامج للمتابعة.', 'expired');
    deviceIdEl.textContent = s.deviceId || '—';
    trialInfo.style.display = 'block';
    activationSection.style.display = 'block';
    return;
  }

  if (s.state === 'blocked') {
    subtitleEl.textContent = 'غير مسموح';
    showStatus('error', `البرنامج لا يعمل على أجهزة وهمية (${s.vmType || 'VM'}).`, 'error');
    trialInfo.style.display = 'none';
    activationSection.style.display = 'none';
    return;
  }

  if (s.state === 'tampered') {
    subtitleEl.textContent = 'تحقق فاشل';
    showStatus('error', `تم اكتشاف تلاعب بالترخيص (${s.reason}).`, 'error');
    trialInfo.style.display = 'none';
    activationSection.style.display = 'none';
    return;
  }

  if (s.state === 'invalid-license') {
    subtitleEl.textContent = 'ترخيص غير صالح';
    showStatus('error', `الترخيص غير صالح (${s.reason}).`, 'error');
    deviceIdEl.textContent = s.deviceId || '—';
    trialInfo.style.display = 'block';
    activationSection.style.display = 'block';
    return;
  }

  subtitleEl.textContent = 'خطأ';
  showStatus('error', `تعذر تحديد حالة الترخيص (${s.reason || 'unknown'}).`, 'error');
}

copyBtn.addEventListener('click', async () => {
  const text = deviceIdEl.textContent;
  if (text && text !== '—') {
    await api.copyToClipboard(text);
    copyBtn.textContent = 'تم النسخ ✓';
    setTimeout(() => { copyBtn.textContent = 'نسخ الكود'; }, 1500);
  }
});

activateBtn.addEventListener('click', async () => {
  const raw = licenseInput.value.trim();
  if (!raw) { activationMsg.textContent = 'الصق الترخيص أولًا'; return; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { activationMsg.textContent = 'صيغة JSON غير صحيحة'; return; }

  activateBtn.disabled = true;
  activationMsg.textContent = 'جارٍ التفعيل...';
  const result = await api.activate(parsed);
  activateBtn.disabled = false;

  if (result.ok) {
    activationMsg.textContent = 'تم التفعيل بنجاح — يفتح البرنامج...';
    setTimeout(() => refresh(), 600);
  } else {
    activationMsg.textContent = `فشل التفعيل: ${result.reason}`;
  }
});

quitBtn.addEventListener('click', () => api.quit());

refresh();
setInterval(refresh, 60000);
