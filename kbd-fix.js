/* kbd-fix.js — Ctrl+R / F5 refresh that works with ANY keyboard layout (Arabic included).
   The old handler compared e.key to 'r', which is 'ق' on an Arabic layout, so it never fired.
   Here we use the physical key (e.code). Load AFTER app.js. */
(function () {
  window.addEventListener('keydown', function (e) {
    var isCtrlR = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyR';
    var isF5 = e.key === 'F5' && !e.ctrlKey && !e.altKey;
    if (!isCtrlR && !isF5) return;
    e.preventDefault();
    e.stopPropagation();
    window.location.reload();
  }, true);
})();
