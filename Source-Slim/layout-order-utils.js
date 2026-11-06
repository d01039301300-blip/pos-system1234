'use strict';

(function exposeLayoutOrder(root) {
  function normalizeOrder(saved, currentIds) {
    const current = Array.isArray(currentIds) ? currentIds.map(String) : [];
    const valid = new Set(current);
    const normalized = [];
    if (Array.isArray(saved)) {
      for (const id of saved) {
        const key = String(id);
        if (valid.has(key) && !normalized.includes(key)) normalized.push(key);
      }
    }
    for (const id of current) if (!normalized.includes(id)) normalized.push(id);
    return normalized;
  }

  function readOrder(serialized, defaults) {
    try {
      const value = JSON.parse(serialized);
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return [...defaults];
      return normalizeOrder(value, defaults);
    } catch (_) { return [...defaults]; }
  }

  function storageKey(userId, area) { return `layout_${String(userId)}_${String(area)}`; }

  function move(order, id, delta) {
    const next = [...order];
    const index = next.indexOf(String(id));
    const destination = index + Math.sign(Number(delta) || 0);
    if (index < 0 || destination < 0 || destination >= next.length) return next;
    [next[index], next[destination]] = [next[destination], next[index]];
    return next;
  }

  const api = Object.freeze({ normalizeOrder, readOrder, storageKey, move });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LayoutOrderUtils = api;
})(typeof window !== 'undefined' ? window : globalThis);
