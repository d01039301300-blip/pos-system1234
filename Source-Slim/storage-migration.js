'use strict';

/** Move legacy browser storage keys without overwriting newer data.
 * Invalid legacy values are deliberately kept so they can be recovered later.
 */
function migrateStorageKeys(storage, mappings, validators = {}) {
  const result = { migrated: [], preserved: [], invalid: [], failed: [] };
  for (const [legacyKey, currentKey] of Object.entries(mappings || {})) {
    try {
      const legacyValue = storage.getItem(legacyKey);
      if (legacyValue === null) continue;
      const currentValue = storage.getItem(currentKey);
      const validate = validators[legacyKey];
      const isValid = value => {
        if (typeof validate !== 'function') return true;
        try { return validate(value) !== false; } catch { return false; }
      };
      if (!isValid(legacyValue) || (currentValue !== null && !isValid(currentValue))) {
        result.invalid.push(legacyKey);
        continue;
      }
      if (currentValue === null) {
        storage.setItem(currentKey, legacyValue);
        if (storage.getItem(currentKey) !== legacyValue) throw new Error('storage read-back mismatch');
        result.migrated.push(legacyKey);
      } else {
        result.preserved.push(legacyKey);
      }
      storage.removeItem(legacyKey);
    } catch (error) {
      result.failed.push({ key: legacyKey, message: String(error?.message || error) });
    }
  }
  return result;
}

/** Split a legacy catalog array out of the browser data blob without risking loss. */
function migrateEmbeddedCatalog(storage, mainKey, catalogKey) {
  const originalMain = storage.getItem(mainKey);
  if (originalMain === null) return { migrated: false, warning: '' };
  let data;
  try { data = JSON.parse(originalMain); }
  catch (error) { return { migrated: false, warning: `تعذر قراءة بيانات التخزين المحلية: ${error.message}` }; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.prototype.hasOwnProperty.call(data, 'business_catalog')) return { migrated: false, warning: '' };
  const rows = Array.isArray(data.business_catalog) ? data.business_catalog : [];
  const serializedRows = JSON.stringify(rows);
  const existingCatalog = storage.getItem(catalogKey);
  try {
    if (existingCatalog === null) storage.setItem(catalogKey, serializedRows);
    if (storage.getItem(catalogKey) !== (existingCatalog === null ? serializedRows : existingCatalog)) throw new Error('catalog storage read-back mismatch');
    const checkRows = JSON.parse(storage.getItem(catalogKey));
    if (!Array.isArray(checkRows)) throw new Error('catalog sidecar is not an array');
    if (existingCatalog !== null && JSON.stringify(checkRows) !== serializedRows) throw new Error('a different catalog sidecar already exists');
    delete data.business_catalog;
    storage.setItem(mainKey, JSON.stringify(data));
    if (!JSON.parse(storage.getItem(mainKey)) || Object.prototype.hasOwnProperty.call(JSON.parse(storage.getItem(mainKey)), 'business_catalog')) throw new Error('main storage read-back mismatch');
    return { migrated: existingCatalog === null, warning: '' };
  } catch (error) {
    try { storage.setItem(mainKey, originalMain); } catch (_) {}
    return { migrated: false, warning: `تعذر فصل الكتالوج المحلي؛ احتُفظ بالبيانات القديمة: ${error.message}` };
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { migrateStorageKeys, migrateEmbeddedCatalog };
if (typeof window !== 'undefined') window.SystemStorageMigration = { migrateStorageKeys, migrateEmbeddedCatalog };
