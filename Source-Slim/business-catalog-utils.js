'use strict';

(function exposeBusinessCatalogUtils(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SystemBusinessCatalogUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createBusinessCatalogUtils() {
  const MAX_EXTRA_FIELDS = 30;
  const MAX_EXTRA_VALUE_LENGTH = 500;
  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const TECHNICAL_SOURCE_FIELDS = new Set(['barcode_source', 'barcode_source_record_id', 'barcode_is_sample']);
  const CANONICAL_ALIASES = new Map([['name_ar', 'name'], ['name_en', 'generic_name'], ['drug_class', 'category']]);
  const STANDARD_FIELDS = new Set([
    'name', 'barcode', 'category', 'unit', 'cost_price', 'sale_price', 'min_stock', 'notes',
    'generic_name', 'active_ingredient', 'scientific_name', 'manufacturer', 'strength', 'dosage_form',
    'extra_fields', 'catalog_file', 'activity', 'created_at', 'updated_at', 'selected', 'dirty'
  ]);
  const INTERNAL_FIELDS = new Set(['selected', 'dirty', 'catalog_file', 'activity', 'created_at', 'updated_at']);

  function normalizeCatalogSearchText(value) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .toLocaleLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function valueAsSearchableText(value, depth = 0) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (depth >= 5) return '';
    if (Array.isArray(value)) return value.map(item => valueAsSearchableText(item, depth + 1)).filter(Boolean).join(' | ');
    if (typeof value === 'object') {
      return Object.entries(value)
        .filter(([key]) => !FORBIDDEN_KEYS.has(key))
        .map(([key, nested]) => {
          const text = valueAsSearchableText(nested, depth + 1);
          return text ? `${key}: ${text}` : '';
        })
        .filter(Boolean)
        .join(' | ');
    }
    return '';
  }

  function sanitizeCatalogExtraFields(raw, excludedFields = STANDARD_FIELDS) {
    const result = Object.create(null);
    const excluded = excludedFields instanceof Set ? excludedFields : new Set(excludedFields || []);
    const add = (keyValue, value) => {
      if (Object.keys(result).length >= MAX_EXTRA_FIELDS) return;
      const key = String(keyValue ?? '').trim().slice(0, 100);
      if (!key || FORBIDDEN_KEYS.has(key) || TECHNICAL_SOURCE_FIELDS.has(key) || excluded.has(key) || Object.hasOwn(result, key)) return;
      const canonicalKey = CANONICAL_ALIASES.get(key);
      if (canonicalKey && Object.hasOwn(raw, canonicalKey)) {
        const originalValue = valueAsSearchableText(value).trim();
        const canonicalValue = valueAsSearchableText(raw[canonicalKey]).trim();
        if (originalValue === canonicalValue) return;
      }
      const text = valueAsSearchableText(value).slice(0, MAX_EXTRA_VALUE_LENGTH);
      if (!text) return;
      Object.defineProperty(result, key, { value: text, enumerable: true, writable: true, configurable: true });
    };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
    const nested = raw.extra_fields;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      for (const [key, value] of Object.entries(nested)) add(key, value);
    }
    for (const [key, value] of Object.entries(raw)) {
      if (key !== 'extra_fields') add(key, value);
    }
    return result;
  }

  function normalizeImportedCatalogRow(raw) {
    const extraFields = sanitizeCatalogExtraFields(raw);
    const name = String(raw?.name || extraFields.name_ar || extraFields.name_en || '').trim();
    return { ...(raw || {}), name, ...(Object.keys(extraFields).length ? { extra_fields: extraFields } : {}) };
  }

  function getCatalogFieldValue(row, key) {
    if (row?.extra_fields && Object.hasOwn(row.extra_fields, key)) return row.extra_fields[key];
    return row?.[key];
  }

  function getSearchableValues(row) {
    const values = [];
    if (row && typeof row === 'object') {
      for (const [key, value] of Object.entries(row)) {
        if (key === 'extra_fields' || INTERNAL_FIELDS.has(key)) continue;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') values.push(String(value));
      }
      if (row.extra_fields && typeof row.extra_fields === 'object') {
        for (const value of Object.values(row.extra_fields)) if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') values.push(String(value));
      }
    }
    return values;
  }

  function buildCatalogSearchIndex(rows) {
    return (Array.isArray(rows) ? rows : []).map((row, index) => {
      const extras = row?.extra_fields && typeof row.extra_fields === 'object' ? row.extra_fields : {};
      const names = [row?.name, row?.generic_name, extras.name_ar, extras.name_en].filter(value => value !== null && value !== undefined).map(normalizeCatalogSearchText).filter(Boolean);
      const barcode = normalizeCatalogSearchText(row?.barcode || '');
      const searchable = normalizeCatalogSearchText(getSearchableValues(row).join(' '));
      return { row, index, names, barcode, searchable };
    });
  }

  function searchCatalog(index, query, filter = {}) {
    const normalizedQuery = normalizeCatalogSearchText(query);
    const tokens = normalizedQuery ? normalizedQuery.split(' ').filter(Boolean) : [];
    const filtered = [];
    for (const record of index || []) {
      const { row } = record;
      if (filter.field && filter.value && normalizeCatalogSearchText(getCatalogFieldValue(row, filter.field)) !== normalizeCatalogSearchText(filter.value)) continue;
      if (tokens.length && !tokens.every(token => record.searchable.includes(token))) continue;
      let rank = 0;
      if (tokens.length) {
        if (record.names.some(name => name.startsWith(normalizedQuery))) rank = 0;
        else if (record.names.some(name => tokens.every(token => name.includes(token)))) rank = 1;
        else if (tokens.every(token => record.barcode.includes(token))) rank = 2;
        else rank = 3;
      }
      filtered.push({ row, index: record.index, rank });
    }
    if (tokens.length) filtered.sort((a, b) => a.rank - b.rank || a.index - b.index);
    return filtered;
  }

  function getCatalogFieldMetadata(rows, minimumCoverage = 0.05) {
    const list = Array.isArray(rows) ? rows : [];
    const stats = new Map();
    const add = (key, value) => {
      if (!key || INTERNAL_FIELDS.has(key) || value === null || value === undefined || String(value).trim() === '') return;
      let stat = stats.get(key);
      if (!stat) { stat = { key, present: 0, distinct: new Set() }; stats.set(key, stat); }
      stat.present++;
      stat.distinct.add(String(value).trim());
    };
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      for (const [key, value] of Object.entries(row)) {
        if (key === 'extra_fields' || INTERNAL_FIELDS.has(key)) continue;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') add(key, value);
      }
      if (row.extra_fields && typeof row.extra_fields === 'object') {
        for (const [key, value] of Object.entries(row.extra_fields)) add(key, value);
      }
    }
    const columns = [...stats.values()].filter(stat => stat.present / Math.max(1, list.length) > minimumCoverage);
    const categoricalLimit = Math.min(500, Math.max(20, Math.ceil(list.length * 0.02)));
    const filterFields = columns
      .filter(stat => stat.key === 'category' || (stat.distinct.size > 1 && stat.distinct.size <= categoricalLimit))
      .map(stat => ({ key: stat.key, values: [...stat.distinct].sort((a, b) => a.localeCompare(b)) }));
    const coreFields = new Set(['name', 'category', 'barcode', 'unit', 'cost_price', 'sale_price', 'min_stock']);
    return {
      extraColumns: columns.filter(stat => !coreFields.has(stat.key)).map(stat => ({ key: stat.key, coverage: stat.present / Math.max(1, list.length) })),
      filterFields
    };
  }

  function filterCatalogRows(rows, field, value) {
    if (!field || !value) return Array.isArray(rows) ? rows : [];
    const target = normalizeCatalogSearchText(value);
    return (Array.isArray(rows) ? rows : []).filter(row => normalizeCatalogSearchText(getCatalogFieldValue(row, field)) === target);
  }

  return {
    MAX_EXTRA_FIELDS, MAX_EXTRA_VALUE_LENGTH, normalizeCatalogSearchText, valueAsSearchableText,
    sanitizeCatalogExtraFields, normalizeImportedCatalogRow, getCatalogFieldValue,
    buildCatalogSearchIndex, searchCatalog, getCatalogFieldMetadata, filterCatalogRows
  };
});
