(function () {
  'use strict';
  const DEFAULTS = { enabled: true, master: 0.5, tap: 0.5, notify: 0.5, sales: 0.5 };
  let settings = { ...DEFAULTS }, audioContext = null, lastPlayed = new Map();
  const userKey = () => `system_pos_sounds_${String(window.rawdaCurrentUser?.id || window.rawdaCurrentUser?.username || 'guest')}`;
  const load = () => { try { settings = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(userKey()) || '{}')) }; } catch (_) { settings = { ...DEFAULTS }; } };
  const save = () => { try { localStorage.setItem(userKey(), JSON.stringify(settings)); } catch (_) {} };
  const categoryFor = name => ['success','error','warning','info','offline','online','confirm'].includes(name) ? 'notify' : ['sale','barcode','add-to-cart','payment','wallet','shift-open','shift-close','return','print','resume','discard','login','logout'].includes(name) ? 'sales' : 'tap';
  function tone(name) {
    try {
      const category = categoryFor(name), now = performance.now();
      if (!settings.enabled || !settings[category] || !settings.master) return;
      if (now - (lastPlayed.get(name) || 0) < 120) return;
      lastPlayed.set(name, now);
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioContext.createOscillator(), gain = audioContext.createGain();
      const tones = { tap:[520,0.045], success:[660,0.12], error:[180,0.16], warning:[330,0.12], info:[460,0.08], barcode:[880,0.07], 'add-to-cart':[590,0.08], sale:[740,0.24], payment:[620,0.14], wallet:[560,0.12], return:[410,0.13], print:[510,0.1], resume:[580,0.1], discard:[260,0.1], 'shift-open':[440,0.12], 'shift-close':[360,0.18], login:[620,0.12], logout:[300,0.12], offline:[220,0.16], online:[520,0.16], confirm:[280,0.1] };
      const [frequency, duration] = tones[name] || tones.tap, volume = Math.max(0.001, Math.min(0.16, settings.master * settings[category] * 0.28));
      osc.type = name === 'sale' ? 'sine' : 'triangle'; osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.001, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(volume, audioContext.currentTime + 0.008); gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);
      osc.connect(gain).connect(audioContext.destination); osc.start(); osc.stop(audioContext.currentTime + duration + 0.02);
    } catch (_) { /* autoplay/device audio restrictions are intentionally ignored */ }
  }
  function playSound(name) {
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === 'suspended') { void audioContext.resume().then(() => tone(name)).catch(() => {}); return; }
      tone(name);
    } catch (_) { /* unsupported audio devices are intentionally ignored */ }
  }
  function unlockAudio() {
    try { audioContext ||= new (window.AudioContext || window.webkitAudioContext)(); if (audioContext.state === 'suspended') void audioContext.resume(); } catch (_) {}
  }
  function syncUser() { load(); render(); }
  function set(name, value) { if (name === 'enabled') settings.enabled = Boolean(value); else settings[name] = Math.max(0, Math.min(1, Number(value))); save(); render(); }
  function render() {
    const enabled = document.getElementById('sounds-enabled'); if (enabled) enabled.checked = settings.enabled;
    const master = document.getElementById('sounds-master'); if (master) master.value = Math.round(settings.master * 100);
    for (const key of ['tap','notify','sales']) { const input = document.getElementById(`sounds-${key}`); if (input) input.value = Math.round(settings[key] * 100); const value = document.getElementById(`sounds-${key}-value`); if (value) value.textContent = `${Math.round(settings[key] * 100)}%`; }
    const masterValue = document.getElementById('sounds-master-value'); if (masterValue) masterValue.textContent = `${Math.round(settings.master * 100)}%`;
    const button = document.getElementById('status-sound-toggle'); if (button) { button.innerHTML = `<i class="fa-solid ${settings.enabled ? 'fa-volume-high' : 'fa-volume-xmark'}" aria-hidden="true"></i>`; button.title = settings.enabled ? 'كتم الأصوات' : 'تشغيل الأصوات'; button.setAttribute('aria-label', button.title); }
  }
  document.addEventListener('click', event => {
    const target = event.target.closest('button, .sidebar-btn, .grid-action-btn, .tab-btn, header a, #header a');
    if (target && !target.closest('#sounds-settings') && target.id !== 'status-sound-toggle' && !target.disabled) playSound('tap');
    const test = target?.closest('[data-sound-test]'); if (test) { event.stopPropagation(); playSound(test.dataset.soundTest); }
  }, true);
  document.addEventListener('change', event => { const el = event.target; if (el.id === 'sounds-enabled') set('enabled', el.checked); else if (el.id === 'sounds-master') set('master', Number(el.value)/100); else if (/^sounds-(tap|notify|sales)$/.test(el.id)) set(el.id.replace('sounds-',''), Number(el.value)/100); });
  document.addEventListener('pointerdown', unlockAudio, true);
  window.addEventListener('online', () => playSound('online')); window.addEventListener('offline', () => playSound('offline'));
  document.addEventListener('DOMContentLoaded', () => { render(); document.getElementById('status-sound-toggle')?.addEventListener('click', event => { event.stopPropagation(); set('enabled', !settings.enabled); playSound('tap'); }); });
  window.playSound = playSound; window.SoundSettings = { playSound, syncUser, render, set, get: () => ({ ...settings }) };
})();
