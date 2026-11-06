'use strict';

const SEARCH_FIELDS = Object.freeze(['item_number', 
  'name', 'barcode', 'category_name', 'generic_name', 'active_ingredient',
  'scientific_name', 'manufacturer', 'strength', 'dosage_form', 'notes'
]);

function normalizeProductText(value) {
  return String(value ?? '').toLocaleLowerCase('ar')
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x06f0))
    .trim();
}

function searchSignature(products) {
  let hash = 2166136261;
  for (const product of products) {
    for (const field of SEARCH_FIELDS) {
      const value = String(product?.[field] ?? '');
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      hash ^= 31;
      hash = Math.imul(hash, 16777619);
    }
    hash ^= Number(product?.id) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return `${products.length}:${hash >>> 0}`;
}

function updateProductIndex(state, products) {
  const rows = Array.isArray(products) ? products : [];
  const signature = searchSignature(rows);
  const rebuilt = state.signature !== signature;
  state.productsById = new Map(rows.map(product => [product.id, product]));
  if (rebuilt) {
    state.entries = rows.map(product => ({
      id: product.id,
      text: SEARCH_FIELDS.map(field => normalizeProductText(product?.[field])).filter(Boolean).join('\u001f'),
      barcode: String(product?.barcode || '').trim()
    }));
    state.byBarcode = new Map();
    for (const entry of state.entries) if (entry.barcode && !state.byBarcode.has(entry.barcode)) state.byBarcode.set(entry.barcode, entry.id);
    state.signature = signature;
  }
  return { rebuilt, signature };
}

function searchProductIds(state, query) {
  const normalized = normalizeProductText(query);
  const ids = new Set();
  if (!normalized) {
    for (const entry of state.entries || []) ids.add(entry.id);
    return ids;
  }
  for (const entry of state.entries || []) if (entry.text.includes(normalized)) ids.add(entry.id);
  return ids;
}

function findProductByBarcode(state, barcode) {
  const id = state.byBarcode?.get(String(barcode || '').trim());
  return id === undefined ? null : (state.productsById?.get(id) || null);
}

function getPageWindow(total, page, pageSize) {
  const size = [50, 100, 200].includes(Number(pageSize)) ? Number(pageSize) : 100;
  const pageCount = Math.max(1, Math.ceil(Math.max(0, Number(total) || 0) / size));
  const current = Math.min(Math.max(0, Number(page) || 0), pageCount - 1);
  return { page: current, pageSize: size, pageCount, start: current * size, end: Math.min((current + 1) * size, Math.max(0, Number(total) || 0)) };
}

const ProductListUtils = { SEARCH_FIELDS, normalizeProductText, updateProductIndex, searchProductIds, findProductByBarcode, getPageWindow };
if (typeof module !== 'undefined' && module.exports) module.exports = ProductListUtils;
if (typeof window !== 'undefined') window.ProductListUtils = ProductListUtils;
