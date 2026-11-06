/**
 * نظام إدارة نقطة البيع العامة
 * Client-side Controller & Dual-Mode Data Engine
 * مطابق تماماً لـ SPEC-KIT.md وملف المتطلبات (SRS)
 */

// ----------------------------------------------------
// Global State
// ----------------------------------------------------
const appConfirmQueue = [];
let appConfirmActive = false;

function logError(entry = {}) {
  try {
    void window.rawdaDesktop?.appendErrorLog?.({
      ts: new Date().toISOString(),
      level: 'error',
      type: String(entry.type || 'renderer.error'),
      message: String(entry.message || ''),
      source: String(entry.source || ''),
      line: Number(entry.line || 0) || 0,
      stack: String(entry.stack || '')
    });
  } catch (err) { console.error('[1.16-B]', err); }
}
window.addEventListener('error', event => logError({
  type: 'window.error',
  message: event.message,
  source: event.filename,
  line: event.lineno,
  stack: event.error?.stack
}));
window.addEventListener('unhandledrejection', event => logError({
  type: 'unhandledrejection',
  message: event.reason?.message || event.reason,
  stack: event.reason?.stack
}));

function showAppToast(message, { duration = 4200, tone = 'info', sound = true } = {}) {
  if (sound) window.playSound?.(tone);
  const add = () => {
    let region = document.getElementById('app-toast-region');
    if (!region) {
      region = document.createElement('div');
      region.id = 'app-toast-region';
      region.className = 'app-toast-region';
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('aria-atomic', 'false');
      document.body.appendChild(region);
    }
    const toast = document.createElement('div');
    toast.className = `app-toast app-toast-${tone}`;
    toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    toast.textContent = String(message ?? '');
    region.appendChild(toast);
    window.setTimeout(() => {
      toast.classList.add('is-leaving');
      window.setTimeout(() => toast.remove(), 240);
    }, Math.max(1000, Number(duration) || 4200));
  };
  if (document.body) add();
  else document.addEventListener('DOMContentLoaded', add, { once: true });
}

function showAppConfirm(message) {
  return new Promise(resolve => {
    appConfirmQueue.push({ message: String(message || 'هل تريد المتابعة؟'), resolve });
    showNextAppConfirm();
  });
}

function showNextAppConfirm() {
  if (appConfirmActive || !appConfirmQueue.length) return;
  const dialog = document.getElementById('app-confirm-dialog');
  const text = document.getElementById('app-confirm-message');
  const accept = document.getElementById('app-confirm-accept');
  const cancel = document.getElementById('app-confirm-cancel');
  if (!dialog || !text || !accept || !cancel) {
    appConfirmQueue.shift()?.resolve(false);
    showNextAppConfirm();
    return;
  }
  window.playSound?.('confirm');
  appConfirmActive = true;
  const request = appConfirmQueue[0];
  text.textContent = request.message;
  dialog.classList.remove('hidden');
  dialog.classList.add('flex');
  syncModalBodyLock();
  const finish = answer => {
    if (!appConfirmActive) return;
    appConfirmActive = false;
    dialog.classList.add('hidden');
    dialog.classList.remove('flex');
    accept.removeEventListener('click', yes);
    cancel.removeEventListener('click', no);
    dialog.removeEventListener('keydown', onKeyDown);
    appConfirmQueue.shift()?.resolve(answer);
    syncModalBodyLock();
    showNextAppConfirm();
  };
  const yes = () => finish(true);
  const no = () => finish(false);
  const onKeyDown = event => {
    if (event.key === 'Escape') { event.preventDefault(); no(); }
    if (event.key === 'Enter' && (event.target === accept || event.target === cancel)) { event.preventDefault(); event.target === accept ? yes() : no(); }
  };
  accept.addEventListener('click', yes);
  cancel.addEventListener('click', no);
  dialog.addEventListener('keydown', onKeyDown);
  cancel.focus();
}

// Keep legacy callers from ever opening a blocking browser dialog. All
// confirmations in the application flow use the async in-page dialog below.

let currentUser = null;
let loginFinishing = false;
let maintenancePollTimer = null;
let pendingPasswordChangeContext = null;
// The safe default is the customer build. Only an explicit dev marker may
// bypass the mandatory bootstrap-password screen.
const BUILD_MODE = globalThis.rawdaDesktop?.buildMode === 'dev' ? 'dev' : 'client';
const IS_DEV_BUILD = BUILD_MODE === 'dev';
let forcedPasswordChangeActive = false;
let userModalDirty = false;
let applyingUserPermissionTemplate = false;
const ACTIVATION_SUPPORT_PHONE = '01039301300';
const SYSTEM_STORAGE_MIGRATIONS = Object.freeze({
  rawda_active_branch_id: 'system_active_branch_id', rawda_session: 'system_session',
  rawda_navigation_layout: 'system_navigation_layout', rawda_active_tab: 'system_active_tab',
  rawda_price_level: 'system_price_level', rawda_selected_theme: 'system_selected_theme',
  rawda_dashboard_interface: 'system_dashboard_interface', rawda_dashboard_interface_glass_v1: 'system_dashboard_interface_glass_v1',
  rawda_custom_db_path: 'system_custom_db_path', rawda_pos_hardware: 'system_pos_hardware',
  rawda_customer_display_payload: 'system_customer_display_payload',
  dr_mohamed_pharmacy_pos_data: 'system_business_pos_data'
});
function migrateLegacySystemStorage() {
  const migration = window.SystemStorageMigration?.migrateStorageKeys;
  if (typeof migration === 'function') {
    const validators = { dr_mohamed_pharmacy_pos_data: value => {
      const data = JSON.parse(value);
      return Boolean(data && typeof data === 'object' && !Array.isArray(data)
        && (Array.isArray(data.products) || Array.isArray(data.users) || Array.isArray(data.employees)));
    } };
    // Intentionally ignored: optional local-storage migration may be unavailable
    try { migration(window.localStorage, SYSTEM_STORAGE_MIGRATIONS, validators); } catch (_) {}
    // Intentionally ignored: optional embedded catalog migration may be unavailable
    try { window.SystemStorageMigration?.migrateEmbeddedCatalog(window.localStorage, 'system_business_pos_data', 'system_business_catalog'); } catch (_) {}
    const sessionMigrations = Object.fromEntries(Object.entries(SYSTEM_STORAGE_MIGRATIONS).filter(([key]) => key !== 'dr_mohamed_pharmacy_pos_data'));
    // Intentionally ignored: optional session migration may be unavailable
    try { migration(window.sessionStorage, sessionMigrations); } catch (_) {}
  }
  // Intentionally ignored: restoring the last tab is best-effort
  try { activeTab = localStorage.getItem('system_active_tab') || 'dashboard'; } catch (_) {}
}
const unsubscribeTrialExpired = window.rawdaDesktop?.onTrialExpired?.(() => {
  document.getElementById('app-shell')?.classList.add('hidden');
  closeModal('modal-login');
  openModal('modal-activation');
  const message = document.getElementById('license-status-message');
  /* FIX-TRIAL-DURATION */
  if (message) message.textContent = 'انتهت مدة التجربة المجانية البالغة 30 يوماً. أدخل كود التفعيل لمتابعة الاستخدام.';
  window.rawdaDesktop?.getDeviceId?.().then(id => { const field = document.getElementById('license-device-id'); if (field) field.value = id; updateActivationSupportLink(); });
});

let activeTab = 'dashboard';
let previousAppTab = null;
migrateLegacySystemStorage();
let activePosCategory = 'all';
let activePosStockTab = 'all';
let phase1Notifications = [];
let activePosPriceLevel = ['retail', 'wholesale', 'special'].includes(localStorage.getItem('system_price_level')) ? localStorage.getItem('system_price_level') : 'retail';
let cart = [];
let posSelectedCustomerId = 1;
let barcodeBuffer = '';
let barcodeTimeout = null;

let activeSelfOrderId = null;
let paymentMethod = 'نقدي';
let loyaltySummaryTimer = null;
let appClockTimer = null;
let dashboardBranchCashSummaryRequestId = 0;
let googleDriveStatusTimer = null;
let taxSettings = { enabled: false, rate: 0, registration_number: '' };
let printSettings = { type: '80mm', copies: 1, show_logo: true, show_tax: true, font_size: 'medium', auto_print: false, preview_before_print: true };
let returnWindowDays = 14;
let activePromotions = [];
let salesChart = null;
let posSearchTimer = null;
let productSearchTimer = null;
let purchasesSearchTimer = null;
let salesHistorySearchTimer = null;
let posCustomerSearchTimer = null;
let wasteProductSearchTimer = null;
let businessCatalogSearchTimer = null;
let unifiedCatalogSearchTimer = null;
let unifiedCatalogRows = [];
const unifiedCatalogSelection = new Set();
let globalShortcutHandler = null;
let barcodeScannerHandler = null;
let salesHistoryBarcodeCamera = null;
const offlineOnlineHandler = () => setTimeout(syncOfflineSalesQueue, 1200);
const offlineOfflineHandler = () => { window.playSound?.('offline'); showAppToast('انقطع الاتصال. سيُحفظ البيع محلياً للمزامنة عند عودة الاتصال.', { tone: 'warning', sound: false }); };
function cleanupClientResources() {
  if (appClockTimer) { clearInterval(appClockTimer); appClockTimer = null; }
  if (googleDriveStatusTimer) { clearInterval(googleDriveStatusTimer); googleDriveStatusTimer = null; }
  [loyaltySummaryTimer, posSearchTimer, productSearchTimer, purchasesSearchTimer, salesHistorySearchTimer, posCustomerSearchTimer, wasteProductSearchTimer, businessCatalogSearchTimer, unifiedCatalogSearchTimer].forEach(timer => { if (timer) clearTimeout(timer); });
  loyaltySummaryTimer = posSearchTimer = productSearchTimer = purchasesSearchTimer = salesHistorySearchTimer = posCustomerSearchTimer = wasteProductSearchTimer = businessCatalogSearchTimer = unifiedCatalogSearchTimer = null;
  window.__rawdaFontObserver?.disconnect?.();
  window.__rawdaModalObserver?.disconnect?.();
  window.__rawdaActionPermissionObserver?.disconnect?.();
  if (globalShortcutHandler) { document.removeEventListener('keydown', globalShortcutHandler); globalShortcutHandler = null; }
  if (barcodeScannerHandler) { document.removeEventListener('keydown', barcodeScannerHandler, true); barcodeScannerHandler = null; }
  if (typeof window !== 'undefined') {
    window.removeEventListener('online', offlineOnlineHandler);
    window.removeEventListener('offline', offlineOfflineHandler);
  }
  salesChart?.destroy?.();
  salesChart = null;
  void stopSalesHistoryBarcodeCamera();
  dashboardDigitObserver?.disconnect?.();
  dashboardDigitObserver = null;
  unsubscribeTrialExpired?.();
}
window.addEventListener('pagehide', cleanupClientResources, { once: true });
let inventoryWasteProducts = [];
const productSearchIndexState = {};
const POS_TOP_SELLERS_LIMIT = 12;
let posTopSellerCache = null;
const productListPages = {
  products: { page: 0, pageSize: 100 },
  pos: { page: 0, pageSize: 500 },
  inventoryProducts: { page: 0, pageSize: 100 },
  inventoryLots: { page: 0, pageSize: 100 },
  inventoryMovements: { page: 0, pageSize: 100 }
};
let lastRenderedReceipt = null;
const LOCAL_DATA_KEY = 'system_business_pos_data';
const LEGACY_LOCAL_DATA_KEY = 'dr_mohamed_pharmacy_pos_data';
const OFFLINE_SALES_DB = 'system-pos-offline-v1';
function openOfflineSalesDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('التخزين المحلي غير متاح في هذا المتصفح.'));
    const request = indexedDB.open(OFFLINE_SALES_DB, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('sales')) request.result.createObjectStore('sales', { keyPath: 'client_transaction_id' }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('تعذر فتح التخزين المحلي.'));
  });
}
async function queueOfflineSale(saleData) {
  const db = await openOfflineSalesDb();
  const record = { ...JSON.parse(JSON.stringify(saleData)), client_transaction_id: saleData.client_transaction_id || `${Date.now()}-${Math.random().toString(16).slice(2)}`, queued_at: new Date().toISOString(), sync_state: 'pending' };
  await new Promise((resolve, reject) => { const tx = db.transaction('sales', 'readwrite'); tx.objectStore('sales').put(record); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  db.close(); return record;
}
async function syncOfflineSalesQueue() {
  if (!navigator.onLine || !currentUser) return;
  // Intentionally ignored: offline queue access is optional when IndexedDB is unavailable
  let db; try { db = await openOfflineSalesDb(); } catch (_) { return; }
  const records = await new Promise((resolve, reject) => { const tx = db.transaction('sales', 'readonly'); const req = tx.objectStore('sales').getAll(); req.onsuccess = () => resolve(req.result || []); req.onerror = () => reject(req.error); }).catch(() => []);
  db.close(); let synced = 0;
  for (const record of records.filter(row => row.sync_state === 'pending')) {
    try {
      const response = await fetch('/api/sales', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) });
      const result = await response.json();
      if (!response.ok) { await updateOfflineSaleRecord(record.client_transaction_id, { sync_state: 'needs_review', sync_error: result.error || 'رفض الخادم الفاتورة' }); continue; }
      await updateOfflineSaleRecord(record.client_transaction_id, { sync_state: 'synced', invoice_number: result.invoice_number, synced_at: new Date().toISOString() }); synced++;
    } catch (_) { break; }
  }
  if (synced && typeof showToast === 'function') showToast(`تمت مزامنة ${synced} فاتورة محفوظة دون اتصال.`);
  if (synced) window.dispatchEvent(new CustomEvent('offline-sales-synced', { detail: { count: synced } }));
}
async function updateOfflineSaleRecord(key, changes) {
  const db = await openOfflineSalesDb();
  await new Promise((resolve, reject) => { const tx = db.transaction('sales', 'readwrite'); const store = tx.objectStore('sales'); const req = store.get(key); req.onsuccess = () => { if (req.result) store.put({ ...req.result, ...changes }); }; tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
}
if (typeof window !== 'undefined') {
  window.addEventListener('online', offlineOnlineHandler);
  window.addEventListener('offline', offlineOfflineHandler);
}

// Temporary purchase invoice builder
let currentPurchaseItems = [];
let currentPurchaseOrderItems = [];
let purchaseSearchResults = [];

// Seed Data for Standalone / Offline mode
const initialLocalData = {
  categories: [],
  products: [],
  // New offline installations start with no seeded users. Existing local
  // data is preserved and migrated below; the server creates the owner account.
  users: [],
  customers: [
    {
      "id": 1,
      "name": "عميل نقدي",
      "phone": "",
      "notes": "عميل نقدي افتراضي",
      "balance": 0
    }
  ],
  suppliers: [],
  sales: [],
  suspended_sales: [],
  sale_items: [],
  purchases: [],
  purchase_items: [],
  stock_movements: [],
  employees: [],
  employee_transactions: [],
  audit_logs: [
    {
      id: 1,
      user_id: 1,
      action: "تهيئة النظام",
      entity: "system",
      entity_id: 1,
      details: "بدء تهيئة النظام بنجاح",
      created_at: new Date().toISOString().replace('T', ' ').substring(0, 19)
    }
  ]
};

// ----------------------------------------------------
// Data Layer (Offline / Online sync)
// ----------------------------------------------------
const LOCAL_PASSWORD_HASH_ITERATIONS = 600000;
const DEFAULT_BOOTSTRAP_PASSWORDS = Object.freeze(['admin123', 'inv123', 'cash123']);
function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function base64UrlToBytes(value) {
  const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}
async function hashLocalPassword(password) {
  if (!globalThis.crypto?.subtle) throw new Error('تشفير كلمات المرور غير متاح في هذا المتصفح. شغّل التطبيق من برنامجه المحلي.');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const key = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: LOCAL_PASSWORD_HASH_ITERATIONS }, key, 256);
  return `pbkdf2-sha256$${LOCAL_PASSWORD_HASH_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(bits)}`;
}
async function verifyLocalPassword(password, encoded) {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) return false;
  const salt = base64UrlToBytes(parts[2]);
  const expected = base64UrlToBytes(parts[3]);
  if (expected.length !== 32) return false;
  const key = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const actual = new Uint8Array(await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}

class StorageManager {
  constructor() {
    this.useApi = false;
    this.init();
  }

  requireCatalogServer() {
    if (!this.useApi) throw new Error('هذه الميزة تتطلب تشغيل الخادم.');
  }

  async init() {
    // Check if Node server is up
    try {
      const res = await fetch('/api/config', { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        this.useApi = true;
        console.log("Connected to Node.js Backend API");
      }
    } catch (e) {
      this.useApi = false;
      console.log("Using Browser Offline LocalStorage Mode");
    }

    if (!localStorage.getItem(LOCAL_DATA_KEY)) {
      // The legacy data key is read exactly once by migrateLegacySystemStorage.
      // Corrupt legacy data is intentionally retained there for manual recovery.
      localStorage.setItem(LOCAL_DATA_KEY, JSON.stringify(initialLocalData));
    }
    if (!this.useApi) {
      const localData = this.getLocalData();
      let migrated = false;
      const localAdmin = (localData.users || []).find(user => user.username === 'admin');
      if (localAdmin) {
        const hashParts = String(localAdmin.password_hash || '').split('$');
        let usableHash = false;
        try {
          usableHash = hashParts.length === 4
            && hashParts[0] === 'pbkdf2-sha256'
            && Number.isInteger(Number(hashParts[1]))
            && Number(hashParts[1]) >= 100000
            && Number(hashParts[1]) <= 1000000
            && base64UrlToBytes(hashParts[3]).length === 32;
        } catch (_) {
          usableHash = false;
        }
        if (!usableHash) {
          const recoveryPassword = `Recovery-${crypto.randomUUID().slice(0, 8)}!`;
          localAdmin.password_hash = await hashLocalPassword(recoveryPassword);
          localAdmin.must_change_password = true;
          localAdmin.bootstrap_password_initialized = true;
          console.warn('[AUTH] Existing offline admin hash was reset; temporary recovery password:', recoveryPassword);
          migrated = true;
        }
      }
      let defaultPasswordMigration = false;
      for (const user of (localData.users || [])) {
        let matchedDefault = false;
        if (typeof user.password_hash === 'string' && !user.password_hash.startsWith('pbkdf2-sha256$')) {
          matchedDefault = DEFAULT_BOOTSTRAP_PASSWORDS.includes(user.password_hash);
          user.password_hash = await hashLocalPassword(user.password_hash);
          migrated = true;
        } else if (typeof user.password_hash === 'string') {
          for (const defaultPassword of DEFAULT_BOOTSTRAP_PASSWORDS) {
            // Intentionally ignored: malformed local hashes are handled by recovery migration
            try {
              if (await verifyLocalPassword(defaultPassword, user.password_hash)) { matchedDefault = true; break; }
            } catch (_) {}
          }
        }
        if (matchedDefault && user.username !== 'admin1' && user.must_change_password !== true) {
          user.must_change_password = true;
          defaultPasswordMigration = true;
        }
      }
      if (!localData.system_settings || typeof localData.system_settings !== 'object') localData.system_settings = {};
      if (defaultPasswordMigration || !localData.system_settings.last_user_migration) {
        localData.system_settings.last_user_migration = new Date().toISOString();
        migrated = true;
      }
      if (migrated) this.saveLocalData(localData);
    }
  }

  getLocalData() {
    // Intentionally ignored: corrupt local data falls back to safe defaults
    try {
      const data = JSON.parse(localStorage.getItem(LOCAL_DATA_KEY)) || initialLocalData;
      delete data.business_catalog;
      return data;
    } catch (e) {
      return initialLocalData;
    }
  }

  saveLocalData(data) {
    const mainData = { ...data };
    delete mainData.business_catalog;
    localStorage.setItem(LOCAL_DATA_KEY, JSON.stringify(mainData));
  }

  getLocalBusinessCatalog() {
    // Intentionally ignored: missing local catalog is treated as empty
    try {
      const rows = JSON.parse(localStorage.getItem('system_business_catalog') || '[]');
      return Array.isArray(rows) ? rows : [];
    } catch (_) { return []; }
  }

  saveLocalBusinessCatalog(rows) {
    localStorage.setItem('system_business_catalog', JSON.stringify(rows));
  }

  logLocalAudit(userId, action, entity, entityId, details) {
    const data = this.getLocalData();
    const nextId = (data.audit_logs && data.audit_logs.length)
      ? Math.max(...data.audit_logs.map(l => l.id || 0)) + 1
      : 1;
    const log = {
      id: nextId,
      user_id: userId,
      action,
      entity,
      entity_id: entityId,
      details: typeof details === 'object' ? JSON.stringify(details) : String(details),
      created_at: new Date().toISOString().replace('T', ' ').substring(0, 19)
    };
    data.audit_logs.unshift(log);
    this.saveLocalData(data);
  }

  // --- Products ---
  async getProducts() {
    if (this.useApi) {
      const res = await fetch('/api/products');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'تعذر حفظ فاتورة الشراء في قاعدة البيانات.');
      return json;
    }
    const data = this.getLocalData();
    return data.products.map(p => {
      const cat = data.categories.find(c => c.id === p.category_id);
      return {
        ...p,
        category_name: cat ? cat.name : 'غير محدد',
        is_low_stock: p.quantity <= p.min_stock
      };
    });
  }

  async saveProduct(product) {
    if (this.useApi) {
      const method = product.id ? 'PUT' : 'POST';
      const url = product.id ? `/api/products/${product.id}` : '/api/products';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...product })
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'تعذر حفظ بيانات المنتج.');
      return result;
    }

    const data = this.getLocalData();
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    if (product.id) {
      const idx = data.products.findIndex(p => p.id === parseInt(product.id));
      if (idx !== -1) {
        const old = data.products[idx];
        if (product.quantity !== old.quantity) {
          const diff = product.quantity - old.quantity;
          data.stock_movements.push({
            id: Date.now(),
            product_id: old.id,
            type: 'adjustment',
            quantity: diff,
            reference_id: 'MANUAL_EDIT',
            created_at: now
          });
          this.logLocalAudit(currentUser.id, 'تعديل كمية يدوي', 'products', old.id, `تعديل رصيد ${old.name} من ${old.quantity} إلى ${product.quantity}`);
        }
        data.products[idx] = { ...old, ...product, id: old.id, updated_at: now };
        this.saveLocalData(data);
        this.logLocalAudit(currentUser.id, 'تعديل منتج', 'products', old.id, `تعديل المنتج ${product.name}`);
        return data.products[idx];
      }
    } else {
      const newId = data.products.length ? Math.max(...data.products.map(p => p.id)) + 1 : 1;
      const barcode = product.barcode ? product.barcode.trim() : '';
      const newProd = {
        ...product,
        id: newId,
        barcode,
        created_at: now,
        updated_at: now
      };
      data.products.push(newProd);
      if (newProd.quantity > 0) {
        data.stock_movements.push({
          id: Date.now(),
          product_id: newProd.id,
          type: 'adjustment',
          quantity: newProd.quantity,
          reference_id: 'INITIAL',
          created_at: now
        });
      }
      this.saveLocalData(data);
      this.logLocalAudit(currentUser.id, 'إضافة منتج', 'products', newId, `إضافة منتج: ${newProd.name}`);
      return newProd;
    }
  }

  async importCatalog(rows, { updatePrices = false, all = false } = {}) {
    this.requireCatalogServer();
    if (this.useApi) {
      const res = await fetch('/api/business-catalog/add-to-inventory', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(all ? { all: true, update_prices: updatePrices } : { ids: rows.map(row => Number(row.id)).filter(Number.isFinite), update_prices: updatePrices }) });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'تعذر استيراد كتالوج المنتجات.');
      return result;
    }

    const data = this.getLocalData();
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const categories = data.categories || [];
    const defaultCategory = categories[0]?.id || 1;
    const totals = { added: 0, updated: 0, skipped: 0 };
    rows.forEach(row => {
      const barcode = String(row.barcode || '').trim();
      const name = String(row.name || '').trim();
      if (!name) { totals.skipped++; return; }
      const rowCategory = normalizeCatalogText(row.category || '');
      const rowUnit = normalizeCatalogText(row.unit || 'قطعة');
      const matchesNameUnitCategory = product => normalizeCatalogText(product.name) === normalizeCatalogText(name)
        && normalizeCatalogText(product.unit || 'قطعة') === rowUnit
        && (!rowCategory || normalizeCatalogText(categories.find(category => category.id === product.category_id)?.name || '') === rowCategory);
      let old = barcode ? data.products.find(product => String(product.barcode || '').trim() === barcode) : null;
      if (!old && barcode) old = data.products.find(product => !String(product.barcode || '').trim() && matchesNameUnitCategory(product));
      if (!old && !barcode) old = data.products.find(matchesNameUnitCategory);
      const details = {
        generic_name: row.generic_name || '', active_ingredient: row.active_ingredient || '',
        scientific_name: row.scientific_name || '', manufacturer: row.manufacturer || '',
        strength: row.strength || '', dosage_form: row.dosage_form || ''
      };
      const matchedCategory = categories.find(category => String(category.name || '').trim().toLocaleLowerCase() === String(row.category || '').trim().toLocaleLowerCase());
      if (old) {
        Object.assign(old, Object.fromEntries(Object.entries(details).filter(([, value]) => value)));
        if (!old.name) old.name = name;
        if (updatePrices) {
          for (const key of ['cost_price', 'sale_price']) { const value = row[key]; if (value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0) old[key] = Number(value); }
        }
        if (row.min_stock !== undefined && row.min_stock !== null && row.min_stock !== '' && Number.isFinite(Number(row.min_stock)) && Number(row.min_stock) > 0) old.min_stock = Number(row.min_stock);
        if (row.unit) old.unit = String(row.unit).trim() || old.unit;
        if (matchedCategory) old.category_id = matchedCategory.id;
        old.updated_at = now;
        totals.updated++;
      } else {
        data.products.push({ id: data.products.length ? Math.max(...data.products.map(p => p.id)) + 1 : 1,
          name, barcode, category_id: matchedCategory?.id || defaultCategory,
          cost_price: Number(row.cost_price) || 0, sale_price: Number(row.sale_price) || 0, quantity: 0,
          min_stock: Number.isFinite(Number(row.min_stock)) ? Math.max(0, Number(row.min_stock)) : 5, unit: String(row.unit || 'قطعة').trim(), notes: String(row.notes || '').trim(), ...details, created_at: now, updated_at: now });
        totals.added++;
      }
    });
    this.saveLocalData(data);
    return totals;
  }

  async getBusinessCatalog() {
    this.requireCatalogServer();
    if (this.useApi) {
      const res = await fetch('/api/business-catalog');
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'تعذر تحميل الكتالوج المستقل.');
      return result.items || [];
    }
    return this.getLocalBusinessCatalog();
  }

  async addBusinessCatalog(rows, metadata = {}) {
    this.requireCatalogServer();
    if (this.useApi) {
      const totals = { added: 0, skipped: 0, total: 0 };
      for (let offset = 0; offset < rows.length; offset += 500) {
        const res = await fetch('/api/business-catalog/import', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: rows.slice(offset, offset + 500), file_name: metadata.fileName || '', activity: metadata.activity || '' }) });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'تعذر حفظ الكتالوج.');
        totals.added += result.added || 0; totals.skipped += result.skipped || 0; totals.total = result.total || totals.total;
      }
      return totals;
    }
    const data = this.getLocalData();
    const catalog = this.getLocalBusinessCatalog();
    const existing = new Set(catalog.map(item => item.barcode ? `b:${item.barcode}` : `n:${normalizeCatalogText(item.name)}|${normalizeCatalogText(item.unit || 'قطعة')}`));
    let added = 0, skipped = 0;
    for (const raw of rows) {
      const item = { ...raw, id: Date.now() + Math.floor(Math.random() * 1000000), name: String(raw.name || '').trim(), barcode: String(raw.barcode || '').trim(), unit: String(raw.unit || 'قطعة').trim(), catalog_file: metadata.fileName || '', activity: metadata.activity || '' };
      const key = item.barcode ? `b:${item.barcode}` : `n:${normalizeCatalogText(item.name)}|${normalizeCatalogText(item.unit)}`;
      if (!item.name || existing.has(key)) { skipped++; continue; }
      existing.add(key); catalog.push(item); added++;
    }
    this.saveLocalBusinessCatalog(catalog); this.logLocalAudit(currentUser.id, 'رفع كتالوج مستقل', 'business_catalog', 0, `إضافة ${added} صنف`);
    return { added, skipped, total: catalog.length };
  }

  async saveBusinessCatalog(rows) {
    this.requireCatalogServer();
    if (this.useApi) {
      const saved = [];
      for (let offset = 0; offset < rows.length; offset += 500) {
        const res = await fetch('/api/business-catalog', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: rows.slice(offset, offset + 500) }) });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'تعذر حفظ تعديلات الكتالوج.');
        saved.push(...(result.items || []));
      }
      return saved;
    }
    const data = this.getLocalData();
    const catalog = this.getLocalBusinessCatalog();
    let nextId = catalog.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
    const saved = rows.map(item => ({ ...item, id: Number(item.id) || nextId++ }));
    this.saveLocalBusinessCatalog(saved); this.logLocalAudit(currentUser.id, 'تعديل كتالوج مستقل', 'business_catalog', 0, `حفظ ${saved.length} صنف`);
    return saved;
  }

  async deleteBusinessCatalog(ids = [], deleteAll = false) {
    this.requireCatalogServer();
    if (this.useApi) {
      const res = await fetch('/api/business-catalog', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, all: deleteAll }) });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'تعذر حذف أصناف الكتالوج.');
      return result;
    }
    const data = this.getLocalData();
    const selected = new Set(ids.map(Number));
    const catalog = this.getLocalBusinessCatalog();
    const before = catalog.length;
    const remaining = deleteAll ? [] : catalog.filter(item => !selected.has(Number(item.id)));
    this.saveLocalBusinessCatalog(remaining); this.logLocalAudit(currentUser.id, deleteAll ? 'حذف الكتالوج المستقل بالكامل' : 'حذف أصناف من الكتالوج المستقل', 'business_catalog', 0, `حذف ${before - remaining.length} صنف`);
    return { deleted: before - remaining.length, total: remaining.length };
  }

  async deleteProduct(id) {
    if (this.useApi) {
      const res = await fetch(`/api/products/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'فشل حذف المنتج');
      return json;
    }
    const data = this.getLocalData();
    const idx = data.products.findIndex(p => p.id === id);
    if (idx !== -1) {
      const removed = data.products.splice(idx, 1)[0];
      this.saveLocalData(data);
      this.logLocalAudit(currentUser.id, 'حذف منتج', 'products', id, `حذف المنتج: ${removed.name}`);
      return { success: true };
    }
  }

  // --- Categories ---
  async getCategories() {
    if (this.useApi) {
      const res = await fetch('/api/categories');
      return await res.json();
    }
    const data = this.getLocalData();
    return data.categories.map(c => {
      const count = data.products.filter(p => p.category_id === c.id).length;
      return { ...c, product_count: count };
    });
  }

  async saveCategory(name) {
    if (this.useApi) {
      const res = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      return await res.json();
    }
    const data = this.getLocalData();
    const newId = data.categories.length ? Math.max(...data.categories.map(c => c.id)) + 1 : 1;
    const newCat = {
      id: newId,
      name,
      created_at: new Date().toISOString().replace('T', ' ').substring(0, 19)
    };
    data.categories.push(newCat);
    this.saveLocalData(data);
    this.logLocalAudit(currentUser.id, 'إضافة فئة', 'categories', newId, `إضافة فئة: ${name}`);
    return newCat;
  }

  async deleteCategory(id) {
    if (this.useApi) {
      const res = await fetch(`/api/categories/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'فشل حذف الفئة');
      return json;
    }
    const data = this.getLocalData();
    const linked = data.products.filter(p => p.category_id === id);
    if (linked.length > 0) {
      throw new Error(`لا يمكن حذف هذه الفئة لوجود (${linked.length}) منتج مرتبط بها.`);
    }
    const idx = data.categories.findIndex(c => c.id === id);
    if (idx !== -1) {
      const removed = data.categories.splice(idx, 1)[0];
      this.saveLocalData(data);
      this.logLocalAudit(currentUser.id, 'حذف فئة', 'categories', id, `حذف فئة: ${removed.name}`);
      return { success: true };
    }
  }

  async updateCategory(id, name) {
    const res = await fetch(`/api/categories/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'فشل تعديل الفئة');
    return json;
  }

  // --- Customers & Suppliers ---
  async getCustomers() {
    if (this.useApi) return await (await fetch('/api/customers')).json();
    return this.getLocalData().customers || [];
  }
  async saveCustomer(cust) {
    if (this.useApi) {
      return await (await fetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...cust })
      })).json();
    }
    const data = this.getLocalData();
    const id = data.customers.length ? Math.max(...data.customers.map(c => c.id)) + 1 : 1;
    const newCust = { ...cust, id, balance: 0 };
    data.customers.push(newCust);
    this.saveLocalData(data);
    this.logLocalAudit(currentUser.id, 'إضافة عميل', 'customers', id, `إضافة عميل: ${newCust.name}`);
    return newCust;
  }

  async updateCustomer(id, customer) {
    const res = await fetch(`/api/customers/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...customer }) });
    const json = await res.json(); if (!res.ok) throw new Error(json.error || 'فشل تعديل العميل'); return json;
  }
  async deleteCustomer(id) {
    const res = await fetch(`/api/customers/${id}`, { method: 'DELETE' });
    const json = await res.json(); if (!res.ok) throw new Error(json.error || 'فشل حذف العميل'); return json;
  }
  async getCustomerLedger(id) { const res = await fetch(`/api/customers/${id}/ledger`); return await res.json(); }
  async payCustomer(id, amount, notes) { const res = await fetch(`/api/customers/${id}/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount, notes }) }); const json = await res.json(); if (!res.ok) throw new Error(json.error || 'فشل تسجيل السداد'); return json; }

  async getSuppliers() {
    if (this.useApi) return await (await fetch('/api/suppliers')).json();
    return this.getLocalData().suppliers || [];
  }
  async saveSupplier(supp) {
    if (this.useApi) {
      return await (await fetch('/api/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...supp })
      })).json();
    }
    const data = this.getLocalData();
    const id = data.suppliers.length ? Math.max(...data.suppliers.map(s => s.id)) + 1 : 1;
    const newSupp = { ...supp, id, balance: 0 };
    data.suppliers.push(newSupp);
    this.saveLocalData(data);
    this.logLocalAudit(currentUser.id, 'إضافة مورد', 'suppliers', id, `إضافة مورد: ${newSupp.name}`);
    return newSupp;
  }

  async updateSupplier(id, supplier) { const res = await fetch(`/api/suppliers/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...supplier }) }); const json = await res.json(); if (!res.ok) throw new Error(json.error || 'فشل تعديل المورد'); return json; }
  async deleteSupplier(id) { const res = await fetch(`/api/suppliers/${id}`, { method: 'DELETE' }); const json = await res.json(); if (!res.ok) throw new Error(json.error || 'فشل حذف المورد'); return json; }
  async getSupplierLedger(id) { const res = await fetch(`/api/suppliers/${id}/ledger`); return await res.json(); }
  async paySupplier(id, amount, notes) { const res = await fetch(`/api/suppliers/${id}/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount, notes }) }); const json = await res.json(); if (!res.ok) throw new Error(json.error || 'فشل تسجيل السداد'); return json; }

  // --- Suspended POS tickets ---
  async getSuspendedSales() {
    if (this.useApi) {
      const res = await fetch(`/api/suspended-sales?user_id=${currentUser.id}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'تعذر تحميل الفواتير المعلقة');
      return json;
    }
    return (this.getLocalData().suspended_sales || []).filter(row => row.user_id === currentUser.id);
  }

  async suspendSale(ticket) {
    if (this.useApi) {
      const res = await fetch('/api/suspended-sales', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ticket) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'تعذر تعليق الفاتورة');
      return json;
    }
    const data = this.getLocalData();
    if (!Array.isArray(data.suspended_sales)) data.suspended_sales = [];
    const id = data.suspended_sales.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const saved = { ...ticket, id, created_at: now, updated_at: now };
    data.suspended_sales.push(saved);
    this.saveLocalData(data);
    return saved;
  }

  async deleteSuspendedSale(id) {
    if (this.useApi) {
      const res = await fetch(`/api/suspended-sales/${id}?user_id=${currentUser.id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'تعذر حذف الفاتورة المعلقة');
      return json;
    }
    const data = this.getLocalData();
    data.suspended_sales = (data.suspended_sales || []).filter(row => !(row.id === id && row.user_id === currentUser.id));
    this.saveLocalData(data);
    return { message: 'تم حذف الفاتورة المعلقة' };
  }

  async takeSuspendedSale(id) {
    if (this.useApi) {
      const res = await fetch(`/api/suspended-sales/${id}/consume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'تعذر استرجاع الفاتورة المعلقة');
      return json;
    }
    const data = this.getLocalData();
    const ticket = (data.suspended_sales || []).find(row => row.id === id && row.user_id === currentUser.id);
    if (!ticket) throw new Error('الفاتورة المعلقة غير موجودة');
    data.suspended_sales = data.suspended_sales.filter(row => row.id !== id);
    this.saveLocalData(data);
    return ticket;
  }

  async discardSuspendedSale(id) {
    if (this.useApi) {
      const res = await fetch(`/api/suspended-sales/${id}/discard`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'تعذر حذف الفاتورة المعلقة');
      return json;
    }
    return this.deleteSuspendedSale(id);
  }

  // --- POS Sale Transaction ---
  async completeSale(saleData) {
    if (this.useApi) {
      // Intentionally ignored: transaction history API failure falls back to local storage
      try {
        const res = await fetch('/api/sales', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(saleData)
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'فشل إتمام البيع');
        return json;
      } catch (error) {
        if (error instanceof TypeError || !navigator.onLine) {
          const queued = await queueOfflineSale(saleData);
          return { pending_sync: true, client_transaction_id: queued.client_transaction_id, queued_at: queued.queued_at };
        }
        throw error;
      }
    }

    const data = this.getLocalData();
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const dateCode = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    // Stock check
    for (const item of saleData.items) {
      const prod = data.products.find(p => p.id === item.product_id);
      if (!prod) throw new Error('منتج غير موجود');
      if (prod.quantity < item.quantity) {
        throw new Error(`الكمية المتوفرة من [${prod.name}] هي (${prod.quantity}) فقط!`);
      }
    }

    const saleId = data.sales.length ? Math.max(...data.sales.map(s => s.id)) + 1 : 1;
    const invoiceNumber = `INV-${dateCode}-${String(saleId).padStart(4, '0')}`;

    const newSale = {
      id: saleId,
      invoice_number: invoiceNumber,
      customer_id: saleData.customer_id || 1,
      user_id: saleData.user_id || currentUser.id,
      subtotal: saleData.subtotal,
      discount: saleData.discount,
      taxable_amount: saleData.taxable_amount,
      tax_rate: saleData.tax_rate,
      tax_amount: saleData.tax_amount,
      tax_registration_number: taxSettings.registration_number,
      total: saleData.total,
      paid_amount: saleData.paid_amount,
      change_amount: saleData.change_amount,
      payment_method: saleData.payment_method,
      created_at: now
    };
    data.sales.push(newSale);

    const createdItems = [];
    for (const item of saleData.items) {
      const prod = data.products.find(p => p.id === item.product_id);
      prod.quantity -= item.quantity;

      const saleItem = {
        id: Date.now() + Math.random(),
        sale_id: saleId,
        product_id: prod.id,
        quantity: item.quantity,
        unit_price: item.unit_price,
        cost_price: prod.cost_price,
        discount: item.discount || 0,
        total: (item.unit_price * item.quantity) - (item.discount || 0)
      };
      data.sale_items.push(saleItem);
      createdItems.push({ ...saleItem, product_name: prod.name });

      // Stock movement
      data.stock_movements.push({
        id: Date.now() + Math.random(),
        product_id: prod.id,
        type: 'sale',
        quantity: -item.quantity,
        reference_id: invoiceNumber,
        created_at: now
      });
    }

    this.saveLocalData(data);
    this.logLocalAudit(currentUser.id, 'إتمام بيع', 'sales', saleId, `فاتورة بيع رقم ${invoiceNumber} بقيمة ${newSale.total} ج.م`);

    return { ...newSale, items: createdItems };
  }

  async returnSale(saleId, items = null, reason = '', options = {}) {
    if (this.useApi) {
      const res = await fetch(`/api/sales/${saleId}/return`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, reason, override_closed_period: options.override_closed_period === true, override_reason: options.override_reason || '' })
      });
      const json = await res.json();
      if (!res.ok) { const error = new Error(json.error || 'فشل تسجيل المرتجع'); error.code = json.code || ''; error.status = res.status; throw error; }
      return json;
    }
    throw new Error('المرتجعات تحتاج إلى تشغيل الخادم المحلي');
  }
  async updateSale(id, data) {
    const res = await fetch(`/api/sales/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...data }) });
    const json = await res.json(); if (!res.ok) throw new Error(json.error || 'فشل تعديل الفاتورة'); return json;
  }

  // --- Purchases ---
  async savePurchase(purchaseData, branchId = null) {
    if (this.useApi) {
      const res = await fetch('/api/purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(branchId ? { 'X-Active-Branch': String(branchId) } : {}) },
        body: JSON.stringify(purchaseData)
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'تعذر حفظ فاتورة الشراء في قاعدة البيانات.');
      return json;
    }

    const data = this.getLocalData();
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const pid = data.purchases.length ? Math.max(...data.purchases.map(p => p.id)) + 1 : 1;

    let grandTotal = 0;
    purchaseData.items.forEach(it => {
      grandTotal += it.quantity * it.unit_cost;
    });

    const newPurchase = {
      id: pid,
      supplier_id: purchaseData.supplier_id,
      user_id: currentUser.id,
      total: grandTotal,
      created_at: now
    };
    data.purchases.push(newPurchase);

    purchaseData.items.forEach(it => {
      const prod = data.products.find(p => p.id === it.product_id);
      if (prod) {
        prod.quantity += parseInt(it.quantity);
        prod.cost_price = parseFloat(it.unit_cost);
        prod.updated_at = now;

        data.purchase_items.push({
          id: Date.now() + Math.random(),
          purchase_id: pid,
          product_id: prod.id,
          quantity: parseInt(it.quantity),
          unit_cost: parseFloat(it.unit_cost)
        });

        data.stock_movements.push({
          id: Date.now() + Math.random(),
          product_id: prod.id,
          type: 'purchase',
          quantity: parseInt(it.quantity),
          reference_id: `PUR-${pid}`,
          created_at: now
        });
      }
    });

    this.saveLocalData(data);
    this.logLocalAudit(currentUser.id, 'فاتورة شراء', 'purchases', pid, `فاتورة شراء رقم ${pid} بقيمة ${grandTotal} ج.م`);
    return newPurchase;
  }

  async updatePurchase(id, paidAmount) {
    const res = await fetch(`/api/purchases/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid_amount: paidAmount }) });
    const json = await res.json(); if (!res.ok) throw new Error(json.error || 'فشل تعديل فاتورة الشراء'); return json;
  }
  async deletePurchase(id) {
    const res = await fetch(`/api/purchases/${id}`, { method: 'DELETE' });
    const json = await res.json(); if (!res.ok) throw new Error(json.error || 'فشل إلغاء فاتورة الشراء'); return json;
  }

  // --- Inventory Adjust ---
  async adjustStock(productId, newQty, reason) {
    if (this.useApi) {
      const res = await fetch('/api/inventory/adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_id: productId, quantity: newQty, reason })
      });
      return await res.json();
    }

    const data = this.getLocalData();
    const prod = data.products.find(p => p.id === parseInt(productId));
    if (!prod) throw new Error('المنتج غير موجود');

    const oldQty = prod.quantity;
    const diff = parseInt(newQty) - oldQty;
    prod.quantity = parseInt(newQty);
    prod.updated_at = new Date().toISOString().replace('T', ' ').substring(0, 19);

    data.stock_movements.push({
      id: Date.now(),
      product_id: prod.id,
      type: 'adjustment',
      quantity: diff,
      reference_id: reason || 'تسوية جرد',
      created_at: prod.updated_at
    });

    this.saveLocalData(data);
    this.logLocalAudit(currentUser.id, 'تسوية مخزنية', 'products', prod.id, `تسوية رصيد ${prod.name} من ${oldQty} إلى ${newQty}`);
    return { success: true };
  }

  // --- Sales History ---
  async getSales() {
    if (this.useApi) return await (await fetch('/api/sales')).json();
    const data = this.getLocalData();
    return data.sales.map(s => {
      const cust = data.customers.find(c => c.id === s.customer_id);
      const user = data.users.find(u => u.id === s.user_id);
      const items = data.sale_items.filter(it => it.sale_id === s.id).map(it => {
        const prod = data.products.find(p => p.id === it.product_id);
        return { ...it, product_name: prod ? prod.name : 'غير محدد' };
      });
      return {
        ...s,
        customer_name: cust ? cust.name : 'عميل نقدي',
        cashier_name: user ? user.name : 'كاشير',
        items
      };
    }).reverse();
  }

  // --- Purchases List ---
  async getPurchases() {
    if (this.useApi) return await (await fetch('/api/purchases')).json();
    const data = this.getLocalData();
    return data.purchases.map(pur => {
      const supp = data.suppliers.find(s => s.id === pur.supplier_id);
      const user = data.users.find(u => u.id === pur.user_id);
      const items = data.purchase_items.filter(it => it.purchase_id === pur.id);
      return {
        ...pur,
        supplier_name: supp ? supp.name : 'مورد عام',
        user_name: user ? user.name : 'مسؤول',
        items_count: items.length
      };
    }).reverse();
  }

  // --- Stock Movements ---
  async getStockMovements() {
    if (this.useApi) return await (await fetch('/api/stock-movements')).json();
    const data = this.getLocalData();
    return (data.stock_movements || []).map(m => {
      const prod = data.products.find(p => p.id === m.product_id);
      return {
        ...m,
        product_name: prod ? prod.name : 'غير محدد',
        product_barcode: prod ? prod.barcode : ''
      };
    }).reverse();
  }

  // --- Users ---
  async getUsers() {
    if (this.useApi) return await (await fetch('/api/users')).json();
    return (this.getLocalData().users || []);
  }

  async login(username, password) {
    if (this.useApi) {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'بيانات الدخول غير صحيحة');
      return json;
    }

    const user = (this.getLocalData().users || []).find(u => u.username === username && u.is_active);
    if (!user || !await verifyLocalPassword(password, user.password_hash)) throw new Error('اسم المستخدم أو كلمة المرور غير صحيحة، أو الحساب معطل');
    return { id: user.id, name: user.name, username: user.username, must_change_password: Boolean(user.must_change_password), role: user.role, permissions: user.permissions || [] };
  }

  async saveUser(user) {
    if (this.useApi) {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...user })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'فشل إضافة المستخدم');
      return json;
    }
    const data = this.getLocalData();
    const id = data.users.length ? Math.max(...data.users.map(u => u.id)) + 1 : 1;
    const newUser = {
      id,
      name: user.name,
      username: user.username,
      password_hash: await hashLocalPassword(user.password),
      role: user.role,
      permissions: Array.isArray(user.permissions) ? user.permissions : [],
      is_active: true,
      created_at: new Date().toISOString().replace('T', ' ').substring(0, 19)
    };
    data.users.push(newUser);
    this.saveLocalData(data);
    this.logLocalAudit(currentUser.id, 'إضافة مستخدم', 'users', id, `إضافة مستخدم: ${newUser.name}`);
    return newUser;
  }

  async updateUser(id, user) {
    if (this.useApi) {
      const res = await fetch(`/api/users/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...user })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'فشل تعديل المستخدم');
      return json;
    }
    throw new Error('تعديل المستخدم يحتاج إلى تشغيل الخادم المحلي');
  }

  async changeOwnPassword(currentPassword, newPassword) {
    if (!currentPassword || !newPassword) throw new Error('أدخل كلمة المرور الحالية والجديدة.');
    if (this.useApi) {
      const res = await fetch('/api/me/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'تعذر تغيير كلمة المرور.');
      return json;
    }
    const data = this.getLocalData();
    const user = (data.users || []).find(entry => entry.id === currentUser.id);
    if (!user || !await verifyLocalPassword(currentPassword, user.password_hash)) throw new Error('كلمة المرور الحالية غير صحيحة.');
    user.password_hash = await hashLocalPassword(newPassword);
    this.saveLocalData(data);
    this.logLocalAudit(user.id, 'تغيير كلمة المرور', 'users', user.id, 'غيّر المستخدم كلمة مرور حسابه.');
    return { message: 'تم تغيير كلمة المرور بنجاح.' };
  }

  async toggleUserActive(userId) {
    if (this.useApi) {
      const users = await this.getUsers();
      const u = users.find(x => x.id === userId);
      if (!u) throw new Error('المستخدم غير موجود');
      if (u.id === currentUser.id && u.is_active) throw new Error('لا يمكن تعطيل المستخدم الحالي');
      const res = await fetch(`/api/users/${userId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_active: !u.is_active }) });
      const json = await res.json(); if (!res.ok) throw new Error(json.error || 'فشل تغيير صلاحية المستخدم'); return json;
    }
    const data = this.getLocalData();
    const u = data.users.find(x => x.id === userId);
    if (u) {
      u.is_active = !u.is_active;
      this.saveLocalData(data);
      this.logLocalAudit(currentUser.id, 'تعديل حالة مستخدم', 'users', userId, `تغيير حالة ${u.name} إلى ${u.is_active ? 'نشط' : 'معطل'}`);
    }
  }

  async deleteUser(userId) {
    if (userId === currentUser.id) throw new Error('لا يمكن حذف المستخدم الحالي أثناء تسجيل الدخول');
    if (this.useApi) {
      const res = await fetch(`/api/users/${userId}?purge_records=1`, { method: 'DELETE' });
      const json = await res.json(); if (!res.ok) throw new Error(json.error || 'فشل حذف المستخدم'); return json;
    }
    const data = this.getLocalData(); const user = (data.users || []).find(u => u.id === userId);
    if (!user) throw new Error('المستخدم غير موجود');
    user.is_active = false;
    data.audit_logs = (data.audit_logs || []).filter(log => log.user_id !== userId);
    this.saveLocalData(data);
    return { message: 'تم حذف المستخدم وسجلاته' };
  }

  // --- Employees & Payroll ---
  async getEmployees() {
    if (this.useApi) {
      // Intentionally ignored: transaction API failure falls back to local storage
      try {
        const res = await fetch('/api/employees');
        if (res.ok) return await res.json();
      } catch (e) {}
    }
    const data = this.getLocalData();
    if (!data.employees) data.employees = initialLocalData.employees;
    if (!data.employee_transactions) data.employee_transactions = initialLocalData.employee_transactions;

    return data.employees.map(emp => {
      const transactions = (data.employee_transactions || []).filter(t => t.employee_id === emp.id);
      let totalAdvances = 0;
      let totalBonuses = 0;
      let totalDeductions = 0;

      transactions.forEach(t => {
        if (t.type === 'advance') totalAdvances += t.amount;
        if (t.type === 'bonus') totalBonuses += t.amount;
        if (t.type === 'deduction') totalDeductions += t.amount;
      });

      const netPayable = emp.base_salary - totalAdvances + totalBonuses - totalDeductions;
      return {
        ...emp,
        total_advances: totalAdvances,
        total_bonuses: totalBonuses,
        total_deductions: totalDeductions,
        net_payable: netPayable,
        transactions_count: transactions.length
      };
    });
  }

  async saveEmployee(emp) {
    if (this.useApi) {
      const res = await fetch('/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...emp }) });
      const json = await res.json(); if (!res.ok) throw new Error(json.error || 'فشل حفظ بيانات الموظف'); return json;
    }

    const data = this.getLocalData();
    if (!data.employees) data.employees = [];
    const newId = data.employees.length ? Math.max(...data.employees.map(e => e.id)) + 1 : 1;
    const newEmp = {
      ...emp,
      id: newId,
      is_active: true,
      created_at: new Date().toISOString().replace('T', ' ').substring(0, 19)
    };
    data.employees.push(newEmp);
    this.saveLocalData(data);
    this.logLocalAudit(currentUser.id, 'إضافة موظف', 'employees', newId, `إضافة الموظف: ${newEmp.name} (راتب: ${newEmp.base_salary} ج.م)`);
    return newEmp;
  }

  async updateEmployee(id, emp) {
    if (this.useApi) {
    const res = await fetch(`/api/employees/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...emp }) });
      const json = await res.json(); if (!res.ok) throw new Error(json.error || 'فشل تعديل الموظف'); return json;
    }
    const data = this.getLocalData(); const item = (data.employees || []).find(e => e.id === id);
    if (!item) throw new Error('الموظف غير موجود'); Object.assign(item, emp); this.saveLocalData(data); return item;
  }

  async deleteEmployee(id) {
      if (this.useApi) { const res = await fetch(`/api/employees/${id}`, { method: 'DELETE' }); const json = await res.json(); if (!res.ok) throw new Error(json.error || 'فشل حذف الموظف'); return json; }
    const data = this.getLocalData(); const item = (data.employees || []).find(e => e.id === id); if (item) item.is_active = false; this.saveLocalData(data); return { message: 'تم تعطيل الموظف' };
  }

  async getAttendance(employeeId = '') {
    if (this.useApi) return await (await fetch(`/api/attendance${employeeId ? `?employee_id=${employeeId}` : ''}`)).json();
    return (this.getLocalData().attendance || []).filter(r => !employeeId || r.employee_id === Number(employeeId));
  }

  async markAttendance(employeeId, action) {
    const body = { employee_id: employeeId };
    if (this.useApi) { const res = await fetch(`/api/attendance/${action === 'in' ? 'check-in' : 'check-out'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employee_id: employeeId }) }); const json = await res.json(); if (!res.ok) throw new Error(json.error || 'تعذر تسجيل الحركة'); return json; }
    const data = this.getLocalData(); if (!data.attendance) data.attendance = []; const date = new Date().toISOString().slice(0, 10); let row = data.attendance.find(r => r.employee_id === employeeId && r.work_date === date); const now = new Date().toTimeString().slice(0, 5);
    if (action === 'in') { if (row?.check_in) throw new Error('تم تسجيل الحضور اليوم'); row ||= { id: Date.now(), employee_id: employeeId, work_date: date, check_in: now, check_out: null, hours: 0 }; data.attendance.push(row); } else { if (!row?.check_in) throw new Error('يجب تسجيل الحضور أولاً'); if (row.check_out) throw new Error('تم تسجيل الانصراف اليوم'); row.check_out = now; const m = ((Number(now.slice(0,2))*60+Number(now.slice(3))) - (Number(row.check_in.slice(0,2))*60+Number(row.check_in.slice(3)))); row.hours = Number(((m < 0 ? m + 1440 : m) / 60).toFixed(2)); } this.saveLocalData(data); return row;
  }

  async addEmployeeTransaction(trans) {
    if (this.useApi) {
      try {
        const res = await fetch(`/api/employees/${trans.employee_id}/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...trans })
        });
        if (res.ok) return await res.json();
      } catch (err) {
        logError({ type: '[1.16-C]', message: err?.message || String(err), stack: err?.stack || '' });
        showAppToast('حدث خطأ، حاول مرة أخرى', { tone: 'error' });
      }
    }

    const data = this.getLocalData();
    if (!data.employee_transactions) data.employee_transactions = [];
    const newId = data.employee_transactions.length ? Math.max(...data.employee_transactions.map(t => t.id)) + 1 : 1;
    const newTrans = {
      ...trans,
      id: newId,
      created_at: new Date().toISOString().replace('T', ' ').substring(0, 19)
    };
    data.employee_transactions.push(newTrans);
    this.saveLocalData(data);

    const typeLabels = {
      advance: 'سلفة نقدية',
      bonus: 'مكافأة / عمولة',
      deduction: 'خصم / جزاء',
      settlement: 'صرف راتب وتصفية'
    };
    const emp = (data.employees || []).find(e => e.id === trans.employee_id);
    this.logLocalAudit(currentUser.id, `حسابات موظف (${typeLabels[trans.type] || trans.type})`, 'employees', trans.employee_id, `تسجيل ${typeLabels[trans.type] || trans.type} بمبلغ ${trans.amount} ج.م للموظف ${emp ? emp.name : ''}`);
    return newTrans;
  }

  async getEmployeeTransactions(empId) {
    if (this.useApi) {
      try {
        const res = await fetch(`/api/employees/${empId}/transactions`);
        if (res.ok) return await res.json();
      } catch (e) {}
    }
    const data = this.getLocalData();
    return (data.employee_transactions || []).filter(t => t.employee_id === parseInt(empId)).reverse();
  }

  // --- Audit Logs ---
  async getAuditLogs() {
    if (this.useApi) return await (await fetch('/api/audit-logs')).json();
    const data = this.getLocalData();
    return (data.audit_logs || []).map(l => {
      const user = data.users.find(u => u.id === l.user_id);
      return { ...l, user_name: l.user_id === null || l.user_id === undefined ? 'بدون حساب' : user ? user.name : 'النظام' };
    });
  }

  // --- Dashboard Data Engine ---
  async getDashboardData() {
    if (this.useApi) {
      return await (await fetch('/api/dashboard')).json();
    }

    const data = this.getLocalData();
    const today = new Date().toISOString().slice(0, 10);
    const thisMonth = new Date().toISOString().slice(0, 7);

    const salesToday = data.sales.filter(s => s.created_at.startsWith(today) && s.status !== 'returned');
    const todaySales = salesToday.reduce((sum, s) => sum + s.total, 0);

    const salesMonth = data.sales.filter(s => s.created_at.startsWith(thisMonth) && s.status !== 'returned');
    const monthSales = salesMonth.reduce((sum, s) => sum + s.total, 0);

    // SPEC-KIT profit calculation rule: actual sale_price - cost_price * quantity
    let todayProfit = 0;
    salesToday.forEach(s => {
      const items = data.sale_items.filter(it => it.sale_id === s.id);
      items.forEach(it => {
        const itemProfit = (it.unit_price - (it.cost_price || 0)) * it.quantity;
        todayProfit += itemProfit - (it.discount || 0);
      });
    });

    let monthProfit = 0;
    salesMonth.forEach(s => {
      const items = data.sale_items.filter(it => it.sale_id === s.id);
      items.forEach(it => {
        const itemProfit = (it.unit_price - (it.cost_price || 0)) * it.quantity;
        monthProfit += itemProfit - (it.discount || 0);
      });
    });

    // Low stock items
    const lowStock = data.products.filter(p => p.quantity <= p.min_stock).map(p => {
      const cat = data.categories.find(c => c.id === p.category_id);
      return {
        id: p.id,
        name: p.name,
        category: cat ? cat.name : '',
        quantity: p.quantity,
        min_stock: p.min_stock,
        is_out_of_stock: p.quantity === 0
      };
    });

    // Top selling
    const countMap = {};
    data.sale_items.forEach(it => {
      countMap[it.product_id] = (countMap[it.product_id] || 0) + it.quantity;
    });
    const topSelling = Object.keys(countMap).map(pid => {
      const prod = data.products.find(p => p.id === parseInt(pid));
      return {
        id: pid,
        name: prod ? prod.name : 'غير محدد',
        total_sold: countMap[pid],
        sale_price: prod ? prod.sale_price : 0
      };
    }).sort((a, b) => b.total_sold - a.total_sold).slice(0, 5);

    // Last 7 days
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const daySales = data.sales.filter(s => s.created_at.startsWith(dateStr) && s.status !== 'returned').reduce((sum, s) => sum + s.total, 0);
      last7Days.push({
        date: dateStr,
        dayName: d.toLocaleDateString('ar-EG-u-nu-latn', { weekday: 'short' }),
        total: daySales
      });
    }

    return {
      today_sales: todaySales,
      today_profit: todayProfit,
      today_invoices_count: salesToday.length,
      month_sales: monthSales,
      month_profit: monthProfit,
      total_products_count: data.products.length,
      low_stock_count: lowStock.length,
      low_stock_products: lowStock,
      top_selling: topSelling,
      last_7_days: last7Days
    };
  }

  async getFinanceSummary() {
    if (this.useApi) return await (await fetch('/api/finance/summary')).json();
    const data = this.getLocalData();
    return {
      cash_balance: (data.cash_transactions || []).reduce((sum, t) => sum + (t.direction === 'out' ? -t.amount : t.amount), 0),
      customer_debt: (data.customers || []).reduce((sum, c) => sum + (c.balance || 0), 0),
      supplier_debt: (data.suppliers || []).reduce((sum, s) => sum + (s.balance || 0), 0)
    };
  }

  async getExpenses(from = '', to = '') {
    if (this.useApi) {
      const query = new URLSearchParams();
      if (from) query.set('from', from);
      if (to) query.set('to', to);
      const response = await fetch(`/api/expenses${query.size ? `?${query}` : ''}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'تعذر تحميل المصروفات.');
      return result;
    }
    const transactions = this.getLocalData().cash_transactions || [];
    return transactions.filter(item => {
      if (item.type !== 'expense') return false;
      const day = String(item.created_at || '').slice(0, 10);
      return (!from || day >= from) && (!to || day <= to);
    }).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || Number(b.id || 0) - Number(a.id || 0));
  }
}

const storage = new StorageManager();

// Short-lived renderer caches keep the POS responsive without allowing stale
// catalog data to survive a write. The in-flight promise also coalesces
// concurrent tab renders into one API request.
const CLIENT_CACHE_TTL = 60_000;
let clientProductsCache = { value: null, expiresAt: 0, promise: null };
let clientCategoriesCache = { value: null, expiresAt: 0, promise: null };
let posDependenciesCache = { value: null, expiresAt: 0, promise: null };

function invalidateClientProductCache() {
  clientProductsCache = { value: null, expiresAt: 0, promise: null };
  posDependenciesCache = { value: null, expiresAt: 0, promise: null };
}

function invalidateClientCategoryCache() {
  clientCategoriesCache = { value: null, expiresAt: 0, promise: null };
  posDependenciesCache = { value: null, expiresAt: 0, promise: null };
}

async function getCachedProducts() {
  if (Array.isArray(clientProductsCache.value) && clientProductsCache.expiresAt > Date.now()) return clientProductsCache.value;
  if (!clientProductsCache.promise) {
    clientProductsCache.promise = storage.getProducts().then(rows => {
      const value = Array.isArray(rows) ? rows : [];
      clientProductsCache.value = value;
      clientProductsCache.expiresAt = Date.now() + CLIENT_CACHE_TTL;
      return value;
    }).finally(() => { clientProductsCache.promise = null; });
  }
  return clientProductsCache.promise;
}

async function getCachedCategories() {
  if (Array.isArray(clientCategoriesCache.value) && clientCategoriesCache.expiresAt > Date.now()) return clientCategoriesCache.value;
  if (!clientCategoriesCache.promise) {
    clientCategoriesCache.promise = storage.getCategories().then(rows => {
      const value = Array.isArray(rows) ? rows : [];
      clientCategoriesCache.value = value;
      clientCategoriesCache.expiresAt = Date.now() + CLIENT_CACHE_TTL;
      return value;
    }).finally(() => { clientCategoriesCache.promise = null; });
  }
  return clientCategoriesCache.promise;
}

async function loadPosDependencies() {
  if (posDependenciesCache.value && posDependenciesCache.expiresAt > Date.now()) return posDependenciesCache.value;
  if (!posDependenciesCache.promise) {
    posDependenciesCache.promise = Promise.all([
      getCachedProducts(),
      getCachedCategories(),
      fetch('/api/settings').then(response => response.ok ? response.json() : null).catch(() => null),
      fetch('/api/wallets').then(response => response.ok ? response.json() : null).catch(() => null)
    ]).then(value => {
      posDependenciesCache.value = value;
      posDependenciesCache.expiresAt = Date.now() + CLIENT_CACHE_TTL;
      return value;
    }).finally(() => { posDependenciesCache.promise = null; });
  }
  return posDependenciesCache.promise;
}
const ACTIVE_BRANCH_KEY = 'system_active_branch_id';
let branchWorkspaceBranches = [];
let branchWarehouseNamesById = new Map();
let branchHiddenListMode = 'visible';
let branchPageRenderRequest = 0;
function branchHiddenStorageKey() { return `system_hidden_branch_cards_${Number(currentUser?.id || 0)}`; }
function getHiddenBranchIds() {
  // Intentionally ignored: missing UI visibility data means no branches are hidden
  try { const parsed = JSON.parse(localStorage.getItem(branchHiddenStorageKey()) || '[]'); return new Set(Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : []); }
  catch (_) { return new Set(); }
}
function updateBranchHiddenToggleButtons() {
  const hiddenCount = getHiddenBranchIds().size;
  document.querySelectorAll('[data-branch-hidden-toggle]').forEach(button => {
    button.textContent = branchHiddenListMode === 'hidden' ? 'العودة للفروع الظاهرة' : `عرض الفروع المخفية (${hiddenCount})`;
    button.setAttribute('aria-pressed', String(branchHiddenListMode === 'hidden'));
  });
}
function renderBranchManagementCard(branch, { warehouses = [], compact = false, warning = '' } = {}) {
  const branchId = Number(branch.id);
  const isDefault = branch.is_default === true;
  const statusClass = branch.is_active === false ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800';
  const statusText = branch.is_active === false ? 'متوقف' : 'نشط';
  const button = (label, action, style, aria = label, disabled = false) => `<button type="button" aria-label="${escapeHtml(aria)}" ${disabled ? 'disabled aria-disabled="true"' : `onclick="${action}"`} class="branch-management-action rounded-xl border ${style}">${escapeHtml(label)}</button>`;
  const warehouseText = warehouses.length ? warehouses.join('، ') : 'لا يوجد مخزن مسجل';
  const lockedStyle = 'border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed';
  const activeActionLabel = branch.is_active === false ? 'تفعيل الفرع' : 'إيقاف الفرع';
  const activeActionAria = isDefault ? 'الفرع الرئيسي لا يمكن إيقافه' : activeActionLabel;
  const hiddenActionLabel = branchHiddenListMode === 'hidden' ? 'إظهار في القائمة' : 'إخفاء من قائمة الإدارة';
  const hiddenActionAria = isDefault ? 'الفرع الرئيسي لا يمكن إخفاؤه' : hiddenActionLabel;
  return `<article class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm ${compact ? '' : 'space-y-3'}"><div class="flex flex-wrap items-start justify-between gap-3"><div class="min-w-0"><h4 class="text-base font-extrabold leading-7 text-slate-900">${escapeHtml(branch.name)}${isDefault ? ' <span class="text-xs font-bold text-slate-500">(الفرع الرئيسي)</span>' : ''}</h4><p class="mt-1 text-sm leading-6 text-slate-600">${escapeHtml(branch.address || 'العنوان غير مسجل')}</p>${!compact ? `<p class="mt-1 text-sm leading-6 text-slate-700"><span class="font-bold">المخزن:</span> ${escapeHtml(warehouseText)}</p>` : ''}${warning ? `<p role="status" class="mt-2 text-xs font-semibold text-amber-800">${escapeHtml(warning)}</p>` : ''}</div><span class="rounded-full px-3 py-1.5 text-xs font-bold ${statusClass}">${statusText}</span></div><div class="flex flex-wrap gap-2">${button('إدارة المخازن والفئات', `openBranchWarehouseManagement(${branchId})`, 'border-blue-700 bg-blue-700 text-white hover:bg-blue-800')}${button('تعديل بيانات الفرع', `editBranch(${branchId})`, 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50')}${button(activeActionLabel, `toggleBranch(${branchId},${branch.is_active === false})`, isDefault ? lockedStyle : branch.is_active === false ? 'border-emerald-200 bg-emerald-50 text-emerald-900 hover:bg-emerald-100' : 'border-amber-200 bg-amber-50 text-amber-950 hover:bg-amber-100', activeActionAria, isDefault)}${button(hiddenActionLabel, `setBranchCardHidden(${branchId},${branchHiddenListMode !== 'hidden'})`, isDefault ? lockedStyle : 'border-indigo-200 bg-indigo-50 text-indigo-900 hover:bg-indigo-100', hiddenActionAria, isDefault)}${button('حذف بعد التصفية', `deleteBranch(${branchId})`, isDefault ? lockedStyle : 'border-rose-200 bg-rose-50 text-rose-900 hover:bg-rose-100', isDefault ? 'لا يمكن حذف الفرع الرئيسي' : 'حذف بعد التصفية', isDefault)}</div></article>`;
}
function renderBranchManagementList(branches = branchWorkspaceBranches) {
  const lists = [document.getElementById('branches-list'), document.getElementById('settings-branches-list')].filter(Boolean);
  if (!lists.length || !isUnrestrictedAccount(currentUser)) return;
  const hiddenIds = getHiddenBranchIds();
  const rows = (branches || []).filter(branch => branchHiddenListMode === 'hidden' ? hiddenIds.has(Number(branch.id)) : !hiddenIds.has(Number(branch.id)));
  const html = rows.length ? `<div class="overflow-x-auto rounded-2xl border border-slate-200"><table class="w-full min-w-[760px] text-right text-sm"><thead class="bg-slate-50"><tr><th class="p-3">اسم الفرع</th><th class="p-3">العنوان</th><th class="p-3">الهاتف</th><th class="p-3">المستخدمون</th><th class="p-3">الحالة</th><th class="p-3">إجراءات</th></tr></thead><tbody>${rows.map(branch => { const id = Number(branch.id); const active = branch.is_active !== false; return `<tr class="border-t border-slate-100"><td class="p-3 font-bold">${escapeHtml(branch.name)}${branch.is_default ? ' (رئيسي)' : ''}</td><td class="p-3">${escapeHtml(branch.address || '—')}</td><td class="p-3" dir="ltr">${escapeHtml(branch.phone || '—')}</td><td class="p-3">${Number(branch.user_count || 0)}</td><td class="p-3"><span class="rounded-full px-2 py-1 text-xs font-bold ${active ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}">${active ? 'نشط' : 'متوقف'}</span></td><td class="p-3"><div class="flex flex-wrap gap-2"><button type="button" class="settings-master-btn secondary" onclick="editBranch(${id})">تعديل</button><button type="button" class="settings-master-btn secondary" onclick="openBranchUsers(${id})">المستخدمون</button><button type="button" class="settings-master-btn ${active ? 'warning' : ''}" onclick="toggleBranch(${id},${!active})" ${branch.is_default ? 'disabled' : ''}>${active ? 'تعطيل' : 'تفعيل'}</button></div></td></tr>`; }).join('')}</tbody></table></div>` : `<p class="col-span-full rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5 text-center text-sm font-semibold text-slate-600">${branchHiddenListMode === 'hidden' ? 'لا توجد فروع مخفية.' : 'لا توجد فروع ظاهرة في القائمة.'}</p>`;
  lists.forEach(list => { list.innerHTML = html; });
  updateBranchHiddenToggleButtons();
}
function toggleBranchHiddenList() { branchHiddenListMode = branchHiddenListMode === 'hidden' ? 'visible' : 'hidden'; renderBranchManagementList(); renderBranchWarehouseDashboard(); }
function setBranchCardHidden(branchId, hidden) {
  const branch = branchWorkspaceBranches.find(row => Number(row.id) === Number(branchId));
  if (!branch || branch.is_default || !isUnrestrictedAccount(currentUser)) return;
  const ids = getHiddenBranchIds(); hidden ? ids.add(Number(branchId)) : ids.delete(Number(branchId));
  // Intentionally ignored: local UI preference persistence is best-effort
  try { localStorage.setItem(branchHiddenStorageKey(), JSON.stringify([...ids])); }
  catch (_) { return showAppToast('تعذر حفظ إخفاء الفرع على هذا الجهاز.'); }
  renderBranchManagementList(); renderBranchWarehouseDashboard();
}
const rawdaOriginalFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (!url.includes('/api/') || /\/api\/(login|webauthn\/)/.test(url)) return rawdaOriginalFetch(input, init);
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  const branchId = localStorage.getItem(ACTIVE_BRANCH_KEY); if (branchId && !headers.has('X-Active-Branch')) headers.set('X-Active-Branch', branchId);
  const requestInit = { ...init, headers };
  const response = await rawdaOriginalFetch(input, requestInit);
  if (response.status !== 409 || typeof input !== 'string' || typeof init.body !== 'string') return response;
  const failure = await response.clone().json().catch(() => null);
  if (failure?.code !== 'NEGATIVE_BALANCE') return response;
  if (!await showAppConfirm(failure.error || 'رصيد الخزنة سيصبح سالباً. هل تريد المتابعة؟')) return response;
  let body;
  try { body = JSON.parse(init.body); } catch { return response; }
  return rawdaOriginalFetch(input, { ...requestInit, body: JSON.stringify({ ...body, confirm_negative_balance: true }) });
};
async function initializeBranchWorkspace() {
  const selector=document.getElementById('active-branch-selector'), panel=document.getElementById('branch-management-panel');
  if(!currentUser){selector?.classList.add('hidden');return;} const unrestricted=isUnrestrictedAccount(currentUser); panel?.classList.toggle('hidden',!unrestricted);
  const allowedIds = unrestricted ? null : (Array.isArray(currentUser.branch_ids) && currentUser.branch_ids.length ? currentUser.branch_ids.map(Number) : [Number(currentUser.branch_id || 0)]);
  const storedBranchId = Number(localStorage.getItem(ACTIVE_BRANCH_KEY) || 0);
  if(!unrestricted && (!allowedIds.includes(storedBranchId) || !storedBranchId) && currentUser.branch_id)localStorage.setItem(ACTIVE_BRANCH_KEY,String(currentUser.branch_id));
  // Intentionally ignored: branch setup failure is reported by the existing warning
  try { let response=await fetch('/api/branches'); if(!response.ok&&unrestricted&&localStorage.getItem(ACTIVE_BRANCH_KEY)){localStorage.removeItem(ACTIVE_BRANCH_KEY);response=await fetch('/api/branches');} if(!response.ok)throw new Error('تعذر تحميل الفروع.');
    const data=await response.json(), branches=data.branches||[]; branchWorkspaceBranches=branches; if(data.active_branch_id)localStorage.setItem(ACTIVE_BRANCH_KEY,String(data.active_branch_id));
    await renderBranchWarehouseDashboard(branches, data.can_manage === true);
    if(selector){selector.innerHTML=branches.map(b=>`<option value="${b.id}">${escapeHtml(b.name)}${b.is_default?' (رئيسي)':''}</option>`).join('');selector.value=String(data.active_branch_id||branches[0]?.id||'');selector.classList.toggle('hidden',!data.can_switch||branches.length<2);selector.onchange=()=>{localStorage.setItem(ACTIVE_BRANCH_KEY,selector.value);location.reload();};}
    const employeeBranchSelect=document.getElementById('emp-new-branch');
    if(employeeBranchSelect){const activeBranches=branches.filter(branch=>branch.is_active!==false);employeeBranchSelect.innerHTML=activeBranches.map(branch=>`<option value="${branch.id}">${escapeHtml(branch.name)}</option>`).join('');employeeBranchSelect.value=String(data.active_branch_id||currentUser.branch_id||branches[0]?.id||'');employeeBranchSelect.disabled=!unrestricted;document.getElementById('emp-branch-owner-field')?.classList.toggle('hidden',!unrestricted);document.getElementById('emp-branch-locked-field')?.classList.toggle('hidden',unrestricted);const lockedBranchName=document.getElementById('emp-branch-locked-name');if(lockedBranchName)lockedBranchName.textContent=branches.find(branch=>Number(branch.id)===Number(currentUser.branch_id||data.active_branch_id))?.name||'فرع العمل';}
    const employeeFilter=document.getElementById('employees-branch-filter');
    if(employeeFilter){const activeBranches=branches.filter(branch=>branch.is_active!==false);employeeFilter.innerHTML=activeBranches.map(branch=>`<option value="${branch.id}">${escapeHtml(branch.name)}</option>`).join('');employeeFilter.value=String(data.active_branch_id||branches[0]?.id||'');employeeFilter.classList.toggle('hidden',!unrestricted);document.getElementById('employees-branch-filter-field')?.classList.toggle('hidden',!unrestricted);employeeFilter.onchange=()=>{localStorage.setItem(ACTIVE_BRANCH_KEY,employeeFilter.value);if(selector)selector.value=employeeFilter.value;renderEmployees();};}
    renderBranchManagementList(branches);
    const branchSelect=document.getElementById('user-new-branch');if(branchSelect){branchSelect.innerHTML=branches.filter(b=>b.is_active!==false).map(b=>`<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');branchSelect.onchange=()=>{const selected=[...branchSelect.selectedOptions];if(selected.length>2){selected[selected.length-1].selected=false;showAppToast('يمكن ربط المستخدم بفرع أو فرعين كحد أقصى.');}};}document.getElementById('user-branch-field')?.classList.toggle('hidden',!unrestricted);
    const purchaseBranchSelect=document.getElementById('purchase-branch-select');
    if(purchaseBranchSelect){purchaseBranchSelect.innerHTML=branches.filter(branch=>branch.is_active!==false).map(branch=>`<option value="${Number(branch.id)}">${escapeHtml(branch.name)}${branch.is_default?' (رئيسي)':''}</option>`).join('');purchaseBranchSelect.value=String(data.active_branch_id||currentUser.branch_id||branches[0]?.id||'');purchaseBranchSelect.onchange=()=>loadPurchaseWarehouses(purchaseBranchSelect.value);document.getElementById('purchase-branch-field')?.classList.toggle('hidden',branches.length<2);}
    await refreshWarehouseUi();
  }catch(error){console.warn('Branch setup:',error.message);}
}

let warehouseWorkspaceRows = [];
async function renderBranchWarehouseDashboard(branches = branchWorkspaceBranches, canManage = isUnrestrictedAccount(currentUser)) {
  const widget = document.getElementById('dashboard-branch-warehouse-widget');
  const list = document.getElementById('dashboard-branch-warehouse-list');
  const warehouseTotal = document.getElementById('dashboard-warehouse-total');
  const warehouseTile = document.getElementById('dashboard-warehouses-tile');
  const warehouseTileCount = document.getElementById('dashboard-warehouse-tile-count');
  const warehouseTileBreakdown = document.getElementById('dashboard-warehouse-tile-breakdown');
  const warehouseTileItems = document.getElementById('dashboard-warehouse-items-total');
  const warehouseGroupSummary = document.getElementById('dashboard-group-warehouse-count');
  const cashWidget = document.getElementById('dashboard-branch-cash-widget');
  if (!widget || !list) return;
  widget.classList.toggle('hidden', !canManage);
  cashWidget?.classList.toggle('hidden', !canManage);
  warehouseTile?.classList.toggle('hidden', !canManage);
  if (!canManage) return;
  await renderDashboardBranchCashSummary();
  if (!branches.length) { list.innerHTML = '<p class="text-xs text-slate-500">لا توجد فروع مسجلة.</p>'; if (warehouseTotal) warehouseTotal.textContent = 'إجمالي المخازن: 0 (رئيسية: 0، فرعية: 0)'; if (warehouseTileCount) warehouseTileCount.textContent = `${new Intl.NumberFormat('en-US').format(0)} مخزن`; if (warehouseTileBreakdown) warehouseTileBreakdown.textContent = 'رئيسية 0 · فرعية 0'; if (warehouseTileItems) warehouseTileItems.textContent = 'الأصناف: 0 · الكميات: 0'; if (warehouseGroupSummary) warehouseGroupSummary.textContent = '0 مخزن · لا توجد فروع مسجلة'; return; }
  list.innerHTML = '<p class="text-xs text-slate-500">جارٍ تحميل الفروع والمخازن…</p>';
  const results = await Promise.all(branches.map(async branch => {
    try {
      const response = await fetch(`/api/warehouses?branch_id=${Number(branch.id)}&include_inactive=1`, { headers: { 'X-Active-Branch': String(branch.id) } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'تعذر تحميل المخزن.');
      const warehouses = data.warehouses || [];
      branchWarehouseNamesById.set(Number(branch.id), warehouses.map(row => row.name));
      return { html: renderBranchManagementCard(branch, { warehouses: warehouses.map(row => row.name) }), warehouses, failed: false };
    } catch (error) {
      return { html: renderBranchManagementCard(branch, { warning: `تعذر تحميل تفاصيل المخزن: ${error.message}` }), warehouses: [], failed: true };
    }
  }));
  if (warehouseTotal) {
    if (results.some(result => result.failed)) { warehouseTotal.textContent = 'تعذر حساب إجمالي المخازن بالكامل؛ تحقق من الاتصال ثم حدّث الشاشة.'; if (warehouseTileCount) warehouseTileCount.textContent = '—'; if (warehouseTileBreakdown) warehouseTileBreakdown.textContent = 'تعذر تحميل العدد'; if (warehouseGroupSummary) warehouseGroupSummary.textContent = 'تعذر تحميل ملخص المخازن'; }
    else {
      const allWarehouses = results.flatMap(result => result.warehouses);
      const subsidiaryCount = allWarehouses.filter(row => Number(row.parent_warehouse_id) > 0).length;
      const primaryCount = allWarehouses.length - subsidiaryCount;
      const formatCount = value => new Intl.NumberFormat('en-US').format(value);
      warehouseTotal.textContent = `إجمالي المخازن: ${formatCount(allWarehouses.length)} (رئيسية: ${formatCount(primaryCount)}، فرعية: ${formatCount(subsidiaryCount)})`;
      if (warehouseTileCount) warehouseTileCount.textContent = `${formatCount(allWarehouses.length)} مخزن`;
      if (warehouseTileBreakdown) warehouseTileBreakdown.textContent = `رئيسية ${formatCount(primaryCount)} · فرعية ${formatCount(subsidiaryCount)}`;
      if (warehouseGroupSummary) warehouseGroupSummary.textContent = `${formatCount(allWarehouses.length)} مخزن · رئيسية ${formatCount(primaryCount)} · فرعية ${formatCount(subsidiaryCount)}`;
    }
  }
  if (warehouseTileItems) {
    try {
      const response = await fetch('/api/warehouse-inventory-summary');
      const summary = await response.json();
      if (!response.ok) throw new Error(summary.error || 'تعذر تحميل إجمالي الأصناف.');
      const formatCount = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(Number(value) || 0);
      warehouseTileItems.textContent = `الأصناف: ${formatCount(summary.product_count)} · الكميات: ${formatCount(summary.total_quantity)}`;
      if (warehouseGroupSummary) warehouseGroupSummary.textContent += ` · أصناف ${formatCount(summary.product_count)}`;
    } catch (error) {
      warehouseTileItems.textContent = 'تعذر تحميل إجمالي الأصناف والكميات';
      if (warehouseGroupSummary) warehouseGroupSummary.textContent += ' · تعذر تحميل الأصناف';
      console.warn('Warehouse inventory dashboard summary:', error.message);
    }
  }
  const hiddenIds = getHiddenBranchIds();
  const filteredRows = results.filter((_, index) => branchHiddenListMode === 'hidden' ? hiddenIds.has(Number(branches[index].id)) : !hiddenIds.has(Number(branches[index].id)));
  list.innerHTML = filteredRows.map(result => result.html).join('') || `<p class="col-span-full rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5 text-center text-sm font-semibold text-slate-600">${branchHiddenListMode === 'hidden' ? 'لا توجد فروع مخفية.' : 'لا توجد فروع ظاهرة في القائمة.'}</p>`;
  updateBranchHiddenToggleButtons();
}

function formatBranchPageMoney(value) {
  return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value) || 0)} ج.م`;
}

function formatBranchPageCount(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(Number(value) || 0);
}

async function loadBranchPageDetails(branches) {
  const cashPromise = isUnrestrictedAccount(currentUser)
    ? fetch('/api/dashboard/branch-cash-summary').then(async response => response.ok ? (await response.json()).branches || [] : [])
    : Promise.resolve([]);
  const usersPromise = fetch('/api/users').then(async response => response.ok ? await response.json() : []).catch(() => []);
  const cashRows = await cashPromise.catch(() => []);
  const users = await usersPromise;
  const cashByBranch = new Map(cashRows.map(row => [Number(row.branch_id), row]));
  const usersByBranch = new Map();
  (Array.isArray(users) ? users : []).forEach(user => {
    const ids = Array.isArray(user.branch_ids) && user.branch_ids.length ? user.branch_ids : [user.branch_id];
    ids.map(Number).filter(Number.isInteger).forEach(branchId => {
      if (!usersByBranch.has(branchId)) usersByBranch.set(branchId, []);
      usersByBranch.get(branchId).push(user);
    });
  });
  const details = await Promise.all(branches.map(async branch => {
    const branchId = Number(branch.id);
    const headers = { 'X-Active-Branch': String(branchId) };
    let warehouses = [];
    let inventoryValue = 0;
    let employeeCount = 0;
    // Intentionally ignored: optional branch warehouse details may be unavailable
    try {
      const response = await fetch(`/api/warehouses?branch_id=${branchId}&include_inactive=1`, { headers });
      const data = await response.json();
      if (response.ok) warehouses = Array.isArray(data.warehouses) ? data.warehouses : [];
      const inventoryRows = (await Promise.all(warehouses.filter(row => row.is_active !== false).map(async warehouse => {
        const inventoryResponse = await fetch(`/api/warehouse-inventory?warehouse_id=${Number(warehouse.id)}`, { headers });
        return inventoryResponse.ok ? await inventoryResponse.json() : [];
      }))).flat();
      inventoryValue = inventoryRows.reduce((sum, row) => {
        const quantity = Number(row.direct_quantity ?? row.quantity) || 0;
        const product = row.product || {};
        const cost = Number(product.cost_price ?? product.purchase_price ?? product.buy_price ?? 0) || 0;
        return sum + (quantity * cost);
      }, 0);
    } catch (_) {}
    // Intentionally ignored: optional branch employee details may be unavailable
    try {
      const response = await fetch('/api/employees', { headers });
      if (response.ok) employeeCount = (await response.json()).length;
    } catch (_) {}
    const branchUsers = usersByBranch.get(branchId) || [];
    const manager = branchUsers.find(user => user.role === 'admin') || branchUsers[0] || null;
    return { branch, warehouses, inventoryValue, employeeCount, manager, cash: cashByBranch.get(branchId) || null };
  }));
  return details;
}

function renderBranchPageCard(detail) {
  const { branch, warehouses, inventoryValue, employeeCount, manager, cash } = detail;
  const branchId = Number(branch.id);
  const warehouseNames = warehouses.map(row => row.name).filter(Boolean);
  const warehouseText = warehouseNames.length ? warehouseNames.join('، ') : 'لا يوجد مخزن مسجل';
  const statusText = branch.is_active === false ? 'متوقف' : 'نشط';
  const managerName = manager?.name || manager?.username || (branch.is_default ? 'مدير النظام' : 'غير محدد');
  const phone = branch.phone || manager?.phone || 'غير مسجل';
  const cashValue = cash?.cash_balance ?? 0;
  return `<article class="branch-page-card" data-branch-id="${branchId}">
    <header class="branch-page-card-header"><div><h4>${escapeHtml(branch.name || 'فرع بدون اسم')}</h4><span>${branch.is_default ? 'WH-001 · الفرع الرئيسي' : `BR-${String(branchId).padStart(3, '0')}`}</span></div><span class="branch-page-status ${branch.is_active === false ? 'is-off' : ''}">${statusText}</span></header>
    <div class="branch-page-card-details">
      <p><i class="fa-solid fa-user-tie" aria-hidden="true"></i><span>المدير:</span> ${escapeHtml(managerName)}</p>
      <p><i class="fa-solid fa-phone" aria-hidden="true"></i><span>الهاتف:</span> ${escapeHtml(phone)}</p>
      <p><i class="fa-solid fa-location-dot" aria-hidden="true"></i><span>العنوان:</span> ${escapeHtml(branch.address || 'العنوان غير مسجل')}</p>
      <p><i class="fa-solid fa-warehouse" aria-hidden="true"></i><span>المخازن:</span> ${escapeHtml(warehouseText)}</p>
    </div>
    <div class="branch-page-card-balance"><span>رصيد الخزينة:</span><strong>${formatBranchPageMoney(cashValue)}</strong></div>
    <div class="branch-page-card-meta"><span><i class="fa-solid fa-users" aria-hidden="true"></i> ${formatBranchPageCount(employeeCount)} موظف</span><span><i class="fa-solid fa-boxes-stacked" aria-hidden="true"></i> ${formatBranchPageMoney(inventoryValue)}</span></div>
    <div class="branch-page-card-actions"><button type="button" class="is-primary" onclick="openBranchWarehouseManagement(${branchId})"><i class="fa-solid fa-boxes-stacked" aria-hidden="true"></i> عرض المخزون</button><button type="button" onclick="openBranchWarehouseManagement(${branchId})"><i class="fa-solid fa-warehouse" aria-hidden="true"></i> إدارة المخزن الرئيسي</button><button type="button" onclick="editBranch(${branchId})"><i class="fa-solid fa-pen" aria-hidden="true"></i> تعديل البيانات</button><button type="button" class="is-danger" ${branch.is_default ? 'disabled aria-disabled="true"' : `onclick="deleteBranch(${branchId})"`}><i class="fa-solid fa-trash" aria-hidden="true"></i> حذف الفرع</button></div>
  </article>`;
}

async function renderBranchWarehousePage() {
  const list = document.getElementById('branch-page-list');
  if (!list) return;
  const requestId = ++branchPageRenderRequest;
  const status = document.getElementById('branch-page-status');
  if (status) status.textContent = 'جارٍ تحميل بيانات الفروع والمخازن…';
  list.innerHTML = '<div class="branch-page-loading"><i class="fa-solid fa-spinner fa-spin"></i> جارٍ تحميل البيانات…</div>';
  try {
    const response = await fetch('/api/branches');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر تحميل الفروع.');
    const branches = Array.isArray(data.branches) ? data.branches : [];
    branchWorkspaceBranches = branches;
    const details = await loadBranchPageDetails(branches);
    if (requestId !== branchPageRenderRequest) return;
    const totalStockValue = details.reduce((sum, item) => sum + Number(item.inventoryValue || 0), 0);
    const totalEmployees = details.reduce((sum, item) => sum + Number(item.employeeCount || 0), 0);
    document.getElementById('branch-page-total-branches').textContent = formatBranchPageCount(branches.length);
    document.getElementById('branch-page-total-stock-value').textContent = formatBranchPageMoney(totalStockValue);
    document.getElementById('branch-page-total-employees').textContent = formatBranchPageCount(totalEmployees);
    document.getElementById('branch-page-list-count').textContent = `${formatBranchPageCount(branches.length)} فرع`;
    list.innerHTML = details.length ? details.map(renderBranchPageCard).join('') : '<div class="branch-page-empty"><i class="fa-solid fa-store-slash"></i><strong>لا توجد فروع مسجلة</strong><span>اضغط «إضافة فرع جديد» لبدء إعداد الفروع والمخازن.</span></div>';
    if (status) status.textContent = `تم تحديث البيانات · ${new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}`;
    if (window.lucide?.createIcons) window.lucide.createIcons();
  } catch (error) {
    if (requestId !== branchPageRenderRequest) return;
    list.innerHTML = `<div class="branch-page-empty is-error"><i class="fa-solid fa-triangle-exclamation"></i><strong>تعذر تحميل بيانات الفروع</strong><span>${escapeHtml(error.message || 'حدث خطأ غير متوقع.')}</span><button type="button" onclick="renderBranchWarehousePage()">إعادة المحاولة</button></div>`;
    if (status) status.textContent = 'تعذر تحديث البيانات';
  }
}

function openBranchWarehousePage() {
  switchTab('branch-warehouse');
}

const BRANCH_TREASURY_HIDDEN_KEY = 'system_branch_treasury_hidden';

function isBranchTreasuryHidden() {
  // Intentionally ignored: missing UI preference leaves treasury visible
  try { return localStorage.getItem(BRANCH_TREASURY_HIDDEN_KEY) === 'true'; } catch (_) { return false; }
}

function applyBranchTreasuryVisibility() {
  const content = document.getElementById('branch-treasury-content');
  const button = document.getElementById('btn-toggle-branch-treasury');
  if (!content || !button) return;
  const hidden = isBranchTreasuryHidden();
  const summary = document.getElementById('dashboard-group-cash-summary');
  content.classList.toggle('hidden', hidden);
  if (summary) {
    if (hidden) summary.textContent = 'الخزينة مخفية';
    else {
      const cash = document.getElementById('dashboard-cash-tile-total')?.textContent?.trim();
      const expenses = document.getElementById('dashboard-expenses-tile-total')?.textContent?.trim();
      if (cash && expenses) summary.textContent = `${cash} · ${expenses}`;
    }
  }
  button.setAttribute('aria-expanded', String(!hidden));
  button.setAttribute('aria-label', hidden ? 'إظهار الخزينة' : 'إخفاء الخزينة');
  const label = button.querySelector('[data-branch-treasury-toggle-label]');
  if (label) label.textContent = hidden ? 'إظهار الخزينة' : 'إخفاء الخزينة';
  const icon = button.querySelector('[data-branch-treasury-toggle-icon]') || button.querySelector('svg');
  if (icon) {
    icon.setAttribute('data-lucide', hidden ? 'eye' : 'eye-off');
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }
}

function toggleBranchTreasury() {
  const nextHidden = !isBranchTreasuryHidden();
  // Intentionally ignored: local UI preference persistence is best-effort
  try { localStorage.setItem(BRANCH_TREASURY_HIDDEN_KEY, String(nextHidden)); } catch (_) {}
  applyBranchTreasuryVisibility();
}

async function renderDashboardBranchCashSummary() {
  const requestId = ++dashboardBranchCashSummaryRequestId;
  applyBranchTreasuryVisibility();
  const totalCash = document.getElementById('dashboard-branch-cash-total');
  const totalExpenses = document.getElementById('dashboard-branch-expenses-total');
  const list = document.getElementById('dashboard-branch-cash-list');
  const cashTileTotal = document.getElementById('dashboard-cash-tile-total');
  const expensesTileTotal = document.getElementById('dashboard-expenses-tile-total');
  const cashGroupSummary = document.getElementById('dashboard-group-cash-summary');
  if (!totalCash || !totalExpenses || !list || !isUnrestrictedAccount(currentUser)) return;
  totalCash.textContent = 'جارٍ التحميل…';
  totalExpenses.textContent = 'جارٍ التحميل…';
  list.textContent = 'جارٍ تحميل أرصدة الفروع…';
  try {
    const response = await fetch('/api/dashboard/branch-cash-summary');
    const summary = await response.json();
    if (requestId !== dashboardBranchCashSummaryRequestId) return;
    if (!response.ok) throw new Error(summary.error || 'تعذر تحميل ملخص الخزائن.');
    const money = value => `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value) || 0)} ج.م`;
    totalCash.textContent = money(summary.total_cash_balance);
    totalExpenses.textContent = money(summary.total_expenses);
    if (cashTileTotal) cashTileTotal.textContent = `إجمالي الرصيد: ${money(summary.total_cash_balance)}`;
    if (expensesTileTotal) expensesTileTotal.textContent = `إجمالي المصروفات: ${money(summary.total_expenses)}`;
    if (cashGroupSummary) cashGroupSummary.textContent = `الرصيد ${money(summary.total_cash_balance)} · المصروفات ${money(summary.total_expenses)}`;
    const branches = Array.isArray(summary.branches) ? summary.branches : [];
    list.innerHTML = branches.length ? branches.map(branch => {
      const expenses = Array.isArray(branch.recent_expenses) ? branch.recent_expenses : [];
      const details = expenses.length
        ? `<details class="cash-expense-details mt-3"><summary>تفاصيل آخر المصروفات (${new Intl.NumberFormat('en-US').format(expenses.length)})</summary><ul class="mt-2 space-y-2">${expenses.map(item => `<li class="flex flex-wrap justify-between gap-2"><span>${escapeHtml(item.description || 'مصروف غير موصوف')}${item.created_at ? ` <small>${escapeHtml(item.created_at)}</small>` : ''}</span><strong>${money(item.amount)}</strong></li>`).join('')}</ul></details>`
        : '<p class="mt-3 text-xs text-slate-500">لا توجد مصروفات مسجلة لهذا الفرع.</p>';
      return `<article class="dashboard-cash-branch rounded-xl border border-slate-200 bg-slate-50 p-3"><div class="flex flex-wrap items-center justify-between gap-2"><h4 class="font-extrabold text-slate-900">${escapeHtml(branch.branch_name || 'فرع')}</h4><span class="rounded-full px-2 py-1 text-[11px] font-bold ${branch.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'}">${branch.is_active ? 'نشط' : 'متوقف'}</span></div><div class="mt-2 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2"><p class="rounded-lg bg-emerald-50 px-2 py-1.5 text-emerald-950"><span class="font-semibold">الرصيد النقدي المسجل للفرع:</span> <strong>${money(branch.cash_balance)}</strong></p><p class="rounded-lg bg-rose-50 px-2 py-1.5 text-rose-950"><span class="font-semibold">إجمالي المصروفات:</span> <strong>${money(branch.expenses)}</strong></p></div>${details}</article>`;
    }).join('') : '<p class="text-sm text-slate-500">لا توجد فروع مسجلة.</p>';
  } catch (error) {
    if (requestId !== dashboardBranchCashSummaryRequestId) return;
    totalCash.textContent = 'تعذر التحميل';
    totalExpenses.textContent = 'تعذر التحميل';
    if (cashTileTotal) cashTileTotal.textContent = 'تعذر تحميل إجمالي الرصيد';
    if (expensesTileTotal) expensesTileTotal.textContent = 'تعذر تحميل إجمالي المصروفات';
    if (cashGroupSummary) cashGroupSummary.textContent = 'تعذر تحميل ملخص الخزينة';
    list.textContent = `تعذر تحميل أرصدة الفروع: ${error.message}`;
    console.warn('Branch cash dashboard summary:', error.message);
  } finally {
    if (requestId === dashboardBranchCashSummaryRequestId) applyBranchTreasuryVisibility();
  }
}

async function refreshBranchDashboardSummaries() {
  if (!isUnrestrictedAccount(currentUser)) return;
  const response = await fetch('/api/branches');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'تعذر تحديث ملخصات الفروع.');
  branchWorkspaceBranches = Array.isArray(data.branches) ? data.branches : [];
  await renderBranchWarehouseDashboard(branchWorkspaceBranches, data.can_manage === true);
}

async function openBranchWarehouseManagement(branchId) {
  const allowedBranchIds = Array.isArray(currentUser?.branch_ids) && currentUser.branch_ids.length ? currentUser.branch_ids.map(Number) : [Number(currentUser?.branch_id || 0)];
  if (!isUnrestrictedAccount(currentUser) && !allowedBranchIds.includes(Number(branchId))) return showAppToast('لا تملك صلاحية الوصول إلى هذا الفرع.');
  localStorage.setItem(ACTIVE_BRANCH_KEY, String(Number(branchId)));
  switchTab('branch-warehouse');
}

async function refreshWarehouseUi() {
  // Intentionally ignored: warehouse setup failure is reported by the existing warning
  try {
    const response = await fetch('/api/warehouses');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر تحميل المخازن.');
    warehouseWorkspaceRows = data.warehouses || [];
    const options = warehouseWorkspaceRows.map(row => `<option value="${Number(row.id)}">${escapeHtml(row.name)}${row.is_default ? ' (رئيسي)' : ''}</option>`).join('');
    for (const id of ['pos-warehouse-select','purchase-warehouse-select','purchase-order-warehouse-select','waste-warehouse-select','warehouse-manager-select','warehouse-parent-select']) {
      const select = document.getElementById(id); if (!select) continue;
      const selected = select.value;
      select.innerHTML = id === 'warehouse-parent-select' ? '<option value="">بدون مخزن أب</option>' + options : options;
      select.value = [...select.options].some(option => option.value === selected) ? selected : String(data.default_warehouse_id || warehouseWorkspaceRows[0]?.id || '');
    }
    const branchField = document.getElementById('warehouse-branch-field');
    const branchSelect = document.getElementById('warehouse-branch-select');
    if (branchField && branchSelect) {
      branchField.classList.toggle('hidden', !isUnrestrictedAccount(currentUser));
      branchSelect.innerHTML = branchWorkspaceBranches.filter(row => row.is_active !== false).map(row => `<option value="${Number(row.id)}">${escapeHtml(row.name)}</option>`).join('');
      branchSelect.value = localStorage.getItem(ACTIVE_BRANCH_KEY) || String(currentUser?.branch_id || warehouseWorkspaceRows[0]?.branch_id || '');
      branchSelect.onchange = async () => { localStorage.setItem(ACTIVE_BRANCH_KEY, branchSelect.value); await initializeBranchWorkspace(); };
    }
    document.getElementById('warehouse-workspace-panel')?.classList.toggle('hidden', false);
    const warehouseBranchCount = document.getElementById('warehouse-count-branches');
    if (warehouseBranchCount) warehouseBranchCount.textContent = new Intl.NumberFormat('ar-EG-u-nu-latn').format(branchWorkspaceBranches.filter(row => row.is_active !== false).length);
    let visibleWarehouseCount = warehouseWorkspaceRows.length;
    if (isUnrestrictedAccount(currentUser) && branchWorkspaceBranches.length > 1) {
      const counts = await Promise.all(branchWorkspaceBranches.filter(row => row.is_active !== false).map(async branch => {
        const response = await fetch(`/api/warehouses?branch_id=${Number(branch.id)}`, { headers: { 'X-Active-Branch': String(branch.id) } });
        const branchData = await response.json();
        return response.ok ? (branchData.warehouses || []).length : 0;
      }));
      visibleWarehouseCount = counts.reduce((sum, count) => sum + count, 0);
    }
    const warehouseCount = document.getElementById('warehouse-count-warehouses');
    if (warehouseCount) warehouseCount.textContent = new Intl.NumberFormat('ar-EG-u-nu-latn').format(visibleWarehouseCount);
    const canManageBranchCatalog = Boolean(isUnrestrictedAccount(currentUser) || (currentUser?.permissions || []).includes('add'));
    const warehouseControls = document.getElementById('warehouse-manager-controls');
    if (warehouseControls) warehouseControls.dataset.allowed = canManageBranchCatalog ? 'true' : 'false';
    await loadPurchaseWarehouses(document.getElementById('purchase-branch-select')?.value || localStorage.getItem(ACTIVE_BRANCH_KEY));
    await renderWarehouseManager();
  } catch (error) { console.warn('Warehouse setup:', error.message); }
}

async function loadPurchaseWarehouses(branchId) {
  const select = document.getElementById('purchase-warehouse-select');
  if (!select || !branchId) return;
  try {
    const response = await fetch(`/api/warehouses?branch_id=${encodeURIComponent(branchId)}`, { headers: { 'X-Active-Branch': String(branchId) } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر تحميل مخازن الفرع المحدد.');
    const warehouses = data.warehouses || [];
    const previous = select.value;
    select.innerHTML = warehouses.map(row => `<option value="${Number(row.id)}">${escapeHtml(row.name)}${row.is_default ? ' (رئيسي)' : ''}</option>`).join('');
    select.value = warehouses.some(row => String(row.id) === previous) ? previous : String(data.default_warehouse_id || warehouses[0]?.id || '');
  } catch (error) {
    select.innerHTML = '';
    console.warn('Purchase warehouse load:', error.message);
  }
}

async function renderWarehouseManager() {
  const select = document.getElementById('warehouse-manager-select');
  const warehouseId = Number(select?.value);
  const productSelect = document.getElementById('warehouse-product-select');
  if (!warehouseId) return;
  // Intentionally ignored: warehouse manager failure is reported by the existing warning
  try {
    const [categoriesResponse, productsResponse, inventoryResponse, historyResponse, catalogProducts] = await Promise.all([
      fetch(`/api/warehouse-categories?warehouse_id=${warehouseId}`), fetch(`/api/warehouse-products?warehouse_id=${warehouseId}`),
      fetch(`/api/warehouse-inventory?warehouse_id=${warehouseId}`), fetch(`/api/warehouse-history?warehouse_id=${warehouseId}`), storage.getProducts()
    ]);
    const [categories, linked, inventory, history] = await Promise.all([categoriesResponse.json(), productsResponse.json(), inventoryResponse.json(), historyResponse.json()]);
    const categorySelect = document.getElementById('warehouse-category-select');
    if (categorySelect) categorySelect.innerHTML = '<option value="">بدون فئة</option>' + categories.map(row => `<option value="${Number(row.id)}">${escapeHtml(row.name)}</option>`).join('');
    const categoryList = document.getElementById('warehouse-category-list');
    if (categoryList) categoryList.innerHTML = categories.length
      ? categories.map(row => `<span class="inline-flex rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-bold text-indigo-900">${escapeHtml(row.name)}</span>`).join('')
      : '<span class="text-xs text-gray-500">لا توجد فئات لهذا المخزن بعد.</span>';
    const linkedIds = new Set((linked || []).map(row => Number(row.product_id)));
    if (productSelect) productSelect.innerHTML = (catalogProducts || []).filter(product => !linkedIds.has(Number(product.id))).map(product => `<option value="${Number(product.id)}">${escapeHtml(product.name)}</option>`).join('');
    const body = document.getElementById('warehouse-products-body');
    const inventoryByProduct = new Map((inventory || []).map(row => [Number(row.product_id), row]));
    const listedProducts = [...new Set([...(linked || []).map(row => Number(row.product_id)), ...inventoryByProduct.keys()])].map(productId => inventoryByProduct.get(productId) || { product_id: productId, quantity: 0, product: (catalogProducts || []).find(product => Number(product.id) === productId) });
    const branchId = Number(localStorage.getItem(ACTIVE_BRANCH_KEY) || currentUser?.branch_id || 0);
    const branchName = branchWorkspaceBranches.find(branch => Number(branch.id) === branchId)?.name || 'الفرع الحالي';
    const selectedWarehouseName = warehouseWorkspaceRows.find(warehouse => Number(warehouse.id) === warehouseId)?.name || 'المخزن المحدد';
    const numberFormat = new Intl.NumberFormat('ar-EG-u-nu-latn', { maximumFractionDigits: 3 });
    document.getElementById('warehouse-count-products').textContent = numberFormat.format((catalogProducts || []).length);
    document.getElementById('warehouse-page-title').textContent = selectedWarehouseName;
    document.getElementById('warehouse-breadcrumb-name').textContent = selectedWarehouseName;
    document.getElementById('warehouse-nav-current-name').textContent = selectedWarehouseName;
    const totalStockUnits = listedProducts.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
    const summary = document.getElementById('warehouse-inventory-summary');
    if (summary) summary.textContent = `${branchName} · ${selectedWarehouseName} · ${numberFormat.format(listedProducts.length)} صنف · إجمالي ${numberFormat.format(totalStockUnits)} وحدة (يشمل المخازن التابعة)`;
    const cards = document.getElementById('warehouse-product-cards');
    if (cards) cards.innerHTML = listedProducts.map(row => {
      const product = row.product || (catalogProducts || []).find(item => Number(item.id) === Number(row.product_id)) || {};
      const quantity = Number(row.direct_quantity ?? row.quantity) || 0;
      const image = product.image || product.image_url || product.photo || '';
      const productName = product.name || 'صنف غير معروف';
      return `<article class="warehouse-product-card"><div class="warehouse-product-image">${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(productName)}">` : '<i data-lucide="package" aria-hidden="true"></i>'}</div><div class="warehouse-product-copy"><h3>${escapeHtml(productName)}</h3><span class="warehouse-sku">كود الصنف: ${escapeHtml(product.item_number ?? '—')}</span><strong>${numberFormat.format(Number(product.sale_price ?? product.price) || 0)} ج.م</strong><span class="warehouse-availability ${quantity > 0 ? 'is-available' : 'is-empty'}">${quantity > 0 ? `متوفر · ${numberFormat.format(quantity)}` : 'غير متوفر'}</span></div></article>`;
    }).join('') || '<div class="warehouse-empty-state">لا توجد منتجات مرتبطة بهذا المخزن.</div>';
    if (body) body.innerHTML = listedProducts.map(row => {
      const link = linked.find(item => Number(item.product_id) === Number(row.product_id));
      const categoryName = categories.find(category => Number(category.id) === Number(link?.category_id))?.name || '—';
      return `<tr><td class="p-3 font-semibold">${escapeHtml(row.product?.name || 'صنف غير معروف')}</td><td class="p-3">${escapeHtml(categoryName)}</td><td class="p-3">${escapeHtml(branchName)}</td><td class="p-3">${numberFormat.format(Number(row.direct_quantity ?? row.quantity) || 0)}</td><td class="p-3 font-bold">${numberFormat.format(Number(row.quantity) || 0)}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="p-3 text-center text-gray-500">لا توجد أصناف في المخزن.</td></tr>';
    const historyBody = document.getElementById('warehouse-history-body');
    if (historyBody) historyBody.innerHTML = (history || []).map(row => `<tr><td class="p-2">${escapeHtml(row.created_at || '')}</td><td class="p-2">${escapeHtml(row.warehouse_name || '')}</td><td class="p-2">${escapeHtml(row.product_name || '')}</td><td class="p-2">${escapeHtml(row.type || '')}</td><td class="p-2">${Number(row.quantity || 0)}</td></tr>`).join('') || '<tr><td colspan="5" class="p-3 text-center text-gray-500">لا توجد حركات بعد.</td></tr>';
    if (window.lucide) lucide.createIcons();
  } catch (error) { console.warn('Warehouse manager load:', error.message); }
}

function switchWarehousePageView(view) {
  document.querySelectorAll('[data-warehouse-view]').forEach(button => button.classList.toggle('active', button.dataset.warehouseView === view));
  document.querySelectorAll('[data-warehouse-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.warehousePanel !== view));
}
function switchInventoryView(filter) {
  switchTab('inventory');
  filterInventory(filter);
  document.getElementById('inventory-table-container')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function showWarehouseManagement(mode) {
  const panel = document.getElementById('warehouse-manager-controls');
  if (!panel || panel.dataset.allowed !== 'true') return showAppToast('لا تملك صلاحية إدارة المخازن.');
  panel.classList.remove('hidden');
  const warehouseMode = mode === 'warehouse';
  document.getElementById('warehouse-management-title').textContent = warehouseMode ? 'إضافة مخزن' : mode === 'category' ? 'إضافة فئة للمخزن' : 'إضافة منتج إلى المخزن';
  document.getElementById('warehouse-create-row').classList.toggle('hidden', !warehouseMode);
  document.getElementById('warehouse-product-row').classList.toggle('hidden', warehouseMode);
  document.getElementById(warehouseMode ? 'warehouse-new-name' : mode === 'category' ? 'warehouse-new-category' : 'warehouse-product-select')?.focus({ preventScroll: true });
}

async function createWarehouseFromUi() {
  const name = document.getElementById('warehouse-new-name')?.value.trim();
  const branch_id = Number(document.getElementById('warehouse-branch-select')?.value || localStorage.getItem(ACTIVE_BRANCH_KEY));
  const parent_warehouse_id = Number(document.getElementById('warehouse-parent-select')?.value) || null;
  try { const response = await fetch('/api/warehouses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, branch_id, parent_warehouse_id }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'تعذر إضافة المخزن.'); document.getElementById('warehouse-new-name').value = ''; await refreshWarehouseUi(); } catch (error) { showAppToast(error.message); }
}
async function createWarehouseCategoryFromUi() {
  const warehouse_id = Number(document.getElementById('warehouse-manager-select')?.value), name = document.getElementById('warehouse-new-category')?.value.trim();
  try { const response = await fetch('/api/warehouse-categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ warehouse_id, name }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'تعذر إضافة الفئة.'); document.getElementById('warehouse-new-category').value = ''; await renderWarehouseManager(); } catch (error) { showAppToast(error.message); }
}
async function addWarehouseProductFromUi() {
  const body = { warehouse_id: Number(document.getElementById('warehouse-manager-select')?.value), product_id: Number(document.getElementById('warehouse-product-select')?.value), category_id: Number(document.getElementById('warehouse-category-select')?.value) || null };
  try { const response = await fetch('/api/warehouse-products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'تعذر ربط الصنف بالمخزن.'); await renderWarehouseManager(); } catch (error) { showAppToast(error.message); }
}
let editingBranchId = null;
async function createBranch(){
  editingBranchId=null; document.getElementById('branch-modal-title').textContent='إضافة فرع'; document.getElementById('branch-edit-id').value=''; document.getElementById('branch-edit-name').value=''; document.getElementById('branch-edit-address').value=''; document.getElementById('branch-edit-phone').value=''; document.getElementById('branch-initial-category').value='';
  document.getElementById('branch-initial-inventory-fields')?.classList.remove('hidden');
  const productsSelect=document.getElementById('branch-initial-products');
  if(productsSelect){try{const products=await storage.getProducts();productsSelect.innerHTML=(products||[]).map(product=>`<option value="${Number(product.id)}">${escapeHtml(product.name)}${product.barcode?` — ${escapeHtml(product.barcode)}`:''}</option>`).join('');}catch(_){productsSelect.innerHTML='';}}
  openModal('modal-branch');
}
async function editBranch(id){
  try {
    const response=await fetch('/api/branches'),data=await response.json();
    if(!response.ok)throw new Error(data.error||'تعذر تحميل بيانات الفروع.');
    const branch=(data.branches||[]).find(row=>Number(row.id)===Number(id));
    if(!branch)throw new Error('الفرع غير موجود أو لا تملك صلاحية الوصول إليه.');
    editingBranchId=Number(id);document.getElementById('branch-modal-title').textContent='تعديل بيانات الفرع';document.getElementById('branch-edit-id').value=String(id);document.getElementById('branch-edit-name').value=branch.name||'';document.getElementById('branch-edit-address').value=branch.address||'';document.getElementById('branch-edit-phone').value=branch.phone||'';document.getElementById('branch-initial-inventory-fields')?.classList.add('hidden');openModal('modal-branch');
  } catch(error) { showAppToast(error.message||'تعذر فتح تعديل الفرع.'); }
}
async function saveBranch(event){ event.preventDefault(); const body={name:document.getElementById('branch-edit-name').value.trim(),address:document.getElementById('branch-edit-address').value.trim(),phone:document.getElementById('branch-edit-phone').value.trim()}; if(!editingBranchId){body.initial_category=document.getElementById('branch-initial-category')?.value.trim()||'';body.initial_product_ids=[...(document.getElementById('branch-initial-products')?.selectedOptions||[])].map(option=>Number(option.value)).filter(Number.isInteger);} try{const response=await fetch(editingBranchId?`/api/branches/${editingBranchId}`:'/api/branches',{method:editingBranchId?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),data=await response.json();if(!response.ok)throw new Error(data.error||'تعذر حفظ الفرع.');closeModal('modal-branch');await initializeBranchWorkspace();}catch(error){showAppToast(error.message);}}

async function toggleBranch(id,activate){
  if(!activate&&!await showAppConfirm('سيتم إيقاف الفرع ومنع تسجيل الدخول إليه. متابعة؟'))return;
  try {
    const response=await fetch(`/api/branches/${Number(id)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({is_active:Boolean(activate)})}),data=await response.json();
    if(!response.ok)throw new Error(data.error||'تعذر تحديث الفرع.');
    await initializeBranchWorkspace();
  } catch(error) { showAppToast(error.message||'تعذر تحديث الفرع.'); }
}

let branchUsersEditingId = null;
async function openBranchUsers(branchId) {
  try {
    const response = await fetch(`/api/branches/${Number(branchId)}/users`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر تحميل مستخدمي الفرع.');
    branchUsersEditingId = Number(branchId);
    const title = document.getElementById('branch-users-modal-title');
    if (title) title.textContent = `مستخدمو ${result.branch?.name || 'الفرع'}`;
    const body = document.getElementById('branch-users-body');
    if (body) body.innerHTML = (result.users || []).map(user => `<tr class="border-t border-slate-100" data-branch-user-row data-user-id="${Number(user.id)}"><td class="p-3 font-bold">${escapeHtml(user.name || user.username)}</td><td class="p-3" dir="ltr">${escapeHtml(user.username || '')}</td><td class="p-3"><select data-branch-access class="rounded-lg border border-slate-300 px-2 py-1"><option value="read" ${user.access_level === 'read' ? 'selected' : ''}>قراءة</option><option value="write" ${user.access_level === 'write' ? 'selected' : ''}>قراءة وكتابة</option><option value="none" ${user.access_level === 'none' ? 'selected' : ''}>منع</option></select></td></tr>`).join('') || `<tr><td colspan="3" class="p-4 text-center text-slate-500">لا يوجد مستخدمون مرتبطون بالفرع.</td></tr>`;
    openModal('modal-branch-users');
  } catch (error) { showAppToast(error.message || 'تعذر فتح مستخدمي الفرع.'); }
}

async function saveBranchUsers() {
  if (!branchUsersEditingId) return;
  const rows = [...document.querySelectorAll('#branch-users-body [data-branch-user-row]')];
  try {
    for (const row of rows) {
      const userId = Number(row.dataset.userId);
      const currentResponse = await fetch(`/api/users/${userId}/branches`);
      const current = await currentResponse.json();
      if (!currentResponse.ok) throw new Error(current.error || 'تعذر قراءة صلاحيات المستخدم.');
      const branches = Array.isArray(current.branches) ? current.branches.filter(item => Number(item.branch_id) !== branchUsersEditingId) : [];
      branches.push({ branch_id: branchUsersEditingId, access_level: row.querySelector('[data-branch-access]')?.value || 'read' });
      const response = await fetch(`/api/users/${userId}/branches`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ branches }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'تعذر حفظ صلاحيات المستخدم.');
    }
    closeModal('modal-branch-users');
    showAppToast('تم حفظ تعيينات مستخدمي الفرع.');
    await initializeBranchWorkspace();
  } catch (error) { showAppToast(error.message || 'تعذر حفظ تعيينات الفرع.'); }
}

async function deleteBranch(id) {
  const branch = branchWorkspaceBranches.find(row => Number(row.id) === Number(id));
  if (!branch || branch.is_default) return showAppToast('لا يمكن حذف الفرع الرئيسي.');
  if (!await showAppConfirm(`سيتم حذف «${branch.name}» ومخازنه الفارغة فقط. يجب نقل المستخدمين وتصفية الأرصدة، ولا يمكن حذف فرع له فواتير أو حركات تاريخية. هل تريد المتابعة؟`)) return;
  try {
    const response = await fetch(`/api/branches/${Number(id)}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر حذف الفرع.');
    await initializeBranchWorkspace();
  } catch (error) { showAppToast(error.message); }
}


// ----------------------------------------------------
// UI Initialization
// ----------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  setupPosTouchLayout();
  if (!window.__rawdaFontObserver) { window.__rawdaFontObserver = new MutationObserver(() => requestAnimationFrame(enforceReadableFontSizes)); window.__rawdaFontObserver.observe(document.getElementById('app-shell') || document.body, { childList: true, subtree: true, characterData: true }); }
  syncModalBodyLock();
  window.__rawdaModalObserver = window.__rawdaModalObserver || new MutationObserver(syncModalBodyLock);
  window.__rawdaModalObserver.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
  document.getElementById('license-device-id')?.addEventListener('input', updateActivationSupportLink);
  const userForm = document.querySelector('#modal-add-user .modal-form');
  userForm?.addEventListener('input', markUserModalDirty);
  userForm?.addEventListener('change', event => {
    if (event.target?.id === 'user-permission-template') { applyUserPermissionTemplate(event.target.value); return; }
    if (event.target?.id === 'user-new-branch') { renderUserBranchAccessFields(); }
    if (!applyingUserPermissionTemplate && event.target?.matches('#user-permissions input[type="checkbox"], #user-allowed-tabs input[type="checkbox"]')) {
      const template = document.getElementById('user-permission-template'); if (template) template.value = 'custom';
    }
    markUserModalDirty();
  });
  document.getElementById('user-permissions-select-all')?.addEventListener('click', () => setUserCheckboxGroup('#user-permissions input[type="checkbox"]', true));
  document.getElementById('user-permissions-select-none')?.addEventListener('click', () => setUserCheckboxGroup('#user-permissions input[type="checkbox"]', false));
  document.getElementById('user-tabs-select-all')?.addEventListener('click', () => setUserCheckboxGroup('#user-allowed-tabs input[type="checkbox"]', true));
  document.getElementById('user-tabs-select-none')?.addEventListener('click', () => setUserCheckboxGroup('#user-allowed-tabs input[type="checkbox"]', false));
  loadSavedTheme();
  loadSavedFontScale();
  bindDashboardWheel();
  applyBranchTreasuryVisibility();
  loadSavedDashboardInterface();
  loadNavigationLayout();
  loadHardwareSettings();
  lucide.createIcons();
  selectRibbonGroup('overview');
  initializeLayoutOrdering();
  applyAllLayoutOrders();
  updateAppClocks();
  appClockTimer = setInterval(updateAppClocks, 1000);
  window.__rawdaActionPermissionObserver = window.__rawdaActionPermissionObserver || new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
    if (node.nodeType === 1) applyActionButtonPermissions(node);
  })));
  window.__rawdaActionPermissionObserver.observe(document.body, { childList: true, subtree: true });
  // Revalidate the browser session with the server; a cached user object alone
  // must never restore application access.
  currentUser = null;
  // Intentionally ignored: branch cleanup after the user action is best-effort
  try {
    const sessionResponse = await fetch('/api/me', { credentials: 'same-origin' });
  if (sessionResponse.ok) { const sessionUser = await sessionResponse.json(); if (sessionUser?.id) { currentUser = sessionUser; window.rawdaCurrentUser = currentUser; window.SoundSettings?.syncUser(); loadSavedFontScale(); setTimeout(syncOfflineSalesQueue, 800); } }
  } catch (_) {}
  window.rawdaCurrentUser = currentUser;
  window.loadUiLanguage?.();
  if (!currentUser) sessionStorage.removeItem('system_session');
  updateUserUI();
  if (currentUser) await initializeBranchWorkspace();
  updatePosCurrentDate();

  await loadNetworkAndConfig();
  updateTrialBanner();
  const licenseStatus = await getServerLicenseStatus();
  if (!licenseStatus.active) {
    document.getElementById('app-shell')?.classList.add('hidden');
    closeModal('modal-login');
    openModal('modal-activation');
    const idInput = document.getElementById('license-device-id');
    const msg = document.getElementById('license-status-message');
    if (msg) msg.textContent = licenseStatus.reason || 'انتهت التجربة. أدخل مفتاح التفعيل.';
  } else if (!networkInfo.business_profile?.is_configured && !String(networkInfo.business_profile?.business_name || '').trim()) {
    openModal('modal-business-setup');
    document.getElementById('initial-business-name')?.focus();
  } else {
    if (!currentUser && window.rawdaDesktop?.getRememberedLogin) {
      try {
        const remembered = await window.rawdaDesktop.getRememberedLogin();
        if (remembered?.username && remembered?.password) {
          const roleInput = document.getElementById('pin-role');
          if (roleInput && remembered.role) roleInput.value = remembered.role;
          const loginUsername = document.getElementById('login-username');
          const loginPassword = document.getElementById('login-password');
          if (loginUsername) loginUsername.value = remembered.username;
          if (loginPassword) loginPassword.value = remembered.password;
          currentUser = await storage.login(remembered.username, remembered.password);
          document.getElementById('remember-login').checked = true;
          sessionStorage.setItem('system_session', JSON.stringify(currentUser));
          loadSavedFontScale();
          updateUserUI();
        }
      } catch (_) {
        await window.rawdaDesktop.clearRememberedLogin?.();
      }
    }
    if (currentUser) {
      if (!currentUser.permissions?.length && !currentUser.is_owner) {
        // A user with no assigned permissions signs in but sees no data screens.
      }
      await loadAuthorizedWorkspace();
      document.getElementById('app-shell')?.classList.remove('hidden');
      closeModal('modal-login');
      switchTab(activeTab);
    } else {
      openModal('modal-login');
      document.getElementById('pin-username')?.focus();
    }
  }

  // Focus barcode input for instant scanning
  const barcodeInput = document.getElementById('pos-barcode-input');
  if (barcodeInput) {
    barcodeInput.focus();
    barcodeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const scannedCode = barcodeInput.value.trim();
        barcodeInput.value = '';
        void processBarcodeInput(scannedCode);
      }
    });
  }
  barcodeScannerHandler = event => {
    if (event.defaultPrevented || event.isComposing || !currentUser || activeTab !== 'pos'
      || document.querySelector('.modal-backdrop:not(.hidden), #modal-input-dialog:not(.hidden), #modal-business-setup:not(.hidden)')) return;
    const target = event.target;
    if (target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName)) return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key === 'Enter') {
      const code = barcodeBuffer;
      barcodeBuffer = '';
      clearTimeout(barcodeTimeout);
      if (code.length > 2) {
        event.preventDefault();
        void processBarcodeInput(code);
      }
      return;
    }
    if (event.key.length !== 1) return;
    barcodeBuffer += event.key;
    clearTimeout(barcodeTimeout);
    barcodeTimeout = setTimeout(() => { barcodeBuffer = ''; }, 50);
  };
  document.addEventListener('keydown', barcodeScannerHandler, true);

  // Live POS search input listener
  const posControlsRoot = document.getElementById('tab-pos');
  posControlsRoot?.addEventListener('click', event => {
    const paymentButton = event.target.closest('.pos-pay-method');
    if (paymentButton) {
      const label = String(paymentButton.dataset.paymentMethod || paymentButton.textContent || '').trim();
      const method = /فيزا|بطاقة|card/i.test(label) ? 'بطاقة' : (/آجل/.test(label) ? 'دفع آجل' : 'نقدي');
      setPaymentMethod(method, paymentButton);
      return;
    }
    const categoryButton = event.target.closest('.pos-cat-btn, .pos-cat-filter');
    if (categoryButton) {
      const label = String(categoryButton.textContent || '').trim();
      const categoryId = categoryButton.dataset.categoryId || (/مشروبات/.test(label) ? 'drinks' : (/مأكولات/.test(label) ? 'food' : 'all'));
      filterPosCategory(categoryId);
      return;
    }
    const action = event.target.closest('[data-pos-action]')?.dataset.posAction;
    if (action === 'close-shift') void closeCashierShift();
    else if (action === 'camera') void startPosBarcodeCamera();
    else if (action === 'stop-camera') void stopPosBarcodeCamera();
    else if (action === 'returns') switchTab('sales-history');
    else if (action === 'suspend') void suspendCurrentSale();
    else if (action === 'held') void togglePosSuspendedSales();
    else if (action === 'delivery' || action === 'in-store') {
      const type = action === 'delivery' ? 'توصيل' : 'داخل المحل';
      const orderType = document.getElementById('pos-order-type');
      if (orderType) { orderType.value = type; orderType.dispatchEvent(new Event('change', { bubbles: true })); }
      posControlsRoot.querySelectorAll('.pos-order-btn').forEach(button => button.classList.toggle('active', button.dataset.posAction === action));
    }
    else if (action === 'search') { productListPages.pos.page = 0; void renderPosProducts(); }
  });
  document.getElementById('pos-amount-paid')?.addEventListener('input', calculateChange);
  document.getElementById('pos-discount-input')?.addEventListener('input', calculateCartTotals);
  document.getElementById('pos-customer-select')?.addEventListener('change', event => {
    const selected = event.currentTarget.options[event.currentTarget.selectedIndex];
    const name = document.getElementById('pos-selected-customer') || document.getElementById('pos-customer-name');
    if (name) name.textContent = selected?.dataset.customerName || selected?.textContent || 'عميل نقدي';
    const balance = document.getElementById('pos-customer-balance');
    if (balance) balance.textContent = `الرصيد: ${Number(selected?.dataset.customerBalance || 0).toFixed(2)} ج.م`;
    updatePosCreditTerms();
  });
  document.getElementById('pos-due-period')?.addEventListener('change', updatePosCreditTerms);
  document.getElementById('pos-due-days-custom')?.addEventListener('input', updatePosCreditTerms);
  const posSearch = document.getElementById('pos-search-input') || document.getElementById('pos-barcode-input');
  posSearch?.addEventListener('input', () => { clearTimeout(posSearchTimer); productListPages.pos.page = 0; posSearchTimer = setTimeout(() => void renderPosProducts(), 180); });
  document.getElementById('pos-warehouse-select')?.addEventListener('change', () => {
    invalidatePosTopSellers();
    invalidateClientProductCache();
    productListPages.pos.page = 0;
    renderPosProducts();
  });
  document.getElementById('pos-order-type')?.addEventListener('change', togglePosDeliveryFields);
  document.getElementById('pos-delivery-rider-select')?.addEventListener('change', applySelectedRiderDeliveryDefaults);
  document.getElementById('pos-delivery-customer-fee')?.addEventListener('input', () => {
    const display = document.getElementById('pos-delivery-fee-display');
    if (display) display.textContent = `${Number(document.getElementById('pos-delivery-customer-fee')?.value || 0).toFixed(2)} ج.م`;
    calculateCartTotals();
  });
  document.getElementById('pos-delivery-rider-select')?.addEventListener('change', () => { applySelectedRiderDeliveryDefaults(); calculateCartTotals(); });
  document.getElementById('delivery-transaction-rider')?.addEventListener('change', event => loadDeliveryRiderTransactions(event.target.value));

  const productSearch = document.getElementById('products-search-input');
  productSearch?.addEventListener('input', () => {
    clearTimeout(productSearchTimer);
    productListPages.products.page = 0;
    productSearchTimer = setTimeout(() => renderProducts(), 250);
  });
  document.getElementById('products-cat-filter')?.addEventListener('change', () => { productListPages.products.page = 0; renderProducts(); });

  const salesHistorySearch = document.getElementById('sales-history-search');
  const salesHistoryDate = document.getElementById('sales-history-date');
  const salesHistoryFrom = document.getElementById('sales-history-from');
  const salesHistoryTo = document.getElementById('sales-history-to');
  const salesHistoryPaymentMethod = document.getElementById('sales-history-payment-method');
  salesHistorySearch?.addEventListener('input', () => {
    clearTimeout(salesHistorySearchTimer);
    salesHistorySearchTimer = setTimeout(() => { salesHistorySearchTimer = null; void renderSalesHistory(); }, 220);
  });
  salesHistorySearch?.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    clearTimeout(salesHistorySearchTimer);
    salesHistorySearchTimer = null;
    void openScannedInvoiceFromHistory(salesHistorySearch.value);
  });
  salesHistoryDate?.addEventListener('change', () => renderSalesHistory());
  salesHistoryFrom?.addEventListener('change', () => renderSalesHistory());
  salesHistoryTo?.addEventListener('change', () => renderSalesHistory());
  salesHistoryPaymentMethod?.addEventListener('change', () => renderSalesHistory());

  // Global keyboard shortcuts (F9 to complete sale)
  globalShortcutHandler = (e) => {
    if ((e.key === 'F3' || e.key === 'F9') && currentUser) {
      e.preventDefault();
      completeSale(e.key === 'F3' && e.shiftKey);
      return;
    }
    if (currentUser && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && String(e.key).toLowerCase() === 'r') {
      e.preventDefault();
      window.location.reload();
      return;
    }
    if (currentUser && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      const zoomKey = String(e.key);
      if (zoomKey === '+' || zoomKey === '=' || zoomKey.toLowerCase() === 'add') {
        e.preventDefault();
        adjustUiZoom(0.1);
        return;
      }
      if (zoomKey === '-' || zoomKey === '_' || zoomKey.toLowerCase() === 'subtract') {
        e.preventDefault();
        adjustUiZoom(-0.1);
        return;
      }
      if (zoomKey === '0') {
        e.preventDefault();
        resetUiZoom();
        return;
      }
    }
    if (!currentUser || e.isComposing || e.ctrlKey || e.metaKey || (e.altKey && e.key !== 'ArrowLeft')) return;
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBackInApp(); return; }
    if (document.querySelector('.modal-backdrop:not(.hidden), #modal-input-dialog:not(.hidden), #modal-business-setup:not(.hidden)')) return;
    const shortcuts = {
      F2: ['pos', 'pos-barcode-input'], 'Shift+F2': ['purchases', 'purchase-product-search', 'modal-add-purchase'],
      F4: ['products', 'products-search-input'], 'Shift+F4': ['inventory', null],
      F6: ['sales-history', 'sales-history-search'], 'Shift+F6': ['customers', null],
      F7: ['employees', null], 'Shift+F7': ['reports', null],
      F8: ['delivery', null], 'Shift+F8': ['categories', null]
    };
    const shortcut = shortcuts[`${e.shiftKey ? 'Shift+' : ''}${e.key}`];
    if (!shortcut) return;
    e.preventDefault();
    if (switchTab(shortcut[0]) === false) return;
    if (shortcut[1]) setTimeout(() => {
      if (shortcut[2] && typeof openModal === 'function') openModal(shortcut[2]);
      document.getElementById(shortcut[1])?.focus({ preventScroll: true });
    }, 0);
  };
  document.addEventListener('keydown', globalShortcutHandler);
});

function goBackInApp() {
  if (!currentUser) return;
  const destination = previousAppTab && previousAppTab !== activeTab ? previousAppTab : 'dashboard';
  previousAppTab = null;
  switchTab(destination);
}

function openKeyboardShortcuts() { openModal('modal-keyboard-shortcuts'); }

function loadNavigationLayout() {
  const layout = localStorage.getItem('system_navigation_layout') || 'cards';
  document.body.classList.toggle('nav-sidebar', layout === 'sidebar');
  const button = document.getElementById('nav-layout-toggle');
  if (button) button.title = layout === 'sidebar' ? 'عرض القائمة كبطاقات' : 'عرض القائمة على الجانب';
}

const layoutOrderDefaults = new Map();
let layoutOrderEditing = false;
let activeLayoutPointerDrag = null;
let activeLayoutDropTarget = null;
function layoutAreaElements() {
  const areas = [];
  const add = (container, area, selector, idFor) => {
    if (!container) return;
    container.dataset.layoutArea = area;
    const items = [...container.querySelectorAll(`:scope > ${selector}`)];
    items.forEach((item, index) => {
      item.dataset.layoutItem = 'true';
      item.dataset.layoutArea = area;
      item.dataset.layoutId ||= idFor(item, index);
    });
    areas.push(container);
  };
  const stableChildId = (item, index) => item.querySelector('[id]')?.id || item.getAttribute('aria-label') || `item-${index + 1}`;
  add(document.querySelector('.quick-actions-grid.dashboard-tiles'), 'dashboard_tiles', '.quick-action-card', (item, index) => `quick-${stableChildId(item, index)}`);
  document.querySelectorAll('#tab-dashboard .grid').forEach((grid, index) => {
    if (![...grid.children].some(child => child.classList.contains('luxury-card'))) return;
    const firstId = grid.querySelector('.luxury-card [id]')?.id || `group-${index + 1}`;
    add(grid, firstId === 'dash-today-sales' ? 'dashboard_metrics_sales' : 'dashboard_metrics_finance', '.luxury-card', stableChildId);
  });
  document.querySelectorAll('#tab-employees .grid').forEach((grid, index) => {
    if ([...grid.children].some(child => child.classList.contains('luxury-card'))) add(grid, `employees_metrics_${index + 1}`, '.luxury-card', stableChildId);
  });
  add(document.getElementById('report-profit'), 'report_metrics', '.luxury-card', stableChildId);

  const sidebar = document.querySelector('aside nav');
  if (sidebar) {
    add(sidebar, 'sidebar_main', '.tab-btn', item => item.id || item.dataset.layoutId || 'tab');
    add(document.getElementById('admin-menu-section'), 'sidebar_admin', '.tab-btn', item => item.id || 'admin-tab');
  }
  add(document.getElementById('focused-nav-menu'), 'sidebar_focused', 'button[data-focused-tab]', item => item.dataset.focusedTab || 'focused-tab');
  add(document.getElementById('ribbon-tabs'), 'ribbon', '.ribbon-tab', item => item.dataset.group || 'ribbon-tab');
  return areas;
}
function layoutItems(container) { return [...(container?.querySelectorAll(':scope > [data-layout-item="true"]') || [])]; }
function layoutItemGroup(item) {
  const tab = item?.dataset.group || item?.dataset.focusedTab || item?.id || '';
  return ['settings', 'reports', 'employees', 'database', 'audit-log', 'users'].includes(tab) || /^tab-btn-(settings|reports|employees|database|audit)/.test(tab) ? 'administration' : 'operations';
}
function constrainLayoutOrder(container, requested) {
  const items = layoutItems(container);
  const ids = items.map(item => item.dataset.layoutId);
  const normalized = window.LayoutOrderUtils.normalizeOrder(requested, ids);
  const result = [...ids];
  const scopes = new Set(items.map(layoutItemGroup));
  for (const scope of scopes) {
    const slots = items.map((item, index) => layoutItemGroup(item) === scope ? index : -1).filter(index => index >= 0);
    const allowed = new Set(slots.map(index => ids[index]));
    const groupOrder = normalized.filter(id => allowed.has(id));
    slots.forEach((slot, index) => { result[slot] = groupOrder[index]; });
  }
  return result;
}
function layoutStorageKey(area) { return window.LayoutOrderUtils.storageKey(currentUser?.id || 'anonymous', area); }
function reorderLayoutContainer(container, order) {
  const items = layoutItems(container);
  if (!items.length) return;
  const byId = new Map(items.map(item => [item.dataset.layoutId, item]));
  const desired = order.map(id => byId.get(id)).filter(Boolean);
  const active = document.activeElement;
  const markers = items.map(item => { const marker = document.createComment('layout-order-slot'); container.replaceChild(marker, item); return marker; });
  markers.forEach((marker, index) => marker.replaceWith(desired[index] || items[index]));
  if (active?.isConnected === false && items.some(item => item.contains(active))) active.focus?.({ preventScroll: true });
}
function applyLayoutOrder(container, { saveDefault = true } = {}) {
  if (!container || !window.LayoutOrderUtils) return;
  const area = container.dataset.layoutArea;
  const ids = layoutItems(container).map(item => item.dataset.layoutId);
  if (!area || !ids.length) return;
  if (saveDefault && !layoutOrderDefaults.has(area)) layoutOrderDefaults.set(area, [...ids]);
  const defaults = layoutOrderDefaults.get(area) || [...ids];
  let order = [...defaults];
  try {
    const serialized = localStorage.getItem(layoutStorageKey(area));
    if (serialized !== null) order = window.LayoutOrderUtils.readOrder(serialized, ids);
  } catch (_) { order = [...defaults]; }
  order = constrainLayoutOrder(container, order);
  reorderLayoutContainer(container, order);
  layoutItems(container).forEach(item => decorateLayoutItem(item));
}
function decorateLayoutItem(item) {
  let handle = item.querySelector(':scope > .layout-drag-handle');
  if (!handle) {
    handle = document.createElement('span');
    handle.className = 'layout-drag-handle';
    handle.textContent = '⠿';
    handle.title = 'اسحب للترتيب، أو استخدم السهمين لأعلى وأسفل';
    handle.setAttribute('role', 'button');
    handle.setAttribute('tabindex', '0');
    handle.setAttribute('aria-label', 'مقبض ترتيب العنصر');
    handle.dataset.enter = 'native';
    item.appendChild(handle);
  }
  handle.hidden = !layoutOrderEditing;
  handle.draggable = layoutOrderEditing;
  item.draggable = false;
  item.classList.toggle('layout-order-item', layoutOrderEditing);
}
function saveLayoutOrder(container) {
  if (!currentUser || !container) return;
  const area = container.dataset.layoutArea;
  const order = layoutItems(container).map(item => item.dataset.layoutId);
  try { localStorage.setItem(layoutStorageKey(area), JSON.stringify(order)); }
  catch (_) { document.getElementById('layout-order-status').textContent = 'تعذر حفظ الترتيب على هذا الجهاز.'; }
}
function applyAllLayoutOrders() {
  const areas = layoutAreaElements();
  for (const container of areas) applyLayoutOrder(container);
}
function setLayoutOrderingMode(enabled) {
  layoutOrderEditing = Boolean(enabled);
  document.body.classList.toggle('layout-order-editing', layoutOrderEditing);
  const button = document.getElementById('layout-customize-toggle');
  if (button) { button.setAttribute('aria-pressed', String(layoutOrderEditing)); button.textContent = layoutOrderEditing ? 'إنهاء التخصيص' : 'تخصيص الترتيب'; }
  applyAllLayoutOrders();
}
function reorderLayoutItem(item, delta) {
  const container = item?.parentElement;
  if (!container || !currentUser) return false;
  const nodes = layoutItems(container);
  const current = nodes.map(node => node.dataset.layoutId);
  const scope = layoutItemGroup(item);
  const groupNodes = nodes.filter(node => layoutItemGroup(node) === scope);
  const groupOrder = groupNodes.map(node => node.dataset.layoutId);
  const nextGroup = window.LayoutOrderUtils.move(groupOrder, item.dataset.layoutId, delta);
  if (nextGroup.every((id, index) => id === groupOrder[index])) return false;
  const requested = [...current];
  const slots = nodes.map((node, index) => layoutItemGroup(node) === scope ? index : -1).filter(index => index >= 0);
  slots.forEach((slot, index) => { requested[slot] = nextGroup[index]; });
  const next = requested;
  reorderLayoutContainer(container, next);
  saveLayoutOrder(container);
  const status = document.getElementById('layout-order-status');
  if (status) status.textContent = 'تم حفظ ترتيب العناصر.';
  return true;
}
function moveLayoutItemTo(item, target, before) {
  if (!item || !target || item === target || item.parentElement !== target.parentElement || layoutItemGroup(item) !== layoutItemGroup(target) || !layoutOrderEditing) return false;
  const container = item.parentElement;
  const nodes = layoutItems(container);
  if (!nodes.includes(target)) return false;
  const group = nodes.filter(node => layoutItemGroup(node) === layoutItemGroup(item));
  const groupOrder = group.map(node => node.dataset.layoutId);
  const from = groupOrder.indexOf(item.dataset.layoutId);
  const to = groupOrder.indexOf(target.dataset.layoutId);
  if (from < 0 || to < 0) return false;
  groupOrder.splice(from, 1);
  groupOrder.splice(Math.max(0, to + (from < to ? -1 : 0) + (before ? 0 : 1)), 0, item.dataset.layoutId);
  const requested = nodes.map(node => node.dataset.layoutId);
  const slots = nodes.map((node, index) => layoutItemGroup(node) === layoutItemGroup(item) ? index : -1).filter(index => index >= 0);
  slots.forEach((slot, index) => { requested[slot] = groupOrder[index]; });
  reorderLayoutContainer(container, requested);
  container.querySelectorAll('.layout-drop-before, .layout-drop-after').forEach(node => node.classList.remove('layout-drop-before', 'layout-drop-after'));
  saveLayoutOrder(container);
  const status = document.getElementById('layout-order-status');
  if (status) status.textContent = 'تم حفظ ترتيب العناصر.';
  return true;
}
async function resetLayoutOrdering() {
  if (!currentUser || !await showAppConfirm('إعادة كل ترتيبات هذا المستخدم إلى الوضع الافتراضي؟')) return;
  for (const container of layoutAreaElements()) {
    const area = container.dataset.layoutArea;
    // Intentionally ignored: missing layout order uses the default arrangement
    try { localStorage.removeItem(layoutStorageKey(area)); } catch (_) {}
    const defaults = layoutOrderDefaults.get(area) || layoutItems(container).map(item => item.dataset.layoutId);
    reorderLayoutContainer(container, defaults);
  }
  setLayoutOrderingMode(false);
  const status = document.getElementById('layout-order-status');
  if (status) status.textContent = 'تم استعادة الترتيب الافتراضي.';
}
function initializeLayoutOrdering() {
  const toggle = document.getElementById('layout-customize-toggle');
  const reset = document.getElementById('layout-reset-default');
  toggle?.addEventListener('click', () => setLayoutOrderingMode(!layoutOrderEditing));
  reset?.addEventListener('click', resetLayoutOrdering);
  document.addEventListener('click', event => {
    if (event.target.closest('.layout-drag-handle')) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  document.addEventListener('keydown', event => {
    const handle = event.target.closest?.('.layout-drag-handle');
    if (!handle || !layoutOrderEditing || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const item = handle.closest('[data-layout-item="true"]');
    const verticalDelta = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1;
    event.preventDefault();
    reorderLayoutItem(item, verticalDelta);
    handle.focus();
  });
  document.addEventListener('dragstart', event => {
    if (!layoutOrderEditing || !event.target.closest?.('.layout-drag-handle')) { event.preventDefault(); return; }
    const item = event.target.closest('[data-layout-item="true"]');
    activeLayoutPointerDrag = item;
    event.dataTransfer?.setData('text/plain', item?.dataset.layoutId || '');
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });
  document.addEventListener('dragover', event => {
    if (!layoutOrderEditing || !activeLayoutPointerDrag) return;
    const target = event.target.closest?.('[data-layout-item="true"]');
    if (!target || target.parentElement !== activeLayoutPointerDrag.parentElement || layoutItemGroup(target) !== layoutItemGroup(activeLayoutPointerDrag)) return;
    event.preventDefault();
    const rect = target.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    target.classList.toggle('layout-drop-before', before);
    target.classList.toggle('layout-drop-after', !before);
  });
  document.addEventListener('drop', event => {
    if (!layoutOrderEditing || !activeLayoutPointerDrag) return;
    const target = event.target.closest?.('[data-layout-item="true"]');
    if (target && target.parentElement === activeLayoutPointerDrag.parentElement && layoutItemGroup(target) === layoutItemGroup(activeLayoutPointerDrag)) {
      event.preventDefault();
      const rect = target.getBoundingClientRect();
      moveLayoutItemTo(activeLayoutPointerDrag, target, event.clientY < rect.top + rect.height / 2);
    }
    activeLayoutPointerDrag = null;
  });
  document.addEventListener('dragend', () => { activeLayoutPointerDrag = null; document.querySelectorAll('.layout-drop-before, .layout-drop-after').forEach(node => node.classList.remove('layout-drop-before', 'layout-drop-after')); });
  document.addEventListener('pointerdown', event => {
    const handle = event.target.closest?.('.layout-drag-handle');
    if (!layoutOrderEditing || !handle) return;
    activeLayoutPointerDrag = handle.closest('[data-layout-item="true"]');
    activeLayoutDropTarget = null;
  });
  document.addEventListener('pointermove', event => {
    if (!layoutOrderEditing || !activeLayoutPointerDrag) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-layout-item="true"]');
    if (!target || target.parentElement !== activeLayoutPointerDrag.parentElement || layoutItemGroup(target) !== layoutItemGroup(activeLayoutPointerDrag)) return;
    activeLayoutDropTarget = target;
    const rect = target.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    target.classList.toggle('layout-drop-before', before);
    target.classList.toggle('layout-drop-after', !before);
  });
  document.addEventListener('pointerup', event => {
    if (!layoutOrderEditing || !activeLayoutPointerDrag) return;
    const target = event.target.closest?.('[data-layout-item="true"]') || activeLayoutDropTarget || document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-layout-item="true"]');
    if (target && target.parentElement === activeLayoutPointerDrag.parentElement && layoutItemGroup(target) === layoutItemGroup(activeLayoutPointerDrag)) {
      const rect = target.getBoundingClientRect();
      moveLayoutItemTo(activeLayoutPointerDrag, target, event.clientY < rect.top + rect.height / 2);
    }
    activeLayoutPointerDrag = null;
    activeLayoutDropTarget = null;
  });
}

function toggleNavigationLayout() {
  const next = document.body.classList.contains('nav-sidebar') ? 'cards' : 'sidebar';
  localStorage.setItem('system_navigation_layout', next);
  loadNavigationLayout();
  window.scrollTo(0, 0);
}

function updatePosCurrentDate() {
  const el = document.getElementById('pos-current-date');
  if (el) {
    const d = new Date();
    el.textContent = d.toLocaleDateString('ar-EG-u-nu-latn', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }
}

// ----------------------------------------------------
// User Authentication & Permissions
// ----------------------------------------------------

// ----------------------------------------------------
// إخفاء الشاشات والأقسام (يحدده المدير من الإعدادات)
// ----------------------------------------------------
const isUnrestrictedAccount = user => window.SystemAccountAccess?.isUnrestrictedAccount(user) === true;
const canSeeAssignedScreen = (user, tabId) => window.SystemAccountAccess?.canSeeScreen(user, tabId) === true;
const isFocusedAccount = user => window.SystemAccountAccess?.isFocusedAccount(user) === true;
const UI_HIDEABLE_TABS = window.SystemAccountAccess?.TABS || [];
const TAB_PERMISSION_REQUIREMENTS = Object.freeze({
  pos:['view'], wallets:['wallets.view'], catalog:['view','import_export'], installments:['view'], promotions:['view'], 'offer-messages':['view'], dashboard:['view'], products:['view'], categories:['view'],
  inventory:['view'], purchases:['view'], suppliers:['view'], treasury:['view'], 'sales-history':['view'], customers:['view'], employees:['view'], 'delivery-riders':['view'],
  barcodes:['view','print_pdf'], 'branch-warehouse':['system_settings'], reports:['view'], users:['user_management'], 'audit-logs':['view'], settings:['system_settings','import_export']
});
function hasAnyCurrentPermission(...permissions) { return isUnrestrictedAccount(currentUser) || permissions.some(hasPermission); }
function isTabAllowedForCurrentUser(tab) {
  if (!currentUser || !canSeeAssignedScreen(currentUser, tab)) return false;
  if (isUnrestrictedAccount(currentUser)) return true;
  const required = TAB_PERMISSION_REQUIREMENTS[tab] || ['view'];
  return tab === 'settings' ? hasAnyCurrentPermission(...required) : required.every(permission => hasPermission(permission));
}
function getFocusedAllowedTabs(user = currentUser) {
  if (!isFocusedAccount(user)) return [];
  return UI_HIDEABLE_TABS.filter(([tab]) => canSeeAssignedScreen(user, tab) && (user === currentUser ? isTabAllowedForCurrentUser(tab) : true)).map(([tab]) => tab);
}
function getFocusedInitialTab() {
  const tabs = getFocusedAllowedTabs();
  return ['pos', 'sales-history'].find(tab => tabs.includes(tab)) || tabs[0] || '';
}
function renderFocusedControls() {
  const focused = isFocusedAccount(currentUser);
  document.body.classList.toggle('focused-mode', focused);
  const controls = document.getElementById('focused-mode-controls');
  const nav = document.getElementById('focused-navigation');
  const navToggle = document.getElementById('focused-nav-toggle');
  const navMenu = document.getElementById('focused-nav-menu');
  const accountToggle = document.getElementById('focused-account-toggle');
  if (!controls || !nav || !navToggle || !navMenu || !accountToggle) return;
  controls.classList.toggle('hidden', !focused);
  const tabs = focused ? getFocusedAllowedTabs() : [];
  if (!focused) document.querySelectorAll('[data-focused-original-display]').forEach(element => {
    element.style.display = element.dataset.focusedOriginalDisplay;
    delete element.dataset.focusedOriginalDisplay;
  });
  nav.classList.toggle('hidden', tabs.length < 2);
  navMenu.innerHTML = tabs.map(tab => {
    const label = UI_HIDEABLE_TABS.find(([id]) => id === tab)?.[1] || tab;
    return `<button type="button" data-focused-tab="${escapeHtml(tab)}" onclick="switchTab('${escapeHtml(tab)}');toggleFocusedNavigation(false)">${escapeHtml(label)}</button>`;
  }).join('');
  accountToggle.textContent = currentUser?.name || currentUser?.username || 'الحساب';
  accountToggle.setAttribute('aria-label', `خيارات الحساب ${accountToggle.textContent}`);
  document.querySelectorAll('[onclick]').forEach(element => {
    const route = element.getAttribute('onclick')?.match(/switchTab\(['"]([^'"]+)['"]\)/)?.[1];
    if (!route) return;
    if (!Object.hasOwn(element.dataset, 'focusedOriginalDisplay')) element.dataset.focusedOriginalDisplay = element.style.display;
    element.style.display = focused && !tabs.includes(route) ? 'none' : element.dataset.focusedOriginalDisplay;
  });
  document.querySelectorAll('#tab-dashboard .quick-action-card').forEach(card => {
    const route = card.getAttribute('onclick')?.match(/switchTab\(['"]([^'"]+)['"]\)/)?.[1];
    card.dataset.focusedAllowed = String(Boolean(focused && route && tabs.includes(route)));
  });
  applyAllLayoutOrders();
}
function toggleFocusedNavigation(force) {
  const menu = document.getElementById('focused-nav-menu'); const button = document.getElementById('focused-nav-toggle');
  if (!menu || !button) return;
  const open = typeof force === 'boolean' ? force : menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open); button.setAttribute('aria-expanded', String(open));
}
function toggleFocusedAccountMenu(force) {
  const menu = document.getElementById('focused-account-menu'); const button = document.getElementById('focused-account-toggle');
  if (!menu || !button) return;
  const open = typeof force === 'boolean' ? force : menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open); button.setAttribute('aria-expanded', String(open));
}
const UI_HIDEABLE_GROUPS = [
  ['overview', 'لوحة التحكم'], ['settings', 'الإعدادات'], ['catalog', 'كتالوج المنتجات'], ['customers', 'العملاء'], ['suppliers', 'الموردين'], ['purchases', 'المشتريات والمخازن'], ['sales', 'المبيعات'],
  ['reports', 'التقارير'], ['employees', 'شئون الموظفين'], ['cash', 'الخزائن والمعاملات النقدية'],
  ['installments', 'نظام التقسيط'], ['database', 'إعدادات البرنامج'],
  ['accounting', 'ربط Tally والحسابات'], ['tax', 'إعدادات الضريبة'], ['owner-alerts', 'تنبيهات صاحب النشاط'],
  ['order-channels', 'نوع الطلب وقنوات البيع'], ['customer-phone-search', 'البحث عن العميل برقم الهاتف'], ['salesperson-commission', 'تعيين البائع وعمولته']
  , ['purchase-orders', 'أوامر الشراء'], ['delivery', 'مكتب الدليفري'], ['delivery-riders', 'طيارو التوصيل'], ['attendance', 'تسجيل حضور PIN والبطاقة'], ['ask-store', 'اسأل محلك'], ['price-levels', 'مستويات الأسعار'], ['waste', 'تسجيل الهالك']
];
const UI_HIDEABLE_NAV = [['network','أجهزة الشبكة'],['dashboard','لوحة التحكم'],['low-stock','تنبيهات النواقص'],['branch','اختيار الفرع']];
let uiHiddenItems = new Set();
let uiEditorHiddenItems = new Set();
let uiVisibilityRole = '';
let uiVisibilityRoles = [];
const UI_VISIBILITY_COLLAPSED_KEY = 'system_visibility_groups_collapsed';
const UI_VISIBILITY_GROUP_KINDS = ['tab', 'nav', 'group', 'card'];
let uiVisibilityCollapsedGroups = new Set(UI_VISIBILITY_GROUP_KINDS);
function loadUiVisibilityCollapsedGroups() {
  try {
    const raw = localStorage.getItem(UI_VISIBILITY_COLLAPSED_KEY);
    if (raw === null) { uiVisibilityCollapsedGroups = new Set(UI_VISIBILITY_GROUP_KINDS); return; }
    const parsed = JSON.parse(raw);
    uiVisibilityCollapsedGroups = new Set(UI_VISIBILITY_GROUP_KINDS.filter(kind => Array.isArray(parsed) && parsed.includes(kind)));
  } catch (_) { uiVisibilityCollapsedGroups = new Set(UI_VISIBILITY_GROUP_KINDS); }
}
function saveUiVisibilityCollapsedGroups() {
  // Intentionally ignored: UI visibility preference is optional
  try { localStorage.setItem(UI_VISIBILITY_COLLAPSED_KEY, JSON.stringify([...uiVisibilityCollapsedGroups])); } catch (_) { /* optional UI preference */ }
}
function applyUiVisibilityCollapsedState() {
  document.querySelectorAll('[data-ui-visibility-group]').forEach(group => {
    const kind = group.dataset.uiVisibilityGroup;
    const collapsed = uiVisibilityCollapsedGroups.has(kind);
    const content = group.querySelector('[data-ui-collapse-content]');
    const controls = group.querySelectorAll('[data-ui-group-toggle]');
    content?.classList.toggle('hidden', collapsed);
    controls.forEach(button => {
      button.setAttribute('aria-expanded', String(!collapsed));
      const label = button.querySelector('[data-ui-group-hide-label]');
      if (label) label.textContent = collapsed ? 'إظهار المجموعة' : 'إخفاء المجموعة';
      const icon = button.querySelector('[data-ui-group-hide-icon]');
      if (icon) icon.setAttribute('data-lucide', collapsed ? 'chevron-down' : 'chevron-up');
    });
  });
  if (window.lucide) window.lucide.createIcons();
}
function isUiHidden(kind, id) { return uiHiddenItems.has(`${kind}:${id}`); }
function isUiVisibilityAdmin(user = currentUser) { return Boolean(user?.is_owner === true || user?.role === 'admin'); }
const DASHBOARD_DEDUP_LEGACY_IDS = new Set([
  'quick-wholesale', 'quick-offers', 'quick-purchases', 'quick-warehouses', 'quick-products', 'quick-categories',
  'quick-suppliers', 'quick-cash', 'quick-employees', 'quick-delivery', 'quick-riders', 'quick-e-invoice',
  'quick-dynamic-pricing', 'quick-customer-display', 'quick-shift-cash', 'quick-ledger-stock'
]);
function dashboardVisibilityCards() {
  const cards = [...document.querySelectorAll('#tab-dashboard .quick-action-card[data-layout-id]')]
    .filter(card => !DASHBOARD_DEDUP_LEGACY_IDS.has(card.dataset.layoutId))
    .map(card => [card.dataset.layoutId, card.getAttribute('aria-label') || card.textContent.trim()]);
  document.querySelectorAll('#tab-dashboard .luxury-card').forEach(card => {
    const value = card.querySelector('[id]');
    const key = value?.id;
    const label = card.querySelector('span')?.textContent?.trim();
    if (key && label) cards.push([key, label]);
  });
  return cards;
}
function applyDashboardGroupVisibility() {
  document.querySelectorAll('#tab-dashboard .dashboard-group-card').forEach(card => {
    const visible = [...card.querySelectorAll('.dashboard-group-link')].some(link => {
      const required = link.dataset.requiredPermission;
      if (required && !hasPermission(required)) return false;
      if (link.dataset.dashboardUnrestricted === 'true' && !isUnrestrictedAccount(currentUser)) return false;
      const route = link.dataset.dashboardGroupRoute;
      return !route || isTabAllowedForCurrentUser(route);
    });
    card.classList.toggle('hidden', !visible);
    card.setAttribute('aria-hidden', String(!visible));
  });
}
function ribbonTargetTab(target) {
  if (target === 'activate') return null;
  if (target === 'backup-settings') return 'settings';
  if (target === 'delivery-search' || target === 'rider-settlement') return 'delivery';
  if (target === 'customer-add') return 'customers';
  if (target === 'employee-add') return 'employees';
  if (target === 'supplier-add') return 'suppliers';
  if (target.startsWith('report-')) return 'reports';
  return target;
}
function applyUiVisibility() {
  document.querySelectorAll('[data-ui-group]').forEach(element => {
    element.classList.toggle('ui-admin-hidden', isUiHidden('group', element.dataset.uiGroup));
  });
  document.querySelectorAll('.tab-btn').forEach(button => {
    const tab = button.id.replace('tab-btn-', '');
    button.classList.toggle('ui-admin-hidden', isUiHidden('tab', tab));
  });
  document.querySelectorAll('.ribbon-tab').forEach(button => {
    const group = button.dataset.group;
    const tools = (typeof ribbonGroups !== 'undefined' ? ribbonGroups[group] : []) || [];
    const visibleTools = tools.filter(([, , target]) => !isUiHidden('tab', ribbonTargetTab(target)));
    button.classList.toggle('ui-admin-hidden', isUiHidden('group', group) || !visibleTools.length);
  });
  document.querySelectorAll('[data-ui-nav]').forEach(element => {
    const id = element.dataset.uiNav;
    element.classList.toggle('ui-admin-hidden', isUiHidden('nav', id));
  });
  document.querySelectorAll('#tab-dashboard .quick-action-card[data-layout-id]').forEach(card => {
    card.classList.toggle('ui-admin-hidden', isUiHidden('card', card.dataset.layoutId));
  });
  document.querySelectorAll('#tab-dashboard .luxury-card').forEach(card => {
    const key = card.querySelector('[id]')?.id;
    if (key) card.classList.toggle('ui-admin-hidden', isUiHidden('card', key));
  });
  const visibleRibbon = [...document.querySelectorAll('.ribbon-tab')].filter(b => !b.classList.contains('ui-admin-hidden') && b.style.display !== 'none');
  const active = visibleRibbon.find(b => b.classList.contains('active')) || visibleRibbon[0];
  if (active && typeof selectRibbonGroup === 'function') selectRibbonGroup(active.dataset.group);
  if (activeTab && isUiHidden('tab', activeTab) && typeof switchTab === 'function') {
    const firstVisible = [...document.querySelectorAll('.tab-btn')].find(button => !button.classList.contains('ui-admin-hidden') && button.style.display !== 'none');
    const fallback = firstVisible?.id.replace('tab-btn-', '') || 'settings';
    if (!isUiHidden('tab', fallback)) switchTab(fallback);
  }
}
async function loadUiSettings(role = '') {
  const requestedRole = String(role || document.getElementById('ui-visibility-role')?.value || uiVisibilityRole || currentUser?.role || '');
  // Intentionally ignored: preserving current UI state is safe when settings are unavailable
  try {
    const response = await fetch(`/api/ui-settings${requestedRole ? `?role=${encodeURIComponent(requestedRole)}` : ''}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر تحميل إعدادات الظهور.');
    uiVisibilityRole = data.role || requestedRole;
    uiVisibilityRoles = Array.isArray(data.roles) ? data.roles : [];
    uiEditorHiddenItems = new Set(Array.isArray(data.hidden) ? data.hidden : []);
    if (uiVisibilityRole === currentUser?.role) uiHiddenItems = new Set(uiEditorHiddenItems);
  } catch (_) { /* نبقي الحالة الحالية */ }
  if (currentUser) updateUserUI();
  renderUiVisibilitySettings();
}
function renderUiVisibilitySettings() {
  const host = document.getElementById('ui-visibility-list');
  if (!host) return;
  const panel = document.getElementById('ui-visibility-admin-panel');
  const admin = isUiVisibilityAdmin();
  panel?.classList.toggle('hidden', !admin);
  if (!admin) { host.replaceChildren(); return; }
  const roleSelect = document.getElementById('ui-visibility-role');
  if (roleSelect) {
    const roles = [...new Set([...uiVisibilityRoles, currentUser.role])].filter(Boolean);
    roleSelect.innerHTML = roles.map(role => `<option value="${escapeHtml(role)}">${escapeHtml(({owner:'مالك النظام',manager:'مدير',admin:'مدير النظام',cashier:'كاشير',accountant:'محاسب',inventory_manager:'مسؤول المخزن'})[role] || role)}</option>`).join('');
    roleSelect.value = roles.includes(uiVisibilityRole) ? uiVisibilityRole : currentUser.role;
    uiVisibilityRole = roleSelect.value;
  }
  loadUiVisibilityCollapsedGroups();
  const box = (kind, id, label) => `<label class="flex items-center gap-2 text-xs font-semibold text-gray-700 rounded-lg border border-gray-200 px-3 py-2 bg-gray-50"><input type="checkbox" class="accent-pink-600 ui-visibility-box" data-kind="${escapeHtml(kind)}" data-id="${escapeHtml(id)}" ${uiEditorHiddenItems.has(`${kind}:${id}`) ? '' : 'checked'}> ${escapeHtml(label)}</label>`;
  const group = (kind, title, items) => `<section class="ui-visibility-group rounded-xl border border-gray-200 p-3" data-ui-visibility-group="${kind}"><div class="flex flex-wrap items-center justify-between gap-2"><button type="button" class="ui-group-title-toggle text-xs font-black text-gray-600" data-ui-group-toggle aria-expanded="${String(!uiVisibilityCollapsedGroups.has(kind))}" aria-controls="ui-visibility-content-${kind}" onclick="toggleUiVisibilityGroup(this,event)">${title}</button><button type="button" class="ui-group-hide-toggle inline-flex min-h-10 min-w-11 items-center gap-1 rounded-lg px-3 py-1.5 text-[11px] font-black" data-ui-group-toggle aria-expanded="${String(!uiVisibilityCollapsedGroups.has(kind))}" aria-controls="ui-visibility-content-${kind}" onclick="toggleUiVisibilityGroup(this,event)"><i data-ui-group-hide-icon data-lucide="${uiVisibilityCollapsedGroups.has(kind) ? 'chevron-down' : 'chevron-up'}" class="h-4 w-4" aria-hidden="true"></i><span data-ui-group-hide-label>${uiVisibilityCollapsedGroups.has(kind) ? 'إظهار المجموعة' : 'إخفاء المجموعة'}</span></button></div><div id="ui-visibility-content-${kind}" data-ui-collapse-content class="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3 ${uiVisibilityCollapsedGroups.has(kind) ? 'hidden' : ''}">${items.map(([id, label]) => box(kind, id, label)).join('')}</div></section>`;
  host.innerHTML = `${group('tab', 'شاشات القائمة الجانبية', UI_HIDEABLE_TABS)}${group('nav', 'أزرار الشريط العلوي', UI_HIDEABLE_NAV)}${group('group', 'قوائم الشريط العلوي', UI_HIDEABLE_GROUPS)}${group('card', 'بطاقات لوحة التحكم', dashboardVisibilityCards())}`;
  if (window.lucide) window.lucide.createIcons();
}
function toggleUiVisibilityGroup(button, event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  const contentId = button?.getAttribute('aria-controls');
  const content = contentId ? document.getElementById(contentId) : button?.closest('[data-ui-visibility-group]')?.querySelector('[data-ui-collapse-content]');
  if (!content) return;
  const group = button.closest('[data-ui-visibility-group]');
  const kind = group?.dataset.uiVisibilityGroup;
  if (!kind || !content) return;
  const collapsed = !uiVisibilityCollapsedGroups.has(kind);
  if (collapsed) uiVisibilityCollapsedGroups.add(kind); else uiVisibilityCollapsedGroups.delete(kind);
  saveUiVisibilityCollapsedGroups();
  applyUiVisibilityCollapsedState();
}
function setAllUiVisibilityGroupsCollapsed(collapsed) {
  uiVisibilityCollapsedGroups = collapsed ? new Set(UI_VISIBILITY_GROUP_KINDS) : new Set();
  saveUiVisibilityCollapsedGroups();
  applyUiVisibilityCollapsedState();
}
async function saveUiVisibility(showAll = false) {
  const status = document.getElementById('ui-visibility-status');
  if (!isUiVisibilityAdmin()) { if (status) status.textContent = 'إعدادات الظهور متاحة للأدمن فقط.'; return; }
  const hidden = showAll ? [] : [...document.querySelectorAll('.ui-visibility-box')].filter(el => !el.checked).map(el => `${el.dataset.kind}:${el.dataset.id}`);
  try {
    const response = await fetch('/api/ui-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: uiVisibilityRole || currentUser.role, hidden }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر الحفظ');
    uiVisibilityRoles = Array.isArray(data.roles) ? data.roles : uiVisibilityRoles;
    uiEditorHiddenItems = new Set(data.hidden);
    if (data.role === currentUser.role) uiHiddenItems = new Set(data.hidden);
    updateUserUI();
    renderUiVisibilitySettings();
    if (status) status.textContent = showAll ? 'تم إظهار كل الشاشات.' : `تم الحفظ. العناصر المخفية: ${data.hidden.length}`;
  } catch (error) { if (status) status.textContent = error.message; }
}

function updateUserUI() {
  const nextLocaleUser = currentUser?.id || currentUser?.username || 'guest';
  if (window.__systemLocaleUser !== nextLocaleUser) {
    window.rawdaCurrentUser = currentUser;
    window.__systemLocaleUser = nextLocaleUser;
    window.loadUiLanguage?.();
  }
  const nameEl = document.getElementById('nav-user-name');
  const roleEl = document.getElementById('nav-user-role');
  const initEl = document.getElementById('nav-user-initial');
  const adminSection = document.getElementById('admin-menu-section');

  if (!currentUser) return;
  if (nameEl) nameEl.textContent = currentUser.name;
  const statusUser = document.getElementById('status-user');
  if (statusUser) statusUser.textContent = currentUser.name;
  if (initEl) initEl.textContent = currentUser.name.charAt(0);

  const roleLabels = {
    super_owner: 'Super Owner',
    owner: 'مالك النظام',
    manager: 'مدير الفرع',
    admin: 'مدير النظام',
    inventory_manager: 'مسؤول المخزن',
    cashier: 'كاشير مبيعات',
    accountant: 'محاسب'
  };

  if (roleEl) roleEl.textContent = roleLabels[currentUser.role] || currentUser.role;
  const unrestricted = isUnrestrictedAccount(currentUser);
  const allowedTabsField = document.getElementById('user-allowed-tabs-field');
  if (allowedTabsField && allowedTabsField.dataset.targetHidden !== 'true') allowedTabsField.classList.toggle('hidden', !unrestricted);

  const tabAllowed = tab => isTabAllowedForCurrentUser(tab);
  document.querySelectorAll('.tab-btn').forEach(button => {
    const tab = button.id.replace('tab-btn-', '');
    button.style.display = tabAllowed(tab) ? '' : 'none';
  });
  document.querySelectorAll('.tab-content[id^="tab-"]').forEach(section => {
    const tab = section.id.replace('tab-', '');
    const allowed = tabAllowed(tab);
    const selected = allowed && tab === activeTab;
    section.classList.toggle('hidden', !selected);
    section.classList.toggle('block', selected);
    section.style.display = allowed ? '' : 'none';
  });
  if (adminSection) adminSection.style.display = ['reports', 'users', 'audit-logs', 'settings'].some(tabAllowed) ? '' : 'none';
  document.querySelectorAll('.ribbon-tab').forEach(button => {
    const group = button.dataset.group;
    const groupPermissions = {
      settings: ['system_settings', 'import_export'], customers: ['view'], suppliers: ['view'],
      purchases: ['view'], sales: ['view'], reports: ['view'], employees: ['view', 'user_management'],
      cash: ['view'], installments: ['view'], database: ['import_export']
    };
    button.style.display = hasAnyCurrentPermission(...(groupPermissions[group] || ['view'])) ? '' : 'none';
  });
  document.querySelectorAll('[data-required-permission]').forEach(element => {
    element.classList.toggle('hidden', !hasPermission(element.dataset.requiredPermission));
  });
  document.querySelectorAll('[data-owner-only="true"]').forEach(element => {
    element.classList.toggle('hidden', !unrestricted);
  });
  const settingsHub = document.getElementById('settings-navigation-hub');
  if (settingsHub) {
    const hubCards = [...settingsHub.querySelectorAll('.settings-navigation-card')];
    const visibleHubCards = hubCards.filter(card => !card.classList.contains('hidden') && card.style.display !== 'none');
    document.getElementById('settings-navigation-empty')?.classList.toggle('hidden', visibleHubCards.length > 0);
  }
  document.getElementById('ui-visibility-admin-panel')?.classList.toggle('hidden', !isUiVisibilityAdmin(currentUser));
  const networkButton = document.querySelector('header button[onclick="openNetworkModal()"]');
  if (networkButton) networkButton.style.display = hasPermission('system_settings') ? '' : 'none';
  applyActionButtonPermissions();
  renderFocusedControls();
  const canOpenAnyTab = Object.keys(TAB_PERMISSION_REQUIREMENTS).some(tabAllowed);
  document.getElementById('permission-empty')?.classList.toggle('hidden', canOpenAnyTab);
  if (!tabAllowed(activeTab)) activeTab = isFocusedAccount(currentUser) ? getFocusedInitialTab() : Object.keys(TAB_PERMISSION_REQUIREMENTS).find(tabAllowed) || '';
  applyUiVisibility();
  applyDashboardGroupVisibility();
  if (currentUser.role === 'cashier' && hasPermission('view') && isTabAllowedForCurrentUser('pos')) switchTab('pos');
}

function hasPermission(permission) {
  return Boolean(isUnrestrictedAccount(currentUser) || (Array.isArray(currentUser?.permissions) && currentUser.permissions.includes(permission)));
}

function applyActionButtonPermissions(root = document) {
  if (!currentUser) return;
  root.querySelectorAll?.('button[onclick], button[form], form button[type="submit"]')?.forEach(button => {
    if (button.closest('#modal-login')) return;
    const form = button.closest('form');
    const handler = button.getAttribute('onclick') || form?.getAttribute('onsubmit') || '';
    let required = '';
    if (/BusinessCatalog|businessCatalog|openBusinessCatalog/.test(handler)) required = 'import_export';
    else if (/editUser|deleteUser|toggleUserStatus/.test(handler)) required = 'user_management';
    else if (/handleUserSubmit/.test(handler)) required = 'user_management';
    else if (/delete|remove|deactivatePromotion/.test(handler) && !/removeFromCart/.test(handler)) required = 'delete';
    else if (/saveOfferMessage|edit|update|returnSale|toggleDeliveryRider/.test(handler)) required = 'edit';
    else if (/print|reprint|barcode/i.test(handler)) required = 'print_pdf';
    else if (/downloadBackup|restoreBackup|export/i.test(handler)) required = 'import_export';
    else if (/saveContactPhone|saveNetworkConfig|saveCustomDatabasePath|chooseDatabaseFolder|openDatabaseFolder|openNetworkModal/.test(handler)) required = 'system_settings';
    else if (form && /handle.*Submit|saveDeliveryRider/.test(handler) && !/handleUserSubmit/.test(handler)) required = 'add_or_edit';
    else if (/openProductModal|openNewUserModal|openModal\('modal-add-|saveCategory|addPurchase|addExpense|createServiceOrder|collectServiceOrderPayment|createPromotion|handle.*Submit|saveProduct|saveCustomer|saveSupplier/.test(handler)) required = 'add';
    if (!required) return;
    const allowed = required === 'add_or_edit'
      ? hasPermission('add') || hasPermission('edit')
      : required === 'user_management'
      ? hasPermission('user_management')
      : hasPermission(required);
    button.style.display = allowed ? '' : 'none';
  });
}

async function loadAuthorizedWorkspace() {
  if (!currentUser || !hasPermission('view')) return;
  await Promise.all([loadUiSettings(), loadPrintSettings(), loadReturnSettings()]);
}

async function handleLogout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch (err) { console.error('[1.16-B]', err); }
  currentUser = null;
  window.rawdaCurrentUser = null;
  window.playSound?.('logout');
  sessionStorage.removeItem('system_session');
  document.body.classList.remove('dashboard-luxury-active', 'dashboard-sage-active');
  document.body.style.removeProperty('background');
  document.getElementById('app-shell')?.classList.add('hidden');
  openModal('modal-login');
}

function toggleProfileMenu(force) {
  const menu = document.getElementById('user-profile-menu');
  const toggle = document.querySelector('#user-profile-badge button[aria-controls="user-profile-menu"]');
  if (!menu) return;
  const open = typeof force === 'boolean' ? force : menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  toggle?.setAttribute('aria-expanded', String(open));
}

async function logoutAllDevices() {
  if (!await showAppConfirm('سيتم تسجيل الخروج من كل الأجهزة المتصلة بهذا الحساب. هل تريد المتابعة؟')) return;
  try {
    const response = await fetch('/api/auth/logout-all', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر تسجيل الخروج من كل الأجهزة.');
    currentUser = null;
    sessionStorage.removeItem('system_session');
    document.getElementById('app-shell')?.classList.add('hidden');
    openModal('modal-login');
    showAppToast(result.message || 'تم تسجيل الخروج من كل الأجهزة.', { tone: 'success' });
  } catch (error) { showAppToast(error.message, { tone: 'error' }); }
}

async function loadMaintenanceStatus() {
  try {
    const response = await fetch('/api/maintenance/status', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) return result;
    const screen = document.getElementById('maintenance-screen');
    const owner = isUnrestrictedAccount(currentUser);
    const visible = Boolean(result.enabled) && !owner;
    screen?.classList.toggle('hidden', !visible);
    screen?.classList.toggle('flex', visible);
    if (visible) {
      document.getElementById('maintenance-message')?.replaceChildren(document.createTextNode(document.documentElement.lang === 'en' ? result.message_en : result.message_ar));
      const expected = document.getElementById('maintenance-expected-end');
      if (expected) expected.textContent = result.expected_end ? `الموعد المتوقع: ${result.expected_end}` : '';
      document.getElementById('app-shell')?.classList.add('hidden');
      document.getElementById('modal-login')?.classList.add('hidden');
    } else if (!result.enabled && !currentUser) {
      document.getElementById('modal-login')?.classList.remove('hidden');
    }
    return result;
  } catch (_) { return null; }
}

async function loadMaintenanceSettings() {
  const result = await loadMaintenanceStatus();
  if (!result) return;
  const enabled = document.getElementById('maintenance-enabled');
  const messageAr = document.getElementById('maintenance-message-ar');
  const messageEn = document.getElementById('maintenance-message-en');
  const expected = document.getElementById('maintenance-expected-end');
  if (enabled) enabled.checked = Boolean(result.enabled);
  if (messageAr) messageAr.value = result.message_ar || '';
  if (messageEn) messageEn.value = result.message_en || '';
  if (expected) expected.value = result.expected_end || '';
}

async function saveMaintenanceSettings() {
  if (!isUnrestrictedAccount(currentUser)) return showAppToast('وضع الصيانة متاح للمالك أو super_owner فقط.', { tone: 'error' });
  const payload = { enabled: Boolean(document.getElementById('maintenance-enabled')?.checked), message_ar: document.getElementById('maintenance-message-ar')?.value, message_en: document.getElementById('maintenance-message-en')?.value, expected_end: document.getElementById('maintenance-expected-end')?.value };
  try {
    const response = await fetch('/api/maintenance/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر حفظ وضع الصيانة.');
    document.getElementById('maintenance-settings-status').textContent = result.message;
    showAppToast(result.message, { tone: 'success' });
    await loadMaintenanceStatus();
  } catch (error) { showAppToast(error.message, { tone: 'error' }); }
}

function updatePasswordStrength(value) {
  const score = [value.length >= 8, /[A-Z]/u.test(value), /\d/u.test(value), /[^\p{L}\p{N}]/u.test(value)].filter(Boolean).length;
  const bar = document.getElementById('own-password-strength');
  const label = document.getElementById('own-password-strength-label');
  if (bar) { bar.style.width = `${score * 25}%`; bar.className = `block h-full rounded-full transition-all ${score < 2 ? 'bg-rose-500' : score < 4 ? 'bg-amber-500' : 'bg-emerald-500'}`; }
  if (label) label.textContent = score === 4 ? 'كلمة مرور قوية' : '8 أحرف + حرف كبير + رقم + رمز';
}

async function updateTrialBanner() {
  const banner = document.getElementById('trial-banner');
  if (!banner) return;
  // Intentionally ignored: trial banner refresh is optional UI feedback
  try {
    const response = await fetch('/api/license/status', { cache: 'no-store' });
    const status = await response.json();
    if (!response.ok || !status.active || !status.trial) { banner.classList.add('hidden'); document.getElementById('trial-days-remaining')?.classList.add('hidden'); return; }
    const daysRemaining = Math.max(0, Number(status.daysRemaining) || Math.ceil((Number(status.expiresAt) - Date.now()) / 86400000));
    const daysUsed = Math.min(30, Math.max(0, 30 - daysRemaining));
    const english = document.documentElement.lang === 'en';
    const text = english
      ? `Trial: 30 days — used ${daysUsed}, remaining ${daysRemaining}. Activate the program after the trial ends.`
      : `التجربة: 30 يوماً — تم استخدام ${daysUsed}، والمتبقي ${daysRemaining} يوماً. فعّل البرنامج بعد انتهاء الفترة.`;
    const textNode = document.getElementById('trial-banner-text');
    if (textNode) textNode.textContent = text; else banner.textContent = text;
    banner.classList.remove('hidden');
    const daysLabel = document.getElementById('trial-days-remaining');
    if (daysLabel) { daysLabel.textContent = english ? `${daysRemaining} trial days left` : `متبقٍ ${daysRemaining} يوماً`; daysLabel.classList.remove('hidden'); }
  } catch (_) {}
}

async function getServerLicenseStatus() {
  try {
    const response = await fetch('/api/license/status', { cache: 'no-store' });
    const status = await response.json();
    const field = document.getElementById('license-device-id');
    if (field) field.value = status.deviceId || '';
    updateActivationSupportLink();
    return response.ok ? status : { ...status, active: false };
  } catch (_) { return { active: false, reason: 'تعذر التحقق من حالة الترخيص من الخادم.' }; }
}

function quickLogin(username, pass) {
  document.getElementById('login-username').value = username;
  document.getElementById('login-password').value = pass;
  handleLoginSubmit(new Event('submit'));
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const loginButton = document.getElementById('login-btn');
  const submitLabel = document.getElementById('login-submit-label');
  const spinner = document.getElementById('login-spinner');
  const originalLabel = submitLabel?.textContent || 'دخول للنظام';
  if (loginButton) { loginButton.disabled = true; loginButton.setAttribute('aria-busy', 'true'); }
  if (submitLabel) submitLabel.textContent = document.documentElement.lang === 'en' ? 'Logging in…' : 'جاري الدخول...';
  if (spinner) spinner.style.display = 'inline-flex';
  const username = document.getElementById('login-username').value.trim();
  const pass = document.getElementById('login-password').value;
  const loginError = document.getElementById('login-error-message');
  if (loginError) { loginError.textContent = ''; loginError.classList.add('hidden'); }
  try {
    currentUser = await storage.login(username, pass);
    window.playSound?.('login');
    const remember = document.getElementById('remember-login')?.checked;
    await finishLogin(currentUser, { username, password: pass, remember, rememberCredentials: true });
  } catch (err) {
    currentUser = null;
    window.playSound?.('error');
    const message = err.message || 'اسم المستخدم أو كلمة المرور غير صحيحة، أو الحساب معطل.';
    if (loginError) { loginError.textContent = message; loginError.classList.remove('hidden'); }
    else showAppToast(message, { tone: 'error' });
  } finally {
    if (loginButton) { loginButton.disabled = false; loginButton.removeAttribute('aria-busy'); }
    if (submitLabel) submitLabel.textContent = originalLabel;
    if (spinner) spinner.style.display = 'none';
  }
}

async function openAuthorizedWorkspace(user) {
  await initializeBranchWorkspace();
  await loadAuthorizedWorkspace();
  document.getElementById('app-shell')?.classList.remove('hidden');
  closeModal('modal-login');
  const firstTab = isFocusedAccount(user) ? getFocusedInitialTab() : 'dashboard';
  activeTab = isTabAllowedForCurrentUser(firstTab) ? firstTab : (isTabAllowedForCurrentUser('dashboard') ? 'dashboard' : Object.keys(TAB_PERMISSION_REQUIREMENTS).find(isTabAllowedForCurrentUser) || 'pos');
  // Intentionally ignored: restoring the active tab is best-effort
  try { localStorage.setItem('system_active_tab', activeTab); } catch (_) {}
  switchTab(activeTab);
}

function reloadWarehouseFramesAfterLogin() {
  document.querySelectorAll('iframe.warehouse-ui-frame').forEach(frame => {
    // These frames can be created before the login cookie exists. Reload them
    // after authentication so their own API calls inherit the live session.
    frame.src = frame.dataset.authSrc || frame.src;
  });
}

async function finishLogin(user, { username, password = '', remember = false, rememberCredentials = false } = {}) {
  let priorSession = null;
  try { priorSession = JSON.parse(sessionStorage.getItem('system_session') || 'null'); } catch (err) {
    logError({ type: '[1.16-C]', message: err?.message || String(err), stack: err?.stack || '' });
    showAppToast('حدث خطأ، حاول مرة أخرى', { tone: 'error' });
  }
  const appAlreadyOpen = !document.getElementById('app-shell')?.classList.contains('hidden');
  if (loginFinishing || (appAlreadyOpen && String(priorSession?.id) === String(user?.id))) return;
  loginFinishing = true;
  try {
    currentUser = user;
    window.rawdaCurrentUser = currentUser;
    window.SoundSettings?.syncUser();
  await initializeUiZoom();
  await initializePerformanceMode();
  setTimeout(syncOfflineSalesQueue, 800);
  if (rememberCredentials) {
    if (remember && window.rawdaDesktop?.saveRememberedLogin) {
      const saved = await window.rawdaDesktop.saveRememberedLogin({ username, password, role: user.role });
      if (!saved?.saved) {
        document.getElementById('remember-login').checked = false;
        showAppToast(saved?.error || 'تعذر حفظ بيانات الدخول على هذا الجهاز.');
      }
    } else if (!remember) {
      await window.rawdaDesktop?.clearRememberedLogin?.();
    } else {
      document.getElementById('remember-login').checked = false;
      showAppToast('حفظ بيانات الدخول تلقائيًا متاح في نسخة Windows فقط.');
    }
  }
  sessionStorage.setItem('system_session', JSON.stringify(user));
  updateUserUI();
  pendingPasswordChangeContext = null;
  await openAuthorizedWorkspace(user);
  reloadWarehouseFramesAfterLogin();
  showAppToast(`مرحباً بك يا ${user.name}!`, { duration: 4500, tone: 'success' });
  } finally {
    loginFinishing = false;
  }
}

const webAuthnEncode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const webAuthnDecode = value => Uint8Array.from(atob(String(value).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - String(value).length % 4) % 4)), char => char.charCodeAt(0));
async function webAuthnRequest(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'تعذر إكمال طلب Windows Hello.');
  return result;
}
function ensureWindowsHelloAvailable() {
  if (!window.isSecureContext || !navigator.credentials || !window.PublicKeyCredential) {
    throw new Error('ميزة Windows Hello غير متاحة في هذا السياق. افتح التطبيق من نسخته المكتبية ثم أعد المحاولة.');
  }
}
function showInPageInputDialog(message, options = {}) {
  const modal=document.getElementById('modal-input-dialog'), input=document.getElementById('input-dialog-value'), messageEl=document.getElementById('input-dialog-message'), ok=document.getElementById('input-dialog-confirm'), cancel=document.getElementById('input-dialog-cancel');
  if(!modal||!input||!messageEl||!ok||!cancel)return Promise.resolve(null);
  messageEl.textContent=String(message||'أدخل القيمة المطلوبة.'); input.value=''; input.type=options.type==='password'?'password':'text'; modal.classList.remove('hidden'); modal.classList.add('flex');
  return new Promise(resolve=>{let settled=false;const finish=value=>{if(settled)return;settled=true;modal.classList.add('hidden');modal.classList.remove('flex');input.removeEventListener('keydown',key);ok.removeEventListener('click',yes);cancel.removeEventListener('click',no);resolve(value)};const yes=()=>finish(input.value),no=()=>finish(null),key=e=>{if(e.key==='Enter'){e.preventDefault();yes()}else if(e.key==='Escape'){e.preventDefault();no()}};ok.addEventListener('click',yes);cancel.addEventListener('click',no);input.addEventListener('keydown',key);input.focus()});
}

async function registerWindowsHello() {
  try {
    ensureWindowsHelloAvailable();
    const username = document.getElementById('pin-username')?.value.trim() || '';
    if (!username) throw new Error('اكتب اسم المستخدم أولاً.');
    const password = await showInPageInputDialog('أدخل كلمة مرور الحساب لربط Windows Hello:', { type: 'password' });
    if (password === null || !password) return;
    const options = await webAuthnRequest('/api/webauthn/register/options', { username, password });
    options.challenge = webAuthnDecode(options.challenge);
    options.user.id = webAuthnDecode(options.user.id);
    options.excludeCredentials = (options.excludeCredentials || []).map(item => ({ ...item, id: webAuthnDecode(item.id) }));
    const credential = await navigator.credentials.create({ publicKey: options });
    if (!credential) throw new Error('لم يُكمل Windows Hello التسجيل.');
    const result = await webAuthnRequest('/api/webauthn/register/verify', {
      challenge: webAuthnEncode(options.challenge),
      id: credential.id,
      clientDataJSON: webAuthnEncode(credential.response.clientDataJSON),
      attestationObject: webAuthnEncode(credential.response.attestationObject),
      transports: credential.response.getTransports ? credential.response.getTransports() : ['internal']
    });
    if (result.success) showAppToast('تم ربط Windows Hello بهذا الحساب. يمكنك الآن الدخول بالبصمة أو الوجه مع بقاء كلمة المرور وPIN متاحين.');
  } catch (error) {
    showAppToast(error.message || 'تعذر ربط Windows Hello.');
  }
}
async function loginWithWindowsHello() {
  try {
    ensureWindowsHelloAvailable();
    const username = document.getElementById('pin-username')?.value.trim() || '';
    if (!username) throw new Error('اكتب اسم المستخدم أولاً.');
    const options = await webAuthnRequest('/api/webauthn/auth/options', { username });
    options.challenge = webAuthnDecode(options.challenge);
    options.allowCredentials = (options.allowCredentials || []).map(item => ({ ...item, id: webAuthnDecode(item.id) }));
    const credential = await navigator.credentials.get({ publicKey: options });
    if (!credential) throw new Error('لم يُكمل Windows Hello التحقق.');
    const user = await webAuthnRequest('/api/webauthn/auth/verify', {
      challenge: webAuthnEncode(options.challenge),
      id: credential.id,
      authenticatorData: webAuthnEncode(credential.response.authenticatorData),
      clientDataJSON: webAuthnEncode(credential.response.clientDataJSON),
      signature: webAuthnEncode(credential.response.signature),
      userHandle: credential.response.userHandle ? webAuthnEncode(credential.response.userHandle) : null
    });
    await finishLogin(user, { username, rememberCredentials: false });
  } catch (error) {
    currentUser = null;
    showAppToast(error.message || 'تعذر الدخول باستخدام Windows Hello. يمكنك استخدام كلمة المرور أو PIN.');
  }
}

// ----------------------------------------------------
// Navigation / Tab Switcher
// ----------------------------------------------------
function setRibbonSelectionForScreen(tabId) {
  const screenGroups = { dashboard:'overview', delivery:'overview', 'delivery-riders':'overview', customers:'customers', purchases:'purchases', inventory:'purchases', products:'purchases', categories:'purchases', 'branch-warehouse':'overview', pos:'sales', 'sales-history':'sales', promotions:'sales', 'offer-messages':'customers', reports:'reports', employees:'employees', users:'employees', installments:'installments', settings:'database', 'audit-logs':'database', barcodes:'database' };
  const group = screenGroups[tabId];
  if (group) selectRibbonGroup(group);
  setActiveRibbonToolForScreen(group, tabId);
}

let dashboardDigitObserver = null;
function normalizeDashboardDigits() {
  const root = document.getElementById('tab-dashboard');
  if (!root) return;
  const convert = value => String(value).replace(/[٠-٩۰-۹]/g, digit => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (/[٠-٩۰-۹]/.test(node.nodeValue)) node.nodeValue = convert(node.nodeValue);
  }
  root.querySelectorAll('[aria-label],[title],[placeholder]').forEach(node => {
    for (const attribute of ['aria-label', 'title', 'placeholder']) {
      const value = node.getAttribute(attribute);
      if (value && /[٠-٩۰-۹]/.test(value)) node.setAttribute(attribute, convert(value));
    }
  });
  if (!dashboardDigitObserver) {
    dashboardDigitObserver = new MutationObserver(() => normalizeDashboardDigits());
    dashboardDigitObserver.observe(root, { subtree: true, childList: true, characterData: true });
  }
}

function refreshPosIdentity(profileOverride = null) {
  const branchNameEl = document.getElementById('pos-dynamic-branch-name');
  const cashierNameEl = document.getElementById('pos-dynamic-cashier-name');
  const businessLogoEl = document.getElementById('pos-business-logo');
  let storedProfile = {};
  // Intentionally ignored: cached business identity is optional
  try { storedProfile = JSON.parse(localStorage.getItem('business_profile') || '{}'); } catch (_) {}
  const profile = profileOverride || networkInfo?.business_profile || {};
  const systemProfile = window.systemSettings?.business_profile || window.systemSettings || {};
  const businessName = String(profile.business_name || profile.activity || networkInfo?.business_profile?.business_name || networkInfo?.business_profile?.activity || storedProfile.business_name || storedProfile.activity || systemProfile.business_name || systemProfile.activity || currentUser?.business_profile?.business_name || currentUser?.business_name || currentUser?.activity || 'النشاط التجاري').trim() || 'النشاط التجاري';
  const cashierName = String(currentUser?.full_name || currentUser?.name || currentUser?.username || '').trim();
  const logoUrl = String(profile.logo_url || networkInfo?.business_profile?.logo_url || storedProfile.logo_url || '').trim();
  if (branchNameEl) branchNameEl.textContent = businessName;
  if (cashierNameEl && cashierName) cashierNameEl.textContent = cashierName;
  if (businessLogoEl) {
    if (logoUrl) {
      businessLogoEl.onerror = () => { businessLogoEl.style.display = 'none'; };
      businessLogoEl.src = logoUrl;
      businessLogoEl.style.display = 'block';
    } else {
      businessLogoEl.removeAttribute('src');
      businessLogoEl.style.display = 'none';
    }
  }
}

function switchTab(tabId) {
  if (!currentUser) return;
  if (tabId !== 'pos') stopPosBarcodeCamera();
  const posNav = document.getElementById('pos-navigation-drawer') || document.querySelector('.pos-subnav') || document.getElementById('ribbon-tools');
  document.body.classList.remove('pos-subnav-visible');
  if (tabId === 'pos') {
    document.querySelectorAll('.pos-subnav, #pos-subnav').forEach(el => el.style.display = 'none');
    if (posNav) posNav.style.display = 'none';
  } else {
    document.querySelectorAll('.pos-subnav, #pos-subnav').forEach(el => el.style.removeProperty('display'));
    if (posNav) posNav.style.removeProperty('display');
  }
  if (tabId !== 'pos') document.getElementById('pos-navigation-drawer')?.classList.add('hidden');
  document.body.classList.toggle('pos-screen-active', tabId === 'pos');
  document.body.classList.toggle('erp-preview-active', tabId !== 'pos');
  applyGlobalChromePreference();
  const globalSidebar = document.querySelector('#app-shell aside.w-60');
  // Phase 1 keeps the global navigation available and collapsible on desktop.
  const hideGlobalSidebar = false;
  globalSidebar?.classList.toggle('hidden', hideGlobalSidebar);
  globalSidebar?.style.setProperty('display', hideGlobalSidebar ? 'none' : 'block', 'important');
  document.body.classList.toggle('warehouse-page-active', tabId === 'inventory');
  document.body.classList.toggle('inventory-preview-active', tabId === 'inventory');
  if (tabId === 'pos') selectRibbonGroup('sales');
  if (tabId !== 'purchases') void stopPurchaseBarcodeCamera();
  const protectedTabs = {
    users: 'user_management', settings: 'system_settings', 'audit-logs': 'view',
    barcodes: 'print_pdf'
  };
  if (isFocusedAccount(currentUser) && !isTabAllowedForCurrentUser(tabId)) return false;
  if (!canSeeAssignedScreen(currentUser, tabId)) return showAppToast('هذه الشاشة غير مسموحة لحسابك.');
  if (!isUnrestrictedAccount(currentUser) && tabId === 'settings') {
    if (!hasPermission('system_settings') && !hasPermission('import_export')) return showAppToast('لا تملك صلاحية إعدادات النظام أو النسخ الاحتياطي.');
  } else if (!isUnrestrictedAccount(currentUser) && tabId === 'barcodes' && (!hasPermission('view') || !hasPermission('print_pdf'))) {
    return showAppToast('تحتاج إلى صلاحية العرض والطباعة لفتح شاشة الباركود.');
  } else if (!isUnrestrictedAccount(currentUser) && protectedTabs[tabId] && !hasPermission(protectedTabs[tabId])) {
    return showAppToast('لا تملك صلاحية فتح هذه الشاشة.');
  } else if (!isUnrestrictedAccount(currentUser) && !protectedTabs[tabId] && !hasPermission('view')) {
    return showAppToast('لا تملك صلاحية العرض والبحث.');
  }
  if (isUiHidden('tab', tabId)) {
    const fallback = [...document.querySelectorAll('.tab-btn')].find(button => button.style.display !== 'none' && button.id !== `tab-btn-${tabId}`)?.id.replace('tab-btn-', '');
    tabId = fallback || 'settings';
  }
  if (tabId !== activeTab) previousAppTab = activeTab;
  if (tabId !== 'reports') explicitDetailedReportTitle = '';
  activeTab = tabId;
  const dashboardLuxuryMode = tabId === 'dashboard';
  document.body.classList.toggle('dashboard-preview-active', dashboardLuxuryMode);
  document.querySelectorAll('.dashboard-preview-nav button').forEach(button => {
    const target = button.getAttribute('onclick')?.match(/switchTab\(['"]([^'"]+)['"]\)/)?.[1];
    button.classList.toggle('active', target === tabId);
  });
  document.querySelectorAll('[data-inventory-preview-nav]').forEach(button => {
    button.classList.toggle('active', button.dataset.inventoryTarget === tabId);
  });
  document.querySelectorAll('[data-erp-preview-nav]').forEach(button => {
    button.classList.toggle('active', button.dataset.erpTarget === tabId);
  });
  const previewUserName = document.getElementById('erp-preview-user-name');
  if (previewUserName && currentUser) previewUserName.textContent = currentUser.name || currentUser.username || 'المدير العام';
  const sageDashboardMode = dashboardLuxuryMode && document.body.classList.contains('theme-sage-metal');
  document.body.classList.toggle('dashboard-sage-active', sageDashboardMode);
  if (sageDashboardMode) document.body.style.setProperty('background', 'var(--system-page)', 'important');
  else document.body.style.removeProperty('background');
  const dashboardRole = document.getElementById('business-dashboard-role');
  const currentRoleLabel = document.getElementById('nav-user-role')?.textContent?.trim();
  if (dashboardRole && currentRoleLabel) dashboardRole.textContent = currentRoleLabel;
  if (isFocusedAccount(currentUser) && !getFocusedAllowedTabs().includes(tabId)) return false;
  localStorage.setItem('system_active_tab', tabId);
  setRibbonSelectionForScreen(tabId);
  if (tabId === 'settings') {
    const backupSection = document.getElementById('settings-backup-section');
    const backupPanel = document.getElementById('backup-manager-panel');
    if (backupSection) { backupSection.hidden = false; backupSection.style.removeProperty('display'); }
    if (backupPanel) { backupPanel.hidden = false; backupPanel.style.removeProperty('display'); }
    void loadNetworkAndConfig();
    loadLoyaltySettings(); loadTaxSettings(); void loadReturnSettings();
    if (hasPermission('system_settings')) { loadScheduledBackupSettings(); loadGoogleDriveBackupStatus(); }
    if (hasPermission('import_export')) { void loadScheduledBackups(); void loadBackupSettings(); void loadBackups(); }
  }

  if (tabId === 'settings') {
    const key = `system_pos_layout_mode_${String(currentUser?.id || currentUser?.username || 'guest')}`;
    const setting = document.getElementById('pos-layout-setting');
    if (setting) setting.value = localStorage.getItem(key) === 'classic' ? 'classic' : 'cards';
  }
  if (tabId === 'pos') { loadActivePromotions(); void loadTaxSettings(); void populateCustomerDropdowns(); void loadPosDeliveryRiders(); document.querySelectorAll('.pos-mode-btn').forEach(button => button.classList.toggle('active', button.dataset.priceMode === activePosPriceLevel)); void renderPosProducts(); void refreshPosSummaryCards(); }
  if (tabId === 'wallets') void window.WalletsUI?.load();

  // Always show the selected section from its beginning after clicking a card.
  // This prevents the user from landing at the previous scroll position.
  window.scrollTo(0, 0);

  // Toggle active class on tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('bg-[#D6336C]', 'text-white', 'shadow-md', 'shadow-pink-100', 'font-bold');
    btn.classList.add('text-gray-700', 'hover:bg-gray-100');
  });

  const activeBtn = document.getElementById(`tab-btn-${tabId}`);
  if (activeBtn) {
    activeBtn.classList.remove('text-gray-700', 'hover:bg-gray-100');
    activeBtn.classList.add('bg-[#D6336C]', 'text-white', 'shadow-md', 'shadow-pink-100', 'font-bold');
  }

  // Toggle content sections
  document.querySelectorAll('.tab-content').forEach(sec => {
    sec.classList.add('hidden');
    sec.classList.remove('block');
  });

  const targetSec = document.getElementById(`tab-${tabId}`);
  if (targetSec) {
    targetSec.classList.remove('hidden');
    targetSec.classList.add('block');
    if (tabId === 'pos') document.getElementById('tab-pos').style.display = 'flex';
  }
  /* static POS HTML owns the initial cart view; do not rewrite #pos-cart-items on tab open */
    if (tabId === 'dashboard') normalizeDashboardDigits();

  // Load screen data dynamically
  if (tabId === 'dashboard') refreshDashboard();
  if (tabId === 'products') renderProducts();
  if (tabId === 'categories') renderCategories();
  if (tabId === 'purchases') renderPurchases();
  if (tabId === 'purchases') renderPurchaseOrders();
  if (tabId === 'suppliers') renderCustomers();
  if (tabId === 'delivery') renderDeliveryDesk();
  if (tabId === 'delivery-riders') renderDeliveryRiders();
  if (tabId === 'installments') renderInstallments();
  if (tabId === 'promotions') renderPromotions();
  if (tabId === 'offer-messages') renderOfferMessages();
  if (tabId === 'offer-messages') { refreshCampaignRecipients(); refreshCampaignWhatsAppStatus(); }
  if (tabId === 'sales-history') renderSalesHistory();
  if (tabId === 'customers') renderCustomers();
  if (tabId === 'employees') renderEmployees();
  if (tabId === 'barcodes') initBarcodeScreen();
  if (tabId === 'reports') { reportsRenderPromise = renderReports(); loadTallySettings(); }
  if (tabId === 'treasury') renderTreasuryPage();
  if (tabId === 'users') renderUsers();
  if (tabId === 'audit-logs') refreshAuditLogs();

  lucide.createIcons();
  window.setTimeout(ensurePhase1EmptyStates, 0);
  enforceReadableFontSizes();
}

const PHASE1_SIDEBAR_KEY = 'system_phase1_sidebar_collapsed';
function toggleSidebarCollapse(force) {
  const collapsed = typeof force === 'boolean' ? force : !document.body.classList.contains('sidebar-collapsed');
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const button = document.getElementById('sidebar-collapse-toggle');
  if (button) {
    button.setAttribute('aria-expanded', String(!collapsed));
    const mobile = window.matchMedia?.('(max-width: 900px)').matches;
    const icon = mobile ? 'fa-bars' : `fa-angles-${collapsed ? 'left' : 'right'}`;
    button.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i><span>${collapsed ? 'فتح القائمة' : 'طي القائمة'}</span>`;
  }
  try { localStorage.setItem(PHASE1_SIDEBAR_KEY, collapsed ? '1' : '0'); } catch (_) {}
}
function loadSidebarCollapse() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(PHASE1_SIDEBAR_KEY) === '1'; } catch (_) {}
  toggleSidebarCollapse(collapsed);
}
function globalChromePreferenceKey() {
  return `system_global_chrome_hidden_${String(currentUser?.id || currentUser?.username || 'guest')}`;
}

function applyGlobalChromePreference() {
  if (!currentUser) return;
  const stored = localStorage.getItem(globalChromePreferenceKey());
  const hidden = stored === null ? document.body.classList.contains('pos-screen-active') : stored === '1';
  document.body.classList.toggle('global-chrome-hidden', hidden);
  // The chrome is an overlay only while the POS workspace is active. On
  // dashboard and other tabs it remains in normal flow so it cannot intercept
  // clicks intended for the page controls.
  document.body.classList.toggle(
    'global-chrome-overlay',
    !hidden && document.body.classList.contains('pos-screen-active')
  );
  const toggle = document.getElementById('global-chrome-toggle');
  if (toggle) {
    toggle.setAttribute('aria-label', hidden ? 'إظهار الشريط العلوي' : 'إخفاء الشريط العلوي');
    toggle.title = hidden ? 'إظهار الشريط العلوي' : 'إخفاء الشريط العلوي';
    const icon = toggle.querySelector('[data-lucide]');
    if (icon) icon.setAttribute('data-lucide', hidden ? 'panel-top-open' : 'panel-top-close');
  }
  document.getElementById('global-chrome-restore')?.classList.toggle('hidden', !hidden);
  const workspace = document.querySelector('#app-shell > .flex-1.flex.max-w-7xl');
  if (workspace) {
    workspace.style.setProperty('max-height', hidden ? 'none' : '', 'important');
    workspace.style.setProperty('height', hidden ? 'calc(100vh - 94px)' : '', 'important');
  }
  window.lucide?.createIcons?.();
}

function toggleGlobalChrome() {
  if (!currentUser) return;
  const nextHidden = !document.body.classList.contains('global-chrome-hidden');
  localStorage.setItem(globalChromePreferenceKey(), nextHidden ? '1' : '0');
  applyGlobalChromePreference();
}

function setupPosTouchLayout() {
  return;
  // POS markup is owned by index.html. Do not create, move, or replace POS nodes at runtime.
  return;
  /*
  document.getElementById('tab-pos')?.classList.add('pos-wrapper');
  const layout = document.getElementById('pos-main-layout');
  if (!layout || layout.dataset.touchLayoutReady === 'true') return;
  const products = document.getElementById('pos-products-column');
  const invoice = document.getElementById('pos-invoice-column');
  const searchPanel = document.getElementById('pos-live-search')?.closest('.bg-white');
  const context = document.getElementById('pos-context-controls');
  const categories = document.getElementById('pos-category-filters');
  const grid = document.getElementById('pos-products-grid');
  if (!products || !invoice || !searchPanel || !context || !categories || !grid) return;
  searchPanel.id = 'pos-search-panel';

  const center = document.createElement('section');
  center.id = 'pos-touch-catalog';
  center.setAttribute('aria-label', 'منتجات البيع');
  const catalogHeading = document.createElement('div');
  catalogHeading.className = 'pos-touch-catalog-heading';
  catalogHeading.innerHTML = '<h2>المنتجات</h2><button type="button" class="pos-layout-toggle" onclick="togglePosLayoutMode()" aria-label="تبديل شكل شاشة البيع">شكل شاشة البيع: بطاقات</button>';
  const categoryPanel = document.createElement('aside');
  categoryPanel.id = 'pos-touch-categories';
  categoryPanel.innerHTML = '<h3 class="pos-touch-section-title">الفئات</h3>';
  const actionBar = document.createElement('div');
  actionBar.id = 'pos-touch-action-bar';
  actionBar.setAttribute('aria-label', 'إجراءات البيع والدفع');
  actionBar.innerHTML = '<div class="pos-touch-action-group" id="pos-touch-sale-actions"></div><div class="pos-touch-action-group" id="pos-touch-payment-actions"></div><div class="pos-touch-action-group" id="pos-touch-session-actions"></div>';
  layout.dataset.touchLayoutReady = 'true';
  layout.replaceChildren(center, invoice, categoryPanel);
  center.append(searchPanel, catalogHeading, grid);
  categoryPanel.append(categories);
  categoryPanel.style.setProperty('display', 'grid', 'important');
  categoryPanel.style.setProperty('grid-template-columns', 'max-content minmax(0,1fr)', 'important');
  categoryPanel.style.setProperty('grid-template-rows', '1fr', 'important');
  categoryPanel.style.setProperty('align-items', 'center', 'important');
  categoryPanel.style.setProperty('overflow', 'hidden', 'important');
  const categoryHeading = categoryPanel.querySelector('h3');
  categoryHeading?.style.setProperty('grid-column', '1', 'important');
  categoryHeading?.style.setProperty('grid-row', '1', 'important');
  categories.style.setProperty('grid-column', '2', 'important');
  categories.style.setProperty('grid-row', '1', 'important');
  categories.style.setProperty('display', 'flex', 'important');
  categories.style.setProperty('flex-direction', 'row', 'important');

  const invoiceCard = invoice.firstElementChild;
  invoiceCard?.append(actionBar);
  invoiceCard?.insertBefore(context, document.getElementById('pos-customer-picker'));
  const dockSale = document.getElementById('pos-touch-sale-actions');
  const dockPayment = document.getElementById('pos-touch-payment-actions');
  const dockSession = document.getElementById('pos-touch-session-actions');
  const header = document.getElementById('pos-invoice-header');
  const nav = document.getElementById('pos-navigation-tools');
  const clear = header?.querySelector('button[onclick="clearCart()"]');
  const suspension = context.querySelector('button[onclick="suspendCurrentSale()"]')?.parentElement;
  const shift = context.querySelector('#cashier-shift-status')?.closest('.mb-3');
  const cameraRetry = [...searchPanel.querySelectorAll('button[onclick="startPosBarcodeCamera()"]')].at(-1);
  const orderChannels = context.querySelector('[data-ui-group="order-channels"]');
  const deliveryDetails = context.querySelector('#pos-delivery-details');
  const deliveryBadge = document.getElementById('pos-delivery-badge');
  const orderTypeLabel = orderChannels?.querySelector('label:first-child');
  const channelLabel = orderChannels?.querySelector('label:nth-child(2)');
  const orderTypeRow = document.createElement('div');
  orderTypeRow.id = 'pos-order-type-compact';
  if (orderTypeLabel) {
    const labelText = [...orderTypeLabel.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    if (labelText) {
      const caption = document.createElement('span');
      caption.textContent = labelText.textContent.trim();
      orderTypeLabel.replaceChild(caption, labelText);
      orderTypeLabel.prepend(caption);
    }
  }
  orderTypeRow.append(orderTypeLabel);
  if (orderTypeLabel) invoiceCard?.insertBefore(orderTypeRow, document.getElementById('pos-customer-picker'));
  channelLabel?.remove();
  orderChannels?.remove();
  deliveryDetails?.remove();
  context.remove();
  // Delivery assignment is a core order-type choice, so keep its rider/address/
  // fee fields beside the compact order selector rather than inside collapsed
  // advanced options. This keeps the no-rider action visible when delivery is
  // selected without changing the accepted POS columns or invoice flow.
  const customerPicker = document.getElementById('pos-customer-picker');
  if (deliveryDetails && customerPicker) {
    if (deliveryBadge) deliveryDetails.insertBefore(deliveryBadge, deliveryDetails.firstChild);
    invoiceCard.insertBefore(deliveryDetails, customerPicker);
  }

  const summary = document.getElementById('pos-invoice-summary');
  if (summary) {
    const finalTotalRow = summary.querySelector(':scope > :nth-child(3)');
    if (finalTotalRow) {
      finalTotalRow.id = 'pos-final-total-row';
      // The responsive POS rules also target the pre-reorganization child
      // index.  Lock the final-total row to a two-cell grid after the DOM is
      // rearranged so the label and amount can never overlap at xlarge scale.
      finalTotalRow.style.setProperty('display', 'grid', 'important');
      finalTotalRow.style.setProperty('grid-template-columns', 'minmax(0,1fr) auto', 'important');
      finalTotalRow.style.setProperty('align-items', 'center', 'important');
      finalTotalRow.style.setProperty('gap', '10px', 'important');
      finalTotalRow.style.setProperty('min-height', '50px', 'important');
      finalTotalRow.style.setProperty('height', 'auto', 'important');
      finalTotalRow.style.setProperty('padding', '5px 8px', 'important');
    }

  }
  const paymentFooter = document.getElementById('pos-invoice-footer');
  const paymentMethods = paymentFooter?.querySelector('.grid.grid-cols-4');
  const complete = document.getElementById('btn-complete-sale');
  const print = complete?.nextElementSibling;
  if (paymentMethods) dockPayment.append(paymentMethods);
  if (complete) dockSale.append(complete);
  if (print) dockSale.append(print);
  window.lucide?.createIcons?.();
  applyPosLayoutMode();
  */
}

function applyPosLayoutMode() {
  const key = `system_pos_layout_mode_${String(currentUser?.id || currentUser?.username || 'guest')}`;
  const classic = localStorage.getItem(key) === 'classic';
  document.body.classList.toggle('pos-classic-mode', classic);
  const toggle = document.querySelector('.pos-layout-toggle');
  if (toggle) toggle.textContent = classic ? 'شكل شاشة البيع: كلاسيك' : 'شكل شاشة البيع: بطاقات';
}

function togglePosLayoutMode() {
  const key = `system_pos_layout_mode_${String(currentUser?.id || currentUser?.username || 'guest')}`;
  localStorage.setItem(key, localStorage.getItem(key) === 'classic' ? 'cards' : 'classic');
  applyPosLayoutMode();
  const setting = document.getElementById('pos-layout-setting');
  if (setting) setting.value = localStorage.getItem(key) === 'classic' ? 'classic' : 'cards';
}

function setPosLayoutMode(mode) {
  const key = `system_pos_layout_mode_${String(currentUser?.id || currentUser?.username || 'guest')}`;
  localStorage.setItem(key, mode === 'classic' ? 'classic' : 'cards');
  applyPosLayoutMode();
}

// ----------------------------------------------------
// POS (Point of Sale) Operations
// ----------------------------------------------------
function normalizeCatalogText(value) {
  return String(value ?? '').toLocaleLowerCase('ar')
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x06f0))
    .trim();
}

function productMatchesSearch(product, normalizedQuery) {
  if (!normalizedQuery) return true;
  const fields = [product.item_number, product.name, product.barcode, product.category_name,
    product.generic_name, product.active_ingredient, product.scientific_name,
    product.manufacturer, product.strength, product.dosage_form, product.notes];
  return fields.some(value => normalizeCatalogText(value).includes(normalizedQuery));
}

function indexedProductMatches(products, query) {
  if (!window.ProductListUtils) return products.filter(product => productMatchesSearch(product, query));
  window.ProductListUtils.updateProductIndex(productSearchIndexState, products);
  const ids = window.ProductListUtils.searchProductIds(productSearchIndexState, query);
  return products.filter(product => ids.has(product.id));
}

function captureProductListInteraction(target, pager) {
  const active = document.activeElement;
  let scrollTarget = target;
  while (scrollTarget && scrollTarget !== document.body) {
    const style = getComputedStyle(scrollTarget);
    if (/(auto|scroll)/.test(`${style.overflowY} ${style.overflow}`) && scrollTarget.scrollHeight > scrollTarget.clientHeight) break;
    scrollTarget = scrollTarget.parentElement;
  }
  return {
    activeId: active?.id || '',
    pageAction: active?.dataset?.pageAction || '',
    selectionStart: typeof active?.selectionStart === 'number' ? active.selectionStart : null,
    selectionEnd: typeof active?.selectionEnd === 'number' ? active.selectionEnd : null,
    scrollTarget: scrollTarget && scrollTarget !== document.body ? scrollTarget : null,
    scrollTop: scrollTarget && scrollTarget !== document.body ? scrollTarget.scrollTop : 0,
    windowY: window.scrollY,
    pager
  };
}

function restoreProductListInteraction(snapshot) {
  requestAnimationFrame(() => {
    if (snapshot.scrollTarget?.isConnected) snapshot.scrollTarget.scrollTop = snapshot.scrollTop;
    else window.scrollTo(window.scrollX, snapshot.windowY);
    if (snapshot.pageAction) {
      const nextControl = snapshot.pager?.querySelector(`[data-page-action="${snapshot.pageAction}"]`);
      nextControl?.focus({ preventScroll: true });
    } else if (snapshot.activeId) {
      const active = document.getElementById(snapshot.activeId);
      if (active && document.activeElement !== active) active.focus({ preventScroll: true });
      if (active && snapshot.selectionStart !== null && typeof active.setSelectionRange === 'function') {
        // Intentionally ignored: restoring text selection is optional UI behavior
        try { active.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd); } catch (_) {}
      }
    }
  });
}

function renderProductListPager(target, stateKey, total, renderPage) {
  const state = productListPages[stateKey];
  if (!state) return null;
  let pager = document.getElementById(`${stateKey}-pagination`);
  if (!pager) {
    pager = document.createElement('nav');
    pager.id = `${stateKey}-pagination`;
    pager.className = 'product-list-pagination flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-3 py-2 text-xs text-gray-600';
    pager.setAttribute('aria-label', 'ترقيم النتائج');
    target.insertAdjacentElement('afterend', pager);
  }
  const page = window.ProductListUtils.getPageWindow(total, state.page, state.pageSize);
  state.page = page.page;
  const from = total ? page.start + 1 : 0;
  const pageSizes = stateKey === 'pos' ? [50, 100, 500] : [50, 100, 200];
  pager.innerHTML = `<span class="product-list-page-status" aria-live="polite">${from}–${page.end} من ${total}</span>
    <div class="flex items-center gap-2">
      <label class="flex items-center gap-1">لكل صفحة
        <select data-page-size aria-label="عدد النتائج في الصفحة" class="rounded-lg border border-gray-200 bg-white px-2 py-1">
          ${pageSizes.map(size => `<option value="${size}" ${page.pageSize === size ? 'selected' : ''}>${size}</option>`).join('')}
        </select>
      </label>
      <span>صفحة ${page.page + 1} من ${page.pageCount}</span>
      <button type="button" data-page-action="previous" ${page.page === 0 ? 'disabled' : ''} class="rounded-lg border border-gray-200 px-3 py-1 disabled:opacity-40">السابق</button>
      <button type="button" data-page-action="next" ${page.page >= page.pageCount - 1 ? 'disabled' : ''} class="rounded-lg border border-gray-200 px-3 py-1 disabled:opacity-40">التالي</button>
    </div>`;
  const pointerSnapshots = new WeakMap();
  pager.querySelectorAll('[data-page-action]').forEach(button => button.addEventListener('pointerdown', () => {
    pointerSnapshots.set(button, {
      ...captureProductListInteraction(target, pager),
      activeId: '',
      pageAction: button.dataset.pageAction
    });
  }, { once: true }));
  pager.querySelector('[data-page-size]')?.addEventListener('change', async event => {
    const interaction = captureProductListInteraction(target, pager);
    state.pageSize = Number(event.currentTarget.value);
    state.page = 0;
    await renderPage();
    restoreProductListInteraction(interaction);
  });
  pager.querySelectorAll('[data-page-action]').forEach(button => button.addEventListener('click', async () => {
    if (button.disabled) return;
    const interaction = pointerSnapshots.get(button) || captureProductListInteraction(target, pager);
    pointerSnapshots.delete(button);
    state.page += button.dataset.pageAction === 'next' ? 1 : -1;
    await renderPage();
    restoreProductListInteraction(interaction);
  }));
  return page;
}

async function posAddToCart(productId) {
  const id = Number(productId);
  if (!Number.isInteger(id) || id <= 0) return false;
  return addToCart(id);
}

async function renderPosProducts() {
  const grid = document.getElementById('pos-products-grid');
  if (!grid) return;
  const requestId = (window.__posProductsRequestId || 0) + 1;
  window.__posProductsRequestId = requestId;
  grid.classList.remove("is-empty");
  grid.replaceChildren();

  let products;
  let categories;
  try {
    [products, categories] = await loadPosDependencies();
  } catch (error) {
    if (requestId !== window.__posProductsRequestId) return;
    const state = document.createElement('div');
    state.className = 'pos-products-empty';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-circle-exclamation';
    icon.setAttribute('aria-hidden', 'true');
    const title = document.createElement('strong');
    title.textContent = error?.message || 'تعذر تحميل المنتجات من قاعدة البيانات.';
    const hint = document.createElement('span');
    hint.textContent = 'تحقق من اتصال قاعدة البيانات ثم أعد المحاولة.';
    state.append(icon, title, hint);
    grid.classList.add('is-empty');
    grid.appendChild(state);
    return;
  }
  if (requestId !== window.__posProductsRequestId) return;

  const categoryNames = new Map((Array.isArray(categories) ? categories : [])
    .map(category => [Number(category.id), String(category.name || '')]));
  const query = normalizeCatalogText(document.getElementById('pos-barcode-input')?.value || '');
  const visibleProducts = (Array.isArray(products) ? products : [])
    .filter(product => product && product.is_active !== false)
    .filter(product => {
      const categoryName = String(product.category_name || categoryNames.get(Number(product.category_id)) || '');
      const productText = normalizeCatalogText(String(product.name || '') + ' ' + String(product.barcode || '') + ' ' + String(product.sku || '') + ' ' + categoryName);
      if (query && !productText.includes(query)) return false;
      const isServiceProduct = product?.is_service === true || String(product?.unit || '').trim() === 'خدمة';
      const stockQuantity = Number(product.quantity || 0);
      const minimumStock = Math.max(1, Number(product.min_stock || 0));
      if (activePosStockTab === 'in-stock' && !isServiceProduct && stockQuantity <= 0) return false;
      if (activePosStockTab === 'low' && (isServiceProduct || stockQuantity <= 0 || stockQuantity > minimumStock)) return false;
      if (activePosStockTab === 'out' && (isServiceProduct || stockQuantity > 0)) return false;
      const categoryText = categoryName + ' ' + String(product.name || '');
      if (activePosCategory === 'drinks') return /مشروب|مياه|قهوة|عصير|drink|beverage/i.test(categoryText);
      if (activePosCategory === 'food') return /مأكول|طعام|وجبة|برجر|food|meal/i.test(categoryText);
      return true;
    });

  if (!visibleProducts.length) {
    const empty = document.createElement('div');
    empty.className = 'pos-products-empty';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-box-open';
    icon.setAttribute('aria-hidden', 'true');
    const title = document.createElement('strong');
    title.textContent = query || activePosCategory !== 'all' ? 'لا توجد منتجات مطابقة.' : 'لا توجد منتجات مسجلة.';
    const hint = document.createElement('span');
    hint.textContent = query || activePosCategory !== 'all' ? 'غيّر البحث أو التصنيف لعرض المنتجات.' : 'أضف المنتجات من شاشة إدارة المنتجات لتظهر هنا.';
    empty.append(icon, title, hint);
    grid.classList.add('is-empty');
    grid.appendChild(empty);
    return;
  }

  const page = renderProductListPager(grid, 'pos', visibleProducts.length, renderPosProducts);
  const pageProducts = visibleProducts.slice(page?.start || 0, page?.end || visibleProducts.length);
  pageProducts.forEach(product => {
    const price = getProductTierPrice(product);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'pos-product-card';
    card.setAttribute('aria-label', String(product.name || '') + '، ' + price.toFixed(2) + '، إضافة إلى الفاتورة');
    const hasTrackedStock = product.quantity !== null && product.quantity !== undefined && product.quantity !== '' && Number.isFinite(Number(product.quantity));
    const isServiceProduct = product?.is_service === true || String(product?.unit || '').trim() === 'خدمة';
    card.disabled = !isServiceProduct && hasTrackedStock && Number(product.quantity) <= 0;
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-box';
    icon.setAttribute('aria-hidden', 'true');
    const name = document.createElement('h3');
    name.textContent = String(product.name || '');
    const amount = document.createElement('span');
    amount.className = 'price';
    amount.textContent = price.toFixed(2) + ' ج.م';
    card.append(icon, name, amount);
    card.addEventListener('click', () => { void posAddToCart(product.id); });
    grid.appendChild(card);
  });
  window.lucide?.createIcons?.();
}
function invalidatePosTopSellers() {
  posTopSellerCache = null;
}
function getProductTierPrice(product, level = activePosPriceLevel) {
  const candidate = level === 'wholesale' ? product?.wholesale_price : level === 'special' ? product?.special_price : product?.sale_price;
  const price = Number(candidate === null || candidate === undefined || candidate === '' ? (product?.sale_price ?? product?.price ?? 0) : candidate);
  return Number.isFinite(price) ? price : 0;
}

async function posSetPriceMode(mode, button) {
  activePosPriceLevel = ['retail', 'wholesale', 'special'].includes(mode) ? mode : 'retail';
  localStorage.setItem('system_price_level', activePosPriceLevel);
  document.querySelectorAll('.pos-mode-btn').forEach(item => item.classList.toggle('active', item === button));
  try {
    const products = await getCachedProducts();
    const productById = new Map((Array.isArray(products) ? products : []).map(product => [Number(product.id), product]));
    cart.forEach(item => {
      const product = productById.get(Number(item.product_id));
      if (product) item.unit_price = getProductTierPrice(product, activePosPriceLevel);
    });
    renderCart();
    void renderPosProducts();
  } catch (error) {
    showAppToast(error?.message || 'تعذر تحديث أسعار الفاتورة.');
  }
}
function posOpenCustomerModal() {
  const customer = document.getElementById('pos-customer-select');
  if (!customer) return showAppToast('قائمة العملاء غير متاحة حالياً.');
  customer.focus();
  // Intentionally ignored: native picker support is optional
  try { customer.showPicker?.(); } catch (_) {}
}

function posOpenDeliveryModal() {
  const type = document.getElementById('pos-order-type');
  if (!type) return showAppToast('إعدادات التوصيل غير متاحة حالياً.');
  type.value = type.value === 'توصيل' ? 'داخل المحل' : 'توصيل';
  type.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('.pos-service-toggle[onclick="posOpenDeliveryModal()"]')?.classList.toggle('active', type.value === 'توصيل');
}

function posToggleCredit() {
  const nextMethod = paymentMethod === 'دفع آجل' ? 'نقدي' : 'دفع آجل';
  const creditService = document.querySelector('.pos-services-row button[onclick="posToggleCredit()"]');
  const target = nextMethod === 'دفع آجل' ? creditService : document.querySelector('.pos-pay-method[data-payment-method="نقدي"]');
  creditService?.classList.toggle('active', nextMethod === 'دفع آجل');
  setPaymentMethod(nextMethod, target);
  if (nextMethod === 'دفع آجل') openModal('credit-modal');
  else closeModal('credit-modal');
}
function posOpenNotesModal() {
  showAppToast('إضافة ملاحظات الفاتورة ستتوفر في تحديث لاحق.');
}

// Expose handlers used by inline POS controls in index.html.
function posCalcTotal() {
  calculateCartTotals();
}

function filterPosCategory(catId) {
  activePosCategory = ['all', 'drinks', 'food'].includes(String(catId)) ? String(catId) : 'all';
  document.querySelectorAll('.pos-cat-btn, .pos-cat-filter').forEach(button => {
    const label = String(button.textContent || '').trim();
    const buttonCategory = button.dataset.categoryId || (/مشروبات/.test(label) ? 'drinks' : (/مأكولات/.test(label) ? 'food' : 'all'));
    button.classList.toggle('active', String(buttonCategory) === activePosCategory);
  });
  void renderPosProducts();
}
function setPosStockTab(tabId, button) {
  activePosStockTab = ['all', 'in-stock', 'low', 'out'].includes(String(tabId)) ? String(tabId) : 'all';
  document.querySelectorAll('[data-pos-stock-tab]').forEach(item => item.classList.toggle('active', item.dataset.posStockTab === activePosStockTab));
  productListPages.pos.page = 0;
  void renderPosProducts();
}
function promotionDiscountForCartItem(item) {
  const today = new Date().toISOString().slice(0, 10);
  const base = Number(item.unit_price || 0) * Number(item.quantity || 0);
  const matches = activePromotions.filter(promotion => promotion.is_active && (!promotion.start_date || promotion.start_date <= today) && (!promotion.end_date || promotion.end_date >= today)
    && ((!promotion.product_id && !promotion.category_id) || Number(promotion.product_id) === Number(item.product_id) || Number(promotion.category_id) === Number(item.category_id)))
    .map(promotion => promotion.type === 'percent' ? base * Number(promotion.value || 0) / 100 : Math.min(base, Number(promotion.value || 0) * Number(item.quantity || 0)))
    .filter(value => Number.isFinite(value));
  return Number(Math.min(Math.max(0, base - Number(item.discount || 0)), Math.max(0, ...matches)).toFixed(2));
}

async function loadActivePromotions() {
  try {
    const response = await fetch('/api/promotions');
    const rows = await response.json();
    if (!response.ok) return;
    activePromotions = Array.isArray(rows) ? rows : [];
    if (cart.length) renderCart();
  } catch (_) { activePromotions = []; }
}

let productBarcodeCamera = null;
let productBarcodeScanHandled = false;
let posBarcodeCamera = null;
let posBarcodeScanHandled = false;

async function startQrCameraWithFallback(camera,scanConfig,onSuccess,onError){
 if(!window.isSecureContext)throw new Error('المتصفح يمنع الكاميرا عبر HTTP. افتح رابط HTTPS آمن على الهاتف واسمح للمتصفح باستخدام الكاميرا.');
 if(!navigator.mediaDevices?.getUserMedia)throw new Error('لم يوفّر المتصفح واجهة الكاميرا. حدّث Chrome أو Safari وافتح رابط HTTPS آمن.');
 const cfg={fps:15,qrbox:{width:280,height:160},aspectRatio:1.777,disableFlip:false,...scanConfig};try{return await camera.start({facingMode:'environment'},cfg,onSuccess,onError)}catch(first){try{const list=await Html5Qrcode.getCameras();if(!list?.length)throw first;const back=list.find(x=>/back|rear|environment|خلف|ظهر/i.test(x.label||''))||list[list.length-1];return await camera.start(back.id,cfg,onSuccess,onError)}catch(_){if(['NotAllowedError','PermissionDeniedError','SecurityError'].includes(first?.name))throw new Error('تم رفض إذن الكاميرا. اسمح بها من إعدادات الموقع أو من نافذة التطبيق، ثم اضغط إعادة المحاولة.');throw first}}
}

async function startPosBarcodeCamera() {
  const container = document.getElementById('pos-barcode-camera');
  const status = document.getElementById('pos-barcode-camera-status');
  const wrapper = document.getElementById('pos-barcode-camera-wrapper');
  if (!container || !status) return;
  wrapper?.classList.remove('hidden');
  if (typeof Html5Qrcode === 'undefined') {
    status.textContent = 'تعذر تحميل قارئ الباركود المرفق. أغلق التطبيق وافتحه مجددًا.';
    status.className = 'mt-1 text-[11px] text-red-600';
    status.classList.remove('hidden');
    return;
  }
  // Intentionally ignored: clearing the camera is best-effort
  try {
    await stopProductBarcodeCamera();
    await stopPosBarcodeCamera();
    posBarcodeScanHandled = false;
    wrapper?.classList.remove('hidden');
    container.classList.remove('hidden');
    container.style.minHeight = '220px';
    status.textContent = 'وجّه الكاميرا الخلفية نحو باركود المنتج. سيتم إضافته للفاتورة دون إتمام البيع.';
    status.className = 'mt-1 text-[11px] text-gray-600';
    status.classList.remove('hidden');
    if (!window.isSecureContext) {
      throw new Error('الكاميرا تحتاج تشغيل البرنامج من localhost أو HTTPS. لا تفتح ملف index.html مباشرة.');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('المتصفح الحالي لا يدعم الوصول للكاميرا. استخدم Chrome أو افتح نسخة سطح المكتب.');
    }
    // Request permission first so Electron/browser reports the real cause immediately.
    const permissionProbe = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    permissionProbe.getTracks().forEach(track => track.stop());
    posBarcodeCamera = new Html5Qrcode('pos-barcode-camera');
    const barcodeFormats = typeof Html5QrcodeSupportedFormats !== 'undefined'
      ? [Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39, Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8, Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E, Html5QrcodeSupportedFormats.QR_CODE].filter(Boolean)
      : undefined;
    await startQrCameraWithFallback(posBarcodeCamera,
      { fps: 15, qrbox: { width: 280, height: 160 }, aspectRatio: 1.777, ...(barcodeFormats ? { formatsToSupport: barcodeFormats } : {}) },
      async decodedText => {
        if (posBarcodeScanHandled) return;
        posBarcodeScanHandled = true;
        const barcode = String(decodedText || '').trim();
        const input = document.getElementById('pos-barcode-input');
        if (input) input.value = barcode;
        status.textContent = `تمت قراءة الباركود ${barcode}؛ جارٍ إضافته للفاتورة.`;
        status.className = 'mt-1 text-[11px] text-emerald-700';
        await stopPosBarcodeCamera();
        await handleBarcodeScan(barcode);
      },
      () => {}
    );
  } catch (error) {
    await stopPosBarcodeCamera();
    wrapper?.classList.remove('hidden');
    status.textContent = `تعذر تشغيل الكاميرا: ${error?.message || 'تحقق من صلاحية الكاميرا.'}`;
    status.className = 'mt-1 text-[11px] text-red-600';
    status.classList.remove('hidden');
  }
}

async function stopPosBarcodeCamera() {
  const camera = posBarcodeCamera;
  posBarcodeCamera = null;
  if (camera) {
    // Intentionally ignored: camera cleanup failure is reported by the existing warning
    try { if (camera.isScanning) await camera.stop(); } catch (error) { console.warn('Could not stop POS barcode camera cleanly:', error); }
    // Intentionally ignored: clearing an already-stopped camera is best-effort
    try { camera.clear(); } catch (_) {}
  }
  const container = document.getElementById('pos-barcode-camera');
  if (container) { container.classList.add('hidden'); container.style.minHeight = ''; }
  document.getElementById('pos-barcode-camera-wrapper')?.classList.add('hidden');
}

async function startProductBarcodeCamera() {
  const cameraContainer = document.getElementById('product-barcode-camera');
  const status = document.getElementById('product-barcode-camera-status');
  if (!cameraContainer || !status) return;

  if (typeof Html5Qrcode === 'undefined') {
    status.textContent = 'تعذر تحميل قارئ الباركود. تحقق من اتصال الإنترنت ثم أعد المحاولة.';
    status.className = 'mt-1 text-[11px] text-red-600';
    return;
  }

  try {
    await stopProductBarcodeCamera();
    productBarcodeScanHandled = false;
    cameraContainer.classList.remove('hidden');
    cameraContainer.style.minHeight = '220px';
    status.textContent = 'وجّه الكاميرا الخلفية نحو الباركود.';
    status.className = 'mt-1 text-[11px] text-gray-500';
    productBarcodeCamera = new Html5Qrcode('product-barcode-camera');
    await startQrCameraWithFallback(productBarcodeCamera,
      { fps: 10, qrbox: { width: 250, height: 140 }, aspectRatio: 1.777 },
      async (decodedText) => {
        if (productBarcodeScanHandled) return;
        productBarcodeScanHandled = true;
        const barcodeInput = document.getElementById('prod-barcode');
        if (barcodeInput) {
          barcodeInput.value = String(decodedText || '').trim();
          barcodeInput.dispatchEvent(new Event('input', { bubbles: true }));
          barcodeInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        status.textContent = 'تمت قراءة الباركود وإضافته إلى حقل المنتج.';
        status.className = 'mt-1 text-[11px] text-emerald-700';
        await stopProductBarcodeCamera();
        barcodeInput?.focus();
      },
      () => {}
    );
  } catch (error) {
    await stopProductBarcodeCamera();
    const message = error?.message || 'تعذر تشغيل الكاميرا.';
    status.textContent = `تعذر تشغيل الكاميرا: ${message}`;
    status.className = 'mt-1 text-[11px] text-red-600';
  }
}

async function stopProductBarcodeCamera() {
  const camera = productBarcodeCamera;
  productBarcodeCamera = null;
  if (!camera) return;
  // Intentionally ignored: camera cleanup failure is reported by the existing warning
  try {
    if (camera.isScanning) await camera.stop();
  } catch (error) {
    console.warn('Could not stop the product barcode camera cleanly:', error);
  }
  try {
    camera.clear();
  } catch (_) {}
  const cameraContainer = document.getElementById('product-barcode-camera');
  if (cameraContainer) {
    cameraContainer.classList.add('hidden');
    cameraContainer.style.minHeight = '';
  }
}

async function handleBarcodeScan(barcode) {
  const input = document.getElementById('pos-barcode-input');
  if (input) input.value = '';
  return processBarcodeInput(barcode);
}

async function processBarcodeInput(rawCode) {
  const code = String(rawCode || '').trim();
  if (code.length < 3) return false;
  const candidates = [...new Set([code, code.split('').reverse().join('')])];
  let products = [];
  try {
    const result = await getCachedProducts();
    products = Array.isArray(result) ? result : [];
  } catch (err) {
    logError({ type: '[1.16-C]', message: err?.message || String(err), stack: err?.stack || '' });
    showAppToast('حدث خطأ، حاول مرة أخرى', { tone: 'error' });
  }

  const matchCode = product => candidates.find(candidate =>
    [product.barcode, product.barcode_number, product.sku, product.code]
      .some(value => value != null && String(value).trim() === candidate));
  let product = products.find(matchCode);
  if (!product) {
    window.playSound?.('error');
    showAppToast(`لم يتم العثور على باركود ${code} أو نسخته المعكوسة.`, { tone: 'error', sound: false });
    return false;
  }

  try {
    const posSurface = document.getElementById('pos-cart-items');
    const available = product.quantity == null || Number(product.quantity) > 0;
    const added = posSurface && typeof window.posAddToCart === 'function'
      ? (available && await window.posAddToCart(product.id, product.name, getProductTierPrice(product)))
      : await addToCart(product.id);
    if (!added) return false;
    document.body.classList.add('pos-barcode-success');
    clearTimeout(barcodeTimeout);
    barcodeTimeout = setTimeout(() => document.body.classList.remove('pos-barcode-success'), 650);
    try { navigator.vibrate?.(70); } catch (_) {}
    window.playSound?.('barcode');
    showAppToast(`تمت إضافة ${product.name} إلى الفاتورة.`, { tone: 'success', sound: false });
    return true;
  } catch (error) {
    logError({ type: '[1.16-C]', message: error?.message || String(error), stack: error?.stack || '' });
    showAppToast('حدث خطأ، حاول مرة أخرى', { tone: 'error' });
    showAppToast(`تعذرت إضافة الصنف: ${error.message || 'خطأ غير معروف'}`, { tone: 'error' });
    return false;
  }
}

async function addToCart(productId) {
  const products = await getCachedProducts();
  const prod = products.find(p => Number(p.id) === Number(productId));
  if (!prod) return false;

  const isServiceProduct = prod?.is_service === true || String(prod?.unit || '').trim() === 'خدمة';

  const existing = cart.find(it => it.product_id === prod.id);

  if (existing) {
    if (!isServiceProduct && existing.quantity + 1 > prod.quantity) {
      showAppToast(`عذراً، أقصى كمية متوفرة في المخزن من [${prod.name}] هي (${prod.quantity}) قطعة.`);
      return false;
    }
    existing.quantity += 1;
  } else {
    if (!isServiceProduct && prod.quantity < 1) {
      showAppToast(`عذراً، المنتج [${prod.name}] نفد من المخزون تماماً.`);
      return false;
    }
    cart.push({
      product_id: prod.id,
      category_id: prod.category_id,
      product_name: prod.name,
      unit_price: getProductTierPrice(prod),
      cost_price: prod.cost_price,
      quantity: 1,
      max_quantity: isServiceProduct ? Number.MAX_SAFE_INTEGER : prod.quantity,
      discount: 0,
      is_weighted: Boolean(prod.is_weighted),
    });
  }

  window.playSound?.('add-to-cart');
  renderCart();
  return true;
}

function updateCartItemQty(productId, delta) {
  const item = cart.find(it => it.product_id === productId);
  if (!item) return;

  const newQty = item.quantity + delta;
  if (newQty <= 0) {
    removeFromCart(productId);
    return;
  }

  if (Number.isFinite(item.max_quantity) && newQty > item.max_quantity) {
    showAppToast(`عذراً، الكمية المطلوبة غير متوفرة في المخزن. المتوفر حالياً: ${item.max_quantity}`);
    return;
  }

  item.quantity = newQty;
  renderCart();
}


function updateCartItemQtyFromInput(productId, input) {
  const item = cart.find(row => row.product_id === Number(productId));
  if (!item) return;
  const quantity = Number(input?.value);
  const quantityText = String(input?.value || '').trim();
  const validWeighted = item.is_weighted === true && /^\d+(?:\.\d{1,3})?$/.test(quantityText);
  const validInteger = item.is_weighted !== true && Number.isSafeInteger(quantity);
  if ((!validWeighted && !validInteger) || quantity <= 0 || quantity > item.max_quantity) {
    if (input) input.value = String(item.quantity);
    showAppToast(quantity > item.max_quantity ? 'الكمية المطلوبة أكبر من المتوفر في المخزن.' : item.is_weighted === true ? 'الكمية يجب أن تكون رقماً حتى 3 منازل عشرية.' : 'الكمية يجب أن تكون عدداً صحيحاً أكبر من صفر.');
    return;
  }
  item.quantity = quantity;
  renderCart();
}

async function capturePosWeight() {
  const status = document.getElementById('pos-weight-status');
  const weightedItem = cart.find(item => item.is_weighted === true);
  if (!weightedItem) {
    showAppToast('أضف منتجاً يُباع بالوزن أولاً.', { tone: 'error' });
    if (status) status.textContent = 'لا يوجد منتج موزون في السلة.';
    return false;
  }
  try {
    const reading = await (window.rawdaHardware?.scaleRead
      ? window.rawdaHardware.scaleRead({ profileId: 'default' })
      : fetch('/api/hardware/scale/read?profile_id=default').then(response => response.json()));
    const weight = Number(reading?.weight);
    if (!Number.isFinite(weight) || weight <= 0) throw new Error('لم تصل قراءة وزن صالحة من الميزان.');
    if (weight > weightedItem.max_quantity) throw new Error('الوزن المقروء أكبر من المتوفر في المخزن.');
    weightedItem.quantity = Number(weight.toFixed(3));
    renderCart();
    if (status) status.textContent = `تم التقاط ${weightedItem.quantity.toFixed(3)} ${reading.unit || 'kg'}${reading.stable === false ? ' — القراءة غير مستقرة' : ''}.`;
    showAppToast(`تم التقاط الوزن: ${weightedItem.quantity.toFixed(3)} ${reading.unit || 'kg'}`, { tone: 'success' });
    return true;
  } catch (error) {
    if (status) status.textContent = error.message;
    showAppToast(error.message, { tone: 'error' });
    return false;
  }
}

async function removeFromCart(productId) {
  if (!await showAppConfirm('حذف هذا الصنف من الفاتورة الحالية؟')) return;
  cart = cart.filter(it => it.product_id !== productId);
  renderCart();
}

async function clearCart() {
  if (!cart.length || !await showAppConfirm('هل تريد إفراغ الفاتورة الحالية؟')) return;
  cart = [];
  activeSelfOrderId = null;
  renderCart();
}

function renderCart() {
  const container = document.getElementById('pos-cart-items');
  if (!container) return;
  container.replaceChildren();
  const payButton = document.getElementById('pos-pay-btn');
  if (payButton) payButton.disabled = cart.length === 0;

  if (!cart.length) {
    const empty = document.createElement('p');
    empty.textContent = 'الفاتورة فارغة';
    empty.style.cssText = 'text-align:center; margin-top:20px;';
    container.appendChild(empty);
  } else {
    cart.forEach(item => {
      const row = document.createElement('article');
      row.className = 'pos-cart-item';
      const details = document.createElement('div');
      const title = document.createElement('h4');
      title.textContent = item.product_name || '';
      title.style.cssText = 'font-size:14px; margin:0 0 3px;';
      const price = document.createElement('div');
      price.textContent = `${Number(item.unit_price || 0).toFixed(2)} ج.م`;
      price.style.cssText = 'color:#00e676; font-weight:900;';
      details.append(title, price);

      const controls = document.createElement('div');
      controls.className = 'pos-qty-controls';
      const decrease = document.createElement('button');
      decrease.type = 'button';
      decrease.className = 'pos-qty-btn';
      decrease.textContent = '−';
      decrease.setAttribute('aria-label', 'تقليل الكمية');
      decrease.addEventListener('click', () => updateCartItemQty(Number(item.product_id), -1));
      const quantity = item.is_weighted === true ? document.createElement('input') : document.createElement('span');
      if (item.is_weighted === true) {
        quantity.type = 'number';
        quantity.step = '0.001';
        quantity.min = '0.001';
        quantity.value = String(Number(item.quantity) || 0);
        quantity.className = 'pos-qty-input';
        quantity.setAttribute('aria-label', 'كمية موزونة');
        quantity.addEventListener('change', () => updateCartItemQtyFromInput(Number(item.product_id), quantity));
      } else {
        quantity.textContent = String(Number(item.quantity) || 0);
      }
      const increase = document.createElement('button');
      increase.type = 'button';
      increase.className = 'pos-qty-btn';
      increase.textContent = '+';
      increase.setAttribute('aria-label', 'زيادة الكمية');
      increase.addEventListener('click', () => updateCartItemQty(Number(item.product_id), 1));
      controls.append(decrease, quantity, increase);
      row.append(details, controls);
      container.appendChild(row);
    });
  }

  calculateCartTotals();
  broadcastCustomerDisplay();
}

function getPosDeliveryCustomerFee() {
  if (document.getElementById('pos-order-type')?.value !== 'توصيل') return 0;
  return Math.max(0, Number(document.getElementById('pos-delivery-customer-fee')?.value || 0));
}

function calculateCartTotals() {
  const subtotalEl = document.getElementById('pos-subtotal');
  const totalEl = document.getElementById('pos-total') || document.getElementById('pos-grand-total');
  const rawSubtotal = cart.reduce((sum, item) => sum + Number(item.unit_price || 0) * Number(item.quantity || 0) - Number(item.discount || 0) - promotionDiscountForCartItem(item), 0);
  const subtotal = Math.max(0, rawSubtotal);
  const requestedDiscount = Math.max(0, Number(document.getElementById('pos-discount-input')?.value || 0));
  const discount = Math.min(subtotal, requestedDiscount);
  const taxable = Math.max(0, subtotal - discount);
  const tax = taxSettings?.enabled ? Number((taxable * Number(taxSettings.rate || 0) / 100).toFixed(2)) : 0;
  const total = taxable + tax + getPosDeliveryCustomerFee();
  if (subtotalEl) subtotalEl.textContent = `${subtotal.toFixed(2)} ج.م`;
  if (totalEl) totalEl.textContent = total.toFixed(2);
  calculateChange();
}
function setPaymentMethod(method, targetButton) {
  paymentMethod = method;
  document.querySelectorAll('.pay-method-btn, .pos-pay-method').forEach(button => {
    button.classList.toggle('active', button === targetButton);
    button.classList.remove('bg-[#D6336C]', 'text-white', 'border-[#D6336C]');
    button.classList.add('bg-gray-50', 'text-gray-700', 'border-gray-200');
  });
  if (targetButton) {
    targetButton.classList.remove('bg-gray-50', 'text-gray-700', 'border-gray-200');
    targetButton.classList.add('bg-[#D6336C]', 'text-white', 'border-[#D6336C]');
  }
  if (method === 'دفع آجل') {
    const paidInput = document.getElementById('pos-paid-amount') || document.getElementById('pos-amount-paid');
    if (paidInput) { paidInput.value = '0'; paidInput.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  updatePosCreditTerms();
}

function getPosDueTermDays() {
  const choice = document.getElementById('pos-due-period')?.value || '';
  if (choice === 'custom') return Number(document.getElementById('pos-due-days-custom')?.value);
  return Number(choice) || Number(document.getElementById('grace-period')?.value || 0) || 0;
}

function updatePosCreditTerms() {
  const box = document.getElementById('pos-credit-terms');
  if (!box) return;
  const subtotal = cart.reduce((sum, item) => sum + (item.unit_price * item.quantity) - (item.discount || 0) - promotionDiscountForCartItem(item), 0);
  const discount = Number(document.getElementById('pos-discount-input')?.value) || 0;
  const taxable = Math.max(0, subtotal - discount);
  const total = taxable + (taxSettings.enabled ? Number((taxable * Number(taxSettings.rate || 0) / 100).toFixed(2)) : 0) + getPosDeliveryCustomerFee();
  const paidField = document.getElementById('pos-paid-amount') || document.getElementById('pos-amount-paid');
  const paid = paidField && paidField.value !== '' ? Number(paidField.value) : total;
  const needsCredit = Number.isFinite(paid) && total - paid > 0.009;
  box.classList.toggle('hidden', !needsCredit && paymentMethod !== 'دفع آجل');
  const period = document.getElementById('pos-due-period');
  const custom = document.getElementById('pos-due-days-custom');
  const customSelected = period?.value === 'custom';
  custom?.classList.toggle('hidden', !customSelected);
  const days = getPosDueTermDays();
  const preview = document.getElementById('pos-due-date-preview');
  if (!preview) return;
  if (!needsCredit || !Number.isInteger(days) || days < 1 || days > 3650) { preview.textContent = '—'; return; }
  const due = new Date(); due.setHours(0, 0, 0, 0); due.setDate(due.getDate() + days);
  preview.textContent = new Intl.DateTimeFormat('en-GB').format(due);
}

function setQuickCash(amount) {
  const subtotal = cart.reduce((s, it) => s + (it.unit_price * it.quantity) - (it.discount || 0) - promotionDiscountForCartItem(it), 0);
  const discount = parseFloat(document.getElementById('pos-discount-input')?.value) || 0;
  const taxable = Math.max(0, subtotal - discount);
  const finalTotal = taxable + (taxSettings.enabled ? Number((taxable * Number(taxSettings.rate || 0) / 100).toFixed(2)) : 0) + getPosDeliveryCustomerFee();

  const paidInput = document.getElementById('pos-paid-amount') || document.getElementById('pos-amount-paid');
  if (!paidInput) return;

  if (amount === 'exact') {
    paidInput.value = finalTotal.toFixed(2);
  } else {
    paidInput.value = (Math.ceil(finalTotal / 50) * 50 + amount).toFixed(2);
  }
  paidInput.dispatchEvent(new Event('input', { bubbles: true }));
  paidInput.focus();
  calculateChange();
}

function calculateChange() {
  const paidInput = document.getElementById('pos-paid-amount') || document.getElementById('pos-amount-paid');
  const changeEl = document.getElementById('pos-change-amount') || document.getElementById('pos-change-due');
  if (!changeEl) return;

  const subtotal = cart.reduce((sum, item) => sum + (item.unit_price * item.quantity) - (item.discount || 0) - promotionDiscountForCartItem(item), 0);
  const discount = parseFloat(document.getElementById('pos-discount-input')?.value) || 0;
  const taxable = Math.max(0, subtotal - discount);
  const finalTotal = taxable + (taxSettings.enabled ? Number((taxable * Number(taxSettings.rate || 0) / 100).toFixed(2)) : 0) + getPosDeliveryCustomerFee();
  const paid = paidInput && paidInput.value.trim() !== '' ? (parseFloat(paidInput.value) || 0) : finalTotal;
  const change = paid - finalTotal;

  changeEl.dataset.state = change >= 0 ? 'change' : 'due';
  if (changeEl.id === 'pos-change-due') {
    changeEl.className = 'pos-change-value';
    changeEl.textContent = change >= 0 ? `${change.toFixed(2)} ج.م` : `متبقي (آجل): ${Math.abs(change).toFixed(2)} ج.م`;
    changeEl.dataset.state = change >= 0 ? 'change' : 'due';
  } else if (change >= 0) {
    changeEl.textContent = `${change.toFixed(2)} ج.م`;
    changeEl.className = 'py-1.5 px-2 bg-green-50 rounded-xl text-sm font-bold text-green-700 text-center border border-green-200';
  } else {
    changeEl.textContent = `متبقي (آجل): ${Math.abs(change).toFixed(2)} ج.م`;
    changeEl.className = 'py-1.5 px-2 bg-red-50 rounded-xl text-xs font-bold text-red-700 text-center border border-red-200';
  }
  updatePosCreditTerms();
}

// ----------------------------------------------------
// Complete Sale & Print Thermal Receipt
// ----------------------------------------------------
async function completeSale(shouldPrint = false) {
  if (cart.length === 0) {
    showAppToast('الفاتورة فارغة! يرجى إضافة أصناف أولاً.');
    return;
  }

  const custSelect = document.getElementById('pos-customer-select');
  const customerId = custSelect ? parseInt(custSelect.value) : Number(posSelectedCustomerId || 1);
  const discount = parseFloat(document.getElementById('pos-discount-input')?.value) || 0;
  const paidInput = document.getElementById('pos-paid-amount') || document.getElementById('pos-amount-paid');
  const mixedPayments = Array.isArray(window.__posMixedPaymentSplits) ? window.__posMixedPaymentSplits : null;

  let subtotal = 0;
  cart.forEach(it => {
    subtotal += (it.unit_price * it.quantity) - (it.discount || 0) - promotionDiscountForCartItem(it);
  });
  const taxable = Math.max(0, subtotal - discount);
  const taxAmount = taxSettings.enabled ? Number((taxable * Number(taxSettings.rate || 0) / 100).toFixed(2)) : 0;
  const orderType = document.getElementById('pos-order-type')?.value || 'داخل المحل';
  const deliveryRiderId = document.getElementById('pos-delivery-rider-select')?.value || null;
  if (orderType === 'توصيل' && !deliveryRiderId) { showAppToast('اختر الطيار لربط طلب التوصيل به.'); return; }
  const total = taxable + taxAmount + (orderType === 'توصيل' ? Number(document.getElementById('pos-delivery-customer-fee')?.value || 0) : 0);
  const paid = mixedPayments
    ? Number(mixedPayments.filter(payment => payment.method !== 'دفع آجل').reduce((sum, payment) => sum + Number(payment.amount || 0), 0).toFixed(2))
    : (paidInput && paidInput.value !== '') ? parseFloat(paidInput.value) : total;

  const remaining = Math.max(0, total - paid);
  if (remaining > 0.009 && (!customerId || customerId === 1)) {
    showAppToast('اختر عميلاً لإتمام البيع الآجل');
    return;
  }
  const dueTermDays = getPosDueTermDays();
  if (remaining > 0.009 && (!Number.isInteger(dueTermDays) || dueTermDays < 1 || dueTermDays > 3650)) {
    showAppToast('اختر فترة السداد لتحديد ميعاد الاستحقاق.');
    return;
  }

  const change = Math.max(0, paid - total);

  const salePayload = {
    client_transaction_id: mixedPayments
      ? (window.__posMixedTransactionId ||= globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`)
      : globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    warehouse_id: Number(document.getElementById('pos-warehouse-select')?.value) || null,
    customer_id: customerId,
    user_id: currentUser.id,
    subtotal,
    discount,
    taxable_amount: taxable,
    tax_rate: taxSettings.enabled ? Number(taxSettings.rate || 0) : 0,
    tax_amount: taxAmount,
    total,
    paid_amount: paid,
    change_amount: change,
    payment_method: mixedPayments ? 'مختلط' : paymentMethod,
    wallet_id: paymentMethod === 'محفظة إلكترونية' ? Number(window.__posSelectedWalletId) || null : null,
    wallet_payment_mode: paymentMethod === 'محفظة إلكترونية' && window.__posWalletAwaitSms ? 'await_sms' : null,
    ...(mixedPayments ? { payments: mixedPayments } : {}),
    due_term_days: dueTermDays,
    order_type: orderType,
    order_channel: document.getElementById('pos-order-channel')?.value || 'مباشر',
    delivery_rider_id: deliveryRiderId,
    delivery_address: document.getElementById('pos-delivery-address')?.value?.trim() || '',
    delivery_fee_customer: Number(document.getElementById('pos-delivery-customer-fee')?.value || 0),
    delivery_fee_rider: Number(document.getElementById('pos-delivery-rider-fee')?.value || 0),
    salesperson_id: document.getElementById('pos-salesperson-select')?.value || null,
    price_level: activePosPriceLevel,
    self_order_id: activeSelfOrderId,
    items: cart.map(it => ({
      product_id: it.product_id,
      quantity: it.quantity,
      unit_price: it.unit_price,
      cost_price: it.cost_price,
      discount: it.discount || 0
    }))
  };

  try {
    const saleResult = await storage.completeSale(salePayload);

    if (salePayload.payment_method === 'نقدي') triggerConfiguredCashDrawer();

    window.playSound?.('sale');
    if (saleResult.pending_sync) showAppToast('حُفظت الفاتورة على هذا الجهاز في قائمة انتظار المزامنة. لم يُخصم المخزون بعد، وسيظهر رقم الفاتورة بعد عودة الاتصال وقبول الخادم للعملية.', { sound: false });
    else if (saleResult.pending_wallet_payment && window.SmsUI?.openPendingModal) window.SmsUI.openPendingModal({ sale: saleResult, pending: saleResult.pending_wallet_payment });
    else if (shouldPrint) {
      renderReceiptModal(saleResult, { open: printSettings.preview_before_print !== false });
      if (printSettings.auto_print && printSettings.preview_before_print === false) setTimeout(() => void printReceiptFromSettings(), 0);
    }
    else {
      const walletPayment = saleResult.payments?.find(payment => payment.method === 'محفظة إلكترونية');
      const walletDetails = typeof walletPayment?.method_details === 'string' ? JSON.parse(walletPayment.method_details || '{}') : (walletPayment?.method_details || {});
      const walletLabel = walletDetails.name && walletDetails.wallet_number ? ` تم الدفع عبر ${walletDetails.name} - ${walletDetails.wallet_number}.` : '';
      showAppToast(`تم إتمام البيع بنجاح.${walletLabel} رقم الفاتورة: ${saleResult.invoice_number}${saleResult.loyalty_points_earned ? `\nكسب العميل ${saleResult.loyalty_points_earned} نقطة ولاء.` : ''}`, { sound: false });
    }

    // Reset Cart only after the local pending record has safely been stored.
    cart = [];
    window.__posMixedPaymentSplits = null;
    window.__posMixedTransactionId = null;
    window.__posWalletAwaitSms = false;
    posSelectedCustomerId = 1;
    activeSelfOrderId = null;
    if (paidInput) paidInput.value = '';
    const discountEl = document.getElementById('pos-discount-input');
    if (discountEl) discountEl.value = '0';
    const deliveryAddress = document.getElementById('pos-delivery-address'); if (deliveryAddress) deliveryAddress.value = '';
    const deliveryRider = document.getElementById('pos-delivery-rider-select'); if (deliveryRider) deliveryRider.value = '';
    const orderTypeSelect = document.getElementById('pos-order-type'); if (orderTypeSelect) { orderTypeSelect.value = 'داخل المحل'; orderTypeSelect.dispatchEvent(new Event('change', { bubbles: true })); }
    document.querySelector('#tab-pos .pos-order-btn[data-pos-action="in-store"]')?.classList.add('active'); document.querySelector('#tab-pos .pos-order-btn[data-pos-action="delivery"]')?.classList.remove('active');
    const cashButton = document.querySelector('#tab-pos .pos-pay-method[data-payment-method="نقدي"]'); setPaymentMethod('نقدي', cashButton);
    const deliveryCustomerFee = document.getElementById('pos-delivery-customer-fee'); if (deliveryCustomerFee) deliveryCustomerFee.value = '0';
    const deliveryRiderFee = document.getElementById('pos-delivery-rider-fee'); if (deliveryRiderFee) deliveryRiderFee.value = '0';
    renderCart();

    // Refresh products view & low stock
    invalidatePosTopSellers();
    invalidateClientProductCache();
    await renderPosProducts();
    await checkLowStockBadge();
    await populateCustomerDropdowns();

  } catch (err) {
    showAppToast(`خطأ أثناء حفظ الفاتورة: ${err.message}`, { tone: 'error' });
  }
}

async function suspendCurrentSale() {
  if (!cart.length) return showAppToast('أضف صنفًا واحدًا على الأقل قبل تعليق الفاتورة.');
  const defaultLabel = `طلب ${new Date().toLocaleTimeString('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit' })}`;
  const values = await openAppFormDialog({ title: 'تعليق الطلب الحالي', subtitle: 'اكتب اسمًا أو رقمًا يسهل العثور به على الطلب لاحقًا.', fields: [{ label: 'اسم أو رقم الطلب', value: defaultLabel }], submitLabel: 'تعليق الطلب' });
  if (!values) return;
  const label = values[0];
  const custSelect = document.getElementById('pos-customer-select');
  const paidInput = document.getElementById('pos-paid-amount') || document.getElementById('pos-amount-paid');
  const ticket = {
    user_id: currentUser.id,
    label: label.trim() || defaultLabel,
    customer_id: custSelect ? Number(custSelect.value) || 1 : 1,
    discount: Number(document.getElementById('pos-discount-input')?.value) || 0,
    paid_amount: Number(paidInput?.value) || 0,
    payment_method: paymentMethod,
    order_type: document.getElementById('pos-order-type')?.value || 'داخل المحل',
    order_channel: document.getElementById('pos-order-channel')?.value || 'مباشر',
    delivery_rider_id: document.getElementById('pos-delivery-rider-select')?.value || null,
    delivery_address: document.getElementById('pos-delivery-address')?.value?.trim() || '',
    salesperson_id: document.getElementById('pos-salesperson-select')?.value || null,
    price_level: activePosPriceLevel,
    self_order_id: activeSelfOrderId,
    items: cart.map(item => ({ product_id: item.product_id, category_id: item.category_id, quantity: item.quantity, unit_price: item.unit_price, cost_price: item.cost_price, discount: item.discount || 0 }))
  };
  try {
    await storage.suspendSale(ticket);
    cart = [];
    activeSelfOrderId = null;
    if (paidInput) paidInput.value = '';
    const discount = document.getElementById('pos-discount-input'); if (discount) discount.value = '0';
    renderCart();
    await renderSuspendedSales();
    showAppToast('تم تعليق الطلب وحفظه. لم يتم خصم أي كمية من المخزون.');
  } catch (error) { showAppToast(`تعذر تعليق الفاتورة: ${error.message}`); }
}

async function togglePosSuspendedSales() {
  const host = document.getElementById('suspended-sales-list');
  if (!host) return;
  const opening = host.classList.contains('hidden');
  host.classList.toggle('hidden', !opening);
  if (opening) await renderSuspendedSales();
}
async function renderSuspendedSales() {
  const host = document.getElementById('suspended-sales-list');
  if (!host) return;
  try {
    const tickets = await storage.getSuspendedSales();
    host.replaceChildren();
    if (!tickets.length) { host.textContent = 'لا توجد طلبات معلقة'; return; }
    tickets.forEach(ticket => {
      const row = document.createElement('div');
      row.className = 'flex items-center gap-2 border border-amber-200 bg-amber-50 rounded-lg px-2 py-1.5';
      const resume = document.createElement('button');
      resume.type = 'button'; resume.className = 'text-[11px] font-bold text-amber-900 hover:underline';
      resume.textContent = `${ticket.label} · ${(ticket.items || []).length} أصناف`;
      resume.onclick = () => resumeSuspendedSale(ticket.id);
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'text-[10px] text-red-600 font-bold'; remove.textContent = 'حذف';
      remove.onclick = () => discardSuspendedSale(ticket.id);
      row.append(resume, remove); host.appendChild(row);
    });
  } catch (error) { host.textContent = `تعذر تحميل الطلبات: ${error.message}`; }
}

async function openSelfOrderQueue() {
  openModal('modal-self-order-queue');
  const host = document.getElementById('self-order-queue-list');
  if (!host) return;
  host.textContent = 'جارٍ التحميل…';
  try {
    const response = await fetch('/api/self-order/orders'); const rows = await response.json();
    if (!response.ok) throw new Error(rows.error || 'تعذر تحميل الطلبات.');
    host.replaceChildren();
    if (!rows.length) { host.textContent = 'لا توجد طلبات ذاتية قيد المراجعة.'; return; }
    for (const order of rows) {
      const conflicts = Array.isArray(order.stock_conflicts) ? order.stock_conflicts : [];
      const card = document.createElement('article'); card.className = conflicts.length ? 'rounded-xl border border-amber-500 bg-amber-50 p-3' : 'rounded-xl border border-gray-200 p-3';
      const title = document.createElement('h3'); title.className = 'font-bold'; title.textContent = `طلب #${order.id} — ${order.customer_name} — ${order.customer_phone}`;
      const details = document.createElement('p'); details.className = 'my-2 text-sm'; details.textContent = `${(order.items || []).map(item => `${item.product_name} × ${item.quantity}`).join('، ')} · الإجمالي ${Number(order.total).toFixed(2)} ج.م · ${order.fulfillment === 'delivery' ? order.address : 'استلام من المتجر'}`;
      card.append(title, details);
      if (conflicts.length) { const warning = document.createElement('p'); warning.className = 'my-2 rounded-lg border border-amber-600 bg-amber-100 p-2 font-bold text-amber-950'; warning.textContent = `تحذير حجز مؤقت: الطلبات المعلقة تطلب ${conflicts.map(item => `${item.pending_quantity} من ${item.product_name} والمتاح ${item.available_quantity}`).join('، ')}. عالج التعارض قبل القبول.`; card.append(warning); }
      if (order.status === 'pending' && hasPermission('add')) {
        if (!conflicts.length) { const accept = document.createElement('button'); accept.type = 'button'; accept.className = 'rounded-lg bg-rose-800 px-4 py-2 font-bold text-white'; accept.textContent = 'قبول وإضافة للفواتير المعلقة'; accept.addEventListener('click', () => acceptSelfOrder(order.id, accept)); card.append(accept); }
        const reject = document.createElement('button'); reject.type = 'button'; reject.className = 'ml-2 rounded-lg border border-gray-400 bg-white px-4 py-2 font-bold text-gray-900'; reject.textContent = 'رفض وإشعار العميل'; reject.addEventListener('click', () => rejectSelfOrder(order.id, reject)); card.append(reject);
      }
      else if (order.status === 'accepted') { const status = document.createElement('p'); status.textContent = `قُبل الطلب وأُضيفت الفاتورة المعلقة رقم ${order.accepted_ticket_id}.`; card.append(status); }
      host.append(card);
    }
  } catch (error) { host.textContent = error.message; }
}

async function acceptSelfOrder(id, button) {
  if (button) button.disabled = true;
  try {
    const response = await fetch(`/api/self-order/orders/${Number(id)}/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'تعذر قبول الطلب.');
    await Promise.all([openSelfOrderQueue(), renderSuspendedSales()]);
  } catch (error) { showAppToast(error.message); if (button) button.disabled = false; }
}

async function rejectSelfOrder(id, button) {
  const values = await openAppFormDialog({ title: 'رفض الطلب الذاتي', subtitle: 'سيظهر سبب الرفض تلقائياً في صفحة العميل المفتوحة.', fields: [{ label: 'سبب الرفض', value: 'المخزون غير متاح حالياً' }], submitLabel: 'رفض وإشعار العميل' });
  if (!values) return;
  if (button) button.disabled = true;
  try {
    const response = await fetch(`/api/self-order/orders/${Number(id)}/reject`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: String(values[0] || '').trim() }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'تعذر رفض الطلب.');
    await openSelfOrderQueue();
  } catch (error) { showAppToast(error.message); if (button) button.disabled = false; }
}

async function renderCashierShift() {
  const status = document.getElementById('cashier-shift-status');
  const openButton = document.getElementById('cashier-shift-open');
  const closeButton = document.getElementById('cashier-shift-close');
  if (!status) return;
  try {
    const response = await fetch('/api/shifts/current');
    const shift = await response.json();
    if (!response.ok) throw new Error(shift.error || 'تعذر قراءة الوردية');
    if (!shift) {
      status.textContent = 'لا توجد وردية مفتوحة لهذا الكاشير.';
      openButton?.classList.remove('hidden'); closeButton?.classList.add('hidden');
      return;
    }
    status.textContent = `وردية مفتوحة منذ ${shift.opened_at} · رصيد متوقع بالصندوق ${Number(shift.expected_cash || 0).toFixed(2)} ج.م`;
    openButton?.classList.add('hidden'); closeButton?.classList.remove('hidden');
  } catch (error) { status.textContent = error.message; }
}

async function openCashierShift() {
  const values = await openAppFormDialog({ title: 'فتح وردية الكاشير', subtitle: 'أدخل النقدية الموجودة فعليًا بالصندوق عند بداية الوردية.', fields: [{ label: 'رصيد بداية الوردية (ج.م)', type: 'number', value: '0', placeholder: '0.00' }], submitLabel: 'فتح الوردية' });
  if (!values) return;
  const opening_cash = Number(values[0]);
  if (!Number.isFinite(opening_cash) || opening_cash < 0) return showAppToast('أدخل مبلغًا صحيحًا لا يقل عن صفر.');
  try {
    const response = await fetch('/api/shifts/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opening_cash }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر فتح الوردية');
    window.playSound?.('shift-open');
    await renderCashierShift();
  } catch (error) { showAppToast(error.message); }
}

async function closeCashierShift() {
  try {
    const currentResponse = await fetch('/api/shifts/current');
    const shift = await currentResponse.json();
    if (!currentResponse.ok || !shift) throw new Error(shift?.error || 'لا توجد وردية مفتوحة.');
    const values = await openAppFormDialog({ title: 'إغلاق الوردية', subtitle: `الرصيد المتوقع بالصندوق ${Number(shift.expected_cash || 0).toFixed(2)} ج.م. أدخل الرصيد الفعلي عند الإغلاق.`, fields: [{ label: 'الرصيد الفعلي (ج.م)', type: 'number', value: Number(shift.expected_cash || 0).toFixed(2), placeholder: '0.00' }], submitLabel: 'إغلاق الوردية' });
    if (!values) return;
    const closing_cash = Number(values[0]);
    if (!Number.isFinite(closing_cash) || closing_cash < 0) return showAppToast('أدخل مبلغًا صحيحًا لا يقل عن صفر.');
    const response = await fetch(`/api/shifts/${shift.id}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ closing_cash }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر إغلاق الوردية');
    await renderCashierShift();
    window.playSound?.('shift-close');
    printShiftCloseReport(result);
    showAppToast(`تم إغلاق الوردية. المتوقع ${Number(result.expected_cash).toFixed(2)} ج.م، الفعلي ${Number(result.closing_cash).toFixed(2)} ج.م، الفرق ${Number(result.difference).toFixed(2)} ج.م.`);
  } catch (error) { showAppToast(error.message); }
}

function printShiftCloseReport(shift) {
  if (!hasPermission('print_pdf')) return;
  const win = window.open('', '_blank', 'width=520,height=720');
  if (!win) return;
  const safe = value => escapeHtml(value ?? '');
  const rows = [
    ['رقم الوردية', shift.id], ['الكاشير', currentUser?.name || currentUser?.username || ''],
    ['بداية الوردية', shift.opened_at], ['إغلاق الوردية', shift.closed_at],
    ['رصيد البداية', `${Number(shift.opening_cash || 0).toFixed(2)} ج.م`],
    ['النقدية المتوقعة', `${Number(shift.expected_cash || 0).toFixed(2)} ج.م`],
    ['النقدية الفعلية', `${Number(shift.closing_cash || 0).toFixed(2)} ج.م`],
    ['العجز / الزيادة', `${Number(shift.difference || 0).toFixed(2)} ج.م`]
  ];
  win.document.write(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>تقرير إغلاق الوردية</title><style>body{font:15px Arial,sans-serif;margin:28px;color:#111}h1{text-align:center;font-size:20px}table{width:100%;border-collapse:collapse;margin-top:22px}td{padding:10px;border:1px solid #bbb}td:first-child{font-weight:bold;background:#f5f5f5}@media print{button{display:none}}</style><h1>تقرير إغلاق الوردية</h1><table>${rows.map(([label,value])=>`<tr><td>${safe(label)}</td><td>${safe(value)}</td></tr>`).join('')}</table><p style="text-align:center;margin-top:28px">تم إنشاء التقرير من نظام سيستم</p><button onclick="window.print()">طباعة التقرير</button><script>setTimeout(()=>window.print(),300)</script></html>`);
  win.document.close();
}

async function resumeSuspendedSale(id) {
  if (cart.length && !await showAppConfirm('سيتم استبدال الفاتورة الحالية بالطلب المعلق. علّق الحالية أولاً إذا أردت الاحتفاظ بها.')) return;
  try {
    const ticket = (await storage.getSuspendedSales()).find(row => row.id === id);
    if (!ticket) throw new Error('الطلب لم يعد موجودًا');
    const products = await storage.getProducts();
    const restored = ticket.items.map(item => {
      const product = products.find(p => p.id === item.product_id);
      if (!product) throw new Error(`الصنف رقم ${item.product_id} لم يعد موجودًا`);
      if (Number(item.quantity) > Number(product.quantity)) throw new Error(`المتاح من ${product.name} الآن ${product.quantity} فقط`);
      return { ...item, product_name: product.name, cost_price: product.cost_price, max_quantity: product.quantity };
    });
    cart = restored;
    window.playSound?.('resume');
    activeSelfOrderId = Number(ticket.self_order_id) || null;
    paymentMethod = ticket.payment_method || 'نقدي';
    activePosPriceLevel = ['retail', 'wholesale', 'special'].includes(ticket.price_level) ? ticket.price_level : 'retail';
    const priceLevel = document.getElementById('pos-price-level'); if (priceLevel) priceLevel.value = activePosPriceLevel;
    const customer = document.getElementById('pos-customer-select'); if (customer) customer.value = String(ticket.customer_id || 1);
    const discount = document.getElementById('pos-discount-input'); if (discount) discount.value = String(ticket.discount || 0);
    const paid = document.getElementById('pos-paid-amount'); if (paid) paid.value = String(ticket.paid_amount || '');
    const orderType = document.getElementById('pos-order-type'); if (orderType) orderType.value = ticket.order_type || 'داخل المحل';
    const orderChannel = document.getElementById('pos-order-channel'); if (orderChannel) orderChannel.value = ticket.order_channel || 'مباشر';
    const deliveryAddress = document.getElementById('pos-delivery-address'); if (deliveryAddress) deliveryAddress.value = ticket.delivery_address || '';
    const deliveryRider = document.getElementById('pos-delivery-rider-select'); if (deliveryRider) deliveryRider.value = String(ticket.delivery_rider_id || '');
    togglePosDeliveryFields();
    const salesperson = document.getElementById('pos-salesperson-select'); if (salesperson) salesperson.value = String(ticket.salesperson_id || '');
    await storage.takeSuspendedSale(id);
    renderCart(); calculateChange(); await Promise.all([renderPosProducts(), renderSuspendedSales()]);
  } catch (error) { showAppToast(`تعذر استرجاع الطلب: ${error.message}`); }
}

async function discardSuspendedSale(id) {
  if (!await showAppConfirm('حذف الطلب المعلق نهائيًا؟')) return;
  try { await storage.discardSuspendedSale(id); window.playSound?.('discard'); await renderSuspendedSales(); }
  catch (error) { showAppToast(error.message); }
}

function renderReceiptModal(sale, options = {}) {
  lastRenderedReceipt = sale;
  const custSelect = document.getElementById('pos-customer-select');
  const custName = sale.customer_name || (custSelect ? custSelect.options[custSelect.selectedIndex].text : 'عميل نقدي');
  const isCreditNote = sale.document_type === 'credit_note';

  document.getElementById('rec-inv-num').textContent = isCreditNote
    ? `${sale.document_number || sale.return_number || 'إشعار دائن'} — أصل ${sale.original_invoice_number || '—'}`
    : sale.invoice_number;
  document.getElementById('rec-date').textContent = sale.created_at || new Date().toLocaleString('ar-EG-u-nu-latn');
  document.getElementById('rec-cashier').textContent = currentUser?.name || 'المستخدم الحالي';
  document.getElementById('rec-customer').textContent = custName;
  const returnReason = String(sale.reason || sale.return_reason || '').trim();
  const returnReasonRow = document.getElementById('rec-return-reason-row');
  const returnReasonNode = document.getElementById('rec-return-reason');
  if (returnReasonNode) returnReasonNode.textContent = returnReason;
  returnReasonRow?.classList.toggle('hidden', !isCreditNote || !returnReason);
  const loyaltyRow = document.getElementById('rec-loyalty-row');
  const loyaltyPoints = Number(sale.loyalty_points_earned) || 0;
  if (loyaltyRow) loyaltyRow.classList.toggle('hidden', loyaltyPoints <= 0);
  const loyaltyPointsLabel = document.getElementById('rec-loyalty-points');
  if (loyaltyPointsLabel) loyaltyPointsLabel.textContent = String(loyaltyPoints);

  const itemsContainer = document.getElementById('rec-items-list');
  itemsContainer.innerHTML = '';

  (sale.items || []).forEach(it => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="py-1 font-semibold">${escapeHtml(it.product_name)}</td>
      <td class="py-1 text-center font-bold">${it.quantity}</td>
      <td class="py-1 text-center">${it.unit_price.toFixed(2)}</td>
      <td class="py-1 text-left font-bold">${it.total.toFixed(2)}</td>
    `;
    itemsContainer.appendChild(row);
  });

  document.getElementById('rec-subtotal').textContent = `${sale.subtotal.toFixed(2)} ج.م`;
  document.getElementById('rec-discount').textContent = `${sale.discount.toFixed(2)} ج.م`;
  const deliveryFeeRow = document.getElementById('rec-delivery-fee-row');
  const deliveryFeeNode = document.getElementById('rec-delivery-fee');
  const deliveryFee = Number(sale.delivery_fee_customer || 0);
  if (deliveryFeeNode) deliveryFeeNode.textContent = `${deliveryFee.toFixed(2)} ج.م`;
  deliveryFeeRow?.classList.toggle('hidden', deliveryFee <= 0);
  const receiptTax = document.getElementById('rec-tax');
  if (receiptTax) { receiptTax.textContent = `${Number(sale.tax_amount || 0).toFixed(2)} ج.م`; receiptTax.parentElement?.classList.toggle('hidden', printSettings.show_tax === false || !(Number(sale.tax_amount) > 0)); }
  const registrationRow = document.getElementById('rec-tax-registration-row');
  if (registrationRow) { registrationRow.classList.toggle('hidden', printSettings.show_tax === false || !(Number(sale.tax_amount) > 0 && sale.tax_registration_number)); const registration = document.getElementById('rec-tax-registration'); if (registration) registration.textContent = sale.tax_registration_number || ''; }
  document.getElementById('rec-total').textContent = `${Number(sale.total || 0).toFixed(2)} ج.م`;
  document.getElementById('rec-paid').textContent = `${Number(sale.paid_amount ?? sale.refunded_amount ?? 0).toFixed(2)} ج.م`;
  const receiptRemaining = sale.remaining_amount === undefined || sale.remaining_amount === null
    ? Math.max(0, Number(sale.total || 0) - Number(sale.paid_amount || 0))
    : Number(sale.remaining_amount);
  document.getElementById('rec-change').textContent = `${receiptRemaining.toFixed(2)} ج.م`;
  const dueAmount = Math.max(0, Number(sale.remaining_amount ?? (Number(sale.total || 0) - Number(sale.paid_amount || 0))));
  const dueAmountNode = document.getElementById('rec-due-amount'); if (dueAmountNode) dueAmountNode.textContent = `${dueAmount.toFixed(2)} ج.م`;
  const dueDateNode = document.getElementById('rec-due-date'); if (dueDateNode) dueDateNode.textContent = sale.due_date || '—';
  const creditNotice = document.getElementById('rec-credit-notice');
  if (creditNotice) { creditNotice.classList.toggle('hidden', dueAmount <= 0.009); creditNotice.textContent = dueAmount > 0.009 ? `تنبيه: يستحق عليكم مبلغ ${dueAmount.toFixed(2)} ج.م، وموعد السداد ${sale.due_date || '—'}` : ''; }
  const walletPayment = (sale.payments || []).find(payment => payment.method === 'محفظة إلكترونية');
  const walletDetails = typeof walletPayment?.method_details === 'string' ? JSON.parse(walletPayment.method_details || '{}') : (walletPayment?.method_details || {});
  const walletLabel = walletDetails.name && walletDetails.wallet_number ? `محفظة إلكترونية — ${walletDetails.name} — ${walletDetails.wallet_number}` : sale.payment_method;
  document.getElementById('rec-pay-method').textContent = isCreditNote ? 'رد قيمة المرتجع' : walletLabel;
  const walletFee = Number(walletDetails.fee || 0);
  const walletRow = document.getElementById('rec-wallet-row');
  const walletLabelNode = document.getElementById('rec-wallet-label');
  if (walletLabelNode) walletLabelNode.textContent = walletDetails.name && walletDetails.wallet_number ? `${walletDetails.name} - ${walletDetails.wallet_number}` : '';
  walletRow?.classList.toggle('hidden', !(walletDetails.name && walletDetails.wallet_number));
  const walletFeeRow = document.getElementById('rec-wallet-fee-row');
  const walletFeeNode = document.getElementById('rec-wallet-fee');
  if (walletFeeNode) walletFeeNode.textContent = `${walletFee.toFixed(2)} ج.م`;
  walletFeeRow?.classList.toggle('hidden', walletFee <= 0);
  const receiptThanks = document.getElementById('receipt-thanks');
  if (receiptThanks) {
    if (isCreditNote) {
      receiptThanks.dataset.returnNote = '1';
      receiptThanks.textContent = 'إشعار دائن — مرتجع مرتبط بالفاتورة الأصلية';
    } else {
      delete receiptThanks.dataset.returnNote;
      receiptThanks.textContent = 'شكراً لزيارتكم';
    }
  }

  // Render Barcode
  const receiptBarcode = document.getElementById('receipt-barcode');
  const receiptBarcodeFallback = document.getElementById('receipt-barcode-fallback');
  receiptBarcode?.classList.remove('hidden');
  receiptBarcodeFallback?.classList.add('hidden');
  if (receiptBarcodeFallback) receiptBarcodeFallback.textContent = '';
  try {
    JsBarcode("#receipt-barcode", sale.invoice_number, {
      format: "CODE128",
      height: 52,
      displayValue: true,
      fontSize: 13,
      margin: 8
    });
  } catch (e) {
    console.error("Barcode render error", e);
    const barcode = document.getElementById('receipt-barcode');
    const fallback = document.getElementById('receipt-barcode-fallback');
    if (barcode) barcode.classList.add('hidden');
    if (fallback) { fallback.textContent = String(sale.invoice_number || ''); fallback.classList.remove('hidden'); }
  }

  const receiptLinkRow = document.getElementById('receipt-public-link-row');
  const receiptLinkHint = document.getElementById('receipt-public-link-hint');
  const receiptLink = document.getElementById('receipt-public-link');
  receiptLinkRow?.classList.add('hidden');
  receiptLinkHint?.classList.add('hidden');
  if (receiptLink) { receiptLink.removeAttribute('href'); receiptLink.textContent = ''; }

  applyConfiguredPrintStyles();
  if (options.open !== false) openModal('modal-receipt');
  void prepareReceiptShare(sale);
}

async function posOpenPaymentModal() {
  if (!cart.length) {
    showAppToast('الفاتورة فارغة! أضف أصنافاً أولاً.');
    return;
  }
  await completeSale(Boolean(printSettings.preview_before_print || printSettings.auto_print));
}

function printReceipt() {
  window.playSound?.('print');
  window.print();
}

async function finishSale() {
  cart = [];
  activeSelfOrderId = null;
  const paid = document.getElementById('pos-amount-paid');
  if (paid) paid.value = '';
  renderCart();
  await closeModal('modal-receipt');
}

let currentReceiptShareUrl = '';
async function prepareReceiptShare(sale) {
  const status = document.getElementById('receipt-share-status'); const canvas = document.getElementById('receipt-share-qr');
  if (!status || !canvas) return;
  currentReceiptShareUrl = '';
  const linkRow = document.getElementById('receipt-public-link-row');
  const linkHint = document.getElementById('receipt-public-link-hint');
  const receiptLink = document.getElementById('receipt-public-link');
  canvas.classList.add('hidden');
  linkRow?.classList.add('hidden');
  linkHint?.classList.add('hidden');
  if (receiptLink) { receiptLink.removeAttribute('href'); receiptLink.textContent = ''; }
  try {
    const networkResponse = await fetch('/api/network-info', { cache: 'no-store' });
    const network = networkResponse.ok ? await networkResponse.json() : {};
    const publicBase = window.InvoiceShareUtils?.normalizePublicBase(network.public_url || '');
    if (!publicBase) {
      const hint = 'رابط الفاتورة الإلكتروني يحتاج ضبط الرابط العام من الإعدادات';
      status.textContent = hint;
      linkHint?.classList.remove('hidden');
      return;
    }
    let token = sale?.public_share_token;
    if (!token && sale?.id) { const response = await fetch(`/api/sales/${sale.id}/share-token`, { method: 'POST' }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'تعذر إنشاء رابط المشاركة.'); token = data.token; }
    if (!token) throw new Error('احفظ الفاتورة على الخادم أولاً لإنشاء رابط المشاركة.');
    currentReceiptShareUrl = window.InvoiceShareUtils.buildPublicInvoiceUrl(publicBase, token);
    if (!currentReceiptShareUrl) throw new Error('رابط الفاتورة الإلكتروني يحتاج ضبط الرابط العام من الإعدادات');
    if (receiptLink) { receiptLink.href = currentReceiptShareUrl; receiptLink.textContent = currentReceiptShareUrl; }
    linkRow?.classList.remove('hidden');
    canvas.classList.remove('hidden');
    await QRCode.toCanvas(canvas, currentReceiptShareUrl, { width: 150, margin: 1, errorCorrectionLevel: 'M' });
    status.textContent = 'امسح الرمز لعرض الفاتورة وحفظها PDF. واتساب لا يرفق ملفات تلقائيًا؛ أرفق الصورة يدويًا.';
  } catch (error) {
    currentReceiptShareUrl = '';
    linkRow?.classList.add('hidden');
    linkHint?.classList.remove('hidden');
    if (receiptLink) { receiptLink.removeAttribute('href'); receiptLink.textContent = ''; }
    status.textContent = error.message || 'تعذر تجهيز رابط الفاتورة الإلكتروني.';
  }
}
function shareReceiptOnWhatsApp() {
  const select = document.getElementById('pos-customer-select');
  const option = select?.options?.[select.selectedIndex];
  const phone = window.InvoiceShareUtils.normalizeEgyptWhatsappPhone(lastRenderedReceipt?.customer_phone || option?.dataset?.customerPhone || '');
  const businessName = networkInfo.business_profile?.business_name || networkInfo.business_profile?.activity || '';
  const message = window.InvoiceShareUtils.buildReceiptMessage(lastRenderedReceipt, { businessName, shareUrl: currentReceiptShareUrl });
  const recipient = phone ? `/${phone}` : '/';
  window.open(`https://wa.me${recipient}?text=${encodeURIComponent(message)}`, '_blank', 'noopener');
}

async function copyReceiptAsImage() {
  const status = document.getElementById('receipt-share-status');
  const receipt = document.getElementById('printable-receipt');
  if (!receipt || !lastRenderedReceipt) { showAppToast('لا توجد فاتورة جاهزة لنسخها.'); return 'unavailable'; }
  try {
    const rows = [...receipt.querySelectorAll('#rec-items-list tr')].map(row => [...row.cells].map(cell => cell.textContent.trim()));
    const invoiceNumber = String(lastRenderedReceipt.invoice_number || '');
    const width = 900;
    const height = 360 + rows.length * 54 + 190;
    const output = document.createElement('canvas');
    output.width = width; output.height = height;
    const context = output.getContext('2d');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
    context.fillStyle = '#111827'; context.textAlign = 'center'; context.direction = 'rtl';
    context.font = 'bold 34px Arial'; context.fillText(document.getElementById('receipt-business-name')?.textContent || '', width / 2, 52, width - 70);
    context.font = '22px Arial'; context.fillText(`رقم الفاتورة: ${invoiceNumber}`, width / 2, 95, width - 70);
    context.fillText(`التاريخ: ${document.getElementById('rec-date')?.textContent || ''}`, width / 2, 132, width - 70);
    context.textAlign = 'right';
    context.font = 'bold 21px Arial';
    context.fillText('الصنف', width - 40, 184); context.fillText('الكمية', 540, 184); context.fillText('السعر', 355, 184); context.fillText('الإجمالي', 155, 184);
    context.beginPath(); context.moveTo(35, 197); context.lineTo(width - 35, 197); context.strokeStyle = '#94a3b8'; context.stroke();
    context.font = '20px Arial';
    rows.forEach((row, index) => {
      const y = 232 + index * 54;
      context.fillStyle = '#111827';
      context.fillText(row[0] || '', width - 40, y, 360);
      context.fillText(row[1] || '', 540, y, 100);
      context.fillText(row[2] || '', 355, y, 150);
      context.fillText(row[3] || '', 155, y, 150);
      context.strokeStyle = '#e5e7eb'; context.beginPath(); context.moveTo(35, y + 16); context.lineTo(width - 35, y + 16); context.stroke();
    });
    const totalsY = 232 + rows.length * 54 + 18;
    const totals = [
      `الخصم: ${document.getElementById('rec-discount')?.textContent || ''}`,
      `الإجمالي: ${document.getElementById('rec-total')?.textContent || ''}`,
      `المدفوع: ${document.getElementById('rec-paid')?.textContent || ''}`,
      `المتبقي: ${document.getElementById('rec-change')?.textContent || ''}`
    ];
    context.font = 'bold 21px Arial'; context.textAlign = 'center';
    totals.forEach((line, index) => context.fillText(line, width / 2, totalsY + index * 32, width - 80));
    const barcode = document.createElement('canvas');
    if (typeof window.JsBarcode !== 'function') throw new Error('تعذر إنشاء باركود الفاتورة.');
    window.JsBarcode(barcode, invoiceNumber, { format: 'CODE128', width: 3, height: 72, displayValue: true, fontSize: 20, margin: 22, background: '#ffffff', lineColor: '#000000' });
    const barcodeY = totalsY + totals.length * 32 + 14;
    context.drawImage(barcode, (width - barcode.width) / 2, barcodeY);
    const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('تعذر إنشاء صورة PNG للفاتورة.');
    if (navigator.clipboard?.write && typeof ClipboardItem === 'function') {
      // Intentionally ignored: the manual image-download fallback remains available
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        if (status) status.textContent = 'تم نسخ صورة الفاتورة. أرفقها يدويًا في واتساب.';
        return 'clipboard';
      } catch (_) { /* Use the manual attachment download fallback below. */ }
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${invoiceNumber.replace(/[^\w-]/g, '_')}.png`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (status) status.textContent = 'تم حفظ صورة PNG. أرفق الملف يدويًا في واتساب.';
    showAppToast('تم حفظ صورة الفاتورة. أرفق ملف PNG يدويًا في واتساب.');
    return 'download';
  } catch (error) {
    if (status) status.textContent = error.message || 'تعذر إنشاء صورة الفاتورة.';
    showAppToast(error.message || 'تعذر إنشاء صورة الفاتورة.');
    return 'error';
  }
}

function saveReceiptAsPdf() {
  if (!lastRenderedReceipt) return showAppToast('لا توجد فاتورة جاهزة لحفظها.');
  window.print();
}

// ----------------------------------------------------
// Dashboard & Analytics
// ----------------------------------------------------
async function askMyStore(event) {
  event.preventDefault();
  const input = document.getElementById('store-question'); const answer = document.getElementById('store-answer'); const list = document.getElementById('store-answer-rows');
  const question = input?.value.trim(); if (!question) return;
  if (answer) answer.textContent = 'جارٍ البحث في بيانات نشاطك…'; if (list) list.replaceChildren();
  try {
    const response = await fetch('/api/assistant/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) }); const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر تنفيذ السؤال.');
    if (answer) answer.textContent = data.answer || '';
    if (list) for (const row of data.rows || []) { const item = document.createElement('li'); item.textContent = [row.name, row.phone, row.quantity != null ? `الكمية ${row.quantity}` : '', row.balance != null ? `الرصيد ${Number(row.balance).toFixed(2)} ج.م` : '', row.expiry_date ? `الصلاحية ${row.expiry_date}` : '', row.min_stock != null ? `الحد الأدنى ${row.min_stock}` : ''].filter(Boolean).join(' · '); list.appendChild(item); }
  } catch (error) { if (answer) answer.textContent = error.message; }
}

function updatePhase1SummaryCards(data) {
  const summary = data?.summary_cards || data || {};
  const sales = Number(summary.today_sales || 0).toFixed(2);
  const invoices = Number(summary.today_invoices_count || 0);
  const profit = Number(summary.today_profit || 0).toFixed(2);
  ['dashboard-summary-sales', 'pos-summary-sales'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = `${sales} ج.م`; });
  ['dashboard-summary-invoices', 'pos-summary-invoices'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = invoices; });
  ['dashboard-summary-profit', 'pos-summary-profit'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = `${profit} ج.م`; });
}

async function refreshDashboardWalletSummary() {
  const node = document.getElementById('dashboard-summary-wallet-balance');
  if (!node) return;
  try {
    const response = await fetch('/api/wallets', { credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const total = (Array.isArray(data.wallets) ? data.wallets : [])
      .filter(wallet => Number(wallet.is_active) === 1)
      .reduce((sum, wallet) => sum + Number(wallet.balance || 0), 0);
    node.textContent = `${total.toFixed(2)} ج.م`;
    console.log('[DASHBOARD_WALLETS] active_balance_total=', total.toFixed(2));
  } catch (error) {
    node.textContent = '0.00 ج.م';
    console.warn('[DASHBOARD_WALLETS] refresh failed:', error.message);
  }
}

async function refreshPosSummaryCards() {
  try { updatePhase1SummaryCards(await storage.getDashboardData()); }
  catch (error) { console.warn('POS summary refresh failed:', error.message); }
}

const PHASE1_NOTIFICATIONS_READ_KEY = 'system_phase1_notifications_read_signature';
function phase1NotificationsSignature(alerts) {
  return (Array.isArray(alerts) ? alerts : []).map(item => [item.type, item.alert_id || item.sms_id || item.pending_id || item.product_id, item.lot_id, item.message].join(':')).join('|');
}
function renderPhase1NotificationPanel() {
  const list = document.getElementById('notification-list');
  if (!list) return;
  if (!phase1Notifications.length) {
    list.innerHTML = '<div class="phase1-notification-empty"><i class="fa-solid fa-circle-check" aria-hidden="true"></i><span>لا توجد تنبيهات حالية.</span></div>';
    return;
  }
  const visibleNotifications = phase1Notifications.slice(0, 20);
  const smsSection = visibleNotifications.some(item => item.type.startsWith('sms_')) ? '<div class="phase1-notification-section-title"><i class="fa-solid fa-mobile-screen-button"></i> SMS</div>' : '';
  list.innerHTML = smsSection + visibleNotifications.map(item => {
    const walletActions = item.type === 'wallet_alert' && item.alert_id
      ? `<div class="phase1-wallet-notification-actions"><button type="button" onclick="window.WalletsUI?.openMovementModal('deposit', this.dataset.walletId)" data-wallet-id="${Number(item.wallet_id) || 0}">تسجيل كدفعة</button><button type="button" onclick="window.WalletsUI?.openMovementModal('withdraw', this.dataset.walletId)" data-wallet-id="${Number(item.wallet_id) || 0}">تسجيل كمصروف</button><button type="button" onclick="window.WalletsUI?.resolveAlert(this.dataset.alertId)" data-alert-id="${Number(item.alert_id) || 0}">تجاهل</button></div>`
      : '';
    const smsActions = item.type === 'sms_message' && item.sms_id
      ? `<div class="phase1-wallet-notification-actions"><button type="button" onclick="window.SmsUI?.processMessage(${Number(item.sms_id)}, 'record_payment', { wallet_id: ${Number(item.wallet_id) || 0} })">تسجيل كدفعة</button><button type="button" onclick="window.SmsUI?.processMessage(${Number(item.sms_id)}, 'ignore')">تجاهل</button></div>`
      : '';
    const smsPending = item.type === 'sms_pending' ? '<span class="phase1-sms-badge">دفعة معلقة</span>' : '';
    return `<div class="phase1-notification-item"><i class="fa-solid ${item.type === 'wallet_alert' ? 'fa-wallet' : item.type.startsWith('sms_') ? 'fa-mobile-screen-button' : 'fa-triangle-exclamation'}" aria-hidden="true"></i><span>${escapeHtml(item.message || 'تنبيه جديد')}${smsPending}</span>${walletActions}${smsActions}</div>`;
  }).join('');
}
async function togglePhase1Notifications() {
  const panel = document.getElementById('notification-panel');
  const bell = document.getElementById('notification-bell');
  if (!panel) return;
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening);
  bell?.setAttribute('aria-expanded', String(opening));
  console.log(`[phase1] notification bell clicked: ${opening ? 'open' : 'close'}`);
  if (opening) await refreshPhase1Notifications();
}
function markPhase1NotificationsRead() {
  const signature = phase1NotificationsSignature(phase1Notifications);
  try { localStorage.setItem(PHASE1_NOTIFICATIONS_READ_KEY, signature); } catch (_) {}
  const badge = document.getElementById('notification-count');
  if (badge) { badge.textContent = '0'; badge.classList.add('hidden'); }
  const panel = document.getElementById('notification-list');
  if (panel) panel.insertAdjacentHTML('afterbegin', '<div class="phase1-notification-read" role="status">تم تعليم التنبيهات كمقروءة.</div>');
  console.log(`[phase1] notifications marked read: ${phase1Notifications.length}`);
  showAppToast('تم تعليم التنبيهات كمقروءة.');
}
async function refreshPhase1Notifications() {
  if (!currentUser) return null;
  const badge = document.getElementById('notification-count');
  try {
    const response = await fetch('/api/alerts/owner');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر تحميل التنبيهات.');
    phase1Notifications = Array.isArray(data.alerts) ? data.alerts : [];
    renderPhase1NotificationPanel();
    let readSignature = '';
    try { readSignature = localStorage.getItem(PHASE1_NOTIFICATIONS_READ_KEY) || ''; } catch (_) {}
    const signature = phase1NotificationsSignature(phase1Notifications);
    const count = signature && signature === readSignature ? 0 : Number(data.count || phase1Notifications.length || 0);
    if (badge) { badge.textContent = count; badge.classList.toggle('hidden', count === 0); }
    const bell = document.getElementById('notification-bell');
    if (bell) bell.title = count ? `لديك ${count} تنبيه` : 'لا توجد تنبيهات جديدة';
    return data;
  } catch (error) {
    console.warn('Notification refresh failed:', error.message);
    if (badge) badge.classList.add('hidden');
    return null;
  }
}

async function refreshDashboard() {
  const buttons = [...document.querySelectorAll('[data-dashboard-refresh]')];
  const status = document.getElementById('dashboard-refresh-status');
  buttons.forEach(button => { button.disabled = true; button.setAttribute('aria-busy', 'true'); const label = button.querySelector('[data-refresh-label]'); if (label) label.textContent = 'جارٍ التحديث'; });
  buttons.forEach(button => button.querySelector('i')?.classList.add('animate-spin'));
  if (status) status.textContent = 'جارٍ تحديث بيانات لوحة التحكم...';
  try {
    await renderDashboardData();
    try {
      await refreshBranchDashboardSummaries();
    } catch (summaryError) {
      console.warn('Branch dashboard summary refresh failed:', summaryError.message);
      const warehouseTotal = document.getElementById('dashboard-warehouse-total');
      if (warehouseTotal) warehouseTotal.textContent = 'تعذر تحديث ملخص المخازن؛ تحقق من الاتصال ثم حدّث الشاشة.';
      const cashTotal = document.getElementById('dashboard-branch-cash-total');
      const expensesTotal = document.getElementById('dashboard-branch-expenses-total');
      if (cashTotal) cashTotal.textContent = 'تعذر التحديث';
      if (expensesTotal) expensesTotal.textContent = 'تعذر التحديث';
    }
    if (status) status.textContent = `تم التحديث ${new Intl.DateTimeFormat('ar-EG-u-nu-latn', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())}`;
    return true;
  } catch (error) {
    console.error('Dashboard refresh failed:', error);
    if (status) status.textContent = `تعذر التحديث: ${error.message || 'تحقق من اتصال البرنامج بقاعدة البيانات.'}`;
    return false;
  } finally {
    buttons.forEach(button => { button.disabled = false; button.removeAttribute('aria-busy'); button.querySelector('i')?.classList.remove('animate-spin'); const label = button.querySelector('[data-refresh-label]'); if (label) label.textContent = 'تحديث'; });
  }
}

async function renderDashboardData() {
  const [data, finance] = await Promise.all([storage.getDashboardData(), storage.getFinanceSummary()]);
  await Promise.all([renderOwnerAlerts(), refreshPhase1Notifications(), renderInventoryInsights()]);

  updatePhase1SummaryCards(data);
  await refreshDashboardWalletSummary();
  document.getElementById('dash-today-sales').textContent = `${data.today_sales.toFixed(2)} ج.م`;
  document.getElementById('dash-today-profit').textContent = `${data.today_profit.toFixed(2)} ج.م`;
  document.getElementById('dash-today-invoices').textContent = data.today_invoices_count;
  document.getElementById('dash-cash-balance')?.replaceChildren(document.createTextNode(`${Number(finance.cash_balance || 0).toFixed(2)} ج.م`));
  document.getElementById('dash-customer-debt')?.replaceChildren(document.createTextNode(`${Number(finance.customer_debt || 0).toFixed(2)} ج.م`));
  document.getElementById('dash-supplier-debt')?.replaceChildren(document.createTextNode(`${Number(finance.supplier_debt || 0).toFixed(2)} ج.م`));
  document.getElementById('dash-low-stock-count').textContent = data.low_stock_count;

  // Top selling
  const topList = document.getElementById('dash-top-selling-list');
  if (topList) {
    topList.innerHTML = '';
    if (!data.top_selling || data.top_selling.length === 0) {
      topList.innerHTML = '<p class="text-xs text-gray-400 py-6 text-center">لا توجد مبيعات مسجلة حتى الآن</p>';
    } else {
      data.top_selling.forEach((p, idx) => {
        const item = document.createElement('div');
        item.className = 'py-2 flex items-center justify-between text-xs';
        item.innerHTML = `
          <div class="flex items-center gap-2">
            <span class="w-5 h-5 rounded-full bg-gold-light text-[#B08D57] font-bold text-[10px] flex items-center justify-center">${idx + 1}</span>
            <span class="font-bold text-gray-800">${escapeHtml(p.name)}</span>
          </div>
          <span class="font-black text-[#D6336C]">${p.total_sold} مباع</span>
        `;
        topList.appendChild(item);
      });
    }
  }

  // Low stock alert table
  const lowTable = document.getElementById('dash-low-stock-table');
  if (lowTable) {
    lowTable.innerHTML = '';
    if (!data.low_stock_products || data.low_stock_products.length === 0) {
      lowTable.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-gray-400 font-bold">المخزون في حالة ممتازة، لا توجد نواقص حالياً! 🎉</td></tr>';
    } else {
      data.low_stock_products.forEach(p => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-amber-50/50';
        tr.innerHTML = `
          <td class="py-2.5 px-3 font-bold text-gray-900">${escapeHtml(p.name)}</td>
          <td class="py-2.5 px-3 text-gray-600">${escapeHtml(p.category)}</td>
          <td class="py-2.5 px-3 font-extrabold text-red-600">${p.quantity}</td>
          <td class="py-2.5 px-3 text-gray-500">${p.min_stock}</td>
          <td class="py-2.5 px-3">
            <span class="px-2 py-0.5 rounded text-[10px] font-bold ${p.quantity === 0 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'}">
              ${p.quantity === 0 ? 'نفد تماماً' : 'منخفض'}
            </span>
          </td>
          <td class="py-2.5 px-3">
            <button onclick="quickStockAdjust(${p.id})" class="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-[10px] font-bold">تسوية المخزن</button>
          </td>
        `;
        lowTable.appendChild(tr);
      });
    }
  }

  // Render 7-day Sales Chart
  renderSalesChart(data.last_7_days);
  lucide.createIcons();
}

async function renderInventoryInsights() {
  const list = document.getElementById('dash-ai-insights-list');
  const button = document.getElementById('dash-generate-insights');
  const status = document.getElementById('dash-ai-insights-status');
  if (!list) return;
  if (button) button.classList.toggle('hidden', !hasPermission('system_settings') && !hasPermission('user_management'));
  try {
    const response = await fetch('/api/insights');
    const rows = await response.json();
    if (!response.ok) throw new Error(rows.error || 'تعذر تحميل التحليلات.');
    list.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('li');
      empty.textContent = 'لا توجد توصيات محفوظة لهذا اليوم. يمكن للمدير تحديث التوقعات.';
      list.appendChild(empty);
      return;
    }
    for (const insight of rows) {
      const item = document.createElement('li');
      item.className = 'rounded-lg border border-indigo-100 bg-white/80 px-3 py-2';
      item.textContent = insight.message || `${insight.product_name}: المخزون ${insight.current_stock}`;
      list.appendChild(item);
    }
    if (status) status.textContent = `آخر تحليل محفوظ: ${rows[0]?.created_at || ''}`;
  } catch (error) {
    list.replaceChildren();
    const failure = document.createElement('li');
    failure.textContent = error.message || 'تعذر تحميل التحليلات حالياً.';
    list.appendChild(failure);
  }
}

async function generateInventoryInsights() {
  const button = document.getElementById('dash-generate-insights');
  const status = document.getElementById('dash-ai-insights-status');
  if (button) { button.disabled = true; button.textContent = 'جارٍ التحليل…'; }
  if (status) status.textContent = 'يجري حساب متوسط المبيعات والمخزون المتاح.';
  try {
    const response = await fetch('/api/insights/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر إنشاء التوقعات.');
    await renderInventoryInsights();
    if (status) status.textContent = `تم تحديث ${result.count} توصية اعتماداً على آخر ${result.lookback_days} يوماً.`;
  } catch (error) {
    if (status) status.textContent = error.message || 'تعذر إنشاء التوقعات.';
  } finally {
    if (button) { button.disabled = false; button.textContent = 'تحديث التوقعات'; }
  }
}

async function renderOwnerAlerts() {
  const section = document.getElementById('dash-owner-alerts');
  const list = document.getElementById('dash-owner-alert-list');
  if (!section || !list) return;
  if (!currentUser) return;
  try {
    const response = await fetch('/api/alerts/owner');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر تحميل التنبيهات.');
    list.replaceChildren();
    for (const alertItem of result.alerts || []) {
      const row = document.createElement('li');
      row.textContent = `• ${alertItem.message}`;
      list.appendChild(row);
    }
    section.classList.toggle('hidden', !result.alerts?.length);
  } catch (error) {
    list.replaceChildren();
    const row = document.createElement('li'); row.textContent = `تعذر تحميل تنبيهات المخزون: ${error.message}`; list.appendChild(row);
    section.classList.remove('hidden');
  }
}

function renderSalesChart(last7Days) {
  const ctx = document.getElementById('salesChart');
  if (!ctx) return;

  if (typeof Chart === 'undefined') {
    if (!document.getElementById('sales-chart-unavailable')) {
      ctx.insertAdjacentHTML('afterend', '<p id="sales-chart-unavailable" class="text-xs text-gray-500 text-center py-4" role="status">الرسم البياني غير متاح حاليًا، لكن تم تحديث مؤشرات لوحة التحكم.</p>');
    }
    return;
  }
  document.getElementById('sales-chart-unavailable')?.remove();

  if (salesChart) {
    salesChart.destroy();
  }

  const labels = (last7Days || []).map(d => `${d.dayName} (${d.date.slice(5)})`);
  const values = (last7Days || []).map(d => d.total);

  salesChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'إجمالي المبيعات (ج.م)',
        data: values,
        borderColor: '#D6336C',
        backgroundColor: 'rgba(214, 51, 108, 0.08)',
        borderWidth: 3,
        tension: 0.35,
        fill: true,
        pointBackgroundColor: '#B08D57',
        pointRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          grid: {
            color: '#F0F0F0'
          }
        },
        x: {
          grid: {
            display: false
          }
        }
      }
    }
  });
}

// ----------------------------------------------------
// Products Management
// ----------------------------------------------------
const BUSINESS_CATALOG_FORMAT = 'system-business-catalog';
const MEDICINE_CATALOG_FORMAT = 'medicine-catalog';
const businessCatalogUtils = window.SystemBusinessCatalogUtils;
let stagedBusinessCatalog = null;

function normalizeBusinessCatalogImport(data, fileName) {
  const name = String(fileName || '').toLowerCase();
  if (name.endsWith('.system-catalog.json') && data?.format === BUSINESS_CATALOG_FORMAT && data?.version === 1 && Array.isArray(data.items)) {
    if (!data.items.length || data.items.length > 10000) throw new Error('يجب أن يحتوي كتالوج SYSTEM من صنف واحد حتى 10,000 صنف.');
    return {
      activity: String(data.activity || '').trim(),
      rows: data.items.map(item => {
        const normalized = businessCatalogUtils.normalizeImportedCatalogRow(item);
        return {
          ...normalized,
          barcode: String(item?.barcode || '').trim(),
          category: String(item?.category || '').trim(), unit: String(item?.unit || 'قطعة').trim(),
          cost_price: item?.cost_price === '' || item?.cost_price === undefined ? 0 : Number(item.cost_price),
          sale_price: item?.sale_price === '' || item?.sale_price === undefined ? 0 : Number(item.sale_price),
          min_stock: item?.min_stock === '' || item?.min_stock === undefined ? 0 : Number(item.min_stock)
        };
      })
    };
  }
  if ((name === 'medicine-catalog.json' || name.endsWith('.medicine-catalog.json')) && data?.format === MEDICINE_CATALOG_FORMAT && data?.version === 1 && Array.isArray(data.items)) {
    if (!data.items.length || data.items.length > 30000) throw new Error('يجب أن يحتوي ملف الكتالوج على صنف واحد حتى 30,000 صنف.');
    return {
      activity: 'نشاط عام',
      rows: data.items.map(item => ({
        ...businessCatalogUtils.normalizeImportedCatalogRow(item),
        name: String(item?.name_ar || item?.name_en || item?.name || '').trim(),
        generic_name: String(item?.name_en || item?.generic_name || '').trim(),
        active_ingredient: String(item?.active_ingredient || '').trim(),
        scientific_name: String(item?.scientific_name || '').trim(),
        manufacturer: String(item?.manufacturer || '').trim(),
        strength: String(item?.strength || '').trim(),
        dosage_form: String(item?.dosage_form || '').trim(),
        barcode: String(item?.barcode || '').trim(),
        category: String(item?.drug_class || item?.route || item?.category || 'أدوية').trim(),
        unit: String(item?.unit || 'علبة').trim(),
        cost_price: item?.cost_price === '' || item?.cost_price === undefined ? 0 : Number(item.cost_price),
        sale_price: item?.sale_price === '' || item?.sale_price === undefined ? 0 : Number(item.sale_price),
        min_stock: item?.min_stock === '' || item?.min_stock === undefined ? 0 : Number(item.min_stock)
      }))
    };
  }
  throw new Error('ملف الكتالوج غير صالح. اختر ملف SYSTEM المنتهي بـ .system-catalog.json أو ملف كتالوج متوافق بصيغة الإصدار 1.');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

const BUSINESS_CATALOG_PAGE_SIZE = 100;
const BUSINESS_CATALOG_CORE_COLUMNS = [
  { key: 'select', label: 'تحديد' }, { key: 'name', label: 'الاسم' }, { key: 'category', label: 'الفئة' },
  { key: 'barcode', label: 'الباركود' }, { key: 'unit', label: 'الوحدة' }, { key: 'cost_price', label: 'سعر الشراء' },
  { key: 'sale_price', label: 'سعر البيع' }, { key: 'min_stock', label: 'حد الأمان' }, { key: 'actions', label: 'إجراء' }
];
function businessCatalogFilterOptionsHtml(selectId, entries, selected, emptyLabel) {
  const options = [`<option value="">${escapeHtml(emptyLabel)}</option>`, ...entries.map(entry => `<option value="${escapeHtml(entry.value ?? entry.key)}" ${String(entry.value ?? entry.key) === String(selected || '') ? 'selected' : ''}>${escapeHtml(entry.label ?? entry.key)}</option>`)];
  return options.join('');
}
function renderBusinessCatalogControls() {
  if (!stagedBusinessCatalog) return;
  const fieldSelect = document.getElementById('catalog-filter-field');
  const valueSelect = document.getElementById('catalog-filter-value');
  if (fieldSelect) {
    const fields = stagedBusinessCatalog.fieldMetadata.filterFields;
    if (!fields.some(field => field.key === stagedBusinessCatalog.filterField)) stagedBusinessCatalog.filterField = fields.some(field => field.key === 'category') ? 'category' : (fields[0]?.key || '');
    fieldSelect.innerHTML = businessCatalogFilterOptionsHtml('catalog-filter-field', fields.map(field => ({ key: field.key, label: field.key })), stagedBusinessCatalog.filterField, 'كل الحقول التصنيفية');
  }
  const activeFilter = stagedBusinessCatalog.fieldMetadata.filterFields.find(field => field.key === stagedBusinessCatalog.filterField);
  if (valueSelect) valueSelect.innerHTML = businessCatalogFilterOptionsHtml('catalog-filter-value', (activeFilter?.values || []).map(value => ({ value, label: value })), stagedBusinessCatalog.filterValue, 'كل القيم');
  const host = document.getElementById('catalog-columns-options');
  if (host) {
    const columns = stagedBusinessCatalog.fieldMetadata.extraColumns;
    host.innerHTML = columns.length
      ? `<span class="font-bold text-gray-700">الأعمدة الإضافية:</span>${columns.map(field => `<label class="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 py-1"><input type="checkbox" data-column="${escapeHtml(field.key)}" ${stagedBusinessCatalog.visibleExtraColumns.has(field.key) ? 'checked' : ''} onchange="toggleBusinessCatalogColumn(this.dataset.column,this.checked)" class="accent-blue-700"><span>${escapeHtml(field.key)}</span></label>`).join('')}`
      : '<span class="text-gray-500">لا توجد حقول إضافية ببيانات كافية لعرضها.</span>';
  }
}
function refreshBusinessCatalogIndex() {
  if (!stagedBusinessCatalog) return;
  stagedBusinessCatalog.searchIndex = businessCatalogUtils.buildCatalogSearchIndex(stagedBusinessCatalog.rows);
  stagedBusinessCatalog.fieldMetadata = businessCatalogUtils.getCatalogFieldMetadata(stagedBusinessCatalog.rows);
  if (!stagedBusinessCatalog.fieldMetadata.filterFields.some(field => field.key === stagedBusinessCatalog.filterField)) stagedBusinessCatalog.filterField = stagedBusinessCatalog.fieldMetadata.filterFields.some(field => field.key === 'category') ? 'category' : (stagedBusinessCatalog.fieldMetadata.filterFields[0]?.key || '');
  stagedBusinessCatalog.page = 0;
  renderBusinessCatalogControls();
}
function renderBusinessCatalogReview() {
  const body = document.getElementById('business-catalog-review-rows');
  if (!body || !stagedBusinessCatalog) return;
  const rows = stagedBusinessCatalog.rows;
  stagedBusinessCatalog.filteredResults = businessCatalogUtils.searchCatalog(stagedBusinessCatalog.searchIndex, stagedBusinessCatalog.query, { field: stagedBusinessCatalog.filterField, value: stagedBusinessCatalog.filterValue });
  const results = stagedBusinessCatalog.filteredResults;
  const pageSize = stagedBusinessCatalog.pageSize || BUSINESS_CATALOG_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(results.length / pageSize));
  stagedBusinessCatalog.page = Math.min(Math.max(0, stagedBusinessCatalog.page || 0), pages - 1);
  const visibleColumns = [
    ...BUSINESS_CATALOG_CORE_COLUMNS,
    ...stagedBusinessCatalog.fieldMetadata.extraColumns.filter(field => stagedBusinessCatalog.visibleExtraColumns.has(field.key)),
  ];
  const head = document.getElementById('business-catalog-review-head');
  if (head) head.innerHTML = `<tr>${visibleColumns.map(column => `<th data-column="${escapeHtml(column.key)}" class="p-2.5 ${column.key === 'select' || column.key === 'actions' ? 'text-center' : ''}">${escapeHtml(column.label)}</th>`).join('')}</tr>`;
  const offset = stagedBusinessCatalog.page * pageSize;
  const pageRows = results.slice(offset, offset + pageSize);
  body.innerHTML = pageRows.map(({ row: item, index }) => {
    const cells = visibleColumns.map(column => {
      if (column.key === 'select') return `<td class="p-2 text-center"><input data-catalog-select data-index="${index}" type="checkbox" ${item.selected ? 'checked' : ''} onchange="setBusinessCatalogRowSelected(${index},this.checked)" aria-label="تحديد الصنف ${index + 1}" class="h-4 w-4 accent-blue-700"></td>`;
      if (column.key === 'name') return `<td class="p-1.5"><input data-field="name" data-index="${index}" value="${escapeHtml(item.name || '')}" class="w-full min-w-36 rounded-lg border border-gray-200 px-2 py-2" aria-label="اسم الصنف"></td>`;
      if (column.key === 'category') return `<td class="p-1.5"><input data-field="category" data-index="${index}" value="${escapeHtml(item.category || '')}" class="w-full min-w-28 rounded-lg border border-gray-200 px-2 py-2" aria-label="الفئة"></td>`;
      if (column.key === 'barcode') return `<td class="p-1.5"><input data-field="barcode" data-index="${index}" value="${escapeHtml(item.barcode || '')}" class="w-full min-w-28 rounded-lg border border-gray-200 px-2 py-2" aria-label="الباركود"></td>`;
      if (column.key === 'unit') return `<td class="p-1.5"><input data-field="unit" data-index="${index}" value="${escapeHtml(item.unit || '')}" class="w-full min-w-20 rounded-lg border border-gray-200 px-2 py-2" aria-label="الوحدة"></td>`;
      if (['cost_price', 'sale_price', 'min_stock'].includes(column.key)) return `<td class="p-1.5"><input type="number" min="0" step="${column.key === 'min_stock' ? '1' : '0.01'}" data-field="${column.key}" data-index="${index}" value="${escapeHtml(item[column.key] ?? 0)}" class="w-24 rounded-lg border border-gray-200 px-2 py-2" aria-label="${escapeHtml(column.label)}"></td>`;
      if (column.key === 'actions') return `<td class="p-1.5 text-center"><button type="button" onclick="removeBusinessCatalogRow(${index})" class="rounded-lg bg-red-50 px-2.5 py-2 font-bold text-red-700">حذف</button></td>`;
      return `<td data-column="${escapeHtml(column.key)}" class="max-w-64 whitespace-normal break-words p-2" title="${escapeHtml(businessCatalogUtils.getCatalogFieldValue(item, column.key) ?? '')}">${escapeHtml(businessCatalogUtils.getCatalogFieldValue(item, column.key) ?? '')}</td>`;
    }).join('');
    return `<tr class="${item.selected ? 'bg-blue-50' : 'bg-white'}">${cells}</tr>`;
  }).join('');
  if (!results.length) body.innerHTML = `<tr><td colspan="${visibleColumns.length}" class="p-10 text-center text-gray-500">${rows.length ? 'لا توجد نتائج مطابقة للبحث أو الفلتر.' : 'الكتالوج فارغ. ارفع ملف كتالوج أو أضف صنفًا يدويًا.'}</td></tr>`;
  document.getElementById('catalog-import-file-name').textContent=`الكتالوج المحفوظ: ${stagedBusinessCatalog.fileName || 'كتالوج النشاط'}`;
  document.getElementById('catalog-import-activity').textContent=stagedBusinessCatalog.activity ? `النشاط المرسل: ${stagedBusinessCatalog.activity}` : '';
  const selectedCount=rows.filter(x=>x.selected).length;
  document.getElementById('catalog-import-count').textContent=`${rows.length} صنف في الكتالوج المستقل`;
  document.getElementById('catalog-selection-count').textContent=`محدد ${selectedCount} صنف`;
  document.getElementById('catalog-result-count').textContent=`${results.length} نتيجة من ${rows.length} صنف`;
  const label=document.getElementById('catalog-import-page'); if(label) label.textContent=`صفحة ${stagedBusinessCatalog.page+1} من ${pages}`;
  const previous=document.getElementById('catalog-page-previous'), next=document.getElementById('catalog-page-next');
  if(previous) previous.disabled=stagedBusinessCatalog.page===0;
  if(next) next.disabled=stagedBusinessCatalog.page>=pages-1;
  ['business-catalog-import-selected','business-catalog-delete-selected'].forEach(id=>{const b=document.getElementById(id);if(b)b.disabled=!selectedCount;});
  const notice=document.getElementById('catalog-import-extra-fields-notice');
  if(notice) notice.classList.toggle('hidden',!rows.some(item=>item.catalog_file&&!Object.keys(item.extra_fields||{}).length));
  const validation=document.getElementById('catalog-import-validation'); if(validation) validation.textContent='';
}
function setBusinessCatalogRowSelected(i,v){if(stagedBusinessCatalog?.rows[i]){stagedBusinessCatalog.rows[i].selected=!!v;renderBusinessCatalogReview();}}
function setBusinessCatalogPage(p){if(!stagedBusinessCatalog)return;const n=Math.max(1,Math.ceil(stagedBusinessCatalog.filteredResults.length/(stagedBusinessCatalog.pageSize||BUSINESS_CATALOG_PAGE_SIZE)));stagedBusinessCatalog.page=Math.min(n-1,Math.max(0,Number(p)||0));renderBusinessCatalogReview();}
function setBusinessCatalogSearch(value){if(!stagedBusinessCatalog)return;stagedBusinessCatalog.query=String(value||'');stagedBusinessCatalog.page=0;clearTimeout(businessCatalogSearchTimer);businessCatalogSearchTimer=setTimeout(renderBusinessCatalogReview,250);}
function clearBusinessCatalogSearch(){const input=document.getElementById('catalog-search');if(input)input.value='';setBusinessCatalogSearch('');}
function setBusinessCatalogFilterField(value){if(!stagedBusinessCatalog)return;stagedBusinessCatalog.filterField=String(value||'');stagedBusinessCatalog.filterValue='';stagedBusinessCatalog.page=0;renderBusinessCatalogControls();renderBusinessCatalogReview();}
function setBusinessCatalogFilterValue(value){if(!stagedBusinessCatalog)return;stagedBusinessCatalog.filterValue=String(value||'');stagedBusinessCatalog.page=0;renderBusinessCatalogReview();}
function setBusinessCatalogPageSize(value){if(!stagedBusinessCatalog)return;stagedBusinessCatalog.pageSize=[50,100,200].includes(Number(value))?Number(value):100;stagedBusinessCatalog.page=0;renderBusinessCatalogReview();}
function toggleBusinessCatalogColumn(key,visible){if(!stagedBusinessCatalog)return;if(visible)stagedBusinessCatalog.visibleExtraColumns.add(String(key));else stagedBusinessCatalog.visibleExtraColumns.delete(String(key));renderBusinessCatalogReview();}
function selectAllBusinessCatalogRows(v){if(!hasPermission('import_export'))return;if(!stagedBusinessCatalog)return;for(const result of stagedBusinessCatalog.filteredResults)stagedBusinessCatalog.rows[result.index].selected=!!v;renderBusinessCatalogReview();}
function updateBusinessCatalogField(input){if(!stagedBusinessCatalog)return;const item=stagedBusinessCatalog.rows[Number(input.dataset.index)];if(!item)return;const f=input.dataset.field;item[f]=['cost_price','sale_price','min_stock'].includes(f)?(input.value===''?'':Number(input.value)):input.value;item.dirty=true;clearTimeout(businessCatalogSearchTimer);businessCatalogSearchTimer=setTimeout(()=>{stagedBusinessCatalog.searchIndex=businessCatalogUtils.buildCatalogSearchIndex(stagedBusinessCatalog.rows);renderBusinessCatalogReview();},250);}
async function removeBusinessCatalogRow(i){if(!await showAppConfirm('حذف هذا الصنف من الكتالوج المستقل؟'))return;if(!hasPermission('import_export')){showAppToast('لا تملك صلاحية إدارة الكتالوج.');return;}if(!stagedBusinessCatalog)return;const item=stagedBusinessCatalog.rows[i];try{if(item?.id)await storage.deleteBusinessCatalog([item.id]);stagedBusinessCatalog.rows.splice(i,1);refreshBusinessCatalogIndex();renderBusinessCatalogReview();}catch(error){
  if (!await showAppConfirm('حذف هذا الصنف من الكتالوج المستقل؟')) return;showAppToast(error.message||'تعذر حذف الصنف.');}}
async function deleteSelectedBusinessCatalogRows(){if(!hasPermission('import_export')){showAppToast('لا تملك صلاحية إدارة الكتالوج.');return;}if(!stagedBusinessCatalog)return;const selected=stagedBusinessCatalog.rows.filter(x=>x.selected);if(!selected.length)return;if(!await showAppConfirm(`حذف ${selected.length} صنف محدد من الكتالوج المستقل؟ لن تتأثر الأصناف أو كميات المخزون.`))return;try{await storage.deleteBusinessCatalog(selected.map(x=>x.id).filter(Boolean));stagedBusinessCatalog.rows=stagedBusinessCatalog.rows.filter(x=>!x.selected);refreshBusinessCatalogIndex();renderBusinessCatalogReview();}catch(error){showAppToast(error.message||'تعذر حذف الأصناف المحددة.');}}
async function deleteEntireBusinessCatalog(){if(!hasPermission('import_export')){showAppToast('لا تملك صلاحية إدارة الكتالوج.');return;}if(!stagedBusinessCatalog)return;if(!await showAppConfirm('حذف جميع أصناف الكتالوج المستقل نهائيًا؟ لن تُحذف المنتجات أو كميات المخزون أو الفواتير.'))return;try{await storage.deleteBusinessCatalog([],true);stagedBusinessCatalog.rows=[];refreshBusinessCatalogIndex();renderBusinessCatalogReview();}catch(error){showAppToast(error.message||'تعذر حذف الكتالوج.');}}
function addBusinessCatalogRow(){if(!hasPermission('import_export'))return;if(!stagedBusinessCatalog)return;stagedBusinessCatalog.rows.push({id:null,name:'',barcode:'',category:'',unit:'قطعة',cost_price:0,sale_price:0,min_stock:0,selected:false,dirty:true,extra_fields:{}});refreshBusinessCatalogIndex();stagedBusinessCatalog.page=Math.floor((stagedBusinessCatalog.rows.length-1)/(stagedBusinessCatalog.pageSize||BUSINESS_CATALOG_PAGE_SIZE));renderBusinessCatalogReview();document.querySelector('#business-catalog-review-rows tr:last-child input[data-field="name"]')?.focus();}
let businessCatalogSaveInFlight=false,businessCatalogDeleteInFlight=false,businessCatalogCommitInFlight=false;
async function saveBusinessCatalogEdits(){if(!hasPermission('import_export')){showAppToast('لا تملك صلاحية إدارة الكتالوج.');return;}if(!stagedBusinessCatalog||businessCatalogSaveInFlight)return;businessCatalogSaveInFlight=true;try{const pending=stagedBusinessCatalog.rows.filter(item=>item.dirty),rows=pending.map(({selected,dirty,...item})=>item);if(!rows.length)return;const saved=await storage.saveBusinessCatalog(rows);saved.forEach((item,index)=>{const row=pending[index];if(row)Object.assign(row,item,{dirty:false});});refreshBusinessCatalogIndex();renderBusinessCatalogReview();showAppToast('تم حفظ تعديلات الكتالوج المستقل. لم تتغير الأصناف أو كميات المخزون.');}catch(error){document.getElementById('catalog-import-validation').textContent=error.message||'تعذر حفظ تعديلات الكتالوج.';}finally{businessCatalogSaveInFlight=false;}}
  // Intentionally ignored: the independent catalog is optional
async function loadBusinessCatalog(){if(!hasPermission('import_export')){showAppToast('لا تملك صلاحية عرض الكتالوج المستقل.');return;}const items=await storage.getBusinessCatalog();const warning=document.getElementById('business-catalog-storage-warning');if(warning){warning.classList.add('hidden');warning.textContent='';if(storage.useApi){try{const response=await fetch('/api/business-catalog/status');const status=await response.json();if(response.ok&&status.warning){warning.textContent=status.warning;warning.classList.remove('hidden');}}catch(_){}}else if(items.length===0&&localStorage.getItem('system_business_pos_data')?.includes('business_catalog')){warning.textContent='تعذر فصل الكتالوج المحلي القديم؛ البيانات القديمة ما زالت محفوظة.';warning.classList.remove('hidden');}}const rows=items.map(item=>({...item,selected:false}));stagedBusinessCatalog={fileName:items[0]?.catalog_file||'',activity:items[0]?.activity||'',rows,searchIndex:businessCatalogUtils.buildCatalogSearchIndex(rows),fieldMetadata:businessCatalogUtils.getCatalogFieldMetadata(rows),visibleExtraColumns:new Set(),filterField:'category',filterValue:'',query:'',page:0,pageSize:100,filteredResults:[]};const search=document.getElementById('catalog-search');if(search)search.value='';renderBusinessCatalogControls();renderBusinessCatalogReview();openModal('modal-catalog-import');if(typeof lucide!=='undefined')lucide.createIcons();}
function closeBusinessCatalogReview(){stagedBusinessCatalog=null;closeModal('modal-catalog-import');const input=document.getElementById('business-catalog-file');if(input)input.value='';}

function queueUnifiedCatalogSearch() {
  if (unifiedCatalogSearchTimer) clearTimeout(unifiedCatalogSearchTimer);
  unifiedCatalogSearchTimer = setTimeout(() => { unifiedCatalogSearchTimer = null; renderUnifiedCatalogPage(); }, 220);
}

async function renderUnifiedCatalogPage() {
  const body = document.getElementById('catalog-page-table-body');
  const status = document.getElementById('catalog-page-status');
  const stats = document.getElementById('catalog-page-stats');
  if (!body) return;
  if (!hasPermission('import_export')) {
    body.innerHTML = '<tr><td colspan="8" class="py-6 text-center text-gray-600">لا تملك صلاحية عرض الكتالوج.</td></tr>';
    return;
  }
  const search = document.getElementById('catalog-page-search')?.value || '';
  const source = document.getElementById('catalog-page-source-filter')?.value || 'catalog';
  if (status) status.textContent = 'جارٍ تحميل الكتالوج…';
  try {
    const query = new URLSearchParams({ search, source });
    const response = await fetch(`/api/catalog/items?${query}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر تحميل الكتالوج.');
    unifiedCatalogRows = Array.isArray(result.items) ? result.items : [];
    const catalogRows = unifiedCatalogRows.filter(item => item.source_type === 'catalog');
    if (stats) stats.textContent = `النتائج: ${unifiedCatalogRows.length} · الكتالوج: ${catalogRows.length} · المسجلة: ${unifiedCatalogRows.length - catalogRows.length}`;
    const selectAll = document.getElementById('catalog-page-select-all');
    if (selectAll) selectAll.checked = catalogRows.length > 0 && catalogRows.every(item => unifiedCatalogSelection.has(Number(item.id)));
    body.innerHTML = unifiedCatalogRows.map(item => {
      const isCatalog = item.source_type === 'catalog';
      const category = String(item.category || '');
      const expiry = item.has_expiry ? 'نعم' : 'لا';
      return `<tr data-source="${isCatalog ? 'catalog' : 'registered'}">
        <td><input type="checkbox" data-catalog-row-id="${isCatalog ? Number(item.id) : ''}" aria-label="تحديد ${escapeHtml(item.name || 'صنف')}" ${isCatalog && unifiedCatalogSelection.has(Number(item.id)) ? 'checked' : ''} ${isCatalog ? '' : 'disabled'} onchange="toggleUnifiedCatalogItem(${Number(item.id)},this.checked)"></td>
        <td dir="ltr">${escapeHtml(item.barcode || '—')}</td><td>${escapeHtml(item.name || '—')}</td><td>${escapeHtml(category || 'غير مصنف')}</td>
        <td>${Number(item.purchase_price || 0).toFixed(2)}</td><td>${Number(item.selling_price || 0).toFixed(2)}</td>
        <td><span class="catalog-source-badge ${isCatalog ? 'catalog-source-badge--catalog' : 'catalog-source-badge--registered'}">${isCatalog ? 'كتالوج' : 'مسجل'}</span></td><td>${expiry}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="8" class="py-6 text-center text-gray-600">لا توجد أصناف مطابقة.</td></tr>';
    if (status) status.textContent = unifiedCatalogSelection.size ? `محدد ${unifiedCatalogSelection.size} من أصناف الكتالوج.` : '';
    const transfer = document.getElementById('btn-transfer-selected');
    if (transfer) transfer.disabled = !unifiedCatalogSelection.size;
  } catch (error) {
    body.innerHTML = '<tr><td colspan="8" class="py-6 text-center text-red-700">تعذر تحميل الكتالوج.</td></tr>';
    if (status) status.textContent = error.message || 'تعذر تحميل الكتالوج.';
  }
  window.lucide?.createIcons?.();
  enforceReadableFontSizes();
}

function toggleUnifiedCatalogItem(id, selected) {
  const item = Number(id);
  if (!Number.isInteger(item) || item <= 0) return;
  if (selected) unifiedCatalogSelection.add(item); else unifiedCatalogSelection.delete(item);
  const status = document.getElementById('catalog-page-status');
  if (status) status.textContent = unifiedCatalogSelection.size ? `محدد ${unifiedCatalogSelection.size} من أصناف الكتالوج.` : '';
  const transfer = document.getElementById('btn-transfer-selected');
  if (transfer) transfer.disabled = !unifiedCatalogSelection.size;
  const visibleCatalog = unifiedCatalogRows.filter(row => row.source_type === 'catalog');
  const selectAll = document.getElementById('catalog-page-select-all');
  if (selectAll) selectAll.checked = visibleCatalog.length > 0 && visibleCatalog.every(row => unifiedCatalogSelection.has(Number(row.id)));
}

function toggleVisibleCatalogItems(selected) {
  for (const item of unifiedCatalogRows) {
    if (item.source_type !== 'catalog') continue;
    if (selected) unifiedCatalogSelection.add(Number(item.id)); else unifiedCatalogSelection.delete(Number(item.id));
  }
  renderUnifiedCatalogPage();
}

async function transferSelectedCatalogItems() {
  if (!hasPermission('import_export')) return showAppToast('لا تملك صلاحية إضافة أصناف الكتالوج للمخزون.');
  const ids = [...unifiedCatalogSelection];
  if (!ids.length) return;
  const button = document.getElementById('btn-transfer-selected');
  if (button) button.disabled = true;
  const status = document.getElementById('catalog-page-status');
  try {
    const response = await fetch('/api/catalog/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, update_prices: false }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذرت إضافة أصناف الكتالوج.');
    unifiedCatalogSelection.clear();
    const summary = `أضيف ${result.added}، حُدّث ${result.updated}، وتُرك ${result.skipped} لمنع التكرار.`;
    await Promise.all([renderUnifiedCatalogPage(), renderProducts(), renderPosProducts()]);
    const finalStatus = document.getElementById('catalog-page-status');
    if (finalStatus) finalStatus.textContent = summary;
  } catch (error) {
    if (status) status.textContent = error.message || 'تعذرت إضافة أصناف الكتالوج.';
  } finally { if (button) button.disabled = !unifiedCatalogSelection.size; }
}

function openUnifiedCatalogPage() {
  if (!hasPermission('import_export')) return showAppToast('لا تملك صلاحية عرض الكتالوج المستقل.');
  switchTab('catalog');
  // Keep the catalog destination exclusive even if a legacy navigation hook
  // left another tab's visibility class behind.
  document.querySelectorAll('.tab-content').forEach(section => {
    if (section.id === 'tab-catalog') return;
    section.classList.add('hidden');
    section.classList.remove('block');
  });
  const catalogTab = document.getElementById('tab-catalog');
  catalogTab?.classList.remove('hidden');
  catalogTab?.classList.add('block');
  selectRibbonGroup('catalog');
  requestAnimationFrame(() => { document.getElementById('catalog-page-container')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); renderUnifiedCatalogPage(); });
}

function closeUnifiedCatalogPage() {
  switchTab('products');
  document.getElementById('products-search-input')?.focus();
}

async function importBusinessCatalogFile(event) {
  const input = event?.currentTarget?.tagName === 'INPUT' ? event.currentTarget : null;
  try {
    if (!hasPermission('import_export')) throw new Error('لا تملك صلاحية استيراد كتالوج النشاط.');
    let fileName = '';
    let fileText = '';
    if (input) {
      const file = input.files?.[0];
      if (!file) return;
      fileName = file.name;
      const maxBytes = fileName.toLowerCase().endsWith('.medicine-catalog.json') ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
      if (file.size > maxBytes) throw new Error(`حجم ملف الكتالوج أكبر من ${maxBytes / (1024 * 1024)} ميجابايت.`);
      fileText = await file.text();
    } else if (window.rawdaDesktop?.chooseBusinessCatalogFile) {
      const result = await window.rawdaDesktop.chooseBusinessCatalogFile();
      if (result?.canceled) return;
      if (result?.error) throw new Error(result.error);
      fileName = result?.name || '';
      fileText = result?.content || '';
    } else {
      document.getElementById('business-catalog-file')?.click();
      return;
    }
    const data = JSON.parse(fileText);
    const normalized = normalizeBusinessCatalogImport(data, fileName);
    const result = await storage.addBusinessCatalog(normalized.rows, { fileName, activity: normalized.activity });
    await openUnifiedCatalogPage();
    showAppToast(`تم حفظ الكتالوج كقائمة مستقلة: أضيف ${result.added} صنف وتُخطّي ${result.skipped} مكررًا. لم يتغير المخزون.`);
  } catch (error) {
    showAppToast(error.message || 'تعذر قراءة ملف الكتالوج.');
    if (input) input.value = '';
  }
}

async function commitBusinessCatalogImport(selectedOnly=false){
  if(businessCatalogCommitInFlight)return;
  if(!hasPermission('import_export')){showAppToast('لا تملك صلاحية استيراد كتالوج النشاط.');return;}
  const all=stagedBusinessCatalog?.rows||[], rows=selectedOnly?all.filter(x=>x.selected):all;
  if(!rows.length){showAppToast(selectedOnly?'حدد صنفًا واحدًا على الأقل.':'أضف صنفًا واحدًا على الأقل قبل الاستيراد.');return;}
  const validation=document.getElementById('catalog-import-validation');
  const bad=all.findIndex(x=>!String(x.name||'').trim()||!String(x.unit||'').trim()||!Number.isFinite(Number(x.cost_price))||Number(x.cost_price)<0||!Number.isFinite(Number(x.sale_price))||Number(x.sale_price)<0||!Number.isFinite(Number(x.min_stock))||Number(x.min_stock)<0);
  if(bad!==-1){if(validation)validation.textContent=`راجع الصنف رقم ${bad+1}: الاسم والوحدة مطلوبان والأسعار وحد الأمان أرقام غير سالبة.`;return;}
  const button=document.getElementById(selectedOnly?'business-catalog-import-selected':'business-catalog-import-submit');if(button){button.disabled=true;button.textContent='جارٍ الحفظ والإضافة…';}
  try{
    businessCatalogCommitInFlight=true;
    const dirtyRows=all.filter(item=>item.dirty),dirty=dirtyRows.map(({selected,dirty,...item})=>item);
    if(dirty.length){const saved=await storage.saveBusinessCatalog(dirty);saved.forEach((item,index)=>{const original=dirtyRows[index];if(original)Object.assign(original,item,{dirty:false});});}
    const payload=rows, updatePrices=Boolean(document.getElementById('business-catalog-update-prices')?.checked), totals=await storage.importCatalog(payload,{updatePrices,all:!selectedOnly});
    stagedBusinessCatalog.rows=(await storage.getBusinessCatalog()).map(item=>({...item,selected:false}));stagedBusinessCatalog.page=Math.min(stagedBusinessCatalog.page||0,Math.max(0,Math.ceil(stagedBusinessCatalog.rows.length/BUSINESS_CATALOG_PAGE_SIZE)-1));renderBusinessCatalogReview();
    await renderProducts();await renderPosProducts();showAppToast(`تمت معالجة ${payload.length} صنف من الكتالوج\nأضيف: ${totals.added}، تم تحديثه: ${totals.updated}، تم تخطيه: ${totals.skipped}.`);
  }catch(error){if(validation)validation.textContent=`لم تتم إضافة أي أصناف إلى المخزون. ${error.message||'تعذر استيراد المنتجات. راجع الاتصال وحاول مرة أخرى.'}`;}
    finally{businessCatalogCommitInFlight=false;if(button){button.disabled=selectedOnly&&!stagedBusinessCatalog?.rows?.some(x=>x.selected);button.textContent=selectedOnly?'إضافة المحدد للأصناف':'إضافة كل الكتالوج للأصناف';}}
}

async function renderProducts() {
  const tbody = document.getElementById('products-table-body');
  if (!tbody) return;

  const searchQuery = normalizeCatalogText(document.getElementById('products-search-input')?.value || '');
  const catFilter = document.getElementById('products-cat-filter')?.value || 'all';

  const products = await storage.getProducts();
  window.ProductListUtils.updateProductIndex(productSearchIndexState, products);
  const categories = await storage.getCategories();

  let filtered = products;
  if (catFilter !== 'all') {
    filtered = filtered.filter(p => p.category_id === parseInt(catFilter));
  }
  if (searchQuery) {
    const matchingIds = window.ProductListUtils.searchProductIds(productSearchIndexState, searchQuery);
    filtered = filtered.filter(product => matchingIds.has(product.id));
  }

  const tableContainer = tbody.closest('.bg-white') || tbody.parentElement;
  const page = renderProductListPager(tableContainer, 'products', filtered.length, renderProducts);
  const visibleProducts = filtered.slice(page.start, page.end);

  const searchStatus = document.getElementById('product-search-status');
  if (searchStatus) {
    searchStatus.textContent = searchQuery
      ? (filtered.length ? `نتائج البحث: ${filtered.length} صنف` : 'لا توجد أصناف مطابقة. جرّب اسمًا أو باركودًا أو كلمة مختلفة.')
      : `إجمالي الأصناف: ${filtered.length}`;
  }

  renderProductExpiryAlert(products);

  tbody.innerHTML = '';
  delete tbody.dataset.phase1Empty;
  visibleProducts.forEach(p => {
    const profitMargin = p.sale_price - p.cost_price;
    const isLow = p.quantity <= p.min_stock;
    const isOut = p.quantity === 0;
    const expiryDays = p.days_until_expiry === undefined ? getDaysUntilExpiry(p.expiry_date) : p.days_until_expiry;
    const expiryCell = !p.expiry_date ? '<span class="text-gray-400">—</span>'
      : expiryDays < 0 ? `<span class="font-black text-red-700">${escapeHtml(formatProductDate(p.expiry_date))}<br>منتهي الصلاحية</span>`
      : expiryDays <= 30 ? `<span class="font-black text-amber-700">${escapeHtml(formatProductDate(p.expiry_date))}<br>ينتهي خلال ${expiryDays} يوم</span>`
      : `<span>${escapeHtml(formatProductDate(p.expiry_date))}</span>`;

    const tr = document.createElement('tr');
    tr.className = 'hover:bg-gray-50/80 transition';
    tr.innerHTML = `
      <td class="py-3 px-4 font-bold text-gray-900" title="${escapeHtml(p.notes)}">${escapeHtml(p.name)}</td>
      <td class="py-3 px-3 text-gray-600">${escapeHtml(p.category_name)}</td>
      <td class="py-3 px-3 font-mono text-[11px] text-gray-500">${escapeHtml(p.barcode)}</td>
      <td class="py-3 px-3 font-semibold text-gray-700">${p.cost_price.toFixed(2)} ج.م</td>
      <td class="py-3 px-3 font-bold text-[#D6336C]">${p.sale_price.toFixed(2)} ج.م</td>
      <td class="py-3 px-3 font-bold text-green-700">+${profitMargin.toFixed(2)} ج.م</td>
      <td class="py-3 px-3">
        <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${isOut ? 'bg-red-100 text-red-700' : isLow ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}">
          ${p.quantity} ${escapeHtml(p.unit)}
        </span>
      </td>
      <td class="py-3 px-3 text-gray-500">${p.min_stock}</td>
      <td class="py-3 px-3 text-gray-700">${p.production_date ? escapeHtml(formatProductDate(p.production_date)) : '<span class="text-gray-400">—</span>'}</td>
      <td class="py-3 px-3">${expiryCell}</td>
      <td class="py-3 px-4 text-center">
        <div class="flex items-center justify-center gap-1.5">
          <button onclick="editProduct(${p.id})" class="p-1 text-gray-500 hover:text-[#B08D57]" title="تعديل"><i data-lucide="edit-3" class="w-4 h-4"></i></button>
          <button onclick="deleteProduct(${p.id})" class="p-1 text-gray-500 hover:text-red-600" title="حذف"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (!filtered.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="11" class="py-10 px-4 text-center text-gray-500">${searchQuery ? 'لا توجد نتائج مطابقة للبحث' : 'لا توجد أصناف مسجلة بعد'}</td>`;
    tbody.appendChild(tr);
  }

  lucide.createIcons();
}

function getDaysUntilExpiry(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  const target = Date.parse(`${value}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((target - today.getTime()) / 86400000);
}

function formatProductDate(value) {
  if (!value) return '';
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || !month || !day) return value;
  return new Date(year, month - 1, day).toLocaleDateString('ar-EG-u-nu-latn');
}

function renderProductExpiryAlert(products) {
  const expiring = products.map(product => ({ ...product, days: product.days_until_expiry === undefined ? getDaysUntilExpiry(product.expiry_date) : product.days_until_expiry }))
    .filter(product => product.days !== null && product.days <= 30)
    .sort((a, b) => a.days - b.days);
  const banner = document.getElementById('product-expiry-alert');
  const status = document.getElementById('expiry-alert-status');
  if (status) {
    status.classList.toggle('hidden', expiring.length === 0);
    status.classList.toggle('expiry-danger', expiring.some(item => item.days < 0));
    status.textContent = expiring.length ? `تنبيه صلاحية: ${expiring.length} منتج` : '';
  }
  if (!banner) return;
  banner.classList.toggle('hidden', expiring.length === 0);
  banner.classList.toggle('expiry-danger', expiring.some(item => item.days < 0));
  if (!expiring.length) { banner.textContent = ''; return; }
  const expiredCount = expiring.filter(item => item.days < 0).length;
  const nearCount = expiring.length - expiredCount;
  const summary = [`تنبيه صلاحية المنتجات: ${expiredCount} منتهي الصلاحية`, `${nearCount} يقترب من الانتهاء خلال 30 يومًا`].join(' — ');
  const names = expiring.slice(0, 5).map(item => `${item.name} (${item.days < 0 ? 'منتهي' : `متبقي ${item.days} يوم`})`).join('، ');
  banner.textContent = `${summary}. ${names}${expiring.length > 5 ? '، والمزيد في القائمة' : ''}`;
}

function openProductModal() {
  document.getElementById('product-modal-title').textContent = 'إضافة منتج جديد';
  document.getElementById('product-form').reset();
  document.getElementById('prod-id').value = '';
  document.getElementById('prod-is-weighted').checked = false;
  updateProductQuantityInputMode();
  setProductImageValue('');
  generateAutoBarcode();
  populateCategorySelect('prod-category');
  openModal('modal-product');
}

async function editProduct(id) {
  const products = await storage.getProducts();
  const prod = products.find(p => p.id === id);
  if (!prod) return;

  document.getElementById('product-modal-title').textContent = `تعديل المنتج: ${prod.name}`;
  document.getElementById('prod-id').value = prod.id;
  document.getElementById('prod-name').value = prod.name;
  document.getElementById('prod-barcode').value = prod.barcode;
  document.getElementById('prod-cost').value = prod.cost_price;
  document.getElementById('prod-price').value = prod.sale_price;
  document.getElementById('prod-wholesale-price').value = prod.wholesale_price ?? '';
  document.getElementById('prod-special-price').value = prod.special_price ?? '';
  document.getElementById('prod-quantity').value = prod.quantity;
  document.getElementById('prod-min-stock').value = prod.min_stock;
  document.getElementById('prod-unit').value = prod.unit;
  document.getElementById('prod-is-weighted').checked = Boolean(prod.is_weighted);
  updateProductQuantityInputMode();
  document.getElementById('prod-notes').value = prod.notes || '';
  document.getElementById('prod-production-date').value = prod.production_date || '';
  document.getElementById('prod-expiry-date').value = prod.expiry_date || '';
  setProductImageValue(prod.image_url || '');

  await populateCategorySelect('prod-category', prod.category_id);
  openModal('modal-product');
}

async function handleProductSubmit(e) {
  e.preventDefault();

  const id = document.getElementById('prod-id').value;
  const prod = {
    id: id ? parseInt(id) : null,
    name: document.getElementById('prod-name').value.trim(),
    category_id: parseInt(document.getElementById('prod-category').value),
    barcode: document.getElementById('prod-barcode').value.trim(),
    cost_price: parseFloat(document.getElementById('prod-cost').value) || 0,
    sale_price: parseFloat(document.getElementById('prod-price').value) || 0,
    wholesale_price: document.getElementById('prod-wholesale-price').value === '' ? null : Number(document.getElementById('prod-wholesale-price').value),
    special_price: document.getElementById('prod-special-price').value === '' ? null : Number(document.getElementById('prod-special-price').value),
    quantity: Number(document.getElementById('prod-quantity').value) || 0,
    min_stock: parseInt(document.getElementById('prod-min-stock').value) || 5,
    unit: document.getElementById('prod-unit').value.trim() || 'قطعة',
    notes: document.getElementById('prod-notes').value.trim(),
    production_date: document.getElementById('prod-production-date').value,
    expiry_date: document.getElementById('prod-expiry-date').value,
    image_url: document.getElementById('prod-image-url')?.value || ''
    ,is_weighted: document.getElementById('prod-is-weighted')?.checked === true
  };

  if (prod.production_date && prod.expiry_date && prod.production_date > prod.expiry_date) {
    showAppToast('تاريخ الإنتاج لا يمكن أن يكون بعد تاريخ الانتهاء.');
    return;
  }

  try {
    await storage.saveProduct(prod);
    invalidateClientProductCache();
    invalidateClientCategoryCache();
    closeModal('modal-product');
    await renderProducts();
    await renderPosProducts();
    await checkLowStockBadge();
    showAppToast('تم حفظ المنتج بنجاح!');
  } catch (err) {
    showAppToast(`خطأ: ${err.message}`);
  }
}

function updateProductQuantityInputMode() {
  const checkbox = document.getElementById('prod-is-weighted');
  const input = document.getElementById('prod-quantity');
  if (!input) return;
  const weighted = Boolean(checkbox?.checked);
  input.step = weighted ? '0.001' : '1';
  input.min = weighted ? '0' : '0';
  input.inputMode = weighted ? 'decimal' : 'numeric';
  input.title = weighted ? 'يسمح حتى 3 منازل عشرية' : 'أعداد صحيحة فقط';
}

function setProductImageValue(value) {
  const input = document.getElementById('prod-image-url');
  const preview = document.getElementById('prod-image-preview');
  const wrap = document.getElementById('prod-image-preview-wrap');
  if (input) input.value = value || '';
  if (preview) preview.src = value || '';
  if (wrap) wrap.classList.toggle('hidden', !value);
}

async function compressProductImage(file) {
  if (!file) return '';
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('اختر صورة بصيغة JPG أو PNG أو WebP.');
  if (file.size > 10 * 1024 * 1024) throw new Error('حجم الصورة قبل الضغط يجب ألا يتجاوز 10 ميجابايت.');
  const source = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('تعذرت قراءة الصورة.')); reader.readAsDataURL(file); });
  const image = await new Promise((resolve, reject) => { const element = new Image(); element.onload = () => resolve(element); element.onerror = () => reject(new Error('ملف الصورة غير صالح.')); element.src = source; });
  const scale = Math.min(1, 400 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  const result = canvas.toDataURL('image/jpeg', 0.82);
  if (result.length > 650000) throw new Error('الصورة المضغوطة أكبر من الحد المسموح. اختر صورة أبسط.');
  return result;
}

document.getElementById('prod-image-file')?.addEventListener('change', async event => {
  try { setProductImageValue(await compressProductImage(event.currentTarget.files?.[0])); }
  catch (error) { event.currentTarget.value = ''; showAppToast(error.message); }
});
document.getElementById('prod-image-remove')?.addEventListener('click', () => { setProductImageValue(''); const input = document.getElementById('prod-image-file'); if (input) input.value = ''; });

async function deleteProduct(id) {
  if (await showAppConfirm('هل أنت متأكد من رغبتك في حذف هذا المنتج نهائياً من النظام؟')) {
    try {
      await storage.deleteProduct(id);
      invalidateClientProductCache();
      await renderProducts();
      await renderPosProducts();
      await checkLowStockBadge();
      showAppToast('تم حذف المنتج بنجاح.');
    } catch (err) { showAppToast(err.message); }
  }
}

function generateAutoBarcode() {
  document.getElementById('prod-barcode')?.focus();
}

// ----------------------------------------------------
// Categories Management
// ----------------------------------------------------
async function renderCategories() {
  const categories = await storage.getCategories();

  // POS category buttons are static HTML in index.html. Keep this renderer
  // focused on the Categories management screen and do not rewrite POS HTML.

  // Populate Products Tab Category Filter
  const prodCatFilter = document.getElementById('products-cat-filter');
  if (prodCatFilter) {
    prodCatFilter.innerHTML = '<option value="all">كل الفئات</option>';
    categories.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      prodCatFilter.appendChild(opt);
    });
  }

  // Populate Categories Table
  const catTbody = document.getElementById('categories-table-body');
  if (catTbody) {
    catTbody.innerHTML = '';
    categories.forEach((c, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="py-2.5 px-3 font-bold">${idx + 1}</td>
        <td class="py-2.5 px-3 font-bold text-gray-900">${escapeHtml(c.name)}</td>
        <td class="py-2.5 px-3 text-gray-600 font-semibold">${c.product_count || 0} منتجات</td>
        <td class="py-2.5 px-3 text-center">
          ${['admin', 'inventory_manager'].includes(currentUser?.role) ? `<button onclick="editCategory(${c.id})" class="text-amber-600 hover:text-amber-800 p-1" title="تعديل الفئة"><i data-lucide="pencil" class="w-4 h-4"></i></button>` : ''}
          ${['admin', 'inventory_manager'].includes(currentUser?.role) ? `
          <button onclick="deleteCategory(${c.id})" class="text-red-500 hover:text-red-700 p-1" title="حذف الفئة">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>` : ''}
        </td>
      `;
      catTbody.appendChild(tr);
    });
  }

  lucide.createIcons();
}

async function saveCategory() {
  const input = document.getElementById('new-category-name');
  const name = input?.value.trim();
  if (!name) {
    showAppToast('يرجى كتابة اسم الفئة أولاً.');
    return;
  }
  await storage.saveCategory(name);
  invalidateClientCategoryCache();
  input.value = '';
  await renderCategories();
  showAppToast('تمت إضافة الفئة بنجاح!');
}

async function deleteCategory(id) {
  if (await showAppConfirm('هل أنت متأكد من حذف هذه الفئة؟')) {
    try {
      await storage.deleteCategory(id);
      invalidateClientCategoryCache();
      await renderCategories();
    } catch (err) {
      showAppToast(err.message);
    }
  }
}

async function editCategory(id) {
  if (!['admin', 'inventory_manager'].includes(currentUser?.role)) {
    showAppToast('تعديل الفئات متاح للمدير ومدير المخزون فقط.');
    return;
  }
  const category = (await storage.getCategories()).find(c => c.id === id);
  if (!category) return;
  const result = await openAppFormDialog({
    title: 'تعديل اسم الفئة',
    subtitle: 'اكتب الاسم الجديد ثم احفظ التعديل.',
    fields: [{ label: 'اسم الفئة', value: category.name }],
    submitLabel: 'حفظ التعديل'
  });
  const name = result?.[0];
  if (!name) return;
  try {
    await storage.updateCategory(id, name.trim());
    invalidateClientCategoryCache();
    await renderCategories();
  } catch (err) {
    showAppToast(err.message);
  }
}

async function populateCategorySelect(selectId, selectedId = null) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const categories = await storage.getCategories();
  sel.innerHTML = '';
  categories.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    if (selectedId && c.id === selectedId) opt.selected = true;
    sel.appendChild(opt);
  });
}

// ----------------------------------------------------
// Inventory & Stock Movements
// ----------------------------------------------------
let activeInvFilter = 'all';

async function filterInventory(mode) {
  activeInvFilter = mode;
  if (mode === 'lots') productListPages.inventoryLots.page = 0;
  else if (mode === 'movements') productListPages.inventoryMovements.page = 0;
  else productListPages.inventoryProducts.page = 0;
  document.querySelectorAll('.inv-filter-btn').forEach(b => {
    b.classList.remove('bg-[#1A1A1A]', 'text-white');
    b.classList.add('bg-gray-100', 'text-gray-700');
  });

  const btn = document.getElementById(`inv-tab-${mode}`);
  if (btn) {
    btn.classList.remove('bg-gray-100', 'text-gray-700');
    btn.classList.add('bg-[#1A1A1A]', 'text-white');
  }

  await renderInventory();
}

async function renderModernInventory() {
  const body = document.getElementById('modern-inventory-body');
  if (!body) return;
  try {
    const products = await storage.getProducts();
    const lowStock = products.filter(product => Number(product.quantity || 0) <= Number(product.min_stock || 0)).length;
    const totalQuantity = products.reduce((sum, product) => sum + Number(product.quantity || 0), 0);
    const totalValue = products.reduce((sum, product) => sum + Number(product.quantity || 0) * Number(product.cost_price || 0), 0);
    const stats = document.getElementById('modern-inventory-stats');
    if (stats) stats.innerHTML = [['fa-boxes-stacked', 'إجمالي المنتجات', products.length, 'accent'], ['fa-cubes', 'إجمالي الكمية', totalQuantity, 'success'], ['fa-triangle-exclamation', 'نواقص المخزون', lowStock, 'warning'], ['fa-sack-dollar', 'قيمة المخزون', `${totalValue.toFixed(2)} ج.م`, 'accent']].map(([icon, label, value, tone]) => `<article class="erp-report-card ${tone}"><i class="fa-solid ${icon}"></i><span>${label}</span><strong>${value}</strong></article>`).join('');
    body.innerHTML = products.map(product => {
      const quantity = Number(product.quantity || 0);
      const low = quantity <= Number(product.min_stock || 0);
      return `<tr><td>${escapeHtml(product.name || '')}</td><td>${escapeHtml(product.branch_name || 'المعادي')}</td><td>${quantity}</td><td dir="ltr">${escapeHtml(product.expiry_date || '—')}</td><td><span class="erp-status-pill ${low ? 'warning' : 'success'}">${low ? 'نواقص' : 'متاح'}</span></td></tr>`;
    }).join('') || '<tr><td colspan="5" class="erp-empty-cell">لا توجد منتجات.</td></tr>';
  } catch (error) { body.innerHTML = `<tr><td colspan="5" class="erp-empty-cell">${escapeHtml(error.message)}</td></tr>`; }
}

async function renderInventory() {
  const thead = document.getElementById('inv-table-head');
  const tbody = document.getElementById('inventory-table-body');
  if (!tbody || !thead) return;
  let inventoryProductsForWaste = null;

  tbody.innerHTML = '';

  if (activeInvFilter === 'lots') {
    thead.innerHTML = '<tr><th class="py-3 px-4">الصنف</th><th class="py-3 px-3">رقم التشغيلة</th><th class="py-3 px-3">المورد / الفاتورة</th><th class="py-3 px-3">الوارد</th><th class="py-3 px-3">المتبقي</th><th class="py-3 px-3">الإنتاج</th><th class="py-3 px-3">الانتهاء</th><th class="py-3 px-4">الحالة</th></tr>';
    const response = await fetch('/api/inventory/lots'); const lots = await response.json();
    const container = tbody.closest('.bg-white') || tbody.parentElement;
    const page = renderProductListPager(container, 'inventoryLots', lots.length, renderInventory);
    lots.slice(page.start, page.end).forEach(lot => {
      const days = lot.days_until_expiry; const status = lot.expired ? '<span class="text-red-700 font-black">منتهية</span>' : days !== null && days <= 30 ? `<span class="text-amber-700 font-bold">تنتهي خلال ${days} يوم</span>` : '<span class="text-emerald-700">سارية</span>';
      const tr = document.createElement('tr'); tr.className = 'border-b';
      tr.innerHTML = `<td class="p-3 font-bold">${escapeHtml(lot.product_name)}</td><td class="p-3">${escapeHtml(lot.lot_number || `تشغيلة ${lot.id}`)}</td><td class="p-3">${escapeHtml(lot.supplier_name)}<div class="text-gray-400 text-[10px]">PUR-${lot.purchase_id}</div></td><td class="p-3">${Number(lot.quantity).toLocaleString('ar-EG-u-nu-latn')}</td><td class="p-3 font-bold">${Number(lot.available_quantity).toLocaleString('ar-EG-u-nu-latn')}</td><td class="p-3">${escapeHtml(lot.production_date || '—')}</td><td class="p-3">${escapeHtml(lot.expiry_date || '—')}</td><td class="p-3">${status}</td>`; tbody.appendChild(tr);
    });
    if (!lots.length) tbody.innerHTML = '<tr><td colspan="8" class="p-8 text-center text-gray-400">لا توجد تشغيلات مسجلة. تظهر التشغيلات الجديدة عند إضافة فواتير الشراء.</td></tr>';
  } else if (activeInvFilter === 'movements') {
    // Show movements table
    thead.innerHTML = `
      <tr>
        <th class="py-3 px-4">التاريخ والوقت</th>
        <th class="py-3 px-3">المنتج</th>
        <th class="py-3 px-3">الباركود</th>
        <th class="py-3 px-3">نوع الحركة</th>
        <th class="py-3 px-3">الكمية</th>
        <th class="py-3 px-4">المرجع / الفاتورة</th>
      </tr>
    `;

    const movements = await storage.getStockMovements();
    const container = tbody.closest('.bg-white') || tbody.parentElement;
    const page = renderProductListPager(container, 'inventoryMovements', movements.length, renderInventory);
    movements.slice(page.start, page.end).forEach(m => {
      const typeLabels = {
        sale: { text: 'بيع كاشير', class: 'bg-red-50 text-red-700' },
        purchase: { text: 'توريد شراء', class: 'bg-green-50 text-green-700' },
        adjustment: { text: 'تسوية جرد', class: 'bg-blue-50 text-blue-700' }
      };
      const label = typeLabels[m.type] || { text: m.type, class: 'bg-gray-100 text-gray-700' };

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="py-3 px-4 font-mono text-[11px] text-gray-500">${escapeHtml(m.created_at)}</td>
        <td class="py-3 px-3 font-bold text-gray-900">${escapeHtml(m.product_name)}</td>
        <td class="py-3 px-3 font-mono text-gray-500">${escapeHtml(m.product_barcode || '')}</td>
        <td class="py-3 px-3">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold ${label.class}">${label.text}</span>
        </td>
        <td class="py-3 px-3 font-extrabold ${m.quantity > 0 ? 'text-green-700' : 'text-red-600'}">${m.quantity > 0 ? `+${m.quantity}` : m.quantity}</td>
        <td class="py-3 px-4 text-gray-600 font-mono text-xs">${escapeHtml(m.reference_id || '--')}</td>
      </tr>
      `;
      tbody.appendChild(tr);
    });

  } else {
    // Show products stock table
    thead.innerHTML = `
      <tr>
        <th class="py-3 px-4">المنتج</th>
        <th class="py-3 px-3">الباركود</th>
        <th class="py-3 px-3">الكمية الحالية</th>
        <th class="py-3 px-3">الحد الأدنى</th>
        <th class="py-3 px-3">قيمة المخزون (سعر التكلفة)</th>
        <th class="py-3 px-3">حالة الرصيد</th>
        <th class="py-3 px-4 text-center">إجراء</th>
      </tr>
    `;

    const products = await storage.getProducts();
    inventoryProductsForWaste = products;
    window.ProductListUtils.updateProductIndex(productSearchIndexState, products);
    let filtered = products;
    if (activeInvFilter === 'low') {
      filtered = filtered.filter(p => p.quantity <= p.min_stock);
    }

    const container = tbody.closest('.bg-white') || tbody.parentElement;
    const page = renderProductListPager(container, 'inventoryProducts', filtered.length, renderInventory);

    filtered.slice(page.start, page.end).forEach(p => {
      const totalCost = p.quantity * p.cost_price;
      const isOut = p.quantity === 0;
      const isLow = p.quantity > 0 && p.quantity <= p.min_stock;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="py-3 px-4 font-bold text-gray-900">${escapeHtml(p.name)}</td>
        <td class="py-3 px-3 font-mono text-gray-500">${escapeHtml(p.barcode)}</td>
        <td class="py-3 px-3 font-black ${isOut ? 'text-red-600' : isLow ? 'text-amber-700' : 'text-gray-900'}">${p.quantity} ${escapeHtml(p.unit)}</td>
        <td class="py-3 px-3 text-gray-500">${p.min_stock}</td>
        <td class="py-3 px-3 font-bold text-[#B08D57]">${totalCost.toFixed(2)} ج.م</td>
        <td class="py-3 px-3">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold ${isOut ? 'bg-red-100 text-red-700' : isLow ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-700'}">
            ${isOut ? 'نفد تماماً' : isLow ? 'منخفض (قارب على النفاد)' : 'مخزون سليم'}
          </span>
        </td>
        <td class="py-3 px-4 text-center">
          <button onclick="quickStockAdjust(${p.id})" class="px-2.5 py-1 rounded-lg bg-gray-100 hover:bg-[#B08D57] hover:text-white transition text-xs font-bold">تسوية</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  lucide.createIcons();
  await renderInventoryWaste(inventoryProductsForWaste);
}

async function renderInventoryWaste(productsOverride = null) {
  const productSelect = document.getElementById('waste-product'); const table = document.getElementById('inventory-waste-list');
  if (!productSelect || !table) return;
  try {
    const [products, recordsResponse] = await Promise.all([Array.isArray(productsOverride) ? Promise.resolve(productsOverride) : storage.getProducts(), fetch('/api/inventory/waste')]); const records = await recordsResponse.json();
    inventoryWasteProducts = products;
    if (!Array.isArray(productsOverride)) window.ProductListUtils.updateProductIndex(productSearchIndexState, products);
    renderWasteProductOptions(document.getElementById('waste-product-search')?.value || '');
    await loadWasteLots();
    table.innerHTML = records.length ? records.map(record => `<tr class="border-b"><td class="p-2">${escapeHtml(record.created_at)}</td><td class="p-2 font-bold">${escapeHtml(record.product_name)}</td><td class="p-2">${Number(record.quantity).toLocaleString('ar-EG-u-nu-latn')}</td><td class="p-2">${Number(record.cost_value || 0).toFixed(2)} ج.م</td><td class="p-2">${escapeHtml(record.reason)}</td><td class="p-2">${(record.allocations || []).map(item => escapeHtml(item.lot_number || 'مخزون عام')).join('، ')}</td></tr>`).join('') : '<tr><td colspan="6" class="p-5 text-center text-gray-400">لا توجد قيود هالك مسجلة.</td></tr>';
  } catch (error) { table.innerHTML = `<tr><td colspan="6" class="p-4 text-red-700">${escapeHtml(error.message || 'تعذر تحميل سجل الهالك')}</td></tr>`; }
}

function renderWasteProductOptions(query = '') {
  const select = document.getElementById('waste-product');
  if (!select) return;
  const selectedId = Number(select.value) || 0;
  const normalizedQuery = window.ProductListUtils.normalizeProductText(query);
  const matchingIds = normalizedQuery ? window.ProductListUtils.searchProductIds(productSearchIndexState, normalizedQuery) : null;
  const matches = normalizedQuery ? inventoryWasteProducts.filter(product => matchingIds.has(product.id)) : inventoryWasteProducts;
  const visible = matches.slice(0, 100);
  const selected = selectedId ? inventoryWasteProducts.find(product => product.id === selectedId) : null;
  if (selected && !visible.some(product => product.id === selected.id)) visible.unshift(selected);
  select.innerHTML = visible.map(product => `<option value="${product.id}">${escapeHtml(product.name)} — ${Number(product.quantity).toLocaleString('ar-EG-u-nu-latn')} ${escapeHtml(product.unit || '')}</option>`).join('');
  if (selected && visible.some(product => product.id === selected.id)) select.value = String(selected.id);
  const status = document.getElementById('waste-product-search-status');
  if (status) status.textContent = normalizedQuery ? `${matches.length} نتيجة؛ يعرض أول 100.` : `إجمالي الأصناف ${matches.length}؛ ابحث لعرض الصنف المطلوب.`;
}

function queueWasteProductSearch(query) {
  clearTimeout(wasteProductSearchTimer);
  wasteProductSearchTimer = setTimeout(() => renderWasteProductOptions(query), 250);
}

async function loadWasteLots() {
  const productId = Number(document.getElementById('waste-product')?.value); const select = document.getElementById('waste-lot'); if (!select) return;
  select.innerHTML = '<option value="">صرف من المخزون حسب الأقدم</option>';
  if (!productId) return;
  // Intentionally ignored: waste-lot loading already reports the failure
  try {
    const response = await fetch(`/api/inventory/lots?product_id=${productId}`); const lots = await response.json();
    select.innerHTML += lots.filter(lot => lot.remaining_quantity !== undefined && Number(lot.available_quantity) > 0).map(lot => `<option value="${lot.id}">${escapeHtml(lot.lot_number || `تشغيلة ${lot.id}`)} — باقي ${Number(lot.available_quantity)}${lot.expiry_date ? ` · ${escapeHtml(lot.expiry_date)}` : ''}</option>`).join('');
  } catch (error) { console.error('Waste lots load failed', error); }
}

async function submitInventoryWaste(event) {
  event.preventDefault();
  const status = document.getElementById('waste-status'); if (status) status.textContent = 'جارٍ تسجيل الهالك…';
  try {
    const response = await fetch('/api/inventory/waste', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ warehouse_id: Number(document.getElementById('waste-warehouse-select')?.value) || null, product_id: Number(document.getElementById('waste-product')?.value), lot_id: Number(document.getElementById('waste-lot')?.value) || null, quantity: Number(document.getElementById('waste-quantity')?.value), reason: document.getElementById('waste-reason')?.value.trim() }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'تعذر تسجيل الهالك.');
    const reason = document.getElementById('waste-reason'); if (reason) reason.value = '';
    if (status) status.textContent = `تم تسجيل ${data.quantity} من ${data.product_name}؛ التكلفة التقديرية ${Number(data.cost_value).toFixed(2)} ج.م.`;
    await Promise.all([renderInventoryWaste(), renderProducts(), renderPosProducts(), checkLowStockBadge()]);
  } catch (error) { if (status) status.textContent = error.message; }
}

async function quickStockAdjust(prodId) {
  await openStockAdjustModal(prodId);
}

async function openStockAdjustModal(preselectedId = null) {
  const sel = document.getElementById('adjust-prod-id');
  const products = await storage.getProducts();
  sel.innerHTML = '';
  products.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} (الرصيد: ${p.quantity})`;
    if (preselectedId && p.id === preselectedId) opt.selected = true;
    sel.appendChild(opt);
  });

  updateAdjustCurrentStock();
  openModal('modal-stock-adjust');
}

async function updateAdjustCurrentStock() {
  const prodId = parseInt(document.getElementById('adjust-prod-id').value);
  const products = await storage.getProducts();
  const prod = products.find(p => p.id === prodId);
  const info = document.getElementById('adjust-current-stock-info');
  const input = document.getElementById('adjust-new-quantity');
  if (prod && info) {
    info.innerHTML = `الرصيد المسجل حالياً: <span class="font-bold text-[#D6336C]">${prod.quantity} ${escapeHtml(prod.unit)}</span>`;
    if (input) input.value = prod.quantity;
  }
}

async function handleStockAdjustSubmit(e) {
  e.preventDefault();
  const prodId = document.getElementById('adjust-prod-id').value;
  const newQty = document.getElementById('adjust-new-quantity').value;
  const reason = document.getElementById('adjust-reason').value;

  try {
    await storage.adjustStock(prodId, newQty, reason);
    closeModal('modal-stock-adjust');
    await renderInventory();
    await renderProducts();
    await renderPosProducts();
    await checkLowStockBadge();
    showAppToast('تمت التسوية المخزنية بنجاح!');
  } catch (err) {
    showAppToast(err.message);
  }
}

async function checkLowStockBadge() {
  const products = await storage.getProducts();
  const lowCount = products.filter(p => p.quantity <= p.min_stock).length;
  const badge = document.getElementById('low-stock-badge');
  if (badge) {
    if (lowCount > 0) {
      badge.textContent = lowCount;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
}

// ----------------------------------------------------
// Purchases Management
// ----------------------------------------------------
function queuePurchasesSearch() {
  clearTimeout(purchasesSearchTimer);
  purchasesSearchTimer = setTimeout(() => { purchasesSearchTimer = null; void renderPurchases(); }, 220);
}
async function renderModernPurchases() {
  const tbody = document.getElementById('modern-purchases-body');
  if (!tbody) return;
  try {
    const purchases = (await storage.getPurchases()).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || Number(b.id) - Number(a.id));
    tbody.innerHTML = purchases.map(purchase => {
      const total = Number(purchase.total || 0);
      const paid = Number(purchase.paid_amount || 0);
      const remaining = Math.max(0, Number(purchase.remaining_amount ?? total - paid) || 0);
      const status = purchase.status === 'cancelled' ? 'ملغاة' : remaining > 0.0001 ? 'آجل' : 'مسددة';
      const tone = status === 'مسددة' ? 'success' : status === 'ملغاة' ? 'danger' : 'warning';
      return `<tr><td><button type="button" class="erp-table-link" onclick="viewPurchaseInvoice(${Number(purchase.id)})">PO-${Number(purchase.id)}#</button></td><td>${escapeHtml(purchase.supplier_name || 'مورد عام')}</td><td dir="ltr">${escapeHtml(String(purchase.created_at || '').slice(0, 10))}</td><td>${total.toFixed(2)} ج.م</td><td>${remaining.toFixed(2)} ج.م</td><td><span class="erp-status-pill ${tone}">${status}</span></td></tr>`;
    }).join('') || '<tr><td colspan="6" class="erp-empty-cell">لا توجد فواتير شراء.</td></tr>';
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="erp-empty-cell">${escapeHtml(error.message)}</td></tr>`;
  }
}
async function renderPurchases() {
  void renderModernPurchases();
  const tbody = document.getElementById('purchases-table-body');
  if (!tbody) return;
  const purchases = await storage.getPurchases();
  const supplierId = Number(document.getElementById('purchase-list-supplier')?.value || 0);
  const from = document.getElementById('purchase-list-from')?.value || '';
  const to = document.getElementById('purchase-list-to')?.value || '';
  const search = normalizeCatalogText(document.getElementById('purchase-list-search')?.value || '');
  const filtered = purchases.filter(purchase => {
    const day = String(purchase.created_at || '').slice(0, 10);
    const haystack = normalizeCatalogText(`PUR-${purchase.id} ${purchase.supplier_name || ''}`);
    return (!supplierId || Number(purchase.supplier_id) === supplierId) &&
      (!from || day >= from) && (!to || day <= to) && (!search || haystack.includes(search));
  }).sort((a,b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || Number(b.id)-Number(a.id));
  tbody.innerHTML = '';
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="p-4 text-center text-gray-500">لا توجد فواتير شراء مطابقة.</td></tr>';
    return;
  }
  filtered.forEach(pur => {
    const total = Number(pur.total || 0);
    const paid = Number(pur.paid_amount || 0);
    const remaining = Math.max(0, Number(pur.remaining_amount ?? (total-paid)) || 0);
    const status = pur.status === 'cancelled' ? 'ملغاة' : (remaining > 0.0001 ? 'غير مسددة' : 'مسددة');
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-gray-50';
    const itemDates = (pur.items || []).filter(item => item.production_date || item.expiry_date).map(item => {
      const productName = escapeHtml(item.product_name || 'صنف');
      const production = item.production_date ? `إنتاج ${escapeHtml(item.production_date)}` : 'إنتاج —';
      const expiry = item.expiry_date ? `انتهاء ${escapeHtml(item.expiry_date)}` : 'انتهاء —';
      return `${productName}: ${production} / ${expiry}`;
    }).join('<br>');
    tr.innerHTML = `
      <td class="py-3 px-4 font-mono font-bold text-[#D6336C]">PUR-${Number(pur.id)}</td>
      <td class="py-3 px-3 font-bold text-gray-800">${escapeHtml(pur.supplier_name)}</td>
      <td class="py-3 px-3 text-gray-600">${escapeHtml(pur.user_name)}</td>
      <td class="py-3 px-3 font-semibold">${pur.items_count || pur.items?.length || 1} أصناف${itemDates ? `<div class="mt-1 text-[10px] leading-5 font-normal text-gray-500">${itemDates}</div>` : ''}</td>
      <td class="py-3 px-3 font-black text-gray-900">${total.toFixed(2)} ج.م</td>
      <td class="py-3 px-3 text-green-700">${paid.toFixed(2)} ج.م</td>
      <td class="py-3 px-3 text-red-600">${remaining.toFixed(2)} ج.م</td>
      <td class="py-3 px-3"><span class="rounded-full px-2 py-1 text-[11px] font-bold ${status === 'مسددة' ? 'bg-emerald-100 text-emerald-800' : status === 'ملغاة' ? 'bg-gray-100 text-gray-600' : 'bg-amber-100 text-amber-800'}">${status}</span></td>
      <td class="py-3 px-3 text-gray-500 font-mono text-[11px]">${escapeHtml(pur.created_at)}</td>
      <td class="py-3 px-3 whitespace-nowrap space-x-1">
        <button type="button" onclick="viewPurchaseInvoice(${Number(pur.id)})" class="purchase-invoice-view text-indigo-700 bg-indigo-50 px-2 py-1 rounded">عرض / طباعة</button>
        <button type="button" onclick="editPurchasePayment(${Number(pur.id)}, ${paid})" class="text-blue-700 bg-blue-50 px-2 py-1 rounded">تعديل</button>
        ${status !== 'ملغاة' ? `<button type="button" onclick="cancelPurchaseInvoice(${Number(pur.id)})" class="text-red-700 bg-red-50 px-2 py-1 rounded">حذف</button>` : '<span class="text-gray-400">ملغاة</span>'}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function viewPurchaseInvoice(id) {
  const [purchases, products] = await Promise.all([storage.getPurchases(), storage.getProducts()]);
  const purchase = purchases.find(row => Number(row.id) === Number(id));
  const target = document.getElementById('purchase-invoice-print-area');
  if (!purchase || !target) return showAppToast('فاتورة الشراء غير موجودة.');
  const productById = new Map(products.map(product => [Number(product.id), product]));
  const rows = (purchase.items || []).map(item => {
    const product = productById.get(Number(item.product_id));
    const number = product?.item_number ?? item.item_number ?? '—';
    const quantity = Number(item.quantity || 0), cost = Number(item.unit_cost || 0);
    return `<tr><td>${escapeHtml(item.product_name || product?.name || 'صنف')}</td><td>${escapeHtml(number)}</td><td>${quantity}</td><td>${cost.toFixed(2)}</td><td>${(quantity*cost).toFixed(2)}</td></tr>`;
  }).join('');
  const total=Number(purchase.total||0), paid=Number(purchase.paid_amount||0), remaining=Math.max(0,Number(purchase.remaining_amount ?? total-paid)||0);
  target.innerHTML = `<header class="mb-4 border-b pb-3"><h1 class="text-2xl font-black">فاتورة شراء PUR-${Number(purchase.id)}</h1><div class="mt-2 grid grid-cols-2 gap-2"><p><b>المورد:</b> ${escapeHtml(purchase.supplier_name||'')}</p><p><b>التاريخ:</b> ${escapeHtml(purchase.created_at||'')}</p><p><b>المسؤول:</b> ${escapeHtml(purchase.user_name||'')}</p><p><b>الفرع:</b> ${escapeHtml(purchase.branch_name||purchase.branch_id||'—')}</p></div></header><table class="w-full text-right border-collapse"><thead><tr><th class="border p-2">الصنف</th><th class="border p-2">رقم الصنف</th><th class="border p-2">الكمية</th><th class="border p-2">سعر الشراء</th><th class="border p-2">الإجمالي</th></tr></thead><tbody>${rows}</tbody></table><section class="mt-4 grid grid-cols-3 gap-3 text-center"><p>الإجمالي<br><b>${total.toFixed(2)} ج.م</b></p><p>المدفوع<br><b>${paid.toFixed(2)} ج.م</b></p><p>المتبقي<br><b>${remaining.toFixed(2)} ج.م</b></p></section>`;
  openModal('modal-purchase-details');
}

function printPurchaseInvoice() { window.print(); }

function renderPurchaseOrderDraft() {
  const body = document.getElementById('purchase-order-draft-items');
  if (!body) return;
  body.replaceChildren();
  currentPurchaseOrderItems.forEach((item, index) => {
    const row = document.createElement('tr');
    row.innerHTML = `<td class="p-2">${escapeHtml(item.product_name)}</td><td class="p-2">${item.quantity}</td><td class="p-2">${Number(item.unit_cost).toFixed(2)}</td><td class="p-2">${escapeHtml(item.expiry_date || '—')}</td><td class="p-2">${(item.quantity * item.unit_cost).toFixed(2)}</td><td class="p-2"><button type="button" class="text-red-700" onclick="removePurchaseOrderItem(${index})">حذف</button></td>`;
    body.appendChild(row);
  });
}

async function addPurchaseOrderItem() {
  const productId = Number(document.getElementById('purchase-order-product')?.value);
  const quantity = Number(document.getElementById('purchase-order-quantity')?.value);
  const unitCost = Number(document.getElementById('purchase-order-unit-cost')?.value);
  const expiryDate = document.getElementById('purchase-order-expiry')?.value || '';
  const lotNumber = document.getElementById('purchase-order-lot')?.value.trim() || '';
  if (!productId || !Number.isInteger(quantity) || quantity < 1 || !Number.isFinite(unitCost) || unitCost < 0) return showAppToast('اختر صنفاً وأدخل كمية وتكلفة صحيحتين.');
  const product = (await storage.getProducts()).find(row => row.id === productId);
  if (!product) return showAppToast('الصنف المحدد غير موجود.');
  currentPurchaseOrderItems.push({ product_id: productId, product_name: product.name, quantity, unit_cost: unitCost, lot_number: lotNumber, production_date: '', expiry_date: expiryDate });
  document.getElementById('purchase-order-lot').value = '';
  renderPurchaseOrderDraft();
}

function removePurchaseOrderItem(index) { currentPurchaseOrderItems.splice(index, 1); renderPurchaseOrderDraft(); }

async function createPurchaseOrder(event) {
  event.preventDefault();
  const status = document.getElementById('purchase-order-status');
  if (!currentPurchaseOrderItems.length) { if (status) status.textContent = 'أضف صنفاً واحداً على الأقل قبل حفظ الأمر.'; return; }
  try {
    const response = await fetch('/api/purchase-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ supplier_id: Number(document.getElementById('purchase-order-supplier')?.value), items: currentPurchaseOrderItems.map(({ product_id, quantity, unit_cost, lot_number, production_date, expiry_date }) => ({ product_id, quantity, unit_cost, lot_number, production_date, expiry_date })), notes: document.getElementById('purchase-order-notes')?.value || '' }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر حفظ أمر الشراء.');
    currentPurchaseOrderItems = []; renderPurchaseOrderDraft();
    const notes = document.getElementById('purchase-order-notes'); if (notes) notes.value = '';
    if (status) status.textContent = `تم حفظ المسودة ${result.order_number} دون تحديث المخزون.`;
    await renderPurchaseOrders();
  } catch (error) { if (status) status.textContent = error.message; }
}

async function renderPurchaseOrders() {
  const body = document.getElementById('purchase-orders-list'); if (!body) return;
  try {
    const response = await fetch('/api/purchase-orders'); const orders = await response.json();
    if (!response.ok) throw new Error(orders.error || 'تعذر تحميل أوامر الشراء.');
    const labels = { draft: 'مسودة', approved: 'معتمد', received: 'مستلم', cancelled: 'ملغي' };
    body.replaceChildren();
    for (const order of orders) {
      const row = document.createElement('tr');
      const itemsText = (order.items || []).map(item => `${escapeHtml(item.product_name)} × ${item.quantity}${item.lot_number ? ` · تشغيلة ${escapeHtml(item.lot_number)}` : ''}${item.expiry_date ? ` · تنتهي ${escapeHtml(item.expiry_date)}` : ''}`).join('<br>');
      const actions = order.status === 'draft'
        ? `<button onclick="setPurchaseOrderStatus(${order.id}, 'approved')" class="rounded bg-blue-50 px-2 py-1 text-blue-800">اعتماد</button> <button onclick="setPurchaseOrderStatus(${order.id}, 'cancelled')" class="rounded bg-red-50 px-2 py-1 text-red-800">إلغاء</button>`
        : order.status === 'approved'
          ? `<button onclick="receivePurchaseOrder(${order.id})" class="rounded bg-green-700 px-2 py-1 text-white">استلام وتحويل لفاتورة</button> <button onclick="setPurchaseOrderStatus(${order.id}, 'cancelled')" class="rounded bg-red-50 px-2 py-1 text-red-800">إلغاء</button>`
          : order.purchase_id ? `PUR-${order.purchase_id}` : '—';
      row.innerHTML = `<td class="p-2 font-bold">${escapeHtml(order.order_number)}</td><td class="p-2">${escapeHtml(order.supplier_name)}</td><td class="p-2">${itemsText}</td><td class="p-2">${Number(order.total).toFixed(2)} ج.م</td><td class="p-2">${labels[order.status] || order.status}</td><td class="p-2">${escapeHtml(order.created_at)}</td><td class="p-2 whitespace-nowrap">${actions}</td>`;
      body.appendChild(row);
    }
    if (!orders.length) body.innerHTML = '<tr><td colspan="7" class="p-4 text-center text-gray-500">لا توجد أوامر شراء.</td></tr>';
  } catch (error) { body.innerHTML = `<tr><td colspan="7" class="p-4 text-red-700">${escapeHtml(error.message)}</td></tr>`; }
}

async function setPurchaseOrderStatus(orderId, statusValue) {
  const promptText = statusValue === 'approved' ? 'اعتماد أمر الشراء؟' : 'إلغاء أمر الشراء؟';
  if (!await showAppConfirm(promptText)) return;
  try {
    const response = await fetch(`/api/purchase-orders/${orderId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: statusValue }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'تعذر تحديث أمر الشراء.');
    await renderPurchaseOrders();
  } catch (error) { showAppToast(error.message); }
}

async function receivePurchaseOrder(orderId) {
  const order = (await (await fetch('/api/purchase-orders')).json()).find(row => row.id === orderId);
  if (!order) return showAppToast('أمر الشراء غير موجود.');
  const result = await openAppFormDialog({ title: `استلام ${order.order_number}`, subtitle: `الإجمالي ${Number(order.total).toFixed(2)} ج.م؛ سيُنشأ سجل فاتورة شراء ويُحدّث المخزون.`, fields: [{ label: 'المبلغ المدفوع للمورد', type: 'number', value: 0 }], submitLabel: 'استلام الأصناف' });
  if (!result) return;
  try {
    const response = await fetch(`/api/purchase-orders/${orderId}/receive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ warehouse_id: Number(document.getElementById('purchase-order-warehouse-select')?.value) || null, paid_amount: Number(result[0]) || 0 }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'تعذر استلام أمر الشراء.');
    await Promise.all([renderPurchaseOrders(), renderPurchases(), renderProducts(), renderPosProducts(), checkLowStockBadge()]);
    showAppToast(`تم استلام الأمر وإنشاء فاتورة PUR-${data.purchase.id}.`);
  } catch (error) { showAppToast(error.message); }
}

function deliveryEsc(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
let deliveryRidersCache = [];
function resetDeliveryRiderForm() {
  document.getElementById('delivery-rider-form')?.reset();
  document.getElementById('delivery-rider-id').value = '';
  document.getElementById('delivery-rider-form-title').textContent = 'إضافة طيار جديد';
  document.getElementById('delivery-rider-save').textContent = 'حفظ بيانات الطيار';
  document.getElementById('delivery-rider-form-status').textContent = '';
}
async function saveDeliveryRider(event) {
  event?.preventDefault();
  const status = document.getElementById('delivery-rider-form-status');
  const id = document.getElementById('delivery-rider-id').value;
  const payload = {
    name: document.getElementById('delivery-rider-name').value.trim(),
    phone: document.getElementById('delivery-rider-phone').value.trim(),
    national_id: document.getElementById('delivery-rider-national-id').value.trim(),
    vehicle_type: document.getElementById('delivery-rider-vehicle').value.trim(),
    plate_number: document.getElementById('delivery-rider-plate').value.trim(),
    notes: document.getElementById('delivery-rider-notes').value.trim(),
    default_delivery_fee: Number(document.getElementById('delivery-rider-default-fee')?.value || 0),
    default_delivery_wage: Number(document.getElementById('delivery-rider-default-wage')?.value || 0)
  };
  if (!payload.name || !payload.phone) { if (status) status.textContent = 'الاسم ورقم الهاتف مطلوبان.'; return; }
  const save = document.getElementById('delivery-rider-save'); if (save) save.disabled = true;
  try {
    const response = await fetch(id ? `/api/delivery/riders/${id}` : '/api/delivery/riders', { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'تعذر حفظ بيانات الطيار.');
    resetDeliveryRiderForm(); if (status) status.textContent = id ? 'تم تحديث ملف الطيار.' : 'تمت إضافة الطيار.';
    await renderDeliveryRiders();
    if (activeTab === 'delivery') await renderDeliveryDesk();
  } catch (error) { if (status) status.textContent = error.message; }
  finally { if (save) save.disabled = false; }
}
async function renderDeliveryRiders() {
  const table = document.getElementById('delivery-riders-table'); if (!table) return;
  const canAddOrEdit = hasPermission('add') || hasPermission('edit');
  const form = document.getElementById('delivery-rider-form'); if (form) form.style.display = canAddOrEdit ? '' : 'none';
  const status = document.getElementById('delivery-riders-list-status');
  if (status) status.textContent = 'جارٍ تحميل ملفات الطيارين…';
  try {
    const [ridersResponse, ordersResponse, settlementsResponse, summaryResponse, profitResponse] = await Promise.all([
      fetch('/api/delivery/riders?include_inactive=1'), fetch('/api/delivery/orders'), fetch('/api/delivery/settlements'), fetch('/api/delivery/riders/summary'), fetch('/api/delivery/profit-summary')
    ]);
    const [riders, orders, settlements, summaries, profit] = await Promise.all([ridersResponse, ordersResponse, settlementsResponse, summaryResponse, profitResponse].map(async response => { const value = await response.json(); if (!response.ok) throw new Error(value.error || 'تعذر تحميل بيانات الطيارين.'); return value; }));
    deliveryRidersCache = Array.isArray(riders) ? riders : [];
    const active = deliveryRidersCache.filter(rider => rider.is_active !== false);
    const activeCount = document.getElementById('delivery-riders-active-count'); if (activeCount) activeCount.textContent = String(active.length);
    const openOrders = (orders || []).filter(row => ['assigned', 'dispatched'].includes(row.status)).length;
    const ordersCount = document.getElementById('delivery-riders-orders-count'); if (ordersCount) ordersCount.textContent = String(openOrders);
    const outstanding = (settlements || []).reduce((sum, row) => sum + Number(row.outstanding || 0), 0);
    const outstandingEl = document.getElementById('delivery-riders-outstanding'); if (outstandingEl) outstandingEl.textContent = `${outstanding.toFixed(2)} ج.م`;
    const customerFeesEl = document.getElementById('delivery-profit-customer-fees'); if (customerFeesEl) customerFeesEl.textContent = `${Number(profit?.customer_delivery_fees || 0).toFixed(2)} ج.م`;
    const riderWagesEl = document.getElementById('delivery-profit-rider-wages'); if (riderWagesEl) riderWagesEl.textContent = `${Number(profit?.rider_wages_due || 0).toFixed(2)} ج.م`;
    const netEl = document.getElementById('delivery-profit-net'); if (netEl) { netEl.textContent = `${Number(profit?.net_delivery_result || 0).toFixed(2)} ج.م`; netEl.classList.toggle('text-rose-900', Number(profit?.net_delivery_result || 0) < 0); }
    const summaryTable = document.getElementById('delivery-riders-summary-table'); if (summaryTable) summaryTable.innerHTML = (summaries || []).map(row => `<tr><td class="p-3"><strong>${deliveryEsc(row.rider_name)}</strong><div class="text-xs text-slate-500" dir="ltr">${deliveryEsc(row.rider_phone || '')}</div></td><td class="p-3">${Number(row.delivered || 0)}</td><td class="p-3">${Number(row.pending || 0)}</td><td class="p-3">${Number(row.returned || 0)}</td><td class="p-3 font-bold text-emerald-800">${Number(row.open_custody || 0).toFixed(2)} ج.م</td><td class="p-3 font-bold ${Number(row.custody_balance || 0) > 0 ? 'text-rose-800' : 'text-slate-700'}">${Number(row.custody_balance || 0).toFixed(2)} ج.م${Number(row.custody_balance || 0) > 0 ? ' — عليه عهدة' : ''}</td><td class="p-3 font-bold text-amber-800">${Number(row.advance_balance || 0).toFixed(2)} ج.م</td><td class="p-3 font-bold text-sky-800">${Number(row.rider_fees_due || 0).toFixed(2)} ج.م</td></tr>`).join('') || '<tr><td colspan="8" class="p-4 text-center text-slate-500">لا توجد بيانات ملخص.</td></tr>';
    table.innerHTML = deliveryRidersCache.map(rider => {
      const isActive = rider.is_active !== false;
      return `<tr data-rider-id="${Number(rider.id)}" data-rider-search="${deliveryEsc([rider.name, rider.phone, rider.national_id].join(' '))}" data-rider-active="${isActive ? '1' : '0'}" class="hover:bg-slate-50">
        <td class="p-3"><strong class="text-slate-900">${deliveryEsc(rider.name)}</strong><a class="block text-xs text-sky-800 hover:underline" dir="ltr" href="tel:${deliveryEsc(rider.phone || '')}">${deliveryEsc(rider.phone || 'بدون رقم')}</a></td>
        <td class="p-3">${deliveryEsc(rider.national_id || '—')}</td><td class="p-3">${deliveryEsc(rider.vehicle_type || '—')}</td><td class="p-3">${deliveryEsc(rider.plate_number || '—')}</td><td class="p-3 max-w-xs whitespace-normal">${deliveryEsc(rider.notes || '—')}</td>
        <td class="p-3"><span class="inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${isActive ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-700'}">${isActive ? 'نشط' : 'معطّل'}</span></td>
        <td class="p-3 whitespace-nowrap">${hasPermission('edit') ? `<button type="button" onclick="editDeliveryRider(${Number(rider.id)})" class="rounded-lg bg-sky-50 px-3 py-1.5 text-xs font-bold text-sky-900 hover:bg-sky-100">تعديل</button> <button type="button" onclick="toggleDeliveryRider(${Number(rider.id)})" class="rounded-lg ${isActive ? 'bg-rose-50 text-rose-800 hover:bg-rose-100' : 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100'} px-3 py-1.5 text-xs font-bold">${isActive ? 'تعطيل' : 'إعادة تفعيل'}</button>` : '<span class="text-xs text-slate-500">عرض فقط</span>'}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="p-8 text-center text-slate-600">لا توجد ملفات طيارين بعد. أضف أول طيار من النموذج أعلاه.</td></tr>';
    filterDeliveryRiders();
    const deskList = document.getElementById('delivery-riders-list'); if (deskList) deskList.textContent = `عدد الطيارين النشطين: ${active.length}. إدارة البيانات من قسم «طيارو التوصيل».`;
    if (status) status.textContent = `عدد الملفات: ${deliveryRidersCache.length} — النشطون: ${active.length}.`;
    const riderSelect = document.getElementById('delivery-transaction-rider');
    if (riderSelect) { const previous = riderSelect.value; riderSelect.innerHTML = active.map(rider => `<option value="${Number(rider.id)}">${deliveryEsc(rider.name)} — ${deliveryEsc(rider.phone || 'بدون هاتف')}</option>`).join(''); if (active.some(rider => String(rider.id) === previous)) riderSelect.value = previous; }
    if (riderSelect?.value) await loadDeliveryRiderTransactions(riderSelect.value);
    if (window.lucide) lucide.createIcons();
  } catch (error) { if (status) status.textContent = error.message; }
}
async function loadDeliveryRiderTransactions(riderId) {
  const host = document.getElementById('delivery-rider-transactions'); if (!host || !riderId) return;
  try { const audit = document.getElementById('delivery-transaction-view')?.value === 'audit'; const response = await fetch(`/api/delivery/riders/${Number(riderId)}/transactions${audit ? '?include_reversals=1' : ''}`); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'تعذر تحميل الحركات.'); const labels = { custody_given: 'عهدة معطاة', custody_return: 'تسليم عهدة', advance: 'سلفة', settlement: 'سداد/خصم سلفة' }; host.innerHTML = (data.transactions || []).map(row => `<div class="flex items-center justify-between gap-2 border-b p-2"><span>${deliveryEsc(row.transaction_date || row.created_at || '')} — ${deliveryEsc(labels[row.type] || row.type)} — ${Number(row.amount || 0).toFixed(2)} ج.م — ${deliveryEsc(row.notes || '')}${row.reversed_by ? ' — ملغاة بقيد عكسي' : ''}${row.reversed_transaction_id ? ' — قيد عكسي' : ''}</span>${hasPermission('edit') && !row.reversed_by && !row.reversed_transaction_id ? `<button type="button" class="rounded-lg border px-2 py-1 font-bold" onclick="reverseDeliveryRiderTransaction(${Number(riderId)},${Number(row.id)})">إلغاء بقيد عكسي</button>` : ''}</div>`).join('') || '<p class="p-3 text-slate-500">لا توجد حركات.</p>'; } catch (error) { host.textContent = error.message; }
}
async function saveDeliveryRiderTransaction(event) {
  event?.preventDefault(); const riderId = Number(document.getElementById('delivery-transaction-rider')?.value); const type = document.getElementById('delivery-transaction-type')?.value; const amount = Number(document.getElementById('delivery-transaction-amount')?.value); if (!riderId || !type || !Number.isFinite(amount) || amount <= 0) return;
  const response = await fetch(`/api/delivery/riders/${riderId}/transactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, amount, notes: document.getElementById('delivery-transaction-notes')?.value || '', transaction_date: document.getElementById('delivery-transaction-date')?.value || null }) }); const data = await response.json(); if (!response.ok) return showAppToast(data.error || 'تعذر حفظ الحركة.'); document.getElementById('delivery-transaction-amount').value = ''; document.getElementById('delivery-transaction-notes').value = ''; await renderDeliveryRiders();
}
async function reverseDeliveryRiderTransaction(riderId, transactionId) {
  if (!await showAppConfirm('سيُنشأ قيد عكسي ولن تُحذف الحركة الأصلية. هل تريد المتابعة؟')) return;
  const response = await fetch(`/api/delivery/riders/${Number(riderId)}/transactions/${Number(transactionId)}/reverse`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: 'إلغاء من شاشة الطيارين' }) }); const data = await response.json(); if (!response.ok) return showAppToast(data.error || 'تعذر إنشاء القيد العكسي.'); await renderDeliveryRiders();
}
function filterDeliveryRiders() {
  const query = normalizeCatalogText(document.getElementById('delivery-rider-search')?.value || '');
  const filter = document.getElementById('delivery-rider-status-filter')?.value || 'active';
  const rows = [...document.querySelectorAll('#delivery-riders-table tr[data-rider-id]')]; let shown = 0;
  rows.forEach(row => {
    const matchesText = !query || normalizeCatalogText(row.dataset.riderSearch).includes(query);
    const active = row.dataset.riderActive === '1';
    const matchesState = filter === 'all' || (filter === 'active' ? active : !active);
    row.hidden = !(matchesText && matchesState); if (!row.hidden) shown++;
  });
  const status = document.getElementById('delivery-riders-list-status');
  if (status && rows.length && !shown) status.textContent = 'لا توجد ملفات مطابقة للبحث والحالة المحددة.';
}
function editDeliveryRider(id) {
  const rider = deliveryRidersCache.find(row => Number(row.id) === Number(id)); if (!rider) return;
  document.getElementById('delivery-rider-id').value = rider.id;
  document.getElementById('delivery-rider-name').value = rider.name || '';
  document.getElementById('delivery-rider-phone').value = rider.phone || '';
  document.getElementById('delivery-rider-national-id').value = rider.national_id || '';
  const vehicle = document.getElementById('delivery-rider-vehicle');
  if (![...vehicle.options].some(option => option.value === (rider.vehicle_type || 'دراجة نارية'))) {
    const option = document.createElement('option'); option.value = rider.vehicle_type; option.textContent = rider.vehicle_type; vehicle.appendChild(option);
  }
  vehicle.value = rider.vehicle_type || 'دراجة نارية';
  document.getElementById('delivery-rider-plate').value = rider.plate_number || '';
  document.getElementById('delivery-rider-notes').value = rider.notes || '';
  document.getElementById('delivery-rider-default-fee').value = Number(rider.default_delivery_fee || 0);
  document.getElementById('delivery-rider-default-wage').value = Number(rider.default_delivery_wage || 0);
  document.getElementById('delivery-rider-form-title').textContent = `تعديل بيانات الطيار: ${rider.name}`;
  document.getElementById('delivery-rider-save').textContent = 'حفظ التعديلات';
  document.getElementById('delivery-rider-form-status').textContent = '';
  document.getElementById('delivery-rider-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('delivery-rider-name').focus();
}
async function toggleDeliveryRider(id) {
  const rider = deliveryRidersCache.find(row => Number(row.id) === Number(id)); if (!rider) return;
  const nextActive = rider.is_active === false;
  if (!await showAppConfirm(nextActive ? `إعادة تفعيل الطيار «${rider.name}»؟` : `تعطيل الطيار «${rider.name}»؟ سيظل سجل الطلبات والعهدة محفوظًا.`)) return;
  try {
    const response = await fetch(`/api/delivery/riders/${rider.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...rider, is_active: nextActive }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'تعذر تغيير حالة ملف الطيار.');
    await renderDeliveryRiders(); if (activeTab === 'delivery') await renderDeliveryDesk();
  } catch (error) { showAppToast(error.message); }
}
async function renderDeliveryDesk() {
  // Intentionally ignored: delivery desk loading already reports the failure
  try {
    const [ridersResponse, ordersResponse, salesResponse, settlementsResponse] = await Promise.all(['/api/delivery/riders', '/api/delivery/orders', '/api/sales', '/api/delivery/settlements'].map(url => fetch(url)));
    const [riders, orders, sales, settlements] = await Promise.all([ridersResponse, ordersResponse, salesResponse, settlementsResponse].map(response => response.json()));
    const riderList = document.getElementById('delivery-riders-list'); if (riderList) riderList.textContent = `عدد الطيارين النشطين: ${riders.length}. إدارة البيانات من قسم «طيارو التوصيل».`;
    const settlementHost = document.getElementById('delivery-settlements-list'); if (settlementHost) settlementHost.innerHTML = settlements.length ? settlements.map(row => `<div class="flex items-center justify-between border rounded-xl p-2"><div><b>${deliveryEsc(row.rider_name)}</b><div class="text-xs text-gray-500">محصل ${Number(row.collected).toFixed(2)} · مورّد ${Number(row.settled).toFixed(2)} · مفتوح ${Number(row.outstanding).toFixed(2)} ج.م</div></div>${row.outstanding > 0 ? `<button onclick="settleDeliveryRider(${row.rider_id},${row.outstanding})" class="bg-emerald-600 text-white rounded-lg px-3 py-1.5">توريد كامل العهدة</button>` : '<span class="text-emerald-700 text-xs">لا توجد عهدة</span>'}</div>`).join('') : '<p class="text-gray-400">أضف طياراً لبدء متابعة العهدة.</p>';
    const host = document.getElementById('delivery-orders-list'); if (!host) return;
    // The API returns newest assignments first; keep the latest one when a
    // cancelled delivery was assigned to a different rider later.
    const linked = new Map();
    for (const row of orders) if (!linked.has(row.sale_id)) linked.set(row.sale_id, row);
    const deliverySales = sales.filter(sale => sale.order_type === 'توصيل');
    host.innerHTML = deliverySales.length ? deliverySales.map(sale => {
      const row = linked.get(sale.id); const due = Math.max(0, Number(sale.total || 0) - Number(sale.paid_amount || 0));
      const status = row ? ({ unassigned: 'غير مُسنَد', assigned: 'مُسنَد', dispatched: 'خرج للتوصيل', delivered: 'تم التسليم', cancelled: 'ملغي' }[row.status] || row.status) : 'بانتظار التعيين';
      const searchText = [sale.id, sale.invoice_number, sale.customer_name, sale.customer_phone, row?.rider?.name, row?.rider?.phone, status].join(' ');
      let action = '';
      if (!row) action = riders.length ? `<select id="delivery-rider-${sale.id}" class="border rounded px-2 py-1">${riders.map(rider => `<option value="${rider.id}">${deliveryEsc(rider.name)}</option>`).join('')}</select><button onclick="assignDeliverySale(${sale.id})" class="bg-blue-600 text-white rounded px-2 py-1">تعيين</button>` : '<span class="text-amber-600">أضف طياراً أولاً</span>';
      else if (row.status === 'unassigned') action = riders.length ? `<select id="delivery-rider-${sale.id}" class="border rounded px-2 py-1">${riders.map(rider => `<option value="${rider.id}">${deliveryEsc(rider.name)}</option>`).join('')}</select><button onclick="assignDeliverySale(${sale.id})" class="bg-blue-600 text-white rounded px-2 py-1">تعيين</button>` : '<span class="text-amber-600">أضف طياراً أولاً</span>';
      else if (row.status === 'assigned') action = `<button onclick="setDeliveryStatus(${row.id},'dispatched',${due})" class="bg-blue-600 text-white rounded px-2 py-1">بدء التوصيل</button> <button onclick="setDeliveryStatus(${row.id},'cancelled',0)" class="text-red-600">إلغاء</button>`;
      else if (row.status === 'dispatched') action = `<button onclick="setDeliveryStatus(${row.id},'delivered',${due})" class="bg-emerald-600 text-white rounded px-2 py-1">تسجيل التسليم</button>`;
      const safeTrackingToken = escapeHtml(row?.tracking_token || '');
      const safeRiderToken = escapeHtml(row?.rider_token || '');
      const links = row?.tracking_token ? `<div class="flex gap-1 mt-1"><button onclick="shareDeliveryLink('track','${safeTrackingToken}')" class="rounded bg-emerald-700 text-white px-1.5 py-1 text-[10px]">تتبع العميل</button><button onclick="shareDeliveryLink('rider','${safeRiderToken}')" class="rounded bg-sky-800 text-white px-1.5 py-1 text-[10px]">رابط الطيار</button></div>` : '';
      return `<tr class="border-b ${status === 'غير مُسنَد' ? 'bg-amber-50 text-amber-950' : ''}" data-delivery-search="${deliveryEsc(searchText)}"><td class="p-2">${deliveryEsc(sale.invoice_number)}<div class="text-gray-500">#${sale.id}</div></td><td class="p-2">${deliveryEsc(sale.customer_name)}<div class="text-gray-500">${deliveryEsc(sale.customer_phone || '')}</div><div class="text-xs text-sky-800">${deliveryEsc(sale.delivery_address || 'بدون عنوان')}</div></td><td class="p-2">${Number(sale.total).toFixed(2)} / ${due.toFixed(2)}</td><td class="p-2 font-bold">${deliveryEsc(row?.rider?.name || 'غير مُسنَد')}</td><td class="p-2">${status}</td><td class="p-2">${row ? `${Number(row.cash_collected || 0).toFixed(2)} / ${Number(row.cash_settled || 0).toFixed(2)}` : '—'}</td><td class="p-2 whitespace-nowrap">${action}${links}</td></tr>`;
    }).join('') : '<tr><td colspan="7" class="p-6 text-center text-gray-400">لا توجد فواتير توصيل بعد.</td></tr>';
    filterDeliveryOrders();
    if (window.lucide) lucide.createIcons();
  } catch (error) { console.error('Delivery desk load failed', error); }
}

async function shareDeliveryLink(kind, token) {
  const path = kind === 'rider' ? `/delivery/rider/${encodeURIComponent(token)}` : `/delivery/track/${encodeURIComponent(token)}`;
  const url = `${location.origin}${path}`; const text = kind === 'rider' ? 'رابط واجهة طلب التوصيل للطيار:' : 'تابع حالة طلب التوصيل:';
  try { if (navigator.share) await navigator.share({ title: 'طلب توصيل', text, url }); else window.open(`https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`, '_blank', 'noopener'); }
  catch (error) { if (error?.name !== 'AbortError') showAppToast('تعذر فتح المشاركة. انسخ الرابط من شريط العنوان بعد فتحه: ' + url); }
}
function filterDeliveryOrders() {
  const query = normalizeCatalogText(document.getElementById('delivery-search-input')?.value || '');
  const rows = [...document.querySelectorAll('#delivery-orders-list tr[data-delivery-search]')];
  const matches = [];
  for (const row of rows) {
    const matched = !query || normalizeCatalogText(row.dataset.deliverySearch).includes(query);
    row.hidden = !matched;
    if (matched && query) matches.push(row);
  }
  const status = document.getElementById('delivery-search-status');
  if (!status) return;
  if (!query) status.textContent = `عدد طلبات التوصيل: ${rows.length}. ابحث برقم الأوردر أو بيانات العميل لمعرفة الطيار المسؤول.`;
  else if (!matches.length) status.textContent = 'لم يتم العثور على أوردر مطابق.';
  else if (matches.length === 1) {
    const row = matches[0];
    status.textContent = `${row.cells[0].innerText.replace(/\s+/g, ' ').trim()} — الطيار المسؤول: ${row.cells[3].innerText.trim()} — الحالة: ${row.cells[4].innerText.trim()}`;
  } else status.textContent = `تم العثور على ${matches.length} طلبات مطابقة؛ يظهر الطيار المسؤول والحالة في كل نتيجة.`;
}
function clearDeliverySearch() {
  const input = document.getElementById('delivery-search-input');
  if (input) input.value = '';
  filterDeliveryOrders();
}
async function assignDeliverySale(saleId) {
  const riderId = Number(document.getElementById(`delivery-rider-${saleId}`)?.value); if (!riderId) return showAppToast('اختر طياراً.');
  try { const response = await fetch(`/api/delivery/orders/${saleId}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rider_id: riderId }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'تعذر تعيين الطلب.'); await renderDeliveryDesk(); } catch (error) { showAppToast(error.message); }
}
async function setDeliveryStatus(id, status, due) {
  let collected = 0;
  if (status === 'delivered') { const answer = await openAppFormDialog({ title: 'تسجيل تسليم الطلب', subtitle: `المبلغ المتبقي على الفاتورة ${Number(due).toFixed(2)} ج.م. أدخل ما استلمه الطيار نقداً.`, fields: [{ label: 'المبلغ المحصل من العميل', type: 'number', value: due }], submitLabel: 'تأكيد التسليم' }); if (!answer) return; collected = Number(answer[0]); }
  else if (status === 'cancelled' && !await showAppConfirm('إلغاء تعيين طلب التوصيل؟')) return;
  try { const response = await fetch(`/api/delivery/orders/${id}/status`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, cash_collected: collected }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'تعذر تحديث الطلب.'); await renderDeliveryDesk(); }
  catch (error) { showAppToast(error.message); }
}
async function settleDeliveryRider(riderId, outstanding) {
  if (!await showAppConfirm(`تسجيل توريد كامل العهدة المفتوحة (${Number(outstanding).toFixed(2)} ج.م)؟`)) return;
  try { const response = await fetch('/api/delivery/settlements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rider_id: riderId, amount: Number(outstanding) }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'تعذر إقفال العهدة.'); await renderDeliveryDesk(); }
  catch (error) { showAppToast(error.message); }
}

async function editPurchasePayment(id, oldPaid) {
  const result = await openAppFormDialog({
    title: 'تعديل المدفوع للمشتريات',
    subtitle: 'عدّل القيمة ثم اضغط حفظ.',
    fields: [{ label: 'المدفوع الجديد (ج.م)', type: 'number', value: oldPaid }],
    submitLabel: 'حفظ التعديل'
  });
  const value = Number(result?.[0]);
  if (!Number.isFinite(value) || value < 0) return;
  try { await storage.updatePurchase(id, value); await renderPurchases(); await renderCustomers(); await refreshDashboard(); } catch (err) { showAppToast(err.message); }
}
async function cancelPurchaseInvoice(id) {
  if (!await showAppConfirm('سيتم إلغاء الفاتورة وإرجاع أثرها على المخزون. هل تريد المتابعة؟')) return;
  try { await storage.deletePurchase(id); await renderPurchases(); await renderProducts(); await renderPosProducts(); await renderCustomers(); await refreshDashboard(); } catch (err) { showAppToast(err.message); }
}

function normalizeInvoiceDigits(value) {
  return String(value || '').replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٬،]/g, ',').replace(/[٫]/g, '.');
}
function parsePurchaseInvoiceLines(text) {
  const rows=[];
  const ignored=/فاتورة|invoice|الإجمالي|اجمالي|المجموع|subtotal|total|ضريبة|tax|خصم|discount|الكمية|quantity|سعر|price|شكرا|thank|رقم ضريبي|هاتف|عنوان|المورد|supplier|التاريخ|date/i;
  let headerHasTotal=false,headerHasUnitPrice=false;
  for(const raw of String(text||'').split(/\r?\n/)){
    const line=normalizeInvoiceDigits(raw).replace(/\s+/g,' ').trim();if(!line)continue;
    if(/[\p{L}]/u.test(line)&&/(?:الكمية|quantity)/i.test(line)&&/(?:الإجمالي|اجمالي|total)/i.test(line)){headerHasTotal=true;headerHasUnitPrice=/(?:سعر|price|unit)/i.test(line);continue;}
    if(line.length<5||ignored.test(line))continue;
    const matches=[...line.matchAll(/\d+(?:[.,]\d{1,3})?/g)];if(matches.length<2)continue;
    const nums=matches.map(m=>Number(m[0].replace(/,/g,''))).filter(Number.isFinite);if(nums.length<2)continue;
    const parts=[];let cursor=0;for(const m of matches){parts.push({text:line.slice(cursor,m.index).trim(),end:m.index,after:m.index+m[0].length});cursor=m.index+m[0].length;}parts.push({text:line.slice(cursor).trim(),end:cursor,after:line.length});
    const namePart=parts.filter(x=>x.text.length>=2&&/[\p{L}]/u.test(x.text)).sort((a,b)=>b.text.length-a.text.length)[0];if(!namePart)continue;
    const name=namePart.text.replace(/^\s*[#№*•.\-\d]+\s*/,'').replace(/[|:;\-]+$/,'').trim();if(name.length<2)continue;
    let qi=matches.findIndex(m=>m.index>=namePart.end);if(qi<0)qi=matches.findIndex(m=>m.index<namePart.end);if(qi<0||qi+1>=nums.length)continue;
    const quantity=nums[qi],amounts=nums.slice(qi+1);if(quantity<=0||quantity>100000||!amounts.length)continue;
    let unitCost;if(amounts.length===1)unitCost=headerHasTotal&&!headerHasUnitPrice?amounts[0]/quantity:amounts[0];else unitCost=headerHasTotal?Math.min(...amounts.slice(0,-1),amounts.at(-1)/quantity):Math.min(...amounts);
    if(!Number.isFinite(unitCost)||unitCost<0||unitCost>100000000)continue;
    rows.push({name,quantity:Math.max(1,Math.round(quantity)),unitCost:Number(unitCost.toFixed(2)),raw:line});
  }
  return rows.slice(0,300);
}
async function readPurchaseInvoiceFile(file) {
  document.getElementById('modal-add-purchase')?.classList.add('purchase-ocr-active');
  const status=document.getElementById('purchase-ocr-status'), review=document.getElementById('purchase-ocr-review'), addButton=document.getElementById('purchase-ocr-add-btn');
  if(!file || !status || !review) return;
  review.classList.add('hidden'); review.innerHTML=''; addButton?.classList.add('hidden');
  if(file.size>25*1024*1024){status.textContent='حجم الفاتورة أكبر من 25 ميجابايت. اختر صورة أصغر أو قسّم ملف PDF.';return;}
  if(typeof Tesseract==='undefined'){status.textContent='تعذر تحميل قارئ النصوص المحلي. أعد تثبيت النسخة المحدثة.';return;}
  if(file.type!=='application/pdf' && !file.type.startsWith('image/')){status.textContent='اختر صورة واضحة أو ملف PDF.';return;}
  status.textContent='جارٍ تجهيز الفاتورة وقراءة النص... قد يستغرق ذلك بعض الوقت في أول مرة.';
  let worker; const recognized=[];
  try {
    worker=await Tesseract.createWorker(['ara','eng'],1,{workerPath:'/assets/vendor/tesseract/worker.min.js',corePath:'/assets/vendor/tesseract/tesseract-core-simd-lstm.js',langPath:'/assets/tessdata',gzip:true,logger:info=>{if(info.status==='recognizing text')status.textContent=`جارٍ قراءة الفاتورة: ${Math.round((info.progress||0)*100)}٪`;}});
    if(file.type==='application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      if(typeof pdfjsLib==='undefined') throw new Error('قارئ ملفات PDF غير متاح في هذه النسخة.');
      pdfjsLib.GlobalWorkerOptions.workerSrc='/assets/vendor/pdfjs/pdf.worker.min.js';
      const pdf=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
      if(pdf.numPages>12) throw new Error('الفاتورة أطول من 12 صفحة؛ ارفع الصفحات المطلوبة في ملفات منفصلة.');
      for(let pageNo=1;pageNo<=pdf.numPages;pageNo++){status.textContent=`قراءة الصفحة ${pageNo} من ${pdf.numPages}...`;const page=await pdf.getPage(pageNo);const viewport=page.getViewport({scale:1.8});const canvas=document.createElement('canvas');canvas.width=viewport.width;canvas.height=viewport.height;await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;const result=await worker.recognize(canvas);recognized.push(result.data.text);canvas.width=canvas.height=0;}
    } else { const result=await worker.recognize(file); recognized.push(result.data.text); }
    const rows=parsePurchaseInvoiceLines(recognized.join('\n'));
    if(!rows.length){status.textContent='لم أجد سطور أصناف واضحة. جرّب صورة مستقيمة عالية الدقة أو راجع إدخال الأصناف يدويًا.';return;}
    window.purchaseOcrRows=rows; await renderPurchaseOcrReview(rows);
    status.textContent=`تم استخراج ${rows.length} سطرًا. راجع اسم الصنف والكمية وسعر الشراء ثم أضف المطابق فقط.`;
    review.classList.remove('hidden'); addButton?.classList.remove('hidden');
  } catch(error) { status.textContent=`تعذرت قراءة الفاتورة: ${error?.message||'خطأ غير معروف'}`; }
  // Intentionally ignored: invoice OCR failure is shown in the status field
  finally { if(worker){try{await worker.terminate();}catch(_){}} }
}
function openPurchaseInvoiceCapture() {
  document.getElementById('modal-add-purchase')?.classList.add('purchase-ocr-active');
  document.getElementById('purchase-invoice-ocr-file')?.click();
}
async function renderPurchaseOcrReview(rows) {
  const review=document.getElementById('purchase-ocr-review'); if(!review) return;
  const products=await storage.getProducts();
  const options='<option value="">اختر الصنف المطابق</option>'+products.map(p=>`<option value="${p.id}">${escapeHtml(p.name||'')} — ${escapeHtml(p.barcode||'بدون باركود')}</option>`).join('');
  review.innerHTML=`<table><thead><tr><th>الصنف المقروء (قابل للتعديل)</th><th>الكمية</th><th>سعر الشراء</th><th>مطابقة الصنف المسجل</th></tr></thead><tbody>${rows.map((row,i)=>{const key=normalizeCatalogText(row.name);const match=products.find(p=>normalizeCatalogText(p.name)===key || (p.barcode&&String(p.barcode)===key));return `<tr class="${match?'':'purchase-ocr-row-unmatched'}"><td><input data-ocr-name="${i}" value="${escapeHtml(row.name)}" aria-label="اسم الصنف المقروء"></td><td><input data-ocr-qty="${i}" type="number" min="1" step="1" value="${row.quantity}" aria-label="الكمية المقروءة"></td><td><input data-ocr-cost="${i}" type="number" min="0" step="0.01" value="${row.unitCost}" aria-label="سعر الشراء المقروء"></td><td><select data-ocr-product="${i}" aria-label="الصنف المطابق">${options}</select></td></tr>`;}).join('')}</tbody></table>`;
  rows.forEach((row,i)=>{const key=normalizeCatalogText(row.name);const match=products.find(p=>normalizeCatalogText(p.name)===key || (p.barcode&&String(p.barcode)===key));const select=review.querySelector(`[data-ocr-product="${i}"]`);if(match&&select)select.value=String(match.id);});
}
async function addReviewedOcrPurchaseRows() {
  const review=document.getElementById('purchase-ocr-review'); if(!review)return;
  const rows=window.purchaseOcrRows||[], products=await storage.getProducts(); let added=0, skipped=0;
  rows.forEach((row,i)=>{const productId=Number(review.querySelector(`[data-ocr-product="${i}"]`)?.value);const quantity=Number(review.querySelector(`[data-ocr-qty="${i}"]`)?.value);const cost=Number(review.querySelector(`[data-ocr-cost="${i}"]`)?.value);const product=products.find(p=>Number(p.id)===productId);if(!product||!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(cost)||cost<0){skipped++;return;}currentPurchaseItems.push({product_id:product.id,product_name:product.name,item_number:product.item_number??'',quantity:Math.round(quantity),unit_cost:cost,lot_number:'',production_date:'',expiry_date:'',total:Math.round(quantity)*cost});added++;});
  renderPurchaseRows();
  const status=document.getElementById('purchase-ocr-status');if(status)status.textContent=`أُضيف ${added} صنفًا للمسودة. ${skipped?`تم تجاوز ${skipped} سطرًا لعدم اختيار صنف مسجل أو لعدم صحة الأرقام.`:''} لم يتغير المخزون بعد؛ يتم التحديث بعد تسجيل فاتورة الشراء.`;
}

let purchaseBarcodeCamera=null,purchaseBarcodeScanHandled=false;
async function startPurchaseBarcodeCamera(){
 const container=document.getElementById('purchase-barcode-camera'),status=document.getElementById('purchase-barcode-camera-status');if(!container||!status)return;
 if(typeof Html5Qrcode==='undefined'){status.textContent='تعذر تحميل قارئ الباركود المرفق.';return;}
 await stopPurchaseBarcodeCamera();try{purchaseBarcodeScanHandled=false;container.classList.remove('hidden');status.textContent='وجّه الكاميرا نحو باركود الصنف الموجود في النظام.';purchaseBarcodeCamera=new Html5Qrcode('purchase-barcode-camera');
 await startQrCameraWithFallback(purchaseBarcodeCamera,{fps:10,qrbox:{width:250,height:140},aspectRatio:1.777},async decoded=>{if(purchaseBarcodeScanHandled)return;purchaseBarcodeScanHandled=true;const barcode=String(decoded||'').trim();await stopPurchaseBarcodeCamera();const products=await storage.getProducts(),product=products.find(item=>String(item.barcode||'').trim()===barcode);if(!product){status.textContent=`لا يوجد صنف مسجل بالباركود ${barcode}. لم يُنشأ صنف جديد.`;return;}const quantity=Math.max(1,Number.parseInt(document.getElementById('purchase-item-qty')?.value,10)||1),costInput=document.getElementById('purchase-item-cost'),cost=Number(costInput?.value||product.cost_price||product.purchase_price||0);currentPurchaseItems.push({product_id:product.id,product_name:product.name,item_number:product.item_number??'',quantity,unit_cost:cost,lot_number:'',production_date:'',expiry_date:'',total:quantity*cost});renderPurchaseRows();status.textContent=`تمت إضافة ${product.name} للفاتورة.`},()=>{});
 }catch(error){await stopPurchaseBarcodeCamera();status.textContent=`تعذر تشغيل الكاميرا: ${error?.message||'تحقق من إذن الكاميرا.'}`;}}
  // Intentionally ignored: stopping an inactive camera is best-effort
  // Intentionally ignored: clearing the camera is best-effort
async function stopPurchaseBarcodeCamera(){const camera=purchaseBarcodeCamera;purchaseBarcodeCamera=null;if(camera){try{if(camera.isScanning)await camera.stop()}catch(_){}try{camera.clear()}catch(_){}}document.getElementById('purchase-barcode-camera')?.classList.add('hidden');}

async function populatePurchaseCategoryFilter(selectedId = null) {
  const select = document.getElementById('purchase-item-category-filter');
  if (!select) return [];
  try {
    const response = await fetch('/api/categories');
    const categories = await response.json();
    if (!response.ok) throw new Error(categories.error || 'تعذر تحميل الفئات.');
    const previous = selectedId == null ? select.value : String(selectedId);
    select.innerHTML = '<option value="">كل الفئات</option>' + categories.map(category => `<option value="${Number(category.id)}">${escapeHtml(category.name)}</option>`).join('');
    select.value = [...select.options].some(option => option.value === previous) ? previous : '';
    return categories;
  } catch (error) {
    const status = document.getElementById('purchase-form-status');
    if (status) status.textContent = error.message;
    return [];
  }
}

async function openPurchaseQuickCategory() {
  const result = await openAppFormDialog({
    title: 'إضافة فئة سريعة',
    subtitle: 'ستظل أصناف ومسودة فاتورة الشراء الحالية كما هي.',
    fields: [{ label: 'اسم الفئة', placeholder: 'اسم الفئة' }],
    submitLabel: 'حفظ الفئة'
  });
  const name = String(result?.[0] || '').trim();
  if (!name) return;
  try {
    const response = await fetch('/api/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const category = await response.json();
    if (!response.ok) throw new Error(category.error || 'تعذر حفظ الفئة.');
    await populatePurchaseCategoryFilter();
    const categoryFilter = document.getElementById('purchase-item-category-filter');
    if (categoryFilter && ![...categoryFilter.options].some(option => option.value === String(category.id))) {
      categoryFilter.add(new Option(category.name, String(category.id)));
    }
    if (categoryFilter) categoryFilter.value = String(category.id);
    await searchPurchaseProducts(document.getElementById('purchase-product-search')?.value || '');
    document.getElementById('purchase-product-search')?.focus({ preventScroll: true });
  } catch (error) { showAppToast(error.message); }
}

async function openPurchaseQuickProduct(initialName = '') {
  let categories = await populatePurchaseCategoryFilter();
  if (!categories.length) {
    await openPurchaseQuickCategory();
    categories = await populatePurchaseCategoryFilter();
  }
  if (!categories.length) return showAppToast('أضف فئة أولاً أو تحقق من اتصال النظام.');
  const selectedCategory = document.getElementById('purchase-item-category-filter')?.value || categories[0].id;
  const result = await openAppFormDialog({
    title: 'إضافة صنف سريع إلى المخزون',
    subtitle: 'لن تتغير أصناف الفاتورة الحالية. سيُحدد الصنف الجديد في سطر الإضافة.',
    fields: [
      { label: 'اسم الصنف', value: String(initialName || '').trim(), placeholder: 'اسم الصنف' },
      { label: 'الفئة', type: 'select', value: selectedCategory, options: categories.map(category => ({ value: category.id, label: category.name })) },
      { label: 'الباركود (اختياري)', placeholder: 'امسح الباركود أو اتركه فارغاً' },
      { label: 'سعر الشراء المبدئي', type: 'number', value: document.getElementById('purchase-item-cost')?.value || 0, min: 0, step: '0.01' },
      { label: 'سعر البيع المبدئي', type: 'number', value: 0, min: 0, step: '0.01' },
      { label: 'الوحدة', value: 'قطعة', placeholder: 'قطعة' }
    ],
    submitLabel: 'حفظ وتحديد الصنف'
  });
  if (!result) return;
  const [name, categoryId, barcode, costValue, saleValue, unitValue] = result;
  const nameValue = String(name || '').trim();
  const cost = Number(costValue), sale = Number(saleValue);
  if (!nameValue || !Number.isFinite(cost) || cost < 0 || !Number.isFinite(sale) || sale < 0) return showAppToast('أدخل اسماً وسعراً صحيحين للصنف.');
  try {
    const response = await fetch('/api/products', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nameValue, category_id: Number(categoryId), barcode: String(barcode || '').trim(), cost_price: cost, sale_price: sale, quantity: 0, min_stock: 0, unit: String(unitValue || 'قطعة').trim() || 'قطعة' })
    });
    const product = await response.json();
    if (!response.ok) throw new Error(product.error || 'تعذر حفظ الصنف.');
    await populatePurchaseCategoryFilter(product.category_id);
    const search = document.getElementById('purchase-product-search');
    if (search) search.value = product.name;
    await searchPurchaseProducts(product.name);
    let index = purchaseSearchResults.findIndex(row => Number(row.id) === Number(product.id));
    if (index < 0) { purchaseSearchResults.unshift(product); index = 0; }
    selectPurchaseSearchProduct(index);
    const costInput = document.getElementById('purchase-item-cost');
    if (costInput) costInput.value = String(product.cost_price ?? cost);
    document.getElementById('purchase-form-status')?.replaceChildren();
  } catch (error) { showAppToast(error.message); }
}

async function addPurchaseRow() {
  const prodSel = document.getElementById('purchase-item-prod');
  const qtyInput = document.getElementById('purchase-item-qty');
  const costInput = document.getElementById('purchase-item-cost');

  let prodId = parseInt(prodSel.value);
  if (!Number.isInteger(prodId) && purchaseSearchResults.length === 1) {
    selectPurchaseSearchProduct(0);
    prodId = Number(prodSel.value);
  }
  if (!Number.isInteger(prodId)) {
    showAppToast('اكتب اسم الصنف أو اختره من نتائج البحث. وإذا كان جديدًا اضغط «الصنف جديد؟».');
    document.getElementById('purchase-product-search')?.focus();
    return;
  }
  const qty = Number(qtyInput.value);
  const cost = Number(costInput.value);
  if (!Number.isInteger(qty) || qty <= 0) { showAppToast('الكمية يجب أن تكون أكبر من صفر.'); qtyInput.focus(); return; }
  if (costInput.value.trim() === '' || !Number.isFinite(cost) || cost < 0) { showAppToast('أدخل سعر شراء صحيحاً.'); costInput.focus(); return; }
  const productionDate = document.getElementById('purchase-item-production-date')?.value || '';
  const expiryDate = document.getElementById('purchase-item-expiry-date')?.value || '';
  const lotNumber = document.getElementById('purchase-item-lot')?.value.trim() || '';
  if (productionDate && expiryDate && productionDate > expiryDate) {
    showAppToast('تاريخ الإنتاج لا يمكن أن يكون بعد تاريخ الانتهاء.');
    return;
  }

  const products = await storage.getProducts();
  const prod = products.find(p => p.id === prodId);

  currentPurchaseItems.push({
    product_id: prodId,
    product_name: prod ? prod.name : 'منتج',
    item_number: prod?.item_number ?? '',
    quantity: qty,
    unit_cost: cost,
    lot_number: lotNumber,
    production_date: productionDate,
    expiry_date: expiryDate,
    total: qty * cost
  });

  document.getElementById('purchase-item-production-date').value = '';
  document.getElementById('purchase-item-expiry-date').value = '';
  document.getElementById('purchase-item-lot').value = '';
  qtyInput.value = '1';
  costInput.value = '';
  prodSel.value = '';
  const search = document.getElementById('purchase-product-search'); if (search) { search.value = ''; search.focus(); }
  document.getElementById('purchase-form-status')?.replaceChildren();
  renderPurchaseRows();
}

function renderPurchaseProductOptions(products, placeholder = 'اختر الصنف الذي اشتريته من المورد') {
  const select = document.getElementById('purchase-item-prod');
  if (!select) return;
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` + products.map(product => `<option value="${Number(product.id)}">${escapeHtml(product.name || '')}${product.barcode ? ` — ${escapeHtml(product.barcode)}` : ''}</option>`).join('');
}

async function searchPurchaseProducts(query) {
  const resultsEl = document.getElementById('purchase-product-results');
  const selectedEl = document.getElementById('purchase-item-prod');
  const normalized = normalizeCatalogText(query);
  if (selectedEl) selectedEl.value = '';
  if (!resultsEl) return;
  const categoryId = Number(document.getElementById('purchase-item-category-filter')?.value || 0);
  if (!normalized && !categoryId) {
    const products = await storage.getProducts();
    purchaseSearchResults = products.slice(0, 200);
    renderPurchaseProductOptions(purchaseSearchResults);
    resultsEl.classList.add('hidden');
    resultsEl.innerHTML = '';
    return;
  }

  const products = await storage.getProducts();
  purchaseSearchResults = products.filter(product => (!normalized || productMatchesSearch(product, normalized)) && (!categoryId || Number(product.category_id) === categoryId)).slice(0, 30);
  renderPurchaseProductOptions(purchaseSearchResults, purchaseSearchResults.length ? 'اختر الصنف المطابق من النتائج' : 'لا توجد أصناف مطابقة');
  resultsEl.innerHTML = '';
  if (!purchaseSearchResults.length) {
    resultsEl.innerHTML = '<div class="px-3 py-2 text-gray-500">لا توجد أصناف مطابقة</div>';
  } else {
    purchaseSearchResults.forEach((product, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'option');
      button.className = 'block w-full border-b border-gray-100 px-3 py-2 text-right hover:bg-pink-50';
      button.innerHTML = `<span class="block font-bold text-gray-800">${escapeHtml(product.name || '')}</span><span class="text-[10px] text-gray-500">${escapeHtml(product.barcode || 'بدون باركود')} · رصيد ${Number(product.quantity) || 0}</span>`;
      button.addEventListener('click', () => selectPurchaseSearchProduct(index));
      resultsEl.appendChild(button);
    });
  }
  resultsEl.classList.remove('hidden');
}

function selectPurchaseSearchProduct(index) {
  const product = purchaseSearchResults[index];
  if (!product) return;
  const select = document.getElementById('purchase-item-prod');
  const input = document.getElementById('purchase-product-search');
  const results = document.getElementById('purchase-product-results');
  if (select) select.value = String(product.id);
  if (input) input.value = `${product.name}${product.barcode ? ` — ${product.barcode}` : ''}`;
  if (results) results.classList.add('hidden');
  const costInput = document.getElementById('purchase-item-cost');
  if (costInput && String(costInput.value || '').trim() === '') costInput.value = String(product.cost_price ?? product.purchase_price ?? 0);
  document.getElementById('purchase-item-qty')?.focus();
}

function handlePurchaseEntryKeydown(event, field) {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  if (field === 'quantity') { document.getElementById('purchase-item-cost')?.focus(); return; }
  if (field === 'cost') void addPurchaseRow();
}

function handlePurchaseSearchKeydown(event) {
  if (event.key === 'Escape') {
    document.getElementById('purchase-product-results')?.classList.add('hidden');
    return;
  }
  if (event.key === 'Enter') {
    const input = event.currentTarget;
    const exact = purchaseSearchResults.findIndex(product => String(product.barcode || '') === input.value.trim());
    if (exact >= 0) {
      event.preventDefault();
      selectPurchaseSearchProduct(exact);
    } else if (purchaseSearchResults.length === 1) {
      event.preventDefault();
      selectPurchaseSearchProduct(0);
    }
  }
}

function renderPurchaseRows() {
  const tbody = document.getElementById('purchase-items-table-body');
  const totalEl = document.getElementById('purchase-grand-total');
  if (!tbody) return;
  const optionalOpen = document.querySelector('#modal-add-purchase .purchase-optional-toggle')?.getAttribute('aria-expanded') !== 'false';

  tbody.innerHTML = '';
  const countEl = document.getElementById('purchase-items-count');
  if (countEl) countEl.textContent = `${currentPurchaseItems.length} صنف${currentPurchaseItems.length === 1 ? '' : 'ًا'}`;
  if (!currentPurchaseItems.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="purchase-empty-items">لم تتم إضافة أصناف بعد. اكتب اسم الصنف بالأعلى ثم اضغط «إضافة».</td></tr>';
  }
  let grand = 0;
  currentPurchaseItems.forEach((it, idx) => {
    grand += it.total;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="p-2"><div class="purchase-row-product">${escapeHtml(it.product_name)}</div><small>${escapeHtml(it.item_number || '')}</small></td>
      <td class="p-2"><input type="number" min="1" step="1" value="${Number(it.quantity) || 1}" onchange="updatePurchaseItemField(${idx},'quantity',this.value)" aria-label="كمية الصنف"></td>
      <td class="p-2"><input type="number" min="0" step="0.01" value="${Number(it.unit_cost || 0).toFixed(2)}" onchange="updatePurchaseItemField(${idx},'unit_cost',this.value)" aria-label="سعر شراء الصنف"></td>
      <td class="p-2 purchase-optional-cell${optionalOpen ? '' : ' hidden'}"><input type="date" value="${escapeHtml(it.production_date || '')}" onchange="updatePurchaseItemField(${idx},'production_date',this.value)" aria-label="تاريخ الإنتاج"></td>
      <td class="p-2 purchase-optional-cell${optionalOpen ? '' : ' hidden'}"><input type="date" value="${escapeHtml(it.expiry_date || '')}" onchange="updatePurchaseItemField(${idx},'expiry_date',this.value)" aria-label="تاريخ الانتهاء"><small class="purchase-expiry-hint">${it.expiry_date ? 'راجع الصلاحية' : ''}</small></td>
      <td class="p-2 purchase-optional-cell${optionalOpen ? '' : ' hidden'}"><input type="text" value="${escapeHtml(it.lot_number || '')}" maxlength="80" onchange="updatePurchaseItemField(${idx},'lot_number',this.value)" aria-label="رقم التشغيلة" placeholder="LOT-01"></td>
      <td class="p-2 font-bold purchase-row-total">${it.total.toFixed(2)}</td>
      <td class="p-2 text-center">
        <button type="button" onclick="removePurchaseRow(${idx})" class="text-red-500">&times;</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (totalEl) totalEl.textContent = `${grand.toFixed(2)} ج.م`;
  updatePurchaseRemaining(grand);
}

function updatePurchaseItemField(index, field, value) {
  const item = currentPurchaseItems[index];
  if (!item) return;
  if (field === 'quantity') item.quantity = Math.max(1, Number.parseInt(value, 10) || 1);
  else if (field === 'unit_cost') item.unit_cost = Math.max(0, Number(value) || 0);
  else item[field] = String(value || '').trim();
  if (item.production_date && item.expiry_date && item.production_date > item.expiry_date) showAppToast('تاريخ الإنتاج لا يمكن أن يكون بعد تاريخ الانتهاء.');
  item.total = item.quantity * item.unit_cost;
  const row = document.querySelectorAll('#purchase-items-table-body tr')[index];
  const total = row?.querySelector('.purchase-row-total');
  if (total) total.textContent = item.total.toFixed(2);
  const grand = currentPurchaseItems.reduce((sum, entry) => sum + Number(entry.total || 0), 0);
  const totalEl = document.getElementById('purchase-grand-total');
  if (totalEl) totalEl.textContent = `${grand.toFixed(2)} ج.م`;
  updatePurchaseRemaining(grand);
}

function togglePurchaseOptionalFields() {
  const button = document.querySelector('.purchase-optional-toggle');
  const open = button?.getAttribute('aria-expanded') !== 'true';
  button?.setAttribute('aria-expanded', String(open));
  button?.classList.toggle('is-open', open);
  if (button) button.innerHTML = open
    ? '<i class="fa-solid fa-eye-slash"></i> إخفاء التفاصيل الإضافية'
    : '<i class="fa-solid fa-eye"></i> عرض التفاصيل الإضافية';
  document.querySelectorAll('#modal-add-purchase .purchase-optional-column').forEach(element => element.classList.toggle('hidden', !open));
  document.querySelectorAll('#modal-add-purchase #purchase-items-table-body .purchase-optional-cell').forEach(element => element.classList.toggle('hidden', !open));
}

function updatePurchaseRemaining(totalOverride = null) {
  const total = totalOverride == null
    ? currentPurchaseItems.reduce((sum, item) => sum + Number(item.total || 0), 0)
    : Number(totalOverride || 0);
  const paid = Number(document.getElementById('purchase-paid-amount')?.value || 0);
  const remaining = Math.max(0, total - paid);
  const target = document.getElementById('purchase-remaining-amount');
  if (target) target.textContent = `${remaining.toFixed(2)} ج.م`;
  return remaining;
}

function removePurchaseRow(index) {
  currentPurchaseItems.splice(index, 1);
  renderPurchaseRows();
}

async function handlePurchaseSubmit(e) {
  e.preventDefault();
  const status = document.getElementById('purchase-form-status');
  const supplierSelect = document.getElementById('purchase-supp-select');
  const suppId = Number(supplierSelect?.value);
  if (!Number.isInteger(suppId) || suppId <= 0) {
    if (status) status.textContent = 'اختر المورد.';
    supplierSelect?.focus();
    return;
  }
  if (currentPurchaseItems.length === 0) {
    if (status) status.textContent = 'أضف صنفاً واحداً على الأقل.';
    document.getElementById('purchase-product-search')?.focus();
    return;
  }
  if (status) status.textContent = '';
  const paidAmount = Number(document.getElementById('purchase-paid-amount')?.value || 0);
  const purchaseBranchId = Number(document.getElementById('purchase-branch-select')?.value || localStorage.getItem(ACTIVE_BRANCH_KEY));
  try {
    await storage.savePurchase({
      supplier_id: suppId,
      branch_id: purchaseBranchId,
      warehouse_id: Number(document.getElementById('purchase-warehouse-select')?.value) || null,
      items: currentPurchaseItems,
      paid_amount: paidAmount,
      user_id: currentUser.id
    }, purchaseBranchId);
  } catch (error) {
    const message = error?.message || 'تعذر حفظ فاتورة الشراء.';
    if (status) status.textContent = message;
    showAppToast(message);
    return;
  }

  currentPurchaseItems = [];
  document.getElementById('purchase-paid-amount').value = '0';
  closeModal('modal-add-purchase');
  await renderPurchases();
  await renderProducts();
  await renderPosProducts();
  await checkLowStockBadge();
  showAppToast('تم تسجيل فاتورة الشراء وتحديث المخزون بنجاح!');
}

// ----------------------------------------------------
// Sales History
// ----------------------------------------------------
const serviceOrderStatusLabels = { received: 'مستلم', in_progress: 'قيد التنفيذ', ready: 'جاهز للتسليم', delivered: 'تم التسليم' };
async function renderServiceOrders() {
  const body = document.getElementById('service-orders-body');
  const select = document.getElementById('service-order-customer');
  const status = document.getElementById('service-order-status');
  if (!body) return;
  try {
    const [ordersResponse, customersResponse] = await Promise.all([fetch('/api/service-orders'), fetch('/api/customers')]);
    const [orders, customers] = await Promise.all([ordersResponse.json(), customersResponse.json()]);
    if (!ordersResponse.ok || !customersResponse.ok) throw new Error(orders.error || customers.error || 'تعذر تحميل أوامر الشغل.');
    if (select) {
      const selected = select.value || '1';
      select.innerHTML = '<option value="1">عميل نقدي</option>' + customers.filter(customer => Number(customer.id) > 1).map(customer => `<option value="${Number(customer.id)}">${escapeHtml(customer.name)} — ${escapeHtml(customer.phone || '')}</option>`).join('');
      select.value = [...select.options].some(option => option.value === selected) ? selected : '1';
    }
    body.innerHTML = orders.map(order => `<tr>
      <td class="p-3 font-bold">${escapeHtml(order.order_number)}</td>
      <td class="p-3">${escapeHtml(order.customer_name)}<br><span dir="ltr">${escapeHtml(order.customer_phone || '—')}</span></td>
      <td class="p-3"><b>${escapeHtml(order.type)}</b><br>${escapeHtml(order.description)}</td>
      <td class="p-3">${escapeHtml(order.due_date || '—')}</td>
      <td class="p-3 font-bold">${Number(order.total).toFixed(2)}</td>
      <td class="p-3">${Number(order.paid_amount).toFixed(2)} / ${Number(order.remaining_amount).toFixed(2)}</td>
      <td class="p-3"><select aria-label="حالة أمر الشغل" ${hasPermission('edit') ? '' : 'disabled'} onchange="updateServiceOrderStatus(${Number(order.id)},this.value)" class="rounded border p-1">${Object.entries(serviceOrderStatusLabels).map(([key,label]) => `<option value="${key}" ${order.status === key ? 'selected' : ''}>${label}</option>`).join('')}</select>${Number(order.remaining_amount) > 0 && hasPermission('add') ? `<button type="button" onclick="collectServiceOrderPayment(${Number(order.id)})" class="block mt-1 rounded bg-emerald-700 px-2 py-1 text-white">تحصيل</button>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="p-5 text-center text-gray-500">لا توجد أوامر شغل.</td></tr>';
    if (status) status.textContent = `عدد الأوامر: ${orders.length}`;
  } catch (error) { if (status) status.textContent = error.message; }
}

async function renderInstallments() {
  const body = document.getElementById('installments-body');
  const select = document.getElementById('installment-sale-select');
  const status = document.getElementById('installment-status');
  if (!body) return;
  try {
    const [contractResponse, salesResponse] = await Promise.all([fetch('/api/installments'), fetch('/api/sales')]);
    const [contracts, sales] = await Promise.all([contractResponse.json(), salesResponse.json()]);
    if (!contractResponse.ok || !salesResponse.ok) throw new Error('تعذر تحميل عقود التقسيط أو الفواتير.');
    const contracted = new Set(contracts.map(contract => Number(contract.sale_id)));
    if (select) {
      const selected = select.value;
      const candidates = sales.filter(sale => Number(sale.customer_id) > 1 && sale.status !== 'returned' && Number(sale.total) - Math.min(Number(sale.total), Number(sale.paid_amount || 0)) - Number(sale.additional_paid_amount || 0) > 0.009 && !contracted.has(Number(sale.id)));
      select.innerHTML = '<option value="">اختر فاتورة عليها رصيد</option>' + candidates.map(sale => `<option value="${Number(sale.id)}">${escapeHtml(sale.invoice_number)} — ${escapeHtml(sale.customer_name || '')} — باقي ${(Number(sale.total) - Math.min(Number(sale.total), Number(sale.paid_amount || 0)) - Number(sale.additional_paid_amount || 0)).toFixed(2)} ج.م</option>`).join('');
      if (candidates.some(sale => String(sale.id) === selected)) select.value = selected;
    }
    body.innerHTML = contracts.map(contract => {
      const schedule = (contract.schedule || []).map(item => `<div class="flex items-center justify-between gap-2 border-b py-1"><span>${escapeHtml(item.due_date)} — ${Number(item.amount).toFixed(2)} (مدفوع ${Number(item.paid_amount).toFixed(2)})</span>${item.status !== 'paid' && hasPermission('add') ? `<button type="button" onclick="payInstallment(${Number(contract.id)},${Number(item.id)},${Number(item.amount) - Number(item.paid_amount)})" class="rounded bg-emerald-700 px-2 py-1 text-white">تحصيل</button>` : ''}</div>`).join('');
      const contractStatus = contract.status === 'completed' ? 'مكتمل' : contract.status === 'settled_by_return' ? 'تمت التسوية بمرتجع' : 'نشط';
      return `<tr><td class="p-3 font-bold">${escapeHtml(contract.contract_number)}<br>${escapeHtml(contract.invoice_number)}</td><td class="p-3">${escapeHtml(contract.customer_name)}</td><td class="p-3">${Number(contract.total).toFixed(2)} / ${Number(contract.paid_amount).toFixed(2)} / ${Number(contract.remaining_amount).toFixed(2)} ج.م</td><td class="p-3 min-w-64">${schedule}</td><td class="p-3">${contractStatus}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="p-5 text-center text-gray-500">لا توجد عقود تقسيط.</td></tr>';
    if (status) status.textContent = `العقود: ${contracts.length} — الفواتير المؤهلة: ${select?.options.length - 1 || 0}`;
  } catch (error) { if (status) status.textContent = error.message; }
}

async function renderPromotions() {
  const body = document.getElementById('promotions-body');
  const status = document.getElementById('promotion-status');
  if (!body) return;
  try {
    const [promotionsResponse, productsResponse, categoriesResponse] = await Promise.all([fetch('/api/promotions'), fetch('/api/products'), fetch('/api/categories')]);
    const [promotions, products, categories] = await Promise.all([promotionsResponse.json(), productsResponse.json(), categoriesResponse.json()]);
    if (![promotionsResponse, productsResponse, categoriesResponse].every(response => response.ok)) throw new Error('تعذر تحميل العروض أو بيانات الأصناف.');
    const productSelect = document.getElementById('promotion-product');
    const categorySelect = document.getElementById('promotion-category');
    if (productSelect) productSelect.innerHTML = '<option value="">كل الأصناف</option>' + products.map(product => `<option value="${Number(product.id)}">${escapeHtml(product.name)}</option>`).join('');
    if (categorySelect) categorySelect.innerHTML = '<option value="">كل الفئات</option>' + categories.map(category => `<option value="${Number(category.id)}">${escapeHtml(category.name)}</option>`).join('');
    body.innerHTML = promotions.map(promotion => {
      const scope = promotion.product_id ? products.find(product => product.id === Number(promotion.product_id))?.name || 'صنف' : promotion.category_id ? categories.find(category => category.id === Number(promotion.category_id))?.name || 'فئة' : 'كل الأصناف';
      const offer = promotion.type === 'bundle' ? `اشترِ ${Number(promotion.buy_quantity)} واحصل على ${Number(promotion.get_quantity)} مجاناً` : promotion.type === 'percent' ? `${Number(promotion.value)}%` : `${Number(promotion.value).toFixed(2)} ج.م/وحدة`;
      const time = promotion.start_time || promotion.end_time ? ` · ${promotion.start_time || '00:00'}–${promotion.end_time || '23:59'}` : '';
      return `<tr><td class="p-3 font-bold">${escapeHtml(promotion.name)}</td><td class="p-3">${escapeHtml(offer)}</td><td class="p-3">${escapeHtml(scope)}</td><td class="p-3">${escapeHtml(promotion.start_date || 'بدون بداية')} — ${escapeHtml(promotion.end_date || 'بدون نهاية')}${escapeHtml(time)}</td><td class="p-3">${promotion.is_active ? 'نشط' : 'متوقف'}</td><td class="p-3">${promotion.is_active && hasPermission('delete') ? `<button type="button" onclick="deactivatePromotion(${Number(promotion.id)})" class="rounded bg-red-700 px-2 py-1 text-white">إيقاف</button>` : '—'}</td></tr>`;
    }).join('') || '<tr><td colspan="6" class="p-5 text-center text-gray-500">لا توجد عروض مسجلة.</td></tr>';
    if (status) status.textContent = `العروض: ${promotions.length} — النشطة: ${promotions.filter(promotion => promotion.is_active).length}`;
  } catch (error) { if (status) status.textContent = error.message; }
}

async function createPromotion(event) {
  event?.preventDefault();
  const status = document.getElementById('promotion-status');
  const productId = document.getElementById('promotion-product')?.value || '';
  const categoryId = document.getElementById('promotion-category')?.value || '';
  if (productId && categoryId) { if (status) status.textContent = 'اختر صنفًا أو فئة واحدة فقط.'; return; }
  const payload = { name: document.getElementById('promotion-name')?.value?.trim(), type: document.getElementById('promotion-type')?.value, value: Number(document.getElementById('promotion-value')?.value), buy_quantity: Number(document.getElementById('promotion-buy-quantity')?.value || 0), get_quantity: Number(document.getElementById('promotion-get-quantity')?.value || 0), start_time: document.getElementById('promotion-start-time')?.value || '', end_time: document.getElementById('promotion-end-time')?.value || '', product_id: productId || null, category_id: categoryId || null, start_date: document.getElementById('promotion-start')?.value || '', end_date: document.getElementById('promotion-end')?.value || '' };
  try {
    const response = await fetch('/api/promotions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر إضافة العرض.');
    document.getElementById('promotion-form')?.reset();
    if (status) status.textContent = `تم حفظ العرض ${result.name}.`;
    await renderPromotions();
    await loadActivePromotions();
  } catch (error) { if (status) status.textContent = error.message; }
}

async function deactivatePromotion(id) {
  try {
    const response = await fetch(`/api/promotions/${id}`, { method: 'DELETE' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر إيقاف العرض.');
    await renderPromotions();
    await loadActivePromotions();
  } catch (error) { showAppToast(error.message); }
}

let offerMessageCustomers = [];
let offerMessageLines = [];
let offerMessageTemplate = null;
let offerMessageQueue = [];
let offerMessageQueueIndex = 0;
let currentOfferMessageRecipient = null;

function normalizeOfferPhone(phone, countryCode) {
  let digits = normalizeCatalogText(phone).replace(/\D/g, '');
  const country = normalizeCatalogText(countryCode || '20').replace(/\D/g, '') || '20';
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = country + digits.slice(1);
  else if (!digits.startsWith(country)) digits = country + digits;
  return digits;
}

function getOfferMessageText(customerName = '') {
  const box = document.getElementById('offer-message-text');
  return String(box?.value || '')
    .replaceAll('{اسم العميل}', customerName || 'عميلنا')
    .replaceAll('{العروض}', offerMessageLines.join('\n') || 'لا توجد عروض نشطة حاليًا.');
}

function updateOfferMessageCount() {
  const selected = document.querySelectorAll('#offer-message-customers .offer-recipient:checked').length;
  const total = offerMessageCustomers.length;
  const badge = document.getElementById('offer-message-recipient-count');
  if (badge) badge.textContent = `${selected} محدد — ${total} لديه رقم`;
  const text = document.getElementById('offer-message-text');
  const count = document.getElementById('offer-message-char-count');
  if (count) count.textContent = `${text?.value?.length || 0} / 4000`;
}

function filterOfferCustomers() {
  const query = normalizeCatalogText(document.getElementById('offer-customer-search')?.value || '');
  document.querySelectorAll('#offer-message-customers .offer-customer-row').forEach(row => {
    row.classList.toggle('hidden', query && !normalizeCatalogText(row.dataset.search || '').includes(query));
  });
}

let campaignRecipients = [];
let activeCampaignJobId = '';
const campaignHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function updateCampaignSelection() {
  const useAll = document.getElementById('campaign-use-all')?.checked;
  const checkboxes = [...document.querySelectorAll('#campaign-recipients .campaign-recipient')];
  checkboxes.forEach(checkbox => { checkbox.disabled = Boolean(useAll); });
  const count = document.getElementById('campaign-selected-count');
  if (count) count.textContent = String(useAll ? campaignRecipients.length : checkboxes.filter(checkbox => checkbox.checked).length);
  const selectAll = document.getElementById('campaign-select-all');
  if (selectAll) selectAll.checked = !useAll && checkboxes.length > 0 && checkboxes.every(checkbox => checkbox.checked);
}
function toggleCampaignRecipients(checked) {
  const useAll = document.getElementById('campaign-use-all');
  if (useAll) useAll.checked = false;
  document.querySelectorAll('#campaign-recipients .campaign-recipient').forEach(checkbox => { checkbox.checked = checked; checkbox.disabled = false; });
  updateCampaignSelection();
}
async function refreshCampaignRecipients() {
  const body = document.getElementById('campaign-recipients');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="3" class="p-4 text-center text-gray-500">جارٍ تحميل أرقام العملاء...</td></tr>';
  try {
    const response = await fetch('/api/campaigns/recipients');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر تحميل الأرقام.');
    campaignRecipients = Array.isArray(result.recipients) ? result.recipients : [];
    document.getElementById('campaign-valid-count').textContent = String(result.valid || 0);
    document.getElementById('campaign-invalid-count').textContent = String(result.invalid || 0);
    document.getElementById('campaign-duplicate-count').textContent = String(result.duplicate || 0);
    body.innerHTML = campaignRecipients.length ? campaignRecipients.map(item => `<tr><td class="p-2"><input class="campaign-recipient" type="checkbox" value="${campaignHtml(item.id)}" onchange="updateCampaignSelection()" aria-label="تحديد ${campaignHtml(item.name)}"></td><td class="p-2">${campaignHtml(item.name)}</td><td class="p-2" dir="ltr">${campaignHtml(item.phone)}</td></tr>`).join('') : '<tr><td colspan="3" class="p-4 text-center text-gray-500">لا توجد أرقام مصرية صالحة.</td></tr>';
    updateCampaignSelection();
  } catch (error) {
    campaignRecipients = [];
    body.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-red-700">${campaignHtml(error.message)} — تحقّق من الاتصال ثم حدّث الأرقام.</td></tr>`;
    const status = document.getElementById('campaign-status');
    if (status) status.textContent = error.message;
  }
}
const campaignWhatsappLabels = { offline: 'غير متصل', connecting: 'جارٍ الربط', qr: 'امسح رمز QR للربط', connected: 'متصل', error: 'تعذر الربط' };
async function refreshCampaignWhatsAppStatus() {
  const state = document.getElementById('campaign-whatsapp-state');
  if (!state) return;
  try {
    const response = await fetch('/api/campaigns/whatsapp/status');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر قراءة حالة WhatsApp.');
    state.textContent = campaignWhatsappLabels[result.status] || result.status;
    const qr = document.getElementById('campaign-whatsapp-qr');
    if (qr) { qr.src = result.qr || ''; qr.classList.toggle('hidden', !result.qr); }
    const error = document.getElementById('campaign-whatsapp-error');
    if (error) error.textContent = result.error || '';
  } catch (error) {
    state.textContent = 'غير متاح';
    const message = document.getElementById('campaign-whatsapp-error');
    if (message) message.textContent = `${error.message} البرنامج ما زال متاحاً للعمل.`;
  }
}
async function connectCampaignWhatsApp() {
  const message = document.getElementById('campaign-whatsapp-error');
  if (message) message.textContent = '';
  try {
    const response = await fetch('/api/campaigns/whatsapp/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر ربط WhatsApp.');
    await refreshCampaignWhatsAppStatus();
    if (result.status === 'connecting') {
      const started = Date.now();
      const poll = async () => { await refreshCampaignWhatsAppStatus(); if (Date.now() - started < 120000 && document.getElementById('campaign-whatsapp-state')?.textContent === campaignWhatsappLabels.connecting) setTimeout(poll, 1000); };
      setTimeout(poll, 500);
    }
  } catch (error) { if (message) message.textContent = error.message; }
}
async function clearCampaignWhatsAppSession() {
  if (!await showAppConfirm('هل تريد تسجيل خروج WhatsApp ومسح جلسة الربط المحفوظة؟')) return;
  try {
    const response = await fetch('/api/campaigns/whatsapp/clear-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر مسح الجلسة.');
    await refreshCampaignWhatsAppStatus();
  } catch (error) { const message = document.getElementById('campaign-whatsapp-error'); if (message) message.textContent = error.message; }
}
async function startCustomerCampaign() {
  const message = document.getElementById('campaign-message')?.value?.trim() || '';
  const dryRun = document.getElementById('campaign-dry-run')?.checked !== false;
  const allValid = document.getElementById('campaign-use-all')?.checked === true;
  const recipientIds = allValid ? [] : [...document.querySelectorAll('#campaign-recipients .campaign-recipient:checked')].map(input => Number(input.value));
  const count = allValid ? campaignRecipients.length : recipientIds.length;
  const status = document.getElementById('campaign-status');
  const progress = document.getElementById('campaign-progress');
  if (!message) { if (status) status.textContent = 'اكتب نص الرسالة أولاً.'; return; }
  if (!count) { if (status) status.textContent = 'حدد مستلماً واحداً على الأقل.'; return; }
  if (!await showAppConfirm(`سيتم إرسال الرسالة إلى ${count} عميل. متابعة؟`)) return;
  if (status) status.textContent = dryRun ? 'جارٍ إعداد سجل تجريبي؛ لن تُرسل أي رسالة.' : 'جارٍ بدء الحملة...';
  if (progress) progress.textContent = '';
  try {
    const channel = document.querySelector('input[name="campaign-channel"]:checked')?.value || 'sms';
    const response = await fetch('/api/campaigns/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, channel, dryRun, allValid, recipientIds }) });
    const started = await response.json();
    if (!response.ok) throw new Error(started.error || 'تعذر بدء الحملة.');
    activeCampaignJobId = started.id;
    while (activeCampaignJobId) {
      const poll = await fetch(`/api/campaigns/jobs/${encodeURIComponent(activeCampaignJobId)}`);
      const job = await poll.json();
      if (!poll.ok) throw new Error(job.error || 'تعذر متابعة الحملة.');
      if (progress) {
        const last = job.events?.at(-1);
        progress.textContent = `المخطط تجريبياً: ${job.planned || 0} — تم فعلياً: ${job.sent || 0} — فشل: ${job.failed || 0}${last?.delay_seconds ? ` — الفاصل المسجل: ${last.delay_seconds} ثانية` : ''}`;
      }
      if (job.status !== 'running') {
        if (status) status.textContent = job.dryRun ? `انتهى الاختبار التجريبي: ${job.planned} مخطط، 0 إرسال حقيقي.` : job.stopped ? `أُوقفت الحملة: تم ${job.sent}، فشل ${job.failed}.` : `انتهت الحملة: تم ${job.sent}، فشل ${job.failed}.`;
        activeCampaignJobId = '';
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) { activeCampaignJobId = ''; if (status) status.textContent = error.message; }
}
async function stopCustomerCampaign() {
  if (!activeCampaignJobId) { const status = document.getElementById('campaign-status'); if (status) status.textContent = 'لا توجد حملة نشطة.'; return; }
  try {
    await fetch(`/api/campaigns/jobs/${encodeURIComponent(activeCampaignJobId)}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } catch (error) { const status = document.getElementById('campaign-status'); if (status) status.textContent = `تعذر طلب الإيقاف: ${error.message}`; }
}

async function renderOfferMessages() {
  const customersBody = document.getElementById('offer-message-customers');
  const promotionsBox = document.getElementById('offer-message-promotions');
  const status = document.getElementById('offer-message-status');
  if (!customersBody || !promotionsBox) return;
  try {
    const [customersResponse, promotionsResponse, productsResponse, categoriesResponse, messageResponse] = await Promise.all([
      fetch('/api/customers'), fetch('/api/promotions'), fetch('/api/products'), fetch('/api/categories'), fetch('/api/whatsapp-offer-message')
    ]);
    const [customers, promotions, products, categories, saved] = await Promise.all([
      customersResponse.json(), promotionsResponse.json(), productsResponse.json(), categoriesResponse.json(), messageResponse.json()
    ]);
    if ([customersResponse, promotionsResponse, productsResponse, categoriesResponse, messageResponse].some(response => !response.ok)) {
      throw new Error('تعذر تحميل بيانات العملاء أو العروض. حدّث الصفحة وحاول مجددًا.');
    }
    offerMessageCustomers = (customers || []).filter(customer => Number(customer.id) !== 1 && String(customer.phone || '').trim());
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const active = (promotions || []).filter(item => item.is_active && (!item.start_date || item.start_date <= todayKey) && (!item.end_date || item.end_date >= todayKey));
    const productById = new Map((products || []).map(item => [Number(item.id), item]));
    const categoryById = new Map((categories || []).map(item => [Number(item.id), item]));
    offerMessageLines = active.map(item => {
      const product = item.product_id ? productById.get(Number(item.product_id)) : null;
      const category = item.category_id ? categoryById.get(Number(item.category_id)) : null;
      const scope = product?.name || category?.name || 'كل المنتجات';
      const discount = item.type === 'percent' ? `خصم ${Number(item.value)}٪` : `خصم ${Number(item.value).toFixed(2)} ج.م للوحدة`;
      let line = `• ${item.name}: ${discount} على ${scope}`;
      if (product && Number.isFinite(Number(product.sale_price))) {
        const oldPrice = Number(product.sale_price);
        const newPrice = Math.max(0, oldPrice - (item.type === 'percent' ? oldPrice * Number(item.value) / 100 : Number(item.value)));
        line += ` — ${newPrice.toFixed(2)} ج.م بدل ${oldPrice.toFixed(2)} ج.م`;
      }
      return line;
    });
    const productsWithDiscount = new Map();
    for (const product of products || []) {
      const eligible = active.filter(item => (!item.product_id && !item.category_id)
        || Number(item.product_id) === Number(product.id)
        || Number(item.category_id) === Number(product.category_id));
      if (!eligible.length) continue;
      const oldPrice = Number(product.sale_price || 0);
      const best = Math.max(...eligible.map(item => item.type === 'percent' ? oldPrice * Number(item.value) / 100 : Number(item.value)));
      if (best > 0 && oldPrice > 0) productsWithDiscount.set(Number(product.id), { name: product.name, oldPrice, newPrice: Math.max(0, oldPrice - best) });
    }
    const discounted = [...productsWithDiscount.values()].slice(0, 12);
    if (discounted.length) offerMessageLines.push('', 'منتجات عليها خصم:', ...discounted.map(item => `• ${item.name}: ${item.newPrice.toFixed(2)} ج.م بدل ${item.oldPrice.toFixed(2)} ج.م`));
    promotionsBox.innerHTML = active.length
      ? active.map(item => {
          const product = item.product_id ? productById.get(Number(item.product_id)) : null;
          const category = item.category_id ? categoryById.get(Number(item.category_id)) : null;
          const scope = product?.name || category?.name || 'كل المنتجات';
          const discount = item.type === 'percent' ? `خصم ${Number(item.value)}٪` : `خصم ${Number(item.value).toFixed(2)} ج.م للوحدة`;
          const productPrice = product ? `<span class="block text-emerald-800 mt-1">السعر بعد الخصم: ${Math.max(0, Number(product.sale_price || 0) - (item.type === 'percent' ? Number(product.sale_price || 0) * Number(item.value) / 100 : Number(item.value))).toFixed(2)} ج.م</span>` : '';
          return `<div class="rounded-xl border border-emerald-100 bg-emerald-50 p-3 text-xs"><b>${escapeHtml(item.name)}</b><span class="block mt-1">${escapeHtml(discount)} على ${escapeHtml(scope)}</span>${productPrice}<small class="block text-gray-500 mt-1">${escapeHtml(item.start_date || 'بدون بداية')} — ${escapeHtml(item.end_date || 'بدون نهاية')}</small></div>`;
        }).join('')
      : '<p class="md:col-span-2 rounded-xl border border-dashed p-4 text-center text-xs text-gray-500">لا توجد عروض نشطة الآن. أضف عرضًا من قائمة «العروض الترويجية».</p>';
    const promoStatus = document.getElementById('offer-message-promotion-status');
    if (promoStatus) promoStatus.textContent = `العروض النشطة: ${active.length} — المنتجات المتأثرة: ${productsWithDiscount.size}`;
    customersBody.innerHTML = offerMessageCustomers.length
      ? offerMessageCustomers.map(customer => `<tr class="offer-customer-row" data-search="${escapeHtml(`${customer.name} ${customer.phone}`)}"><td class="p-2"><input type="checkbox" data-customer-id="${Number(customer.id)}" class="offer-recipient" aria-label="تحديد ${escapeHtml(customer.name)}" onchange="updateOfferMessageCount()"></td><td class="p-2 font-bold">${escapeHtml(customer.name)}</td><td class="p-2" dir="ltr">${escapeHtml(customer.phone)}</td><td class="p-2"><button type="button" class="rounded bg-emerald-700 px-2 py-1 text-white" onclick="openOfferWhatsAppFor(${Number(customer.id)})">فتح</button></td></tr>`).join('')
      : '<tr><td colspan="4" class="p-4 text-center text-gray-500">لا يوجد عملاء بأرقام هاتف مسجلة.</td></tr>';
    offerMessageTemplate = saved.message;
    const messageBox = document.getElementById('offer-message-text');
    if (messageBox && document.activeElement !== messageBox) {
      messageBox.value = saved.message === null ? `أهلاً {اسم العميل} 👋\n\nأحدث عروضنا:\n{العروض}\n\nيسعدنا زيارتك!` : String(saved.message);
    }
    const country = document.getElementById('offer-message-country-code');
    if (country) country.value = localStorage.getItem('system_offer_country_code') || '20';
    messageBox?.addEventListener('input', updateOfferMessageCount, { once: false });
    customersBody.querySelectorAll('.offer-recipient').forEach(box => box.addEventListener('change', updateOfferMessageCount));
    updateOfferMessageCount();
    if (status) status.textContent = saved.message === '' ? 'لا يوجد نص رسالة محفوظ. اكتب نصًا جديدًا واحفظه لإرسال العروض.' : 'اختر العملاء وحدد الإجراء. الرسائل تفتح في واتساب ولا تُرسل إلا بعد ضغطك على إرسال.';
  } catch (error) {
    customersBody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-red-700">${escapeHtml(error.message)}</td></tr>`;
    if (status) status.textContent = error.message;
  }
}

async function saveOfferMessage() {
  const status = document.getElementById('offer-message-status');
  const message = document.getElementById('offer-message-text')?.value || '';
  if (!message.trim()) { if (status) status.textContent = 'اكتب نص الرسالة قبل حفظها.'; return; }
  try {
    const response = await fetch('/api/whatsapp-offer-message', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر حفظ نص الرسالة.');
    offerMessageTemplate = result.message;
    if (status) status.textContent = 'تم حفظ نص الرسالة. سيُستخدم مع كل عميل بعد استبدال اسمه والعروض.';
  } catch (error) { if (status) status.textContent = error.message; }
}

async function deleteOfferMessage() {
  if (!hasPermission('delete')) return showAppToast('لا تملك صلاحية حذف الرسالة.');
  if (!await showAppConfirm('هل تريد حذف نص رسالة العروض المحفوظ؟')) return;
  const status = document.getElementById('offer-message-status');
  try {
    const response = await fetch('/api/whatsapp-offer-message', { method: 'DELETE' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر حذف الرسالة.');
    offerMessageTemplate = result.message;
    document.getElementById('offer-message-text').value = '';
    document.getElementById('offer-message-preview')?.classList.add('hidden');
    updateOfferMessageCount();
    if (status) status.textContent = 'تم حذف نص الرسالة المحفوظ. لن يمكن بدء تجهيز رسائل حتى تكتب نصًا جديدًا.';
  } catch (error) { if (status) status.textContent = error.message; }
}

function previewOfferMessage() {
  const recipient = offerMessageCustomers.find(customer => document.querySelector(`#offer-message-customers .offer-recipient[data-customer-id="${Number(customer.id)}"]:checked`)) || offerMessageCustomers[0];
  const name = recipient?.name || 'عميلنا';
  const preview = document.getElementById('offer-message-preview');
  if (!preview) return;
  preview.textContent = getOfferMessageText(name);
  preview.classList.remove('hidden');
}

function startOfferMessageQueue(mode) {
  const checkedIds = new Set([...document.querySelectorAll('#offer-message-customers .offer-recipient:checked')].map(input => Number(input.dataset.customerId)));
  offerMessageQueue = mode === 'all' ? [...offerMessageCustomers] : offerMessageCustomers.filter(customer => checkedIds.has(Number(customer.id)));
  if (!offerMessageQueue.length) return showAppToast(mode === 'all' ? 'لا يوجد عملاء لديهم أرقام هاتف.' : 'حدد عميلًا واحدًا على الأقل أولًا.');
  if (!String(document.getElementById('offer-message-text')?.value || '').trim()) return showAppToast('اكتب نص الرسالة واحفظه قبل تجهيز الإرسال.');
  offerMessageQueueIndex = 0;
  showCurrentOfferQueueRecipient();
}

function showCurrentOfferQueueRecipient() {
  const box = document.getElementById('offer-message-queue');
  if (offerMessageQueueIndex >= offerMessageQueue.length) {
    currentOfferMessageRecipient = null;
    document.getElementById('offer-message-queue-status').textContent = 'اكتملت القائمة. أرسل آخر رسالة من واتساب قبل إغلاقها.';
    document.getElementById('offer-message-queue-text').textContent = '';
    document.getElementById('offer-message-open-whatsapp').disabled = true;
    box?.classList.remove('hidden');
    return;
  }
  currentOfferMessageRecipient = offerMessageQueue[offerMessageQueueIndex];
  document.getElementById('offer-message-queue-status').textContent = `رسالة ${offerMessageQueueIndex + 1} من ${offerMessageQueue.length} — ${currentOfferMessageRecipient.name} (${currentOfferMessageRecipient.phone}). افتح واتساب، أرسل الرسالة بنفسك، ثم اضغط «أرسلت، التالي».`;
  document.getElementById('offer-message-queue-text').textContent = getOfferMessageText(currentOfferMessageRecipient.name);
  document.getElementById('offer-message-open-whatsapp').disabled = false;
  box?.classList.remove('hidden');
}

function openCurrentOfferWhatsApp() {
  if (!currentOfferMessageRecipient) return;
  const country = document.getElementById('offer-message-country-code')?.value || '20';
  const phone = normalizeOfferPhone(currentOfferMessageRecipient.phone, country);
  if (phone.length < 8) return showAppToast(`رقم ${currentOfferMessageRecipient.name} غير صالح لفتح واتساب.`);
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(getOfferMessageText(currentOfferMessageRecipient.name))}`;
  window.open(url, '_blank', 'noopener');
}

function openOfferWhatsAppFor(customerId) {
  const customer = offerMessageCustomers.find(item => Number(item.id) === Number(customerId));
  if (!customer) return;
  currentOfferMessageRecipient = customer;
  openCurrentOfferWhatsApp();
}

function advanceOfferMessageQueue() {
  if (!currentOfferMessageRecipient) return;
  offerMessageQueueIndex += 1;
  showCurrentOfferQueueRecipient();
}

function stopOfferMessageQueue() {
  offerMessageQueue = [];
  offerMessageQueueIndex = 0;
  currentOfferMessageRecipient = null;
  document.getElementById('offer-message-queue')?.classList.add('hidden');
}

async function createInstallmentContract(event) {
  event?.preventDefault();
  const status = document.getElementById('installment-status');
  const payload = { sale_id: Number(document.getElementById('installment-sale-select')?.value), count: Number(document.getElementById('installment-count')?.value), frequency: document.getElementById('installment-frequency')?.value, first_due_date: document.getElementById('installment-first-due')?.value };
  try {
    const response = await fetch('/api/installments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر إنشاء جدول الأقساط.');
    if (status) status.textContent = `تم إنشاء العقد ${result.contract_number} بإجمالي ${Number(result.total).toFixed(2)} ج.م.`;
    await renderInstallments();
  } catch (error) { if (status) status.textContent = error.message; }
}

async function payInstallment(contractId, installmentId, remaining) {
  const values = await openAppFormDialog({ title: 'تحصيل قسط', subtitle: `المتبقي من القسط ${Number(remaining).toFixed(2)} ج.م.`, fields: [{ label: 'مبلغ السداد (ج.م)', type: 'number', value: Number(remaining).toFixed(2), placeholder: '0.00' }, { label: 'طريقة السداد', value: 'نقدي', placeholder: 'نقدي أو بطاقة أو محفظة' }], submitLabel: 'تسجيل التحصيل' });
  if (!values) return;
  const amount = Number(values[0]);
  if (!Number.isFinite(amount) || amount <= 0) return;
  const method = values[1] || 'نقدي';
  try {
    const response = await fetch(`/api/installments/${contractId}/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ installment_id: installmentId, amount, method }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر تحصيل القسط.');
    await renderInstallments();
    await refreshDashboard();
  } catch (error) { showAppToast(error.message); }
}

async function createServiceOrder(event) {
  event?.preventDefault();
  const status = document.getElementById('service-order-status');
  const serviceType = document.getElementById('service-order-type')?.value || '';
  const description = document.getElementById('service-order-description')?.value?.trim() || '';
  if (!serviceType || !description) {
    if (status) status.textContent = 'نوع الخدمة ووصف العمل مطلوبان.';
    return;
  }
  const payload = {
    type: serviceType,
    customer_id: Number(document.getElementById('service-order-customer')?.value || 1),
    description,
    total: Number(document.getElementById('service-order-total')?.value || 0),
    deposit: Number(document.getElementById('service-order-deposit')?.value || 0),
    due_date: document.getElementById('service-order-due-date')?.value || '',
    payment_method: document.getElementById('service-order-payment-method')?.value || 'نقدي'
  };
  try {
    const response = await fetch('/api/service-orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر إنشاء أمر الشغل.');
    document.getElementById('service-order-form')?.reset();
    if (status) status.textContent = `تم إنشاء الأمر ${result.order_number}. المتبقي ${Number(result.remaining_amount).toFixed(2)} ج.م.`;
    await renderServiceOrders();
    await refreshDashboard();
  } catch (error) { if (status) status.textContent = error.message; }
}

async function updateServiceOrderStatus(id, value) {
  try {
    const response = await fetch(`/api/service-orders/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر تحديث الحالة.');
    await renderServiceOrders();
  } catch (error) { showAppToast(error.message); await renderServiceOrders(); }
}

async function collectServiceOrderPayment(id) {
  const values = await openAppFormDialog({ title: 'تحصيل أمر الشغل', subtitle: 'أدخل مبلغ التحصيل وطريقة السداد.', fields: [{ label: 'مبلغ التحصيل (ج.م)', type: 'number', placeholder: '0.00' }, { label: 'طريقة السداد', value: 'نقدي', placeholder: 'نقدي أو بطاقة أو محفظة' }], submitLabel: 'تسجيل التحصيل' });
  if (!values) return;
  const amount = Number(values[0]);
  if (!Number.isFinite(amount) || amount <= 0) return;
  const method = values[1] || 'نقدي';
  try {
    const response = await fetch(`/api/service-orders/${id}/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount, method }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر تسجيل التحصيل.');
    await renderServiceOrders();
    await refreshDashboard();
  } catch (error) { showAppToast(error.message); }
}

function ensurePhase1EmptyStates() {
  document.querySelectorAll('#app-shell table tbody').forEach(tbody => {
    if (tbody.children.length || tbody.dataset.phase1Empty === 'true') return;
    const columns = tbody.closest('table')?.querySelectorAll('thead th').length || 1;
    tbody.innerHTML = `<tr class="phase1-empty-row"><td colspan="${columns}"><div class="phase1-empty-state"><i class="fa-solid fa-inbox" aria-hidden="true"></i><strong>لا توجد بيانات مطابقة</strong><span>جرّب تغيير الفلاتر أو أضف بيانات جديدة.</span></div></td></tr>`;
    tbody.dataset.phase1Empty = 'true';
  });
}

function normalizePhase1PaymentMethod(value) {
  const text = String(value || '').trim().toLowerCase();
  if (/فيزا|بطاق|card|visa/.test(text)) return 'بطاقة';
  if (/آجل|اجل|credit|deferred/.test(text)) return 'دفع آجل';
  if (/محفظ|wallet|e-wallet|e_wallet/.test(text)) return 'محفظة إلكترونية';
  if (/نقد|cash/.test(text)) return 'نقدي';
  return text;
}

function applySalesHistoryFilters() {
  productListPages.salesHistory = productListPages.salesHistory || { page: 0, pageSize: 100 };
  productListPages.salesHistory.page = 0;
  void renderSalesHistory();
  showAppToast('تم تطبيق فلاتر سجل الفواتير.');
}

function clearSalesHistoryFilters() {
  ['sales-history-search', 'sales-history-from', 'sales-history-to', 'sales-history-date'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const payment = document.getElementById('sales-history-payment-method');
  if (payment) payment.value = '';
  void renderSalesHistory();
  showAppToast('تم مسح فلاتر سجل الفواتير.');
}

async function renderSalesHistory() {
  const tbody = document.getElementById('sales-history-table-body');
  const countEl = document.getElementById('sales-history-count');
  const totalEl = document.getElementById('sales-history-total');
  const profitEl = document.getElementById('sales-history-profit');
  const searchEl = document.getElementById('sales-history-search');
  const dateEl = document.getElementById('sales-history-date');
  const fromEl = document.getElementById('sales-history-from');
  const toEl = document.getElementById('sales-history-to');
  const paymentMethodEl = document.getElementById('sales-history-payment-method');
  if (!tbody) return;

  const sales = await storage.getSales();
  if (dateEl && !dateEl.value && !fromEl?.value && !toEl?.value) dateEl.value = '';
  const query = (searchEl?.value || '').trim().toLowerCase();
  const selectedDate = dateEl?.value || '';
  const fromDate = fromEl?.value || selectedDate;
  const toDate = toEl?.value || selectedDate;
  const selectedPaymentMethod = normalizePhase1PaymentMethod(paymentMethodEl?.value || '');
  const visibleSales = sales.filter(s => {
    const day = String(s.created_at).slice(0, 10);
    const matchesDate = (!fromDate || day >= fromDate) && (!toDate || day <= toDate);
    const haystack = `${s.invoice_number || ''} ${s.customer_name || ''} ${s.total}`.toLowerCase();
    const matchesPayment = !selectedPaymentMethod || normalizePhase1PaymentMethod(s.payment_method) === selectedPaymentMethod;
    return matchesDate && matchesPayment && (!query || haystack.includes(query));
  });
  const activeSales = visibleSales.filter(s => s.status !== 'returned');
  const totalSales = activeSales.reduce((sum, s) => sum + Number(s.total || 0), 0);
  const totalProfit = activeSales.reduce((sum, s) => sum + (s.items || []).reduce((lineSum, item) => lineSum + ((Number(item.unit_price) - Number(item.cost_price || 0)) * Number(item.quantity) - Number(item.discount || 0)), 0), 0);
  if (countEl) countEl.textContent = visibleSales.length;
  if (totalEl) totalEl.textContent = `${totalSales.toFixed(2)} ج.م`;
  if (profitEl) profitEl.textContent = `${totalProfit.toFixed(2)} ج.م`;

  tbody.innerHTML = '';
  delete tbody.dataset.phase1Empty;
  visibleSales.forEach(s => {
    const tr = document.createElement('tr');
    const walletPayment = (s.payments || []).find(payment => payment.method === 'محفظة إلكترونية');
    const walletDetails = typeof walletPayment?.method_details === 'string' ? JSON.parse(walletPayment.method_details || '{}') : (walletPayment?.method_details || {});
    const paymentLabel = walletDetails.name && walletDetails.wallet_number ? `محفظة إلكترونية — ${walletDetails.name} — ${walletDetails.wallet_number}` : s.payment_method;
    tr.className = 'hover:bg-gray-50';
    tr.innerHTML = `
      <td class="py-3 px-4 font-mono font-bold text-[#D6336C]">${escapeHtml(s.invoice_number)}</td>
      <td class="py-3 px-3 font-semibold text-gray-800">${escapeHtml(s.customer_name)}</td>
      <td class="py-3 px-3 text-gray-600">${escapeHtml(s.cashier_name)}</td>
      <td class="py-3 px-3 font-bold">${escapeHtml(paymentLabel)}<div class="text-[10px] text-gray-500">${escapeHtml(s.order_type || 'داخل المحل')} · ${escapeHtml(s.order_channel || 'مباشر')}</div></td>
      <td class="py-3 px-3"><span class="inline-flex rounded-full px-2 py-1 text-[11px] font-black ${s.status === 'returned' ? 'bg-red-100 text-red-800' : s.status === 'partially_returned' ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}">${s.status === 'returned' ? 'مرتجع' : s.status === 'partially_returned' ? 'مرتجع جزئي' : 'مباع'}</span></td>
      <td class="py-3 px-3 text-gray-600">${s.subtotal.toFixed(2)} ج.م</td>
      <td class="py-3 px-3 text-red-600">${s.discount.toFixed(2)} ج.م</td>
      <td class="py-3 px-3 font-black text-gray-900">${s.total.toFixed(2)} ج.م</td>
      <td class="py-3 px-3 text-gray-500 font-mono text-[11px]">${escapeHtml(s.created_at)}</td>
      <td class="py-3 px-4 text-center">
        <button data-invoice-number="${escapeHtml(s.invoice_number)}" onclick="reprintInvoice(this.dataset.invoiceNumber)" class="px-2.5 py-1 bg-gray-100 hover:bg-[#D6336C] hover:text-white rounded-lg text-xs font-bold transition flex items-center gap-1 mx-auto">
          <i data-lucide="printer" class="w-3.5 h-3.5"></i>
          طباعة
        </button>
        ${hasPermission('edit') && s.status !== 'returned' ? `<button onclick="returnSaleFromArchive(${s.id})" class="mt-1 px-2.5 py-1 bg-red-50 hover:bg-red-600 hover:text-white text-red-700 rounded-lg text-xs font-bold transition">استرجاع</button>` : ''}
        ${hasPermission('edit') && Number(s.returned_amount || 0) <= 0 ? `<button onclick="editSaleFromArchive(${s.id})" class="mt-1 px-2.5 py-1 bg-amber-50 hover:bg-amber-600 hover:text-white text-amber-700 rounded-lg text-xs font-bold transition">تعديل</button>` : ''}
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (!visibleSales.length) ensurePhase1EmptyStates();
  lucide.createIcons();
}

async function returnSaleFromArchive(saleId) {
  if (!hasPermission('edit')) return showAppToast('لا تملك صلاحية تعديل أو استرجاع الفواتير.');
  const sale = (await storage.getSales()).find(s => s.id === saleId);
  if (!sale) return;
  if (sale.status === 'returned') return showAppToast('تم استرجاع هذه الفاتورة بالكامل من قبل.');
  const returnedByLine = new Map();
  (sale.returns || []).forEach(row => returnedByLine.set(Number(row.sale_item_id), (returnedByLine.get(Number(row.sale_item_id)) || 0) + Number(row.quantity || 0)));
  const returnableLines = (sale.items || []).map(item => ({ ...item, remaining: Math.max(0, Number(item.quantity || 0) - (returnedByLine.get(Number(item.id)) || 0)) })).filter(item => item.remaining > 0);
  if (!returnableLines.length) return showAppToast('لا توجد كميات متبقية للاسترجاع في هذه الفاتورة.');
  const dialog = document.createElement('div');
  dialog.className = 'fixed inset-0 z-[80] modal-backdrop flex items-center justify-center p-4';
  const lineMarkup = returnableLines.map((item, index) => `<label class="flex items-center justify-between gap-3 border-b border-gray-100 py-2 text-sm"><span class="min-w-0 flex-1">${escapeHtml(item.product_name || `صنف ${item.product_id}`)} <small class="text-gray-500">متبقي ${item.remaining}</small></span><input data-return-qty="${index}" type="number" min="0" max="${item.remaining}" step="1" value="${item.remaining}" class="w-24 rounded-lg border border-gray-300 px-2 py-1 text-center"></label>`).join('');
  dialog.innerHTML = `<div class="apple-form-dialog bg-white rounded-3xl w-full max-w-lg p-6 shadow-2xl border border-gray-200"><h3 class="text-base font-black mb-1">استرجاع الفاتورة ${escapeHtml(sale.invoice_number)}</h3><p class="text-sm text-gray-600 mb-3">أدخل الكمية المراد استرجاعها لكل صنف. اجعلها صفراً لتخطي الصنف.</p><form data-return-form><div class="max-h-64 overflow-y-auto">${lineMarkup}</div><label class="block mt-3 text-sm font-bold">سبب الاسترجاع<textarea name="reason" rows="2" class="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2">استرجاع من العميل</textarea></label><div class="flex gap-2 mt-4"><button type="submit" class="flex-1 rounded-xl btn-pink px-4 py-2 font-bold">تأكيد الاسترجاع</button><button type="button" data-return-cancel class="rounded-xl border border-gray-300 bg-white px-4 py-2 font-bold">إلغاء</button></div></form></div>`;
  document.body.appendChild(dialog);
  const request = await new Promise(resolve => {
    dialog.querySelector('[data-return-cancel]').addEventListener('click', () => { dialog.remove(); resolve(null); });
    dialog.querySelector('[data-return-form]').addEventListener('submit', event => {
      event.preventDefault();
      const quantities = returnableLines.map((item, index) => Number(dialog.querySelector(`[data-return-qty="${index}"]`).value));
      const invalid = quantities.some((quantity, index) => !Number.isInteger(quantity) || quantity < 0 || quantity > returnableLines[index].remaining);
      if (invalid || quantities.every(quantity => quantity === 0)) { showAppToast('أدخل كمية صحيحة للاسترجاع لكل صنف، ويجب استرجاع صنف واحد على الأقل.'); return; }
      const items = returnableLines.map((item, index) => ({ sale_item_id: item.id, quantity: quantities[index] })).filter(item => item.quantity > 0);
      const reason = dialog.querySelector('[name="reason"]').value.trim();
      dialog.remove(); resolve({ items, reason });
    });
  });
  if (!request) return;
  try {
    let result;
    try {
      result = await storage.returnSale(sale.id, request.items, request.reason);
    } catch (error) {
      if (!['RETURN_PERIOD_LOCKED', 'RETURN_WINDOW_EXPIRED'].includes(error.code) || !isUnrestrictedAccount(currentUser)) throw error;
      const override = await openAppFormDialog({
        title: 'اعتماد استرجاع خارج المدة المسموحة',
        subtitle: 'يظهر هذا الاسترجاع في سجل التدقيق المشفّر باسم المدير مع سبب التجاوز.',
        fields: [{ label: 'سبب تجاوز المدة أو إغلاق الفترة', type: 'textarea', value: request.reason, placeholder: 'سبب واضح لاعتماد المرتجع' }],
        submitLabel: 'اعتماد وتسجيل المرتجع'
      });
      const overrideReason = String(override?.[0] || '').trim();
      if (overrideReason.length < 4) { if (override) showAppToast('اكتب سبباً واضحاً لتجاوز المدة أو إغلاق الفترة المالية.'); return; }
      result = await storage.returnSale(sale.id, request.items, request.reason, { override_closed_period: true, override_reason: overrideReason });
    }
    if (result.return_document) {
      renderReceiptModal({
        ...result.return_document,
        document_type: 'credit_note',
        document_number: result.return_document.number,
        invoice_number: result.return_document.number,
        paid_amount: result.return_document.refunded_amount,
        remaining_amount: 0,
        discount: 0,
        delivery_fee_customer: 0,
        payment_method: 'رد قيمة المرتجع',
        due_date: null,
        loyalty_points_earned: 0
      });
    }
    showAppToast(result.message || 'تم تسجيل الاسترجاع بنجاح');
    await renderSalesHistory();
    await renderProducts();
    await renderPosProducts();
    await refreshDashboard();
  } catch (err) {
    showAppToast(err.message);
  }
}

async function startSalesHistoryBarcodeCamera() {
  const wrapper = document.getElementById('sales-history-barcode-camera-wrapper');
  const container = document.getElementById('sales-history-barcode-camera');
  const status = document.getElementById('sales-history-barcode-camera-status');
  if (!wrapper || !container || !status) return;
  wrapper.classList.remove('hidden');
  if (typeof Html5Qrcode === 'undefined') {
    status.textContent = 'تعذر تحميل قارئ الباركود المرفق. أغلق التطبيق وافتحه مجددًا.';
    status.className = 'mt-1 text-[11px] text-red-600';
    return;
  }
  try {
    await stopSalesHistoryBarcodeCamera();
    if (!window.isSecureContext) throw new Error('الكاميرا تحتاج تشغيل البرنامج من localhost أو HTTPS.');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('المتصفح الحالي لا يدعم الوصول للكاميرا.');
    const permissionProbe = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    permissionProbe.getTracks().forEach(track => track.stop());
    container.classList.remove('hidden');
    container.style.minHeight = '220px';
    status.textContent = 'وجّه الكاميرا نحو باركود الفاتورة.';
    status.className = 'mt-1 text-[11px] text-gray-600';
    salesHistoryBarcodeCamera = new Html5Qrcode('sales-history-barcode-camera');
    const barcodeFormats = typeof Html5QrcodeSupportedFormats !== 'undefined'
      ? [Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39, Html5QrcodeSupportedFormats.QR_CODE].filter(Boolean)
      : undefined;
    await startQrCameraWithFallback(
      salesHistoryBarcodeCamera,
      { fps: 15, qrbox: { width: 280, height: 160 }, aspectRatio: 1.777, ...(barcodeFormats ? { formatsToSupport: barcodeFormats } : {}) },
      async decodedText => {
        const invoiceNumber = String(decodedText || '').trim();
        if (!invoiceNumber) return;
        const input = document.getElementById('sales-history-search');
        if (input) input.value = invoiceNumber;
        status.textContent = `تمت قراءة ${invoiceNumber}؛ جارٍ فتح الفاتورة.`;
        status.className = 'mt-1 text-[11px] text-emerald-700';
        await stopSalesHistoryBarcodeCamera();
        await openScannedInvoiceFromHistory(invoiceNumber);
      },
      () => {}
    );
  } catch (error) {
    await stopSalesHistoryBarcodeCamera();
    status.textContent = `تعذر تشغيل الكاميرا: ${error?.message || 'تحقق من إذن الكاميرا.'}`;
    status.className = 'mt-1 text-[11px] text-red-600';
    status.classList.remove('hidden');
  }
}

async function stopSalesHistoryBarcodeCamera() {
  const camera = salesHistoryBarcodeCamera;
  salesHistoryBarcodeCamera = null;
  if (camera) {
    try { if (camera.isScanning) await camera.stop(); } catch (_) {}
    try { camera.clear(); } catch (_) {}
  }
  const container = document.getElementById('sales-history-barcode-camera');
  if (container) { container.classList.add('hidden'); container.style.minHeight = ''; }
  document.getElementById('sales-history-barcode-camera-wrapper')?.classList.add('hidden');
}

async function openScannedInvoiceFromHistory(value) {
  if (!hasPermission('view')) return;
  const scanned = String(value || '').trim();
  if (!scanned) return;
  const sale = (await storage.getSales()).find(row => String(row.invoice_number || '').trim().toLowerCase() === scanned.toLowerCase());
  if (!sale) { showAppToast('لم يتم العثور على فاتورة بهذا الرقم أو الباركود.'); return; }
  const canReturn = sale.status !== 'returned' && hasPermission('edit');
  const canEdit = Number(sale.returned_amount || 0) <= 0 && hasPermission('edit');
  const choice = await new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'fixed inset-0 z-[80] modal-backdrop flex items-center justify-center p-4';
    backdrop.innerHTML = `<div class="apple-form-dialog bg-white rounded-3xl w-full max-w-md p-6 shadow-2xl border border-gray-200"><h3 class="text-base font-black">فاتورة ${escapeHtml(sale.invoice_number)}</h3><p class="text-sm text-gray-600 mt-1 mb-5">${sale.status === 'returned' ? 'تم استرجاع الفاتورة بالكامل.' : 'اختر الإجراء المطلوب.'}</p><div class="grid grid-cols-1 gap-2">${canReturn ? '<button type="button" data-invoice-action="return" class="rounded-xl btn-pink px-4 py-3 font-bold">استرجاع كلي أو جزئي</button>' : ''}${canEdit ? '<button type="button" data-invoice-action="edit" class="rounded-xl border border-gray-300 bg-white px-4 py-3 font-bold">تعديل الفاتورة</button>' : ''}${hasPermission('print_pdf') ? `<button type="button" data-invoice-action="print" class="rounded-xl border border-gray-300 bg-white px-4 py-3 font-bold">طباعة الفاتورة</button>` : ''}<button type="button" data-invoice-action="cancel" class="rounded-xl border border-gray-300 bg-white px-4 py-3 font-bold">إغلاق</button></div></div>`;
    document.body.appendChild(backdrop);
    backdrop.querySelectorAll('[data-invoice-action]').forEach(button => button.addEventListener('click', () => { const action = button.dataset.invoiceAction; backdrop.remove(); resolve(action); }));
  });
  if (choice === 'return') return returnSaleFromArchive(sale.id);
  if (choice === 'edit') return editSaleFromArchive(sale.id);
  if (choice === 'print') return reprintInvoice(sale.invoice_number);
}

async function editSaleFromArchive(saleId) {
  if (!hasPermission('edit')) return showAppToast('لا تملك صلاحية تعديل الفواتير.');
  const sale = (await storage.getSales()).find(s => s.id === saleId); if (!sale) return;
  const fields = [{ label: `الخصم الجديد للفاتورة ${sale.invoice_number}`, type: 'number', value: sale.discount || 0 }];
  sale.items.forEach(item => fields.push({ label: `سعر ${item.product_name}`, type: 'number', value: item.unit_price }));
  const result = await openAppFormDialog({
    title: 'تعديل الفاتورة',
    subtitle: 'راجع الخصم والأسعار ثم احفظ التعديلات.',
    fields,
    submitLabel: 'حفظ الفاتورة'
  });
  if (!result) return;
  const discount = Number(result[0]);
  if (!Number.isFinite(discount) || discount < 0) return;
  const items = sale.items.map((item, index) => ({ id: item.id, unit_price: Number(result[index + 1]), discount: item.discount || 0 }));
  if (items.some(item => !Number.isFinite(item.unit_price) || item.unit_price < 0)) return showAppToast('يوجد سعر غير صحيح.');
  try { await storage.updateSale(sale.id, { discount, items }); showAppToast('تم تعديل الفاتورة.'); await renderSalesHistory(); await refreshDashboard(); } catch (err) { showAppToast(err.message); }
}

async function reprintInvoice(invoiceNumber) {
  if (!hasPermission('print_pdf')) return showAppToast('لا تملك صلاحية الطباعة.');
  const sales = await storage.getSales();
  const sale = sales.find(s => s.invoice_number === invoiceNumber);
  if (sale) {
    renderReceiptModal(sale);
  }
}

// ----------------------------------------------------
// Customers & Suppliers
// ----------------------------------------------------
async function populateCustomerDropdowns() {
  const sel = document.getElementById('pos-customer-select');
  const customers = await storage.getCustomers();
  if (sel) {
    sel.innerHTML = '';
    customers.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.dataset.customerName = c.name || '';
      opt.dataset.customerPhone = c.phone || '';
      opt.dataset.customerBalance = String(Number(c.balance || 0));
      opt.textContent = `${c.name || 'عميل'}${c.phone ? ` — ${c.phone}` : ''}${c.balance > 0 ? ` (آجل: ${c.balance} ج.م)` : ''}${Number(c.loyalty_points) > 0 ? ` (نقاط: ${c.loyalty_points})` : ''}`;
      sel.appendChild(opt);
    });
    if ([...sel.options].some(option => option.value === '1')) sel.value = '1';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Populate purchase suppliers
  const suppSel = document.getElementById('purchase-supp-select');
  const suppliers = await storage.getSuppliers();
  if (suppSel) {
    suppSel.innerHTML = '<option value="">اختر المورد</option>';
    suppliers.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      suppSel.appendChild(opt);
    });
  }
  const purchaseSupplierFilter = document.getElementById('purchase-list-supplier');
  if (purchaseSupplierFilter) {
    const selected = purchaseSupplierFilter.value;
    purchaseSupplierFilter.innerHTML = '<option value="">كل الموردين</option>' + suppliers.map(s => `<option value="${Number(s.id)}">${escapeHtml(s.name || '')}</option>`).join('');
    if (suppliers.some(s => String(s.id) === selected)) purchaseSupplierFilter.value = selected;
  }
  const orderSupp = document.getElementById('purchase-order-supplier');
  if (orderSupp) {
    orderSupp.innerHTML = '';
    suppliers.forEach(supplier => { const option = document.createElement('option'); option.value = supplier.id; option.textContent = supplier.name; orderSupp.appendChild(option); });
  }

  const salespersonSelect = document.getElementById('pos-salesperson-select');
  if (salespersonSelect) {
    const selected = salespersonSelect.value;
    const employees = (await storage.getEmployees()).filter(employee => employee.is_active !== false);
    salespersonSelect.innerHTML = '<option value="">بدون ربط بموظف</option>';
    employees.forEach(employee => {
      const option = document.createElement('option'); option.value = employee.id;
      option.textContent = `${employee.name} · عمولة ${Number(employee.commission_rate || 0)}%`;
      salespersonSelect.appendChild(option);
    });
    if (employees.some(employee => String(employee.id) === selected)) salespersonSelect.value = selected;
  }

  // Populate purchase product dropdown
  const purProdSel = document.getElementById('purchase-item-prod');
  const prods = await storage.getProducts();
  if (purProdSel) {
    purProdSel.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'اختر صنفاً من البحث';
    placeholder.disabled = true;
    placeholder.selected = true;
    purProdSel.appendChild(placeholder);
    prods.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name}${p.barcode ? ` — ${p.barcode}` : ''}`;
      purProdSel.appendChild(opt);
    });
  }
  const orderProduct = document.getElementById('purchase-order-product');
  if (orderProduct) {
    orderProduct.innerHTML = '';
    prods.forEach(product => { const option = document.createElement('option'); option.value = product.id; option.textContent = `${product.name}${product.barcode ? ` — ${product.barcode}` : ''}`; orderProduct.appendChild(option); });
  }
  const purchaseSearch = document.getElementById('purchase-product-search');
  if (purchaseSearch) purchaseSearch.value = '';
  document.getElementById('purchase-product-results')?.classList.add('hidden');
  await loadPosDeliveryRiders();
  updatePosLoyaltySummary();
}

async function loadPosDeliveryRiders() {
  const select = document.getElementById('pos-delivery-rider-select');
  if (!select) return;
  let selected = select.value;
  try {
    const response = await fetch('/api/delivery/riders');
    const riders = response.ok ? await response.json() : [];
    deliveryRidersCache = Array.isArray(riders) ? riders : [];
    // A delivery-mode refresh may finish after the cashier has already picked
    // a rider. Preserve the current selection at response time, not only the
    // value captured when the request began.
    selected = select.value || selected;
    select.innerHTML = '<option value="">غير مُسنَدة — اختر لاحقاً</option>';
    const status = document.getElementById('pos-delivery-rider-status');
    if (status) {
      status.textContent = '';
      if (riders.length) status.textContent = `اختر الطيار المتاح — ${riders.length} طيار${riders.length === 1 ? '' : 'ين'} متاحين.`;
      else {
        status.append('لا يوجد طيارون نشطون. يمكنك إتمام البيع بدون توصيل أو ');
        const button = document.createElement('button'); button.type = 'button'; button.className = 'font-bold text-sky-800 underline'; button.textContent = 'فتح شاشة الطيارين'; button.onclick = () => switchTab('delivery-riders'); status.append(button);
      }
    }
    riders.forEach(rider => {
      const option = document.createElement('option');
      option.value = rider.id;
      option.dataset.phone = rider.phone || '';
      option.dataset.status = rider.is_active === false ? 'غير نشط' : 'متاح';
      option.setAttribute('aria-label', `${rider.name}${rider.phone ? ` — ${rider.phone}` : ''} — ${option.dataset.status}`);
      // Keep the status readable in the visible option as well as in aria-label.
      // The cashier must be able to distinguish an available rider without
      // relying on a symbol that is ambiguous in some fonts.
      option.textContent = `${rider.name}${rider.phone ? ` · ${rider.phone}` : ''} · ${rider.is_active === false ? 'غير نشط' : 'متاح'}`;
      select.appendChild(option);
    });
    if (riders.some(rider => String(rider.id) === selected)) {
      select.value = selected;
      applySelectedRiderDeliveryDefaults();
    }
  } catch (_) { select.innerHTML = '<option value="">تعذر تحميل الطيارين — غير مُسنَدة</option>'; }
}

function togglePosDeliveryFields() {
  const type = document.getElementById('pos-order-type')?.value;
  const box = document.getElementById('pos-delivery-details');
  box?.classList.toggle('hidden', type !== 'توصيل');
  if (type === 'توصيل') loadPosDeliveryRiders();
  const feeRow = document.getElementById('pos-delivery-fee-row');
  feeRow?.classList.toggle('hidden', type !== 'توصيل');
  const rider = document.getElementById('pos-delivery-rider-select');
  const customerFee = document.getElementById('pos-delivery-customer-fee');
  const riderFee = document.getElementById('pos-delivery-rider-fee');
  const selected = deliveryRidersCache.find(row => String(row.id) === String(rider?.value || ''));
  if (selected && customerFee && !Number(customerFee.value)) customerFee.value = Number(selected.default_delivery_fee || 0);
  if (selected && riderFee && !Number(riderFee.value)) riderFee.value = Number(selected.default_delivery_wage || 0);
  const display = document.getElementById('pos-delivery-fee-display');
  if (display) display.textContent = `${Number(customerFee?.value || 0).toFixed(2)} ج.م`;
  updatePosDeliveryBadge();
  calculateCartTotals();
}

function applySelectedRiderDeliveryDefaults() {
  const riderId = document.getElementById('pos-delivery-rider-select')?.value;
  const rider = deliveryRidersCache.find(row => String(row.id) === String(riderId || ''));
  const riderStatus = document.getElementById('pos-delivery-rider-status');
  if (!rider) { if (riderStatus) riderStatus.style.display = ''; return; }
  // Once assigned, the selected rider and their defaults are visible in the
  // controls and invoice badge; remove the redundant availability hint so the
  // cart and checkout actions retain room at large text scales.
  if (riderStatus) riderStatus.style.display = 'none';
  const customerFee = document.getElementById('pos-delivery-customer-fee');
  const riderFee = document.getElementById('pos-delivery-rider-fee');
  if (customerFee) customerFee.value = Number(rider.default_delivery_fee || 0).toFixed(2);
  if (riderFee) riderFee.value = Number(rider.default_delivery_wage || 0).toFixed(2);
  const display = document.getElementById('pos-delivery-fee-display');
  if (display) display.textContent = `${Number(customerFee?.value || 0).toFixed(2)} ج.م`;
  updatePosDeliveryBadge();
}

function updatePosDeliveryBadge() {
  const badge = document.getElementById('pos-delivery-badge');
  const type = document.getElementById('pos-order-type')?.value;
  const rider = deliveryRidersCache.find(row => String(row.id) === String(document.getElementById('pos-delivery-rider-select')?.value || ''));
  if (!badge) return;
  badge.classList.toggle('hidden', type !== 'توصيل' || !rider);
  badge.textContent = rider ? `توصيل ← ${rider.name}` : '';
}

function searchPosCustomerByPhone() {
  clearTimeout(posCustomerSearchTimer);
  const input = document.getElementById('pos-customer-phone-search');
  if (!String(input?.value || '').trim()) { performPosCustomerSearch(); return; }
  posCustomerSearchTimer = setTimeout(() => { posCustomerSearchTimer = null; performPosCustomerSearch(); }, 120);
}

function performPosCustomerSearch() {
  const query = normalizeCatalogText(document.getElementById('pos-customer-phone-search')?.value || '');
  const select = document.getElementById('pos-customer-select');
  const status = document.getElementById('pos-customer-search-status');
  const addButton = document.getElementById('pos-add-phone-customer');
  if (!select || !query) { if (status) status.textContent = ''; addButton?.classList.add('hidden'); return; }
  const options = [...select.options].filter(option => option.value !== '1');
  const matches = options.filter(option => normalizeCatalogText(`${option.dataset.customerName || ''} ${option.dataset.customerPhone || ''}`).includes(query));
  if (matches.length === 1) { select.value = matches[0].value; select.dispatchEvent(new Event('change')); }
  if (status) status.textContent = matches.length ? `تم العثور على ${matches.length} عميل${matches.length === 1 ? '' : 'ين'}.` : 'لا يوجد عميل بهذا الاسم أو الرقم.';
  addButton?.classList.toggle('hidden', !/^\+?[\d٠-٩۰-۹\s()-]{5,}$/.test(document.getElementById('pos-customer-phone-search')?.value.trim() || '') || matches.length > 0);
}

function openCustomerFromPhoneSearch() {
  const phone = document.getElementById('pos-customer-phone-search')?.value.trim() || '';
  const phoneField = document.getElementById('cust-phone');
  if (phoneField) phoneField.value = phone;
  openModal('modal-add-customer');
  document.getElementById('cust-name')?.focus();
}

async function updatePosLoyaltySummary() {
  const box = document.getElementById('pos-loyalty-summary');
  const select = document.getElementById('pos-customer-select');
  const customerId = Number(select?.value || 1);
  if (!box || customerId <= 1) { box?.classList.add('hidden'); return; }
  try {
    const [settingsResponse, balanceResponse] = await Promise.all([
      fetch('/api/loyalty/settings'),
      fetch(`/api/customers/${customerId}/loyalty`)
    ]);
    if (!settingsResponse.ok || !balanceResponse.ok) throw new Error('تعذر قراءة نقاط العميل');
    const settings = await settingsResponse.json();
    const balance = await balanceResponse.json();
    if (Number(select.value) !== customerId) return;
    if (!settings.enabled) { box.classList.add('hidden'); return; }
    const subtotal = cart.reduce((sum, item) => sum + Number(item.unit_price || 0) * Number(item.quantity || 0) - Number(item.discount || 0) - promotionDiscountForCartItem(item), 0);
    const invoiceDiscount = Number(document.getElementById('pos-discount-input')?.value || 0);
    const estimated = Math.floor(Math.max(0, subtotal - invoiceDiscount) / Math.max(1, Number(settings.spend_per_point) || 10));
    box.textContent = `رصيد العميل: ${Number(balance.points) || 0} نقطة — سيكتسب ${estimated} نقطة عند إتمام الفاتورة.`;
    box.classList.remove('hidden');
  } catch (_) {
    box.classList.add('hidden');
  }
}

async function loadLoyaltySettings() {
  const enabled = document.getElementById('loyalty-enabled');
  const spend = document.getElementById('loyalty-spend-per-point');
  const status = document.getElementById('loyalty-settings-status');
  if (!enabled || !spend) return;
  try {
    const response = await fetch('/api/loyalty/settings');
    const settings = await response.json();
    if (!response.ok) throw new Error(settings.error || 'تعذر تحميل الإعدادات');
    enabled.checked = Boolean(settings.enabled);
    spend.value = String(settings.spend_per_point || 10);
    if (status) status.textContent = settings.enabled ? 'البرنامج مفعّل للعملاء المسجلين.' : 'البرنامج متوقف حاليًا.';
  } catch (error) { if (status) status.textContent = error.message; }
}

async function loadTaxSettings() {
  // Intentionally ignored: tax defaults remain disabled when settings are unavailable
  try {
    const response = await fetch('/api/tax/settings');
    const data = await response.json();
    if (response.ok) {
      taxSettings = { enabled: data.enabled === true, rate: Number(data.rate) || 0, registration_number: String(data.registration_number || '') };
      const enabled = document.getElementById('tax-enabled'); if (enabled) enabled.checked = taxSettings.enabled;
      const rate = document.getElementById('tax-rate'); if (rate) rate.value = String(taxSettings.rate);
      const registration = document.getElementById('tax-registration-number'); if (registration) registration.value = taxSettings.registration_number;
      const status = document.getElementById('tax-settings-status'); if (status) status.textContent = taxSettings.enabled ? `الضريبة مفعلة بنسبة ${taxSettings.rate}%.` : 'الضريبة متوقفة.';
    }
  } catch (_) { /* الضريبة متوقفة افتراضياً عند تعذر الاتصال */ }
  calculateCartTotals();
}

async function loadReturnSettings() {
  try {
    const response = await fetch('/api/settings', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر تحميل سياسة المرتجعات.');
    returnWindowDays = Number.isInteger(Number(data.return_window_days)) && Number(data.return_window_days) >= 0 ? Number(data.return_window_days) : 14;
    const input = document.getElementById('return-window-days');
    if (input) input.value = String(returnWindowDays);
    renderReturnWindowText();
  } catch (error) {
    console.warn('[returns] settings load failed:', error.message);
    renderReturnWindowText();
  }
}

function renderReturnWindowText() {
  const label = returnWindowDays === 0 ? 'بدون حد' : `خلال ${returnWindowDays} يوماً`;
  document.querySelectorAll('[data-return-window-text]').forEach(node => { node.textContent = label; });
}

async function saveTaxSettings() {
  const status = document.getElementById('tax-settings-status');
  const rate = Number(document.getElementById('tax-rate')?.value);
  const registration_number = String(document.getElementById('tax-registration-number')?.value || '').trim();
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) { if (status) status.textContent = 'أدخل نسبة بين 0 و100.'; return; }
  try {
    const response = await fetch('/api/tax/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: Boolean(document.getElementById('tax-enabled')?.checked), rate, registration_number }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر حفظ الإعدادات');
    taxSettings = result;
    calculateCartTotals();
    if (status) status.textContent = result.enabled ? `تم تفعيل الضريبة بنسبة ${result.rate}%.` : 'الضريبة متوقفة.';
  } catch (error) { if (status) status.textContent = error.message; }
}

async function loadTallySettings() {
  const status = document.getElementById('tally-integration-status');
  if (!document.getElementById('tally-endpoint')) return;
  try {
    const response = await fetch('/api/integrations/tally/settings');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر تحميل إعدادات Tally.');
    for (const [field, value] of [['endpoint', data.endpoint], ['company-name', data.company_name], ['sales-ledger', data.sales_ledger], ['cash-ledger', data.cash_ledger], ['receivables-ledger', data.receivables_ledger], ['tax-ledger', data.tax_ledger]]) {
      const input = document.getElementById(`tally-${field}`); if (input) input.value = value || '';
    }
    if (status) status.textContent = `فواتير مؤكدة الإرسال سابقاً: ${Number(data.exported_sales_count || 0)}.`;
  } catch (error) { if (status) status.textContent = error.message; }
}

async function saveTallySettings() {
  if (!hasPermission('system_settings')) return showAppToast('إعداد الربط متاح للمدير فقط.');
  const status = document.getElementById('tally-integration-status');
  const body = Object.fromEntries([['endpoint', 'endpoint'], ['company_name', 'company-name'], ['sales_ledger', 'sales-ledger'], ['cash_ledger', 'cash-ledger'], ['receivables_ledger', 'receivables-ledger'], ['tax_ledger', 'tax-ledger']].map(([key, id]) => [key, document.getElementById(`tally-${id}`)?.value.trim() || '']));
  try {
    const response = await fetch('/api/integrations/tally/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر حفظ الإعدادات.');
    if (status) status.textContent = 'تم حفظ عنوان الاتصال وخرائط الحسابات.';
  } catch (error) { if (status) status.textContent = error.message; }
}

async function testTallyConnection() {
  const status = document.getElementById('tally-integration-status');
  try {
    const response = await fetch('/api/integrations/tally/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'فشل الاتصال.');
    if (status) status.textContent = `${data.message} العنوان: ${data.endpoint}`;
  } catch (error) { if (status) status.textContent = error.message; }
}

async function syncSalesToTally() {
  if (!hasPermission('import_export')) return showAppToast('لا تملك صلاحية تصدير الحسابات.');
  const status = document.getElementById('tally-integration-status');
  const from = document.getElementById('accounting-export-from')?.value || '';
  const to = document.getElementById('accounting-export-to')?.value || '';
  if (!await showAppConfirm('سيتم إرسال فواتير المبيعات غير المرسلة ضمن الفترة المحددة. تأكد من مطابقة أسماء الحسابات في Tally.')) return;
  try {
    if (status) status.textContent = 'جارٍ إرسال الفواتير إلى TallyPrime…';
    const response = await fetch('/api/integrations/tally/sync-sales', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر إرسال الفواتير.');
    if (status) status.textContent = `إرسال مكتمل: ${data.sent} ناجح، ${data.failed} فشل، من أصل ${data.total}. ${data.results.filter(row => row.status === 'error').slice(0, 3).map(row => `${row.invoice_number}: ${row.message}`).join(' | ')}`;
  } catch (error) { if (status) status.textContent = error.message; }
}

async function renderTaxReport() {
  const status = document.getElementById('tax-report-status');
  const body = document.getElementById('tax-report-body');
  try {
    const params = new URLSearchParams();
    const from = document.getElementById('tax-report-from')?.value || '';
    const to = document.getElementById('tax-report-to')?.value || '';
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const response = await fetch(`/api/reports/tax${params.size ? `?${params}` : ''}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر تحميل التقرير');
    document.getElementById('tax-report-sales').textContent = `${Number(result.sales_tax).toFixed(2)} ج.م`;
    document.getElementById('tax-report-returns').textContent = `${Number(result.returned_tax).toFixed(2)} ج.م`;
    document.getElementById('tax-report-net').textContent = `${Number(result.net_tax).toFixed(2)} ج.م`;
    if (body) body.innerHTML = (result.rows || []).map(row => `<tr><td class="p-3">${escapeHtml(row.date || '')}</td><td class="p-3">${row.type === 'return' ? 'تسوية مرتجع' : 'ضريبة بيع'}</td><td class="p-3">${escapeHtml(row.reference || '—')}</td><td class="p-3">${Number(row.rate || 0).toFixed(2)}%</td><td class="p-3 font-bold">${Number(row.amount).toFixed(2)} ج.م</td></tr>`).join('') || '<tr><td colspan="5" class="p-4 text-center">لا توجد حركات ضريبية في الفترة.</td></tr>';
    if (status) status.textContent = `عدد الحركات: ${result.rows.length}`;
  } catch (error) { if (status) status.textContent = error.message; }
}

async function saveLoyaltySettings() {
  const status = document.getElementById('loyalty-settings-status');
  const spend = Number(document.getElementById('loyalty-spend-per-point')?.value);
  if (!Number.isSafeInteger(spend) || spend < 1) { showAppToast('أدخل قيمة صحيحة لا تقل عن جنيه واحد.'); return; }
  try {
    const response = await fetch('/api/loyalty/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: Boolean(document.getElementById('loyalty-enabled')?.checked), spend_per_point: spend })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر حفظ الإعدادات');
    if (status) status.textContent = result.enabled ? `تم التفعيل: كل ${result.spend_per_point} ج.م تمنح نقطة.` : 'تم إيقاف برنامج نقاط الولاء.';
    await populateCustomerDropdowns();
    await updatePosLoyaltySummary();
  } catch (error) { showAppToast(error.message); }
}

async function saveSettingsMaster() {
  if (!hasPermission('system_settings')) return showAppToast('لا تملك صلاحية تعديل إعدادات النظام.');
  const status = document.getElementById('settings-master-status');
  const rate = Number(document.getElementById('tax-rate')?.value);
  const spend = Number(document.getElementById('loyalty-spend-per-point')?.value);
  const registration_number = String(document.getElementById('tax-registration-number')?.value || '').trim();
  const return_window_days = Number(document.getElementById('return-window-days')?.value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) { if (status) status.textContent = 'أدخل نسبة ضريبة بين 0 و100.'; return; }
  if (!Number.isSafeInteger(spend) || spend < 1) { if (status) status.textContent = 'أدخل قيمة ولاء صحيحة لا تقل عن 1.'; return; }
  if (!Number.isInteger(return_window_days) || return_window_days < 0 || return_window_days > 3650) { if (status) status.textContent = 'أدخل مدة ارتجاع صحيحة بين 0 و3650 يوماً.'; return; }
  try {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tax: { enabled: Boolean(document.getElementById('tax-enabled')?.checked), rate, registration_number },
        loyalty: { enabled: Boolean(document.getElementById('loyalty-enabled')?.checked), spend_per_point: spend },
        return_window_days
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر حفظ إعدادات النظام.');
    taxSettings = result.tax || taxSettings;
    returnWindowDays = Number(result.return_window_days ?? return_window_days);
    renderReturnWindowText();
    if (status) status.textContent = result.message || 'تم حفظ إعدادات الضريبة والولاء.';
    document.getElementById('tax-settings-status')?.replaceChildren(document.createTextNode(result.tax?.enabled ? `الضريبة مفعلة بنسبة ${result.tax.rate}%.` : 'الضريبة متوقفة.'));
    document.getElementById('loyalty-settings-status')?.replaceChildren(document.createTextNode(result.loyalty?.enabled ? `الولاء مفعّل: كل ${result.loyalty.spend_per_point} ج.م تمنح نقطة.` : 'الولاء متوقف.'));
    calculateCartTotals();
    await populateCustomerDropdowns();
  } catch (error) {
    if (status) status.textContent = error.message;
  }
}

function applyConfiguredPrintStyles() {
  const existing = document.getElementById('phase3-print-style');
  existing?.remove();
  const paper = printSettings.type === 'A4' ? 'A4' : `${printSettings.type} auto`;
  const width = printSettings.type === 'A4' ? '190mm' : printSettings.type;
  const fontSize = { small: '10px', medium: '12px', large: '15px' }[printSettings.font_size] || '12px';
  const style = document.createElement('style');
  style.id = 'phase3-print-style';
  style.textContent = `
    @media print {
      @page { size: ${paper}; margin: ${printSettings.type === 'A4' ? '12mm' : '3mm'}; }
      html, body { background: #fff !important; color: #111 !important; direction: rtl; }
      body * { visibility: hidden !important; }
      #modal-receipt { display: block !important; position: static !important; background: #fff !important; }
      #printable-receipt, #printable-receipt * { visibility: visible !important; }
      #printable-receipt { position: absolute; inset: 0 auto auto 0; width: ${width}; max-width: ${width}; margin: 0 auto; font-family: Cairo, Arial, sans-serif !important; font-size: ${fontSize} !important; color: #111 !important; background: #fff !important; }
      #printable-receipt .business-logo { max-height: 26mm; object-fit: contain; }
      ${printSettings.show_logo ? '' : '#printable-receipt .business-logo { display: none !important; }'}
      ${printSettings.show_tax ? '' : '#rec-tax-row, #rec-tax-registration-row { display: none !important; }'}
      .no-print { display: none !important; }
    }
    .print-font-${printSettings.font_size} { font-size: ${fontSize}; }
  `;
  document.head.appendChild(style);
  document.getElementById('printable-receipt')?.classList.add(`print-font-${printSettings.font_size}`);
}

async function loadPrintSettings() {
  const status = document.getElementById('print-settings-status');
  try {
    const response = await fetch('/api/settings/print');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر تحميل إعدادات الطباعة.');
    const print = { ...printSettings, ...(result || {}) };
    printSettings = print;
    const type = document.getElementById('print-type'); if (type) type.value = print.type || '80mm';
    const copies = document.getElementById('print-copies'); if (copies) copies.value = String(print.copies || 1);
    const showLogo = document.getElementById('print-show-logo'); if (showLogo) showLogo.checked = print.show_logo !== false;
    const showTax = document.getElementById('print-show-tax'); if (showTax) showTax.checked = print.show_tax !== false;
    const autoPrint = document.getElementById('print-auto-print'); if (autoPrint) autoPrint.checked = print.auto_print === true;
    const previewBeforePrint = document.getElementById('print-preview-before'); if (previewBeforePrint) previewBeforePrint.checked = print.preview_before_print !== false;
    const fontSize = document.getElementById('print-font-size'); if (fontSize) fontSize.value = print.font_size || 'medium';
    applyConfiguredPrintStyles();
    if (status) status.textContent = 'تم تحميل إعدادات الطباعة.';
  } catch (error) { if (status) status.textContent = error.message; }
}

async function savePrintSettings() {
  if (!hasPermission('system_settings')) return showAppToast('لا تملك صلاحية تعديل إعدادات الطباعة.');
  const status = document.getElementById('print-settings-status');
  const print = {
    type: document.getElementById('print-type')?.value || '80mm',
    copies: Number(document.getElementById('print-copies')?.value || 1),
    show_logo: Boolean(document.getElementById('print-show-logo')?.checked),
    show_tax: Boolean(document.getElementById('print-show-tax')?.checked),
    auto_print: Boolean(document.getElementById('print-auto-print')?.checked),
    preview_before_print: Boolean(document.getElementById('print-preview-before')?.checked),
    font_size: document.getElementById('print-font-size')?.value || 'medium'
  };
  if (!Number.isInteger(print.copies) || print.copies < 1 || print.copies > 3) { if (status) status.textContent = 'عدد النسخ يجب أن يكون بين 1 و3.'; return; }
  try {
    const response = await fetch('/api/settings/print', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(print) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر حفظ إعدادات الطباعة.');
    printSettings = result.print || print;
    applyConfiguredPrintStyles();
    if (status) status.textContent = 'تم حفظ إعدادات الطباعة.';
    showAppToast('تم حفظ إعدادات الطباعة.');
  } catch (error) { if (status) status.textContent = error.message; }
}

async function downloadSettingsBackup() {
  const status = document.getElementById('settings-backup-status');
  try {
    const response = await fetch('/api/backup');
    if (!response.ok) throw new Error((await response.json()).error || 'تعذر إنشاء النسخة الاحتياطية.');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `system_pos_backup_${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    if (status) status.textContent = 'تم تجهيز النسخة الاحتياطية للتنزيل.';
  } catch (error) { if (status) status.textContent = error.message; }
}

async function restoreSettingsBackup() {
  const input = document.getElementById('settings-restore-file');
  const status = document.getElementById('settings-backup-status');
  const file = input?.files?.[0];
  if (!file) { if (status) status.textContent = 'اختر ملف JSON أولاً.'; return; }
  if (!await showAppConfirm('ستحل النسخة المحددة محل البيانات الحالية. هل تريد المتابعة؟')) return;
  try {
    const response = await fetch('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await file.text() });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'فشلت استعادة النسخة.');
    if (status) status.textContent = result.message || 'تمت استعادة النسخة الاحتياطية.';
    window.location.reload();
  } catch (error) { if (status) status.textContent = error.message; }
}

async function loadSettingsMasterLicense() {
  const deviceInput = document.getElementById('settings-license-device-id');
  const status = document.getElementById('settings-license-status');
  try {
    const deviceId = await window.rawdaDesktop?.getDeviceId?.();
    if (deviceInput) deviceInput.value = deviceId || 'متاح في نسخة سطح المكتب فقط';
  } catch (_) { if (deviceInput) deviceInput.value = 'متاح في نسخة سطح المكتب فقط'; }
  try {
    const response = await fetch('/api/license/status');
    const data = await response.json();
    if (data.deviceId && deviceInput) deviceInput.value = data.deviceId;
    if (status) status.textContent = data.active ? (data.trial ? `الفترة التجريبية نشطة — متبقٍ ${data.daysRemaining || 0} يوم.` : 'الترخيص مفعّل على هذا الجهاز.') : (data.reason || 'الترخيص غير مفعّل.');
  } catch (error) { if (status) status.textContent = error.message; }
}

async function activateSettingsLicense() {
  const status = document.getElementById('settings-license-status');
  const licenseText = document.getElementById('settings-license-key')?.value?.trim() || '';
  if (!licenseText) { if (status) status.textContent = 'ألصق مفتاح التفعيل أولاً.'; return; }
  try {
    const desktopResult = await window.rawdaDesktop?.activateLicense?.(licenseText);
    const result = desktopResult || await (async () => {
      const response = await fetch('/api/license/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ licenseText }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.reason || 'فشل التفعيل.');
      return data;
    })();
    if (!result?.active) throw new Error(result?.reason || 'فشل التفعيل.');
    if (status) status.textContent = result.message || 'تم تفعيل الجهاز.';
  } catch (error) { if (status) status.textContent = error.message; }
}

function switchSettingsMasterTab(tabId, element) {
  document.querySelectorAll('[data-settings-master-section]').forEach(section => section.classList.toggle('active', section.dataset.settingsMasterSection === tabId));
  document.querySelectorAll('[data-settings-master-tab]').forEach(tab => tab.classList.toggle('active', tab === element));
  const titles = {
    general: ['عام والواجهة', 'تخصيص اللغة، الخطوط، وسلوك إغلاق البرنامج.'],
    business: ['إعدادات المتجر', 'بيانات النشاط والعملة واللغة والمنطقة الزمنية.'],
    tax: ['إعدادات الضريبة', 'تفعيل الضريبة ونسبتها ورقم التسجيل.'],
    print: ['إعدادات الطباعة', 'مقاس الورق وعدد النسخ وشكل الفاتورة.'],
    branches: ['الفروع والمخازن', 'فتح شاشة إدارة المخازن والفروع.'],
    users: ['المستخدمون والصلاحيات', 'فتح إدارة الحسابات والصلاحيات.'],
    network: ['الشبكة والبيانات', 'مسار قاعدة البيانات ومعلومات الشبكة.'],
    devices: ['الأجهزة الطرفية', 'الطابعة والميزان وشاشة العميل.'],
    hardware: ['الهاردوير', 'إدارة الطابعات والدرج والميزان والماسح في وضع Mock أو Native.'],
    backup: ['النسخ الاحتياطي', 'تصدير واستعادة بيانات النظام.'],
    license: ['الترخيص والتفعيل', 'معرّف الجهاز ومفتاح التفعيل.'],
    sms: ['ربط الموبايل', 'استقبال تحويلات المحافظ عبر SMS Forwarder.'],
    maintenance: ['الصيانة', 'تفعيل وضع الصيانة ورسالة المستخدمين.']
  };
  const [title, description] = titles[tabId] || titles.general;
  document.getElementById('settings-master-title')?.replaceChildren(document.createTextNode(title));
  document.getElementById('settings-master-description')?.replaceChildren(document.createTextNode(description));
  if (tabId === 'backup') {
    const backupSection = document.getElementById('settings-backup-section');
    const backupPanel = document.getElementById('backup-manager-panel');
    if (backupSection) { backupSection.hidden = false; backupSection.style.setProperty('display', 'block', 'important'); }
    if (backupPanel) { backupPanel.hidden = false; backupPanel.style.setProperty('display', 'block', 'important'); }
  }
  if (tabId === 'license') void loadSettingsMasterLicense();
  if (tabId === 'tax') { void loadTaxSettings(); void loadLoyaltySettings(); }
  if (tabId === 'print') void loadPrintSettings();
  if (tabId === 'sms') void window.SmsUI?.load();
  if (tabId === 'maintenance') void loadMaintenanceSettings();
  if (tabId === 'hardware') void window.HardwareUI?.load();
}

async function showCustomerLoyalty(id) {
  try {
    const response = await fetch(`/api/customers/${id}/loyalty`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر قراءة نقاط العميل');
    const history = (result.transactions || []).slice(0, 12).map(entry => `${entry.created_at}: ${Number(entry.points) > 0 ? '+' : ''}${entry.points} نقطة — ${entry.notes || entry.type}`).join('\n');
    showAppToast(`رصيد نقاط العميل: ${result.points}\n\n${history || 'لا توجد حركات نقاط بعد.'}`);
  } catch (error) { showAppToast(error.message); }
}

async function renderCustomers() {
  const custBody = document.getElementById('customers-table-body');
  const suppBody = document.getElementById('suppliers-table-body');

  const customers = await storage.getCustomers();
  const suppliers = await storage.getSuppliers();

  const modernBody = document.getElementById('modern-customers-body');
  if (modernBody) {
    modernBody.innerHTML = customers.map(customer => `<tr><td>${escapeHtml(customer.name || '')}</td><td dir="ltr">${escapeHtml(customer.phone || '—')}</td><td>${customer.credit_limit == null ? '—' : `${Number(customer.credit_limit).toFixed(2)} ج.م`}</td><td class="${Number(customer.balance || 0) > 0 ? 'text-rose-400' : 'text-emerald-400'}">${Number(customer.balance || 0).toFixed(2)} ج.م</td><td><button type="button" class="erp-table-link" onclick="showCustomerLedger(${Number(customer.id)})">كشف حساب</button></td></tr>`).join('') || '<tr><td colspan="5" class="erp-empty-cell">لا يوجد عملاء مسجلون.</td></tr>';
  }

  if (custBody) {
    custBody.innerHTML = '';
    customers.forEach(c => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="py-2.5 px-3 font-bold text-gray-900">${escapeHtml(c.name)}</td>
        <td class="py-2.5 px-3 font-mono">${escapeHtml(c.phone || '--')}</td>
        <td class="py-2.5 px-3 font-bold ${c.balance > 0 ? 'text-red-600' : 'text-green-700'}">${(c.balance || 0).toFixed(2)} ج.م${c.credit_limit != null ? `<div class="text-[10px] text-gray-500">السقف: ${Number(c.credit_limit).toFixed(2)} ج.م</div>` : ''}</td>
        <td class="py-2.5 px-3 font-extrabold text-amber-700">${Number(c.loyalty_points) || 0}</td>
        <td class="py-2.5 px-3 text-gray-500">${escapeHtml(c.notes || '--')}</td>
        <td class="py-2.5 px-3 whitespace-nowrap">
          <button onclick="showCustomerLedger(${c.id})" class="text-blue-700 bg-blue-50 px-2 py-1 rounded">السجل</button>
          <button onclick="showCustomerLoyalty(${c.id})" class="text-amber-700 bg-amber-50 px-2 py-1 rounded">النقاط</button>
          <button onclick="recordCustomerPayment(${c.id})" class="text-green-700 bg-green-50 px-2 py-1 rounded">سداد</button>
          <button onclick="editCustomerRecord(${c.id})" class="text-amber-700 bg-amber-50 px-2 py-1 rounded">تعديل</button>
          <button onclick="deleteCustomerRecord(${c.id})" class="text-red-700 bg-red-50 px-2 py-1 rounded">حذف</button>
        </td>
      `;
      custBody.appendChild(tr);
    });
  }

  if (suppBody) {
    suppBody.innerHTML = '';
    suppliers.forEach(s => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="py-2.5 px-3 font-bold text-gray-900">${escapeHtml(s.name)}</td>
        <td class="py-2.5 px-3 font-mono">${escapeHtml(s.phone || '--')}</td>
        <td class="py-2.5 px-3 font-bold text-gray-700">${(s.balance || 0).toFixed(2)} ج.م</td>
        <td class="py-2.5 px-3 text-gray-500">${escapeHtml(s.notes || '--')}</td>
        <td class="py-2.5 px-3 whitespace-nowrap">
          <button onclick="showSupplierLedger(${s.id})" class="text-blue-700 bg-blue-50 px-2 py-1 rounded">السجل</button>
          <button onclick="recordSupplierPayment(${s.id})" class="text-green-700 bg-green-50 px-2 py-1 rounded">سداد</button>
          <button onclick="editSupplierRecord(${s.id})" class="text-amber-700 bg-amber-50 px-2 py-1 rounded">تعديل</button>
          <button onclick="deleteSupplierRecord(${s.id})" class="text-red-700 bg-red-50 px-2 py-1 rounded">حذف</button>
        </td>
      `;
      suppBody.appendChild(tr);
    });
  }
}

async function handleCustomerSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('cust-name').value.trim();
  const phone = document.getElementById('cust-phone').value.trim();
  const notes = document.getElementById('cust-notes').value.trim();

  const creditLimitValue = document.getElementById('cust-credit-limit')?.value;
  const credit_limit = creditLimitValue === '' || creditLimitValue === undefined ? null : Number(creditLimitValue);
  if (credit_limit !== null && (!Number.isFinite(credit_limit) || credit_limit < 0)) return showAppToast('أدخل سقفًا ائتمانيًا صحيحًا أو اتركه فارغًا.');
  await storage.saveCustomer({ name, phone, notes, credit_limit });
  closeModal('modal-add-customer');
  await populateCustomerDropdowns();
  const normalizedPhone = normalizeCatalogText(phone);
  const createdCustomer = (await storage.getCustomers()).find(customer => normalizedPhone && normalizeCatalogText(customer.phone || '') === normalizedPhone);
  if (createdCustomer) {
    const selector = document.getElementById('pos-customer-select'); if (selector) { selector.value = String(createdCustomer.id); selector.dispatchEvent(new Event('change')); }
    const search = document.getElementById('pos-customer-phone-search'); if (search) search.value = phone;
    searchPosCustomerByPhone();
  }
  await renderCustomers();
  const creditInput = document.getElementById('cust-credit-limit'); if (creditInput) creditInput.value = '';
  showAppToast('تمت إضافة العميل بنجاح!');
}

async function handleSupplierSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('supp-name').value.trim();
  const phone = document.getElementById('supp-phone').value.trim();
  const notes = document.getElementById('supp-notes').value.trim();

  await storage.saveSupplier({ name, phone, notes });
  closeModal('modal-add-supplier');
  await populateCustomerDropdowns();
  await renderCustomers();
  showAppToast('تمت إضافة المورد بنجاح!');
}

async function showCustomerLedger(id) {
  const data = await storage.getCustomerLedger(id);
  printLedger(`كشف حساب العميل: ${data.customer.name}`, data.transactions, data.balance, data.total_debit, data.total_credit);
}
async function showSupplierLedger(id) {
  const data = await storage.getSupplierLedger(id);
  printLedger(`كشف حساب المورد: ${data.supplier.name}`, data.transactions, data.balance, data.total_debit, data.total_credit);
}

// Use in-app dialogs for data entry so the same controls work in Chromium and Electron.
function openAppFormDialog({ title, subtitle = '', fields = [], submitLabel = 'حفظ' }) {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'fixed inset-0 z-[80] modal-backdrop flex items-center justify-center p-4';
    const fieldMarkup = fields.map((field, index) => `
      <label class="block text-right text-xs font-bold text-gray-700 mb-3">
        ${escapeHtml(field.label)}
        ${field.type === 'textarea'
          ? `<textarea data-dialog-field="${index}" rows="3" class="mt-1.5 w-full rounded-xl border border-gray-200 px-3 py-2 text-xs" placeholder="${escapeHtml(field.placeholder || '')}">${escapeHtml(field.value || '')}</textarea>`
          : field.type === 'select'
            ? `<select data-dialog-field="${index}" ${field.disabled ? 'disabled' : ''} class="mt-1.5 w-full rounded-xl border border-gray-200 px-3 py-2 text-xs">${(field.options || []).map(option => `<option value="${escapeHtml(option.value)}" ${String(option.value) === String(field.value) ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select>`
          : `<input data-dialog-field="${index}" type="${field.type || 'text'}" ${field.type === 'number' ? `step="${field.step || 'any'}"${field.min !== undefined ? ` min="${field.min}"` : ''}${field.max !== undefined ? ` max="${field.max}"` : ''}` : ''} value="${escapeHtml(field.value || '')}" class="mt-1.5 w-full rounded-xl border border-gray-200 px-3 py-2 text-xs" placeholder="${escapeHtml(field.placeholder || '')}">`}
      </label>`).join('');
    backdrop.innerHTML = `
      <div class="apple-form-dialog bg-white rounded-3xl w-full max-w-md p-6 shadow-2xl border border-gray-200">
        <div class="flex items-start justify-between gap-3 mb-5">
          <div><h3 class="text-base font-black text-gray-900">${escapeHtml(title)}</h3><p class="text-[11px] text-gray-500 mt-1">${escapeHtml(subtitle)}</p></div>
          <button type="button" data-dialog-cancel class="w-9 h-9 rounded-full bg-gray-100 text-gray-500 text-xl leading-none">×</button>
        </div>
        <form data-dialog-form>${fieldMarkup}
          <div class="flex gap-2 pt-2">
            <button type="submit" class="flex-1 py-2.5 rounded-xl btn-pink text-xs font-bold">${escapeHtml(submitLabel)}</button>
            <button type="button" data-dialog-cancel class="px-5 py-2.5 rounded-xl bg-gray-100 text-gray-600 text-xs font-bold">إلغاء</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(backdrop);
    const finish = values => { backdrop.remove(); resolve(values); };
    backdrop.querySelectorAll('[data-dialog-cancel]').forEach(button => button.addEventListener('click', () => finish(null)));
    backdrop.querySelector('[data-dialog-form]').addEventListener('submit', event => {
      event.preventDefault();
      const values = fields.map((_, index) => backdrop.querySelector(`[data-dialog-field="${index}"]`).value.trim());
      finish(values);
    });
    backdrop.querySelector('[data-dialog-field="0"]')?.focus();
  });
}

function printLedger(title, transactions, balance, totalDebit = 0, totalCredit = 0) {
  if (!hasPermission('print_pdf')) return showAppToast('لا تملك صلاحية الطباعة.');
  const win = window.open('', '_blank', 'width=800,height=700');
  if (!win) { showAppToast('اسمح بفتح نافذة الطباعة من إعدادات المتصفح.'); return; }
  const rows = (transactions || []).map(t => `<tr><td>${escapeHtml(t.created_at || '')}</td><td>${escapeHtml(t.type || '')}</td><td>${Number(t.debit || 0).toFixed(2)}</td><td>${Number(t.credit || 0).toFixed(2)}</td><td>${escapeHtml(t.notes || t.reference_id || '')}</td></tr>`).join('');
  win.document.write(`<html dir="rtl"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:Arial;padding:25px}h2{text-align:center}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #999;padding:8px;text-align:right}th{background:#eee}.total{margin-top:18px;font-size:18px;font-weight:bold}</style></head><body><h2>${escapeHtml(title)}</h2><div class="total">الإجمالي: ${Number(totalDebit || 0).toFixed(2)} ج.م — المدفوع: ${Number(totalCredit || 0).toFixed(2)} ج.م — المتبقي: ${Number(balance || 0).toFixed(2)} ج.م</div><table><thead><tr><th>التاريخ</th><th>النوع</th><th>مدين</th><th>دائن</th><th>البيان</th></tr></thead><tbody>${rows || '<tr><td colspan="5">لا توجد حركات</td></tr>'}</tbody></table><script>window.onload=()=>window.print();</script></body></html>`);
  win.document.close();
}
async function recordCustomerPayment(id) {
  const result = await openAppFormDialog({
    title: 'تسجيل سداد من العميل',
    subtitle: 'اكتب قيمة المبلغ المدفوع ثم اضغط حفظ.',
    fields: [{ label: 'المبلغ المدفوع (ج.م)', type: 'number', placeholder: '0.00' }],
    submitLabel: 'تسجيل السداد'
  });
  const amount = Number(result?.[0]);
  if (!Number.isFinite(amount) || amount <= 0) return;
  try { await storage.payCustomer(id, amount, 'سداد من شاشة العملاء'); window.playSound?.('payment'); await renderCustomers(); await refreshDashboard(); showAppToast('تم تسجيل السداد بنجاح.', { sound: false }); }
  catch (err) { showAppToast(err.message); }
}
async function recordSupplierPayment(id) {
  const result = await openAppFormDialog({
    title: 'تسجيل سداد للمورد',
    subtitle: 'اكتب قيمة المبلغ المدفوع ثم اضغط حفظ.',
    fields: [{ label: 'المبلغ المدفوع (ج.م)', type: 'number', placeholder: '0.00' }],
    submitLabel: 'تسجيل السداد'
  });
  const amount = Number(result?.[0]);
  if (!Number.isFinite(amount) || amount <= 0) return;
  try { await storage.paySupplier(id, amount, 'سداد من شاشة الموردين'); window.playSound?.('payment'); await renderCustomers(); await refreshDashboard(); showAppToast('تم تسجيل السداد بنجاح.', { sound: false }); }
  catch (err) { showAppToast(err.message); }
}
async function deleteCustomerRecord(id) {
  if (!await showAppConfirm('هل تريد حذف العميل؟')) return;
  try { await storage.deleteCustomer(id); await renderCustomers(); await populateCustomerDropdowns(); } catch (err) { showAppToast(err.message); }
}
async function editCustomerRecord(id) {
  const customer = (await storage.getCustomers()).find(c => c.id === id); if (!customer) return;
  const result = await openAppFormDialog({
    title: 'تعديل بيانات العميل',
    subtitle: 'حدّث البيانات ثم اضغط حفظ التعديلات.',
    fields: [
      { label: 'اسم العميل', value: customer.name },
      { label: 'رقم الهاتف', value: customer.phone || '' },
      { label: 'السقف الائتماني (اتركه فارغًا بلا حد)', type: 'number', min: 0, value: customer.credit_limit ?? '' },
      { label: 'الملاحظات', type: 'textarea', value: customer.notes || '' }
    ],
    submitLabel: 'حفظ التعديلات'
  });
  if (!result || !result[0]) return;
  const [name, phone, creditValue, notes] = result;
  const credit_limit = creditValue === '' ? null : Number(creditValue);
  if (credit_limit !== null && (!Number.isFinite(credit_limit) || credit_limit < 0)) return showAppToast('أدخل سقفًا ائتمانيًا صحيحًا أو اتركه فارغًا.');
  try { await storage.updateCustomer(id, { name, phone, notes, credit_limit }); await renderCustomers(); await populateCustomerDropdowns(); } catch (err) { showAppToast(err.message); }
}
async function editSupplierRecord(id) {
  const supplier = (await storage.getSuppliers()).find(s => s.id === id); if (!supplier) return;
  const result = await openAppFormDialog({
    title: 'تعديل بيانات المورد',
    subtitle: 'حدّث البيانات ثم اضغط حفظ التعديلات.',
    fields: [
      { label: 'اسم المورد', value: supplier.name },
      { label: 'رقم الهاتف', value: supplier.phone || '' },
      { label: 'الملاحظات', type: 'textarea', value: supplier.notes || '' }
    ],
    submitLabel: 'حفظ التعديلات'
  });
  if (!result || !result[0]) return;
  const [name, phone, notes] = result;
  try { await storage.updateSupplier(id, { name, phone, notes }); await renderCustomers(); await populateCustomerDropdowns(); } catch (err) { showAppToast(err.message); }
}
async function deleteSupplierRecord(id) {
  if (!await showAppConfirm('هل تريد حذف المورد؟')) return;
  try { await storage.deleteSupplier(id); await renderCustomers(); await populateCustomerDropdowns(); } catch (err) { showAppToast(err.message); }
}

// ----------------------------------------------------
// Barcode Generator & Printing
// ----------------------------------------------------
async function initBarcodeScreen() {
  const sel = document.getElementById('barcode-select-product');
  if (!sel) return;

  const products = await storage.getProducts();
  sel.innerHTML = '';
  products.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} - [${p.barcode}]`;
    sel.appendChild(opt);
  });

  renderBarcodePreview();
}

async function renderBarcodePreview() {
  const sel = document.getElementById('barcode-select-product');
  const countInput = document.getElementById('barcode-print-count');
  const container = document.getElementById('barcode-sheet-preview');
  if (!sel || !container) return;

  const prodId = parseInt(sel.value);
  const count = parseInt(countInput.value) || 12;

  const products = await storage.getProducts();
  const prod = products.find(p => p.id === prodId);
  if (!prod) return;

  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const label = document.createElement('div');
    label.className = 'border-2 border-dashed border-gray-300 p-3 rounded-xl text-center bg-white shadow-sm flex flex-col items-center justify-between';
    const svgId = `barcode-svg-${i}`;
    label.innerHTML = `
      <p class="text-[10px] font-bold text-gray-500">${escapeHtml(networkInfo.business_profile?.business_name || '')}${networkInfo.business_profile?.activity ? ` - ${escapeHtml(networkInfo.business_profile.activity)}` : ''}</p>
      <h5 class="text-xs font-black text-gray-900 truncate max-w-full my-1">${escapeHtml(prod.name)}</h5>
      <svg id="${svgId}" class="max-h-12 w-full"></svg>
      <p class="text-sm font-extrabold text-[#D6336C] mt-1">${prod.sale_price.toFixed(2)} ج.م</p>
    `;
    container.appendChild(label);

    setTimeout(() => {
      // Intentionally ignored: optional barcode preview may remain unavailable
      try {
        JsBarcode(`#${svgId}`, prod.barcode, {
          format: "CODE128",
          height: 30,
          displayValue: true,
          fontSize: 10
        });
      } catch (e) {}
    }, 10);
  }
}

function printBarcodeSheet() {
  if (!hasPermission('print_pdf')) return showAppToast('لا تملك صلاحية الطباعة.');
  window.print();
}

// ----------------------------------------------------
// Financial Reports & Profit Engine
// ----------------------------------------------------
async function renderReports() {
  const reportTitle = document.getElementById('detailed-financial-report-title');
  if (reportTitle && !explicitDetailedReportTitle) reportTitle.textContent = 'التقارير التفصيلية';
  const skipDetailedReport = pendingExplicitDetailedReport;
  pendingExplicitDetailedReport = false;
  void renderModernReports();
  const dashData = await storage.getDashboardData();
  const products = await storage.getProducts();
  const sales = await storage.getSales();
  await renderShiftReport(sales);
  await renderExpensesReport();
  await renderCashVouchers();
  await renderTaxReport();
  if (!skipDetailedReport) await renderDetailedFinancialReport();

  document.getElementById('report-month-sales').textContent = `${dashData.month_sales.toFixed(2)} ج.م`;
  const monthKey = new Date().toISOString().slice(0, 7);
  const financeSummary = await storage.getFinanceSummary();
  const monthlyExpenses = (financeSummary.cash_transactions || []).filter(t => t.type === 'expense' && String(t.created_at || '').slice(0, 7) === monthKey).reduce((sum, t) => sum + Number(t.amount || 0), 0);
  document.getElementById('report-month-profit').textContent = `${(dashData.month_profit - monthlyExpenses).toFixed(2)} ج.م`;

  const totalCost = products.reduce((sum, p) => sum + (p.quantity * p.cost_price), 0);
  document.getElementById('report-inventory-cost').textContent = `${totalCost.toFixed(2)} ج.م`;

  // Item profitability report
  const tableBody = document.getElementById('report-profit-table-body');
  if (tableBody) {
    tableBody.innerHTML = '';

    const productSalesMap = {};
    sales.forEach(s => {
      (s.items || []).forEach(it => {
        if (!productSalesMap[it.product_id]) {
          productSalesMap[it.product_id] = {
            name: it.product_name,
            qty: 0,
            revenue: 0,
            cost: 0,
            profit: 0
          };
        }
        productSalesMap[it.product_id].qty += it.quantity;
        productSalesMap[it.product_id].revenue += it.total;
        const c = (it.cost_price || 0) * it.quantity;
        productSalesMap[it.product_id].cost += c;
        productSalesMap[it.product_id].profit += (it.total - c);
      });
    });

    Object.values(productSalesMap).forEach(p => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="py-2.5 px-3 font-bold text-gray-900">${escapeHtml(p.name)}</td>
        <td class="py-2.5 px-3 font-bold text-center">${p.qty}</td>
        <td class="py-2.5 px-3 font-semibold text-gray-600">${p.qty ? (p.cost / p.qty).toFixed(2) : 0} ج.م</td>
        <td class="py-2.5 px-3 font-semibold text-gray-600">${p.qty ? (p.revenue / p.qty).toFixed(2) : 0} ج.م</td>
        <td class="py-2.5 px-3 font-bold text-gray-900">${p.revenue.toFixed(2)} ج.م</td>
        <td class="py-2.5 px-3 font-black text-green-700">+${p.profit.toFixed(2)} ج.م</td>
      `;
      tableBody.appendChild(tr);
    });
  }
}

async function renderModernReports() {
  const host = document.getElementById('modern-reports-body');
  if (!host) return;
  try {
    const [dashboard, purchases, finance] = await Promise.all([storage.getDashboardData(), storage.getPurchases(), storage.getFinanceSummary()]);
    const purchaseTotal = purchases.reduce((sum, purchase) => sum + Number(purchase.total || 0), 0);
    host.innerHTML = [
      ['fa-chart-line', 'تقرير المبيعات', `${Number(dashboard.month_sales || 0).toFixed(2)} ج.م`, 'accent'],
      ['fa-file-invoice-dollar', 'تقرير المشتريات', `${purchaseTotal.toFixed(2)} ج.م`, 'success'],
      ['fa-wallet', 'تقرير الخزينة', `${Number(finance.cash_balance || 0).toFixed(2)} ج.م`, 'warning']
    ].map(([icon, label, value, tone]) => {
      const kind = label === 'تقرير المبيعات' ? 'sales' : label === 'تقرير المشتريات' ? 'purchases' : 'treasury';
      return `<article class="erp-report-card ${tone}" role="button" tabindex="0" data-report-card-kind="${kind}" onclick="openReportCard('${kind}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openReportCard('${kind}')}" aria-label="فتح ${label}"><i class="fa-solid ${icon}"></i><span>${label}</span><strong>${value}</strong><small>اضغط لفتح التفاصيل</small></article>`;
    }).join('');
  } catch (error) { host.innerHTML = `<p class="erp-empty-cell">${escapeHtml(error.message)}</p>`; }
}

let lastDetailedFinancialReport = null;
let detailedFinancialReportRequest = 0;
let reportsRenderPromise = null;
let pendingExplicitDetailedReport = false;
let explicitDetailedReportTitle = '';
const reportMoney = value => `${Number(value || 0).toFixed(2)} ج.م`;
function reportDetailItems(items, type) {
  const rows = (items || []).map(item => {
    const quantity = Number(item.quantity || 0);
    const unit = Number(type === 'purchase' ? item.unit_cost : item.unit_price || 0);
    const total = Number(item.total ?? (quantity * unit) - Number(item.discount || 0));
    return `<tr><td class="p-2">${escapeHtml(item.product_name || 'صنف غير معروف')}</td><td class="p-2">${escapeHtml(item.product_barcode || '')}</td><td class="p-2">${quantity}</td><td class="p-2">${reportMoney(unit)}</td><td class="p-2">${reportMoney(total)}</td></tr>`;
  }).join('');
  return `<div class="overflow-x-auto"><table class="w-full text-right"><thead><tr><th class="p-2">الصنف</th><th class="p-2">الباركود</th><th class="p-2">الكمية</th><th class="p-2">سعر الوحدة</th><th class="p-2">الإجمالي</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="p-3 text-center">لا توجد تفاصيل أصناف مطابقة.</td></tr>'}</tbody></table></div>`;
}
function renderDetailedInvoiceRows(rows, type) {
  return (rows || []).map(row => {
    const reference = type === 'purchase' ? `PUR-${row.id}` : row.invoice_number;
    const party = type === 'purchase' ? row.supplier_name : row.customer_name;
    const user = type === 'purchase' ? row.user_name : row.cashier_name;
    const details = reportDetailItems(row.items, type);
    return `<tr class="border-t"><td class="p-2">${escapeHtml(row.created_at || '')}</td><td class="p-2 font-bold">${escapeHtml(reference || '')}</td><td class="p-2">${escapeHtml(party || '')}</td><td class="p-2">${escapeHtml(user || '')}</td><td class="p-2 font-bold">${reportMoney(row.total)}</td><td class="p-2"><details><summary class="cursor-pointer font-bold text-rose-800">عرض الأصناف (${(row.items || []).length})</summary>${details}</details></td></tr>`;
  }).join('') || '<tr><td colspan="6" class="p-4 text-center text-gray-600">لا توجد فواتير في الفترة المحددة.</td></tr>';
}
async function renderDetailedFinancialReport() {
  const status = document.getElementById('detailed-report-status');
  if (!status) return;
  const requestId = ++detailedFinancialReportRequest;
  const kind = document.getElementById('detailed-report-kind')?.value || 'profit-loss';
  const params = new URLSearchParams({ kind });
  const values = {
    from: document.getElementById('detailed-report-from')?.value || '',
    to: document.getElementById('detailed-report-to')?.value || '',
    branch_id: document.getElementById('detailed-report-branch')?.value || '',
    warehouse_id: document.getElementById('detailed-report-warehouse')?.value || '',
    product: document.getElementById('detailed-report-product')?.value?.trim() || '',
    category_id: document.getElementById('detailed-report-category')?.value || '',
    party_id: document.getElementById('detailed-report-party')?.value || '',
    user_id: document.getElementById('detailed-report-user')?.value || ''
  };
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  status.textContent = 'جارٍ إعداد التقرير…';
  try {
    const response = await fetch(`/api/reports/detailed?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر إعداد التقرير التفصيلي.');
    if (requestId !== detailedFinancialReportRequest) return;
    lastDetailedFinancialReport = data;
    const replaceOptions = (id, rows, emptyLabel, selectedValue, label = row => row.name) => {
      const select = document.getElementById(id);
      if (!select) return;
      const current = selectedValue ?? select.value;
      select.innerHTML = `<option value="">${escapeHtml(emptyLabel)}</option>${(rows || []).map(row => `<option value="${Number(row.id)}">${escapeHtml(label(row))}</option>`).join('')}`;
      if ([...select.options].some(option => option.value === String(current))) select.value = String(current);
    };
    replaceOptions('detailed-report-branch', data.options.branches, 'اختر الفرع', values.branch_id || data.filters.branch_id);
    replaceOptions('detailed-report-warehouse', data.options.warehouses, 'كل المخازن', values.warehouse_id);
    replaceOptions('detailed-report-category', data.options.categories, 'كل الفئات', values.category_id);
    const partyRows = kind === 'purchases' ? data.options.suppliers : data.options.customers;
    replaceOptions('detailed-report-party', partyRows, kind === 'purchases' ? 'كل الموردين' : 'كل العملاء', values.party_id);
    replaceOptions('detailed-report-user', data.options.users, 'كل المستخدمين', values.user_id);
    document.querySelectorAll('#detailed-financial-report [data-report-kind]').forEach(element => {
      const allowed = String(element.dataset.reportKind || '').split(/\s+/);
      element.classList.toggle('hidden', !allowed.includes(kind));
    });
    const summary = data.summary || {};
    for (const [id, key] of [['detailed-report-revenue','sales_revenue'],['detailed-report-cogs','cogs'],['detailed-report-returns','returns'],['detailed-report-expenses','expenses'],['detailed-report-delivery-wages','delivery_wages'],['detailed-report-net','net_profit'],['detailed-report-owner-deposits','owner_deposits']]) {
      const element = document.getElementById(id); if (element) element.textContent = reportMoney(summary[key]);
    }
    for (const [id, key] of [['detailed-report-sales-total','sales_revenue'],['detailed-report-sales-paid','sales_paid'],['detailed-report-sales-due','sales_due'],['detailed-report-purchases-total','purchases_total'],['detailed-report-purchases-paid','purchases_paid'],['detailed-report-purchases-due','purchases_due']]) {
      const element = document.getElementById(id); if (element) element.textContent = reportMoney(summary[key]);
    }
    const salesBody = document.getElementById('detailed-report-sales-body');
    const purchasesBody = document.getElementById('detailed-report-purchases-body');
    if (salesBody) salesBody.innerHTML = renderDetailedInvoiceRows(data.sales, 'sale');
    if (purchasesBody) purchasesBody.innerHTML = renderDetailedInvoiceRows(data.purchases, 'purchase');
    const renderLineRows = (id, rows, columns, emptyText) => {
      const body = document.getElementById(id); if (!body) return;
      body.innerHTML = (rows || []).map(row => `<tr class="border-t">${columns.map(([label, value]) => `<td class="p-2">${escapeHtml(String(value(row) ?? '—'))}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${columns.length}" class="p-3 text-center">${escapeHtml(emptyText)}</td></tr>`;
    };
    renderLineRows('detailed-report-returns-body', data.returns, [['date', row => row.created_at], ['invoice', row => row.invoice_number], ['customer', row => row.customer_name], ['amount', row => reportMoney(Number(row.amount || 0) + Number(row.tax_amount || 0))], ['reason', row => row.reason]], 'لا توجد مرتجعات في الفترة المحددة.');
    renderLineRows('detailed-report-expenses-body', data.expenses, [['date', row => row.created_at], ['reference', row => row.reference_id], ['notes', row => row.notes], ['amount', row => reportMoney(row.amount)]], 'لا توجد مصروفات في الفترة المحددة.');
    renderLineRows('detailed-report-delivery-body', data.delivery_wages, [['date', row => row.delivered_at], ['invoice', row => row.invoice_number], ['rider', row => row.rider_name], ['amount', row => reportMoney(row.delivery_fee_rider)]], 'لا توجد أجور توصيل في الفترة المحددة.');
    renderLineRows('detailed-report-owner-body', data.owner_deposits, [['date', row => row.created_at], ['reference', row => row.reference_id], ['notes', row => row.notes], ['amount', row => reportMoney(row.amount)]], 'لا توجد إيداعات مالك مسجلة في الفترة المحددة.');
    document.getElementById('detailed-report-sales-count').textContent = `(${summary.sales_count || 0})`;
    document.getElementById('detailed-report-purchases-count').textContent = `(${summary.purchases_count || 0})`;
    const period = values.from || values.to ? `${values.from || 'البداية'} — ${values.to || 'اليوم'}` : 'كل الفترات';
    status.textContent = `${data.branch_name} · ${period} · المبيعات ${summary.sales_count || 0} · المشتريات ${summary.purchases_count || 0}`;
  } catch (error) {
    if (requestId !== detailedFinancialReportRequest) return;
    status.textContent = error.message || 'تعذر إعداد التقرير.';
  }
}
function clearDetailedFinancialReportFilters() {
  for (const id of ['detailed-report-from','detailed-report-to','detailed-report-warehouse','detailed-report-product','detailed-report-category','detailed-report-party','detailed-report-user']) {
    const element = document.getElementById(id); if (element) element.value = '';
  }
  renderDetailedFinancialReport();
}
async function exportDetailedFinancialReport() {
  if (!hasPermission('import_export')) return showAppToast('لا تملك صلاحية التصدير.');
  if (!lastDetailedFinancialReport) await renderDetailedFinancialReport();
  const data = lastDetailedFinancialReport;
  if (!data) return showAppToast('تعذر تحميل بيانات التقرير.');
  const summary = data.summary || {};
  const sheets = [
    ['ملخص الربح والخسارة', [['البند','القيمة'],['إيراد المبيعات',summary.sales_revenue],['تكلفة البضاعة المباعة',summary.cogs],['المرتجعات',summary.returns],['المصروفات',summary.expenses],['أجور التوصيل',summary.delivery_wages],['صافي الربح / الخسارة',summary.net_profit],['إيداعات المالك (مفصولة)',summary.owner_deposits]]],
    ['فواتير المبيعات', [['التاريخ','الفاتورة','العميل','الكاشير','الإجمالي'], ...(data.sales || []).map(row => [row.created_at,row.invoice_number,row.customer_name,row.cashier_name,Number(row.total || 0)])]],
    ['أصناف المبيعات', [['الفاتورة','الصنف','الكمية','سعر الوحدة','التكلفة وقت البيع','الإجمالي'], ...(data.sales || []).flatMap(row => (row.items || []).map(item => [row.invoice_number,item.product_name,Number(item.quantity || 0),Number(item.unit_price || 0),Number(item.cost_price || 0),Number(item.total || 0)]))]],
    ['فواتير المشتريات', [['التاريخ','المرجع','المورد','المستخدم','الإجمالي'], ...(data.purchases || []).map(row => [row.created_at,`PUR-${row.id}`,row.supplier_name,row.user_name,Number(row.total || 0)])]],
    ['أصناف المشتريات', [['المرجع','الصنف','الكمية','تكلفة الوحدة','الإجمالي'], ...(data.purchases || []).flatMap(row => (row.items || []).map(item => [`PUR-${row.id}`,item.product_name,Number(item.quantity || 0),Number(item.unit_cost || 0),Number(item.quantity || 0) * Number(item.unit_cost || 0)]))]],
    ['المرتجعات والمصروفات والتوصيل', [['التاريخ','النوع','المرجع','البيان','القيمة'], ...(data.returns || []).map(row => [row.created_at,'مرتجع',row.invoice_number,row.reason || '',Number(row.amount || 0) + Number(row.tax_amount || 0)]), ...(data.expenses || []).map(row => [row.created_at,'مصروف',row.reference_id || '',row.notes || '',Number(row.amount || 0)]), ...(data.delivery_wages || []).map(row => [row.delivered_at || row.updated_at,'أجر توصيل',row.invoice_number,'أجر الطيار',Number(row.delivery_fee_rider || 0)])]],
    ['إيداعات المالك', [['التاريخ','المرجع','البيان','القيمة'], ...(data.owner_deposits || []).map(row => [row.created_at,row.reference_id || '',row.notes || '',Number(row.amount || 0)])]]
  ];
  const workbook = buildReportWorkbook(sheets);
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', compression: true });
  downloadBlob(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `التقرير_التفصيلي_${new Date().toISOString().slice(0, 10)}.xlsx`);
}
function printDetailedFinancialReport() {
  document.body.classList.add('detailed-report-print');
  const reset = () => document.body.classList.remove('detailed-report-print');
  window.addEventListener('afterprint', reset, { once: true });
  window.print();
}

async function openDashboardReport(section) {
  switchTab('reports');
  requestAnimationFrame(() => document.getElementById(`report-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function localReportDate() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

async function openReportCard(kind) {
  pendingExplicitDetailedReport = true;
  explicitDetailedReportTitle = kind === 'purchases' ? 'تفاصيل تقرير المشتريات' : kind === 'sales' ? 'تفاصيل تقرير المبيعات' : '';
  switchTab('reports');
  requestAnimationFrame(async () => {
    if (kind === 'treasury') {
      await renderCashVouchers();
      document.getElementById('report-cash-vouchers')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const select = document.getElementById('detailed-report-kind');
    if (!select) return;
    select.value = kind === 'purchases' ? 'purchases' : 'sales';
    const title = document.getElementById('detailed-financial-report-title');
    if (title) title.textContent = kind === 'purchases' ? 'تفاصيل تقرير المشتريات' : 'تفاصيل تقرير المبيعات';
    for (const id of ['detailed-report-from','detailed-report-to','detailed-report-branch','detailed-report-warehouse','detailed-report-product','detailed-report-category','detailed-report-party','detailed-report-user']) {
      const element = document.getElementById(id);
      if (element) element.value = '';
    }
    await renderDetailedFinancialReport();
    document.getElementById('detailed-financial-report')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

async function openDashboardMetricDetail(metric) {
  pendingExplicitDetailedReport = true;
  explicitDetailedReportTitle = metric === 'profit' ? 'تفاصيل أرباح اليوم' : metric === 'invoices' ? 'تفاصيل فواتير اليوم' : 'تفاصيل مبيعات اليوم';
  switchTab('reports');
  requestAnimationFrame(async () => {
    const select = document.getElementById('detailed-report-kind');
    if (!select) return;
    const today = localReportDate();
    const kind = metric === 'profit' ? 'profit-loss' : 'sales';
    select.value = kind;
    const title = document.getElementById('detailed-financial-report-title');
    if (title) title.textContent = metric === 'profit' ? 'تفاصيل أرباح اليوم' : metric === 'invoices' ? 'تفاصيل فواتير اليوم' : 'تفاصيل مبيعات اليوم';
    const from = document.getElementById('detailed-report-from');
    const to = document.getElementById('detailed-report-to');
    if (from) from.value = today;
    if (to) to.value = today;
    for (const id of ['detailed-report-branch','detailed-report-warehouse','detailed-report-product','detailed-report-category','detailed-report-party','detailed-report-user']) {
      const element = document.getElementById(id);
      if (element) element.value = '';
    }
    await renderDetailedFinancialReport();
    document.getElementById('detailed-financial-report')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

async function renderShiftReport(salesData) {
  const body = document.getElementById('shift-report-body');
  if (!body) return;
  const sales = salesData || await storage.getSales();
  const dateInput = document.getElementById('shift-report-date');
  const today = new Date();
  const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (dateInput && !dateInput.value) dateInput.value = localToday;
  const day = dateInput?.value || localToday;
  const shifts = new Map();
  sales.filter(s => String(s.created_at || '').slice(0, 10) === day && s.status !== 'returned').forEach(s => {
    const key = s.user_id || s.cashier_name || 'unknown';
    const row = shifts.get(key) || { name: s.cashier_name || 'كاشير', count: 0, total: 0, paid: 0, profit: 0 };
    row.count += 1;
    row.total += Number(s.total) || 0;
    row.paid += Number(s.paid_amount) || 0;
    (s.items || []).forEach(item => { row.profit += (Number(item.unit_price) - Number(item.cost_price || 0)) * Number(item.quantity || 0) - Number(item.discount || 0); });
    shifts.set(key, row);
  });
  body.innerHTML = [...shifts.values()].map(row => `<tr><td class="p-3 font-extrabold">${escapeHtml(row.name)}</td><td class="p-3 font-bold">${row.count}</td><td class="p-3 font-bold">${row.total.toFixed(2)} ج.م</td><td class="p-3 font-bold">${row.paid.toFixed(2)} ج.م</td><td class="p-3 font-extrabold text-green-800">${row.profit.toFixed(2)} ج.م</td></tr>`).join('') || '<tr><td colspan="5" class="p-4 text-center font-bold text-slate-600">لا توجد مبيعات في هذا اليوم.</td></tr>';
}

async function renderExpensesReport() {
  const body = document.getElementById('expenses-report-body');
  if (!body) return;
  const status = document.getElementById('expenses-report-status');
  body.innerHTML = '<tr><td colspan="4" class="p-4 text-center text-gray-500">جارٍ تحميل المصروفات…</td></tr>';
  try {
    const from = document.getElementById('expenses-from')?.value || '';
    const to = document.getElementById('expenses-to')?.value || '';
    const expenses = await storage.getExpenses(from, to);
    document.getElementById('expenses-total').textContent = `${expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0).toFixed(2)} ج.م`;
    body.innerHTML = expenses.map(item => `<tr><td class="p-3 font-semibold">${escapeHtml(item.created_at || '')}</td><td class="p-3 font-extrabold">${escapeHtml(item.notes || 'مصروف')}</td><td class="p-3 font-semibold">${escapeHtml(item.reference_id || '—')}</td><td class="p-3 font-black text-red-800">${Number(item.amount || 0).toFixed(2)} ج.م</td></tr>`).join('') || '<tr><td colspan="4" class="p-4 text-center font-bold text-slate-600">لا توجد مصروفات في الفترة المحددة.</td></tr>';
    if (status) status.textContent = `عدد المصروفات: ${expenses.length}`;
  } catch (error) {
    document.getElementById('expenses-total').textContent = '—';
    body.innerHTML = `<tr><td colspan="4" class="p-4 text-center font-bold text-red-700">${escapeHtml(error.message || 'تعذر تحميل المصروفات.')}</td></tr>`;
    if (status) status.textContent = 'تعذر تحميل القائمة';
  }
}

async function clearExpenseDateFilter() {
  const from = document.getElementById('expenses-from');
  const to = document.getElementById('expenses-to');
  if (from) from.value = '';
  if (to) to.value = '';
  await renderExpensesReport();
}

async function addExpense() {
  if (!hasPermission('add')) return showAppToast('لا تملك صلاحية إضافة المصروفات.');
  const values = await openAppFormDialog({ title: 'تسجيل مصروف', subtitle: 'سجّل بيان المصروف وقيمته ليظهر في التقرير وحركة النقدية.', fields: [{ label: 'بيان المصروف', type: 'textarea', placeholder: 'مثال: فاتورة الكهرباء' }, { label: 'قيمة المصروف (ج.م)', type: 'number', placeholder: '0.00' }], submitLabel: 'حفظ المصروف' });
  if (!values) return;
  const [description, amountText] = values;
  if (!description?.trim()) return showAppToast('اكتب بيان المصروف.');
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount <= 0) return showAppToast('أدخل قيمة أكبر من صفر.');
  try {
    const response = await fetch('/api/expenses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description, amount }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر تسجيل المصروف.');
    await renderExpensesReport();
    await refreshDashboard();
    showAppToast('تم تسجيل المصروف وحفظ نسخة احتياطية تلقائية قبل العملية.');
  } catch (error) { showAppToast(error.message); }
}

async function renderCashVouchers() {
  const body = document.getElementById('cash-vouchers-body');
  if (!body) return;
  const status = document.getElementById('cash-vouchers-status');
  try {
    const params = new URLSearchParams();
    const from = document.getElementById('cash-vouchers-from')?.value || '';
    const to = document.getElementById('cash-vouchers-to')?.value || '';
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const response = await fetch(`/api/cash-transactions${params.size ? `?${params}` : ''}`);
    const rows = await response.json();
    if (!response.ok) throw new Error(rows.error || 'تعذر تحميل سندات الخزينة.');
    body.innerHTML = rows.map(row => `<tr><td class="p-3">${escapeHtml(row.created_at || '')}</td><td class="p-3 font-bold">${row.type === 'owner_deposit' ? 'إيداع مالك' : row.type === 'cash_receipt' ? 'قبض' : 'صرف'}</td><td class="p-3">${escapeHtml(row.notes || '')}</td><td class="p-3">${escapeHtml(row.reference_id || '—')}</td><td class="p-3 font-bold ${row.direction === 'in' ? 'text-emerald-800' : 'text-rose-800'}">${Number(row.amount || 0).toFixed(2)} ج.م</td><td class="p-3">${row.shift_id ? `#${Number(row.shift_id)}` : 'بدون وردية'}</td></tr>`).join('') || '<tr><td colspan="6" class="p-4 text-center font-bold text-slate-600">لا توجد سندات في الفترة المحددة.</td></tr>';
    if (status) status.textContent = `عدد السندات: ${rows.length}`;
  } catch (error) {
    body.innerHTML = `<tr><td colspan="6" class="p-4 text-center font-bold text-red-700">${escapeHtml(error.message)}</td></tr>`;
    if (status) status.textContent = 'تعذر تحميل القائمة';
  }
}

async function renderTreasuryPage() {
  const cashBody = document.getElementById('treasury-cash-vouchers-body');
  if (!cashBody) return;
  const expenseBody = document.getElementById('treasury-expenses-body');
  const from = document.getElementById('treasury-from')?.value || '';
  const to = document.getElementById('treasury-to')?.value || '';
  try {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const [cashResponse, finance, expenses] = await Promise.all([
      fetch(`/api/cash-transactions${params.size ? `?${params}` : ''}`).then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'تعذر تحميل حركة الخزينة.');
        return data;
      }),
      storage.getFinanceSummary(),
      storage.getExpenses(from, to)
    ]);
    const rows = Array.isArray(cashResponse) ? cashResponse : [];
    cashBody.innerHTML = rows.map(row => `<tr><td>${escapeHtml(row.created_at || '')}</td><td>${row.type === 'owner_deposit' ? 'إيداع مالك' : row.type === 'cash_receipt' ? 'قبض' : 'صرف'}</td><td>${escapeHtml(row.notes || '')}</td><td>${escapeHtml(row.reference_id || '—')}</td><td class="${row.direction === 'in' ? 'text-emerald-400' : 'text-rose-400'}">${Number(row.amount || 0).toFixed(2)} ج.م</td><td>${row.shift_id ? `#${Number(row.shift_id)}` : 'بدون وردية'}</td></tr>`).join('') || '<tr><td colspan="6" class="text-center">لا توجد حركات خلال الفترة المحددة.</td></tr>';
    if (expenseBody) expenseBody.innerHTML = (Array.isArray(expenses) ? expenses : []).map(row => `<tr><td>${escapeHtml(row.created_at || '')}</td><td>${escapeHtml(row.description || row.notes || '')}</td><td>${escapeHtml(row.reference_id || '—')}</td><td class="text-rose-400">${Number(row.amount || 0).toFixed(2)} ج.م</td></tr>`).join('') || '<tr><td colspan="4" class="text-center">لا توجد مصروفات خلال الفترة المحددة.</td></tr>';
    const totalExpenses = (Array.isArray(expenses) ? expenses : []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
    document.getElementById('treasury-cash-balance')?.replaceChildren(document.createTextNode(`${Number(finance.cash_balance || 0).toFixed(2)} ج.م`));
    document.getElementById('treasury-transaction-count')?.replaceChildren(document.createTextNode(String(rows.length)));
    document.getElementById('treasury-expenses-total')?.replaceChildren(document.createTextNode(`${totalExpenses.toFixed(2)} ج.م`));
    const status = from || to ? `${from || 'البداية'} — ${to || 'اليوم'}` : 'كل الفترات';
    document.getElementById('treasury-status')?.replaceChildren(document.createTextNode(status));
  } catch (error) {
    cashBody.innerHTML = `<tr><td colspan="6" class="text-center text-rose-400">${escapeHtml(error.message)}</td></tr>`;
    if (expenseBody) expenseBody.innerHTML = '<tr><td colspan="4" class="text-center">تعذر تحميل المصروفات.</td></tr>';
  }
}

async function addCashVoucher(type) {
  if (!hasPermission('add')) return showAppToast('لا تملك صلاحية تسجيل حركات الخزينة.');
  const ownerDeposit = type === 'owner_deposit';
  if (ownerDeposit && !isUnrestrictedAccount(currentUser)) return showAppToast('إيداع مالك النشاط متاح لمالك النظام أو حساب admin فقط.');
  const receipt = type === 'cash_receipt';
  const values = await openAppFormDialog({
    title: ownerDeposit ? 'إيداع من صاحب المحل' : receipt ? 'سند قبض نقدي' : 'سند صرف نقدي',
    subtitle: ownerDeposit ? 'يسجل تمويلاً من المالك في الخزنة، ويظل منفصلاً عن إيرادات المبيعات وصافي الربح.' : receipt ? 'يسجل المبلغ الوارد في الخزينة ويربطه بالوردية المفتوحة إن وجدت.' : 'يسجل المبلغ المنصرف من الخزينة ويربطه بالوردية المفتوحة إن وجدت.',
    fields: [{ label: 'البيان', type: 'textarea', placeholder: ownerDeposit ? 'مثال: تمويل من المالك' : receipt ? 'مثال: توريد نقدية' : 'مثال: مصروف نقدي' }, { label: 'المبلغ (ج.م)', type: 'number', placeholder: '0.00' }],
    submitLabel: ownerDeposit ? 'حفظ إيداع المالك' : receipt ? 'حفظ سند القبض' : 'حفظ سند الصرف'
  });
  if (!values) return;
  const [description, amountText] = values;
  const amount = Number(amountText);
  if (!String(description || '').trim() || !Number.isFinite(amount) || amount <= 0) return showAppToast('أدخل البيان ومبلغاً أكبر من صفر.');
  try {
    const response = await fetch('/api/cash-transactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, description, amount }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر حفظ حركة الخزينة.');
    await Promise.all([renderCashVouchers(), renderTreasuryPage(), refreshDashboard()]);
    showAppToast(`${ownerDeposit ? 'تم حفظ إيداع المالك' : receipt ? 'تم حفظ سند القبض' : 'تم حفظ سند الصرف'} رقم ${result.reference_id}.`);
  } catch (error) { showAppToast(error.message); }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
async function loadAccountingExportData() {
  const params = new URLSearchParams();
  const from = document.getElementById('accounting-export-from')?.value;
  const to = document.getElementById('accounting-export-to')?.value;
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const response = await fetch(`/api/accounting/export-data${params.size ? `?${params}` : ''}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'تعذر تحميل بيانات التصدير.');
  return data;
}
function accountingRows(data) {
  const headers = ['التاريخ', 'نوع الحركة', 'رقم المرجع', 'الطرف', 'البيان', 'الإجمالي', 'الضريبة', 'المدفوع', 'المتبقي'];
  const rows = [headers];
  for (const sale of data.sales || []) rows.push([sale.created_at, 'بيع', sale.invoice_number, sale.customer_name, sale.payment_method, Number(sale.total || 0), Number(sale.tax_amount || 0), Math.max(0, Number(sale.paid_amount || 0) - Number(sale.change_amount || 0)), Math.max(0, Number(sale.total || 0) - Number(sale.paid_amount || 0))]);
  for (const purchase of data.purchases || []) rows.push([purchase.created_at, 'شراء', `PUR-${purchase.id}`, purchase.supplier_name, 'فاتورة مشتريات', Number(purchase.total || 0), 0, Number(purchase.paid_amount || 0), Number(purchase.remaining_amount || 0)]);
  for (const row of data.returns || []) rows.push([row.created_at, 'مرتجع', row.invoice_number, '', row.reason || '', -Number(row.total_amount ?? row.amount ?? 0), -Number(row.tax_amount || 0), -Number(row.cash_amount || 0), 0]);
  const linkedFinanceTypes = new Set(['sale', 'sale_return', 'purchase', 'customer_payment', 'supplier_payment', 'service_order_deposit', 'service_order_payment', 'installment_payment']);
  for (const row of data.cash_transactions || []) if (!linkedFinanceTypes.has(row.type)) rows.push([row.created_at, 'حركة خزينة', row.reference_id, '', row.notes || row.type, (row.direction === 'out' ? -1 : 1) * Number(row.amount || 0), 0, (row.direction === 'out' ? -1 : 1) * Number(row.amount || 0), 0]);
  for (const order of data.service_orders || []) rows.push([order.created_at, 'أمر شغل', order.order_number, order.customer_name || '', order.type || '', Number(order.total || 0), 0, Number(order.paid_amount || 0), Number(order.remaining_amount || 0)]);
  for (const contract of data.installment_contracts || []) rows.push([contract.created_at, 'عقد تقسيط', contract.contract_number, contract.customer_name || '', contract.frequency || '', Number(contract.total || 0), 0, Number(contract.paid_amount || 0), Number(contract.remaining_amount || 0)]);
  return rows;
}
async function exportReportToExcel() {
  if (!hasPermission('import_export')) return showAppToast('لا تملك صلاحية التصدير.');
  try {
    const data = await loadAccountingExportData();
    const sheets = [
      ['دفتر القيود', accountingRows(data)],
      ['المبيعات', [['التاريخ','رقم الفاتورة','العميل','الهاتف','نوع الطلب','القناة','قبل الضريبة','الخصم','النسبة','الضريبة','الإجمالي','المدفوع','طريقة الدفع'], ...(data.sales || []).map(sale => [sale.created_at,sale.invoice_number,sale.customer_name,sale.customer_phone,sale.order_type || 'داخل المحل',sale.order_channel || 'مباشر',Number(sale.subtotal || 0),Number(sale.discount || 0),Number(sale.tax_rate || 0),Number(sale.tax_amount || 0),Number(sale.total || 0),Number(sale.paid_amount || 0),sale.payment_method])]],
      ['الأصناف المباعة', [['الفاتورة','المنتج','الكمية','السعر','الخصم','خصم العرض','الإجمالي'], ...(data.sales || []).flatMap(sale => (sale.items || []).map(item => [sale.invoice_number,item.product_name,Number(item.quantity || 0),Number(item.unit_price || 0),Number(item.discount || 0),Number(item.promotion_discount || 0),Number(item.total || 0)]))]],
      ['المشتريات', [['التاريخ','المرجع','المورد','الإجمالي','المدفوع','المتبقي'], ...(data.purchases || []).map(row => [row.created_at,`PUR-${row.id}`,row.supplier_name,Number(row.total || 0),Number(row.paid_amount || 0),Number(row.remaining_amount || 0)])]],
      ['العملاء', [['الاسم','الهاتف','الرصيد'], ...(data.customers || []).map(row => [row.name,row.phone,Number(row.balance || 0)])]],
      ['الموردون', [['الاسم','الهاتف','الرصيد'], ...(data.suppliers || []).map(row => [row.name,row.phone,Number(row.balance || 0)])]],
      ['أوامر الشغل', [['التاريخ','الرقم','النوع','العميل','الإجمالي','المدفوع','المتبقي','الحالة'], ...(data.service_orders || []).map(row => [row.created_at,row.order_number,row.type,row.customer_name || '',Number(row.total || 0),Number(row.paid_amount || 0),Number(row.remaining_amount || 0),row.status])]],
      ['التقسيط', [['التاريخ','رقم العقد','رقم الفاتورة','العميل','الإجمالي','المدفوع','المتبقي','الحالة'], ...(data.installment_contracts || []).map(row => [row.created_at,row.contract_number,row.sale_id,row.customer_name || '',Number(row.total || 0),Number(row.paid_amount || 0),Number(row.remaining_amount || 0),row.status])]]
    ];
    const workbook = buildReportWorkbook(sheets);
    const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', compression: true });
    downloadBlob(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `تصدير_محاسبي_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (error) { showAppToast(error.message); }
}
function buildReportWorkbook(sheets) {
  if (!window.XLSX) throw new Error('مكتبة Excel المحلية لم تُحمّل.');
  const workbook = XLSX.utils.book_new();
  workbook.Workbook = { Views: [{ RTL: true }] };
  for (const [name, rows] of sheets) {
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols'] = (rows[0] || []).map(value => ({ wch: Math.min(34, Math.max(12, String(value || '').length + 2)) }));
    XLSX.utils.book_append_sheet(workbook, sheet, String(name).slice(0, 31));
  }
  return workbook;
}
async function exportBusinessReportToExcel(reportType) {
  if (!hasPermission('import_export')) return showAppToast('لا تملك صلاحية التصدير.');
  const allowedTypes = ['sales', 'purchases', 'inventory', 'customer-ledger', 'supplier-ledger'];
  if (!allowedTypes.includes(reportType)) return showAppToast('نوع التقرير المطلوب غير مدعوم.');
  try {
    const data = await loadAccountingExportData();
    const headers = {
      sales: ['التاريخ','رقم الفاتورة','العميل','الهاتف','الكاشير','الإجمالي','المدفوع','طريقة الدفع'],
      purchases: ['التاريخ','رقم الفاتورة','المورد','عدد الأصناف','الإجمالي','المدفوع','المتبقي'],
      inventory: ['كود الصنف','اسم الصنف','الباركود','الكمية','الحد الأدنى','تكلفة الوحدة','سعر البيع','تاريخ الصلاحية'],
      'customer-ledger': ['التاريخ','العميل','نوع الحركة','المرجع','مدين','دائن','ملاحظات'],
      'supplier-ledger': ['التاريخ','المورد','نوع الحركة','المرجع','مدين','دائن','ملاحظات']
    };
    const rowsByType = {
      sales: (data.sales || []).map(row => [row.created_at,row.invoice_number,row.customer_name,row.customer_phone,row.cashier_name,Number(row.total || 0),Number(row.paid_amount || 0),row.payment_method]),
      purchases: (data.purchases || []).map(row => [row.created_at,`PUR-${row.id}`,row.supplier_name,(row.items || []).length,Number(row.total || 0),Number(row.paid_amount || 0),Number(row.remaining_amount || Math.max(0, Number(row.total || 0) - Number(row.paid_amount || 0)))]),
      inventory: (data.inventory || []).map(row => [Number(row.id),row.name,row.barcode,Number(row.quantity || 0),Number(row.min_stock || 0),Number(row.cost_price || 0),Number(row.sale_price || 0),row.expiry_date || '']),
      'customer-ledger': (data.customer_ledgers || []).map(row => [row.created_at,row.customer_name,row.type,row.reference_id,Number(row.debit || 0),Number(row.credit || 0),row.notes]),
      'supplier-ledger': (data.supplier_ledgers || []).map(row => [row.created_at,row.supplier_name,row.type,row.reference_id,Number(row.debit || 0),Number(row.credit || 0),row.notes])
    };
    const title = { sales: 'المبيعات', purchases: 'المشتريات', inventory: 'المخزون', 'customer-ledger': 'كشف العملاء', 'supplier-ledger': 'كشف الموردين' }[reportType];
    const workbook = buildReportWorkbook([[title, [headers[reportType], ...rowsByType[reportType]]]]);
    const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', compression: true });
    downloadBlob(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `تقرير_${title}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (error) { showAppToast(error.message || 'تعذر تصدير تقرير Excel.'); }
}
async function exportReportToCSV() {
  if (!hasPermission('import_export')) return showAppToast('لا تملك صلاحية التصدير.');
  try {
    const data = await loadAccountingExportData();
    const rows = accountingRows(data);
    const csv = '\ufeff' + rows.map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `تصدير_محاسبي_${new Date().toISOString().slice(0, 10)}.csv`);
  } catch (error) { showAppToast(error.message); }
}

// ----------------------------------------------------
// Users Management
// ----------------------------------------------------
async function renderUsers() {
  const tbody = document.getElementById('users-table-body');
  if (!tbody) return;

  const users = await storage.getUsers();
  tbody.innerHTML = '';
  users.forEach(u => {
    const roleLabels = {
      admin: '👑 مدير (حسب الصلاحيات المحددة)',
      inventory_manager: '📦 مسؤول مخزن',
      cashier: '💳 كاشير مبيعات'
    };

    const tr = document.createElement('tr');
    tr.className = 'hover:bg-gray-50';
    tr.innerHTML = `
      <td class="py-3 px-4 font-bold text-gray-900">${escapeHtml(u.name)}</td>
      <td class="py-3 px-3 font-mono text-gray-600">${escapeHtml(u.username)}</td>
      <td class="py-3 px-3 font-semibold text-gray-800"><div>${roleLabels[u.role] || u.role}</div><div class="flex flex-wrap gap-1 mt-1">${(u.permissions || []).map(permission => `<span class="permission-chip">${escapeHtml(({view:'العرض',add:'الإضافة',edit:'التعديل',delete:'الحذف',import_export:'الاستيراد والتصدير',print_pdf:'الطباعة وPDF',system_settings:'إعدادات النظام',user_management:'إدارة المستخدمين',image_management:'إدارة الصور'})[permission] || permission)}</span>`).join('')}</div></td>
      <td class="py-3 px-3 text-gray-600">${escapeHtml((u.branch_names || (u.branch_name ? [u.branch_name] : [])).join('، ') || (u.branch_id ? `فرع ${u.branch_id}` : '—'))}</td>
      <td class="py-3 px-3">
        <span class="px-2 py-0.5 rounded text-[10px] font-bold ${u.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}">
          ${u.is_active ? 'نشط' : 'معطل'}
        </span>
      </td>
      <td class="py-3 px-3 text-gray-500 font-mono text-[11px]">${escapeHtml(u.created_at)}</td>
      <td class="py-3 px-4 text-center">
        <button onclick="editUser(${u.id})" class="px-3 py-2 rounded-lg text-sm font-extrabold bg-blue-100 text-blue-900 hover:bg-blue-200">تعديل الصلاحية</button>
        <button onclick="deleteUser(${u.id})" class="px-3 py-2 rounded-lg text-sm font-extrabold bg-red-100 text-red-900 hover:bg-red-200">
          حذف المستخدم وسجلاته
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function loadGranularPermissionsPanel(userId) {
  const panel = document.getElementById('granular-permissions-panel');
  const list = document.getElementById('granular-permissions-list');
  if (!panel || !list || !userId) { panel?.classList.add('hidden'); return; }
  try {
    const response = await fetch(`/api/users/${userId}/permissions`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر تحميل الصلاحيات التفصيلية.');
    panel.dataset.userId = String(userId);
    panel.classList.remove('hidden');
    const groups = {};
    for (const permission of data.permissions || []) (groups[permission.category] ||= []).push(permission);
    list.innerHTML = Object.entries(groups).map(([category, rows]) => `<details open class="rounded-lg border border-emerald-200 bg-white p-2"><summary class="cursor-pointer font-black text-emerald-900">${escapeHtml(category)} (${rows.length})</summary><div class="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">${rows.map(row => `<label class="flex items-center gap-2 rounded-md bg-emerald-50 px-2 py-1 text-xs"><input type="checkbox" data-granular-code="${escapeHtml(row.code)}" ${row.granted ? 'checked' : ''}> <span>${escapeHtml(row.name_ar)} <small dir="ltr">${escapeHtml(row.code)}</small></span></label>`).join('')}</div></details>`).join('');
    document.getElementById('permission-max-discount').value = data.constraints?.max_discount_percent ?? 100;
    document.getElementById('permission-max-invoice').value = data.constraints?.max_invoice_amount ?? 0;
    document.getElementById('permission-can-delete').checked = Number(data.constraints?.can_delete_invoice) === 1;
    document.getElementById('granular-permissions-summary').textContent = `هذا المستخدم سيرى ${Object.values(groups).flat().filter(row => row.granted).length} صلاحية فعالة من ${data.permissions?.length || 0}.`;
    document.getElementById('granular-permissions-save').onclick = saveGranularPermissions;
  } catch (error) { panel.classList.add('hidden'); showAppToast(error.message); }
}

async function saveGranularPermissions() {
  const panel = document.getElementById('granular-permissions-panel'); const userId = panel?.dataset.userId;
  if (!userId) return;
  const overrides = [...panel.querySelectorAll('[data-granular-code]')].map(input => ({ code: input.dataset.granularCode, granted: input.checked }));
  const body = { overrides, constraints: { max_discount_percent: Number(document.getElementById('permission-max-discount')?.value || 0), max_invoice_amount: Number(document.getElementById('permission-max-invoice')?.value || 0), can_delete_invoice: Boolean(document.getElementById('permission-can-delete')?.checked) } };
  const response = await fetch(`/api/users/${userId}/permissions`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) return showAppToast(data.error || 'تعذر حفظ الصلاحيات.');
  document.getElementById('granular-permissions-summary').textContent = `تم الحفظ. الصلاحيات الفعالة الآن: ${(data.permissions || []).length}.`;
  showAppToast('تم حفظ الصلاحيات التفصيلية وسُجل التغيير في سجل النشاط.');
}

async function editUser(id) {
  const user = (await storage.getUsers()).find(u => u.id === id);
  if (!user) return;
  configureAllowedTabs(user);
  document.getElementById('user-new-id').value = user.id;
  document.getElementById('user-new-name').value = user.name;
  document.getElementById('user-new-username').value = user.username;
  document.getElementById('user-new-username').disabled = true;
  document.getElementById('user-new-pass').value = '';
  document.getElementById('user-new-pass').placeholder = 'اتركه فارغًا للإبقاء على كلمة المرور';
  document.getElementById('user-new-role').value = user.role;
  await initializeBranchWorkspace(); if(document.getElementById('user-new-branch')){const assigned=new Set((Array.isArray(user.branch_ids)&&user.branch_ids.length?user.branch_ids:[user.branch_id]).map(Number));for(const option of document.getElementById('user-new-branch').options)option.selected=assigned.has(Number(option.value));} renderUserBranchAccessFields();
  try { const accessResponse = await fetch(`/api/users/${user.id}/branches`); const accessData = await accessResponse.json(); for (const entry of accessData.branches || []) { const control = document.querySelector(`[data-branch-access="${CSS.escape(String(entry.branch_id))}"]`); if (control) control.value = entry.access_level; } } catch (_) {}
  document.querySelectorAll('#user-permissions input[type="checkbox"]').forEach(input => { input.checked = (user.permissions || []).includes(input.value); });
  document.getElementById('user-modal-title').textContent = 'تعديل مستخدم وصلاحياته';
  document.getElementById('user-submit-button').textContent = 'حفظ التعديلات';
  document.getElementById('user-permission-template').value = 'custom';
  renderUserPermissionSummary();
  setUserModalDirty(false);
  openModal('modal-add-user');
  loadGranularPermissionsPanel(user.id);
}

async function openNewUserModal() {
  await initializeBranchWorkspace();
  configureAllowedTabs(null);
  document.getElementById('user-new-id').value = '';
  document.getElementById('user-new-name').value = '';
  document.getElementById('user-new-username').value = '';
  document.getElementById('user-new-username').disabled = false;
  document.getElementById('user-new-pass').value = '';
  document.getElementById('user-new-pass').placeholder = '';
  document.getElementById('user-new-role').value = 'cashier';
  const branchSelect = document.getElementById('user-new-branch');
  if (branchSelect) { const active = Number(localStorage.getItem(ACTIVE_BRANCH_KEY) || currentUser?.branch_id || 0); for (const option of branchSelect.options) option.selected = Number(option.value) === active; } renderUserBranchAccessFields();
  document.querySelectorAll('#user-permissions input[type="checkbox"]').forEach(input => { input.checked = false; });
  document.getElementById('user-permission-template').value = 'cashier';
  document.getElementById('granular-permissions-panel')?.classList.add('hidden');
  applyUserPermissionTemplate('cashier');
  document.getElementById('user-modal-title').textContent = 'إضافة مستخدم للنظام';
  document.getElementById('user-submit-button').textContent = 'إنشاء المستخدم';
  setUserModalDirty(false);
  openModal('modal-add-user');
}

async function handleUserSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('user-new-name').value.trim();
  const username = document.getElementById('user-new-username').value.trim();
  const password = document.getElementById('user-new-pass').value;
  const role = document.getElementById('user-new-role').value;
  const permissions = [...document.querySelectorAll('#user-permissions input[type="checkbox"]:checked')].map(input => input.value);
  const allowedTabsField = document.getElementById('user-allowed-tabs-field');
  const allowed_tabs = isUnrestrictedAccount(currentUser) && allowedTabsField && !allowedTabsField.classList.contains('hidden')
    ? [...document.querySelectorAll('#user-allowed-tabs input[type="checkbox"]:checked')].map(input => input.value)
    : undefined;
  const selectedBranchIds = document.getElementById('user-branch-field')?.classList.contains('hidden') ? [] : [...(document.getElementById('user-new-branch')?.selectedOptions || [])].map(option => Number(option.value));
  const branch_ids = selectedBranchIds.length ? selectedBranchIds : undefined;
  const branch_id = branch_ids?.[0];
  const branch_access = collectUserBranchAccess();
  const id = Number(document.getElementById('user-new-id').value || 0);
  if (!id && !password) {
    showAppToast('كلمة المرور مطلوبة عند إضافة مستخدم جديد.');
    return;
  }
  try {
    if (id) await storage.updateUser(id, { name, password, role, permissions, branch_id, branch_ids, branch_access, ...(allowed_tabs === undefined ? {} : { allowed_tabs }) });
    else await storage.saveUser({ name, username, password, role, permissions, branch_id, branch_ids, branch_access, ...(allowed_tabs === undefined ? {} : { allowed_tabs }) });
    setUserModalDirty(false);
    closeModal('modal-add-user');
    document.getElementById('user-new-id').value = '';
    document.getElementById('user-new-username').disabled = false;
    document.getElementById('user-modal-title').textContent = 'إضافة مستخدم للنظام';
    document.getElementById('user-submit-button').textContent = 'إنشاء المستخدم';
    document.querySelectorAll('#user-permissions input[type="checkbox"]').forEach(input => { input.checked = false; });
    configureAllowedTabs(null);
    renderUserPermissionSummary();
    await renderUsers();
    showAppToast(id ? 'تم حفظ بيانات المستخدم وصلاحياته.' : 'تمت إضافة المستخدم بنجاح!');
  } catch (error) { showAppToast(error.message || 'تعذر حفظ بيانات المستخدم.'); }
}

function configureAllowedTabs(user = null) {
  const field = document.getElementById('user-allowed-tabs-field');
  const host = document.getElementById('user-allowed-tabs');
  if (!field || !host) return;
  const show = isUnrestrictedAccount(currentUser) && (!user || !isUnrestrictedAccount(user));
  field.dataset.targetHidden = String(!show);
  field.classList.toggle('hidden', !show);
  if (!show) return;
  const selected = new Set(Array.isArray(user?.allowed_tabs) ? user.allowed_tabs : UI_HIDEABLE_TABS.map(([id]) => id));
  const groups = [
    ['المبيعات والعملاء', ['pos','sales-history','customers','promotions','offer-messages']],
    ['المخزون والمشتريات', ['products','categories','inventory','purchases','barcodes','branch-warehouse']],
    ['الموظفون والتوصيل', ['employees','delivery','delivery-riders','installments']],
    ['التقارير والإدارة', ['dashboard','reports','users','audit-logs']]
  ];
  host.innerHTML = groups.map(([label, ids]) => {
    const items = UI_HIDEABLE_TABS.filter(([id]) => ids.includes(id));
    return `<section class="space-y-2"><h5 class="text-xs font-black text-blue-900">${label}</h5><div class="grid grid-cols-1 sm:grid-cols-2 gap-2">${items.map(([id, title]) => `<label class="permission-option"><input type="checkbox" value="${escapeHtml(id)}" ${selected.has(id) ? 'checked' : ''}> ${escapeHtml(title)}</label>`).join('')}</div></section>`;
  }).join('');
  renderUserPermissionSummary();
}

const USER_PERMISSION_LABELS = Object.freeze({
  view:'العرض والبحث', add:'الإضافة', edit:'التعديل', delete:'الحذف', import_export:'الاستيراد والتصدير',
  print_pdf:'الطباعة وPDF', system_settings:'إعدادات النظام', user_management:'إدارة المستخدمين', image_management:'إدارة الصور'
});
const USER_PERMISSION_TEMPLATES = Object.freeze({
  cashier:{permissions:['view','add','print_pdf'],tabs:['pos']},
  inventory_manager:{permissions:['view','add','edit','import_export'],tabs:['products','categories','inventory','purchases']},
  accountant:{permissions:['view','print_pdf','system_settings','import_export'],tabs:['dashboard','sales-history','purchases','suppliers','treasury','reports','audit-logs']},
  manager:{permissions:Object.keys(USER_PERMISSION_LABELS),tabs:UI_HIDEABLE_TABS.map(([id])=>id)},
  owner:{permissions:Object.keys(USER_PERMISSION_LABELS),tabs:UI_HIDEABLE_TABS.map(([id])=>id)},
  admin:{permissions:Object.keys(USER_PERMISSION_LABELS),tabs:UI_HIDEABLE_TABS.map(([id])=>id)}
});
function setUserModalDirty(dirty) {
  userModalDirty = Boolean(dirty);
  document.getElementById('user-unsaved-status')?.classList.toggle('hidden', !userModalDirty);
}
function markUserModalDirty() {
  if (!applyingUserPermissionTemplate) setUserModalDirty(true);
  renderUserPermissionSummary();
}
function renderUserPermissionSummary() {
  const summary = document.getElementById('user-permission-summary');
  if (!summary) return;
  const selectedPermissions = [...document.querySelectorAll('#user-permissions input[type="checkbox"]:checked')].map(input => USER_PERMISSION_LABELS[input.value] || input.value);
  const selectedTabs = [...document.querySelectorAll('#user-allowed-tabs input[type="checkbox"]:checked')].map(input => UI_HIDEABLE_TABS.find(([id]) => id === input.value)?.[1] || input.value);
  const activePermissions = selectedPermissions.length ? selectedPermissions.join('، ') : 'لا توجد صلاحيات عمليات محددة';
  const screens = selectedTabs.length ? selectedTabs.join('، ') : 'لا توجد شاشات مسموحة';
  const deniedPermissions = Object.values(USER_PERMISSION_LABELS).filter(label => !selectedPermissions.includes(label));
  summary.innerHTML = `<strong>يستطيع:</strong> ${escapeHtml(activePermissions)}. <strong>الشاشات:</strong> ${escapeHtml(screens)}.<br><strong>لا يستطيع:</strong> ${escapeHtml(deniedPermissions.length ? deniedPermissions.join('، ') : 'لا توجد صلاحية مستبعدة من مصفوفة العمليات')}.`;
}
function applyUserPermissionTemplate(templateName) {
  const template = USER_PERMISSION_TEMPLATES[templateName];
  if (!template) return;
  applyingUserPermissionTemplate = true;
  const permissions = new Set(template.permissions);
  document.querySelectorAll('#user-permissions input[type="checkbox"]').forEach(input => { input.checked = permissions.has(input.value); });
  const tabs = new Set(template.tabs);
  document.querySelectorAll('#user-allowed-tabs input[type="checkbox"]').forEach(input => { input.checked = tabs.has(input.value); });
  applyingUserPermissionTemplate = false;
  renderUserPermissionSummary();
  setUserModalDirty(true);
}
function renderUserBranchAccessFields() {
  const select = document.getElementById('user-new-branch');
  const host = document.getElementById('user-branch-access-list');
  if (!select || !host) return;
  const selected = [...select.selectedOptions];
  host.innerHTML = selected.length ? selected.map(option => `<label class="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold"><span>${escapeHtml(option.textContent || `فرع ${option.value}`)}</span><select data-branch-access="${escapeHtml(option.value)}" class="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-bold"><option value="write">كتابة</option><option value="read">قراءة فقط</option><option value="none">منع</option></select></label>`).join('') : '<p class="text-xs text-slate-500">اختر فرعاً لعرض مستوى الوصول.</p>';
}

function collectUserBranchAccess() {
  const select = document.getElementById('user-new-branch');
  if (!select) return [];
  return [...select.selectedOptions].map(option => ({
    branch_id: Number(option.value),
    access_level: document.querySelector(`[data-branch-access="${CSS.escape(option.value)}"]`)?.value || 'write'
  }));
}

function setUserCheckboxGroup(selector, checked) {
  document.querySelectorAll(selector).forEach(input => { input.checked = checked; });
  const template = document.getElementById('user-permission-template');
  if (selector.startsWith('#user-permissions') && template) template.value = 'custom';
  markUserModalDirty();
}

function openChangePasswordModal() {
  setForcedPasswordChangeState(false);
  document.getElementById('own-current-password').value = '';
  document.getElementById('own-new-password').value = '';
  document.getElementById('own-confirm-password').value = '';
  openModal('modal-change-password');
}

async function handleChangeOwnPassword(e) {
  e.preventDefault();
  const currentPassword = document.getElementById('own-current-password').value;
  const newPassword = document.getElementById('own-new-password').value;
  const confirmation = document.getElementById('own-confirm-password').value;
  if (!newPassword) { showAppToast('اكتب كلمة المرور الجديدة.'); return; }
  if (newPassword.length < 8 || !/[A-Z]/u.test(newPassword) || !/\d/u.test(newPassword) || !/[^\p{L}\p{N}]/u.test(newPassword)) { showAppToast('كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل وتحتوي على حرف كبير ورقم ورمز.', { tone: 'error' }); return; }
  if (currentUser?.username && newPassword.toLocaleLowerCase() === String(currentUser.username).toLocaleLowerCase()) {
    showAppToast('لا تستخدم اسم المستخدم ككلمة مرور.');
    return;
  }
  if (['admin123', 'inv123', 'cash123', '12345678', 'password'].includes(newPassword.toLocaleLowerCase())) {
    showAppToast('اختر كلمة مرور جديدة غير الافتراضية.');
    return;
  }
  if (newPassword === currentPassword) { showAppToast('كلمة المرور الجديدة يجب أن تختلف عن الحالية.'); return; }
  if (newPassword !== confirmation) { showAppToast('تأكيد كلمة المرور غير مطابق.'); return; }
  try {
    const result = await storage.changeOwnPassword(currentPassword, newPassword);
    if (currentUser) currentUser.must_change_password = false;
    sessionStorage.setItem('system_session', JSON.stringify(currentUser));
    const pending = pendingPasswordChangeContext;
    pendingPasswordChangeContext = null;
    setForcedPasswordChangeState(false);
    await closeModal('modal-change-password');
    if (pending?.remember && pending.rememberCredentials && window.rawdaDesktop?.saveRememberedLogin) {
      const saved = await window.rawdaDesktop.saveRememberedLogin({ username: pending.username, password: newPassword, role: currentUser?.role });
      if (!saved?.saved) showAppToast(saved?.error || 'تعذر تحديث بيانات الدخول المحفوظة.');
    }
    if (forcedPasswordChangeActive === false && document.getElementById('app-shell')?.classList.contains('hidden')) {
      await openAuthorizedWorkspace(currentUser);
    }
    showAppToast(result.message || 'تم تغيير كلمة المرور بنجاح.');
  } catch (error) {
    showAppToast(error.message || 'تعذر تغيير كلمة المرور.');
  }
}

async function toggleUserStatus(id) {
  if (await showAppConfirm('هل أنت متأكد من تغيير حالة هذا المستخدم؟')) {
    try { await storage.toggleUserActive(id); await renderUsers(); }
    catch (err) { showAppToast(err.message); }
  }
}

async function deleteUser(id) {
  if (!await showAppConfirm('هل تريد حذف هذا المستخدم وحذف سجلات نشاطه؟ سيتم الحفاظ على الفواتير والحسابات المالية المرتبطة به.')) return;
  try { await storage.deleteUser(id); await renderUsers(); showAppToast('تم حذف المستخدم بنجاح.'); }
  catch (err) { showAppToast(err.message); }
}

// ----------------------------------------------------
// Audit Logs
// ----------------------------------------------------
async function refreshAuditLogs() {
  const tbody = document.getElementById('audit-table-body');
  if (!tbody) return;

  const logs = await storage.getAuditLogs();
  tbody.innerHTML = '';
  logs.forEach(l => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-gray-50';
    tr.innerHTML = `
      <td class="py-2.5 px-4 text-gray-500">${escapeHtml(l.created_at)}</td>
      <td class="py-2.5 px-3 font-bold text-gray-800">${escapeHtml(l.user_name || 'بدون حساب')}</td>
      <td class="py-2.5 px-3 font-bold text-[#D6336C]">${escapeHtml(l.action)}</td>
      <td class="py-2.5 px-3 text-gray-600 font-semibold">${escapeHtml(l.entity)}</td>
      <td class="py-2.5 px-4 text-gray-700">${escapeHtml(l.details)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ----------------------------------------------------
// Backup & Restore
// ----------------------------------------------------
async function downloadBackup() {
  if (!hasPermission('import_export')) return showAppToast('لا تملك صلاحية النسخ الاحتياطي.');
  try {
    const res = await fetch('/api/backup/sqlite');
    if (!res.ok) throw new Error((await res.json()).error || 'تعذر تنزيل النسخة الاحتياطية.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `system_pos_backup_${new Date().toISOString().slice(0, 10)}.sqlite`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) { showAppToast(err.message || 'تعذر تنزيل النسخة الاحتياطية.'); }
}

async function restoreBackupFromFile() {
  const fileInput = document.getElementById('restore-file-input');
  const firstRunPicker = fileInput?.dataset.firstRunAutoRestore === 'true';
  if (!hasPermission('import_export') && !firstRunPicker) return showAppToast('لا تملك صلاحية استعادة النسخ الاحتياطية.');
  if (!fileInput.files || fileInput.files.length === 0) return showAppToast('يرجى اختيار ملف نسخة احتياطية (.sqlite أو .json) أولاً.');
  if (!await showAppConfirm(`ستحل النسخة المحلية «${fileInput.files[0].name}» محل جميع البيانات الحالية. سيحفظ النظام نسخة أمان قبل الاستبدال. هل تريد المتابعة؟`)) return;
  try {
    const file = fileInput.files[0];
    if (/\.(sqlite|db)$/i.test(file.name)) {
      const headers = { 'Content-Type': 'application/vnd.sqlite3' };
      if (firstRunPicker) headers['X-First-Run-Restore'] = await window.rawdaDesktop?.getFirstRunRestoreToken?.() || '';
      const response = await fetch('/api/restore-sqlite', { method: 'POST', headers, body: await file.arrayBuffer() });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'فشلت استعادة نسخة SQLite.');
      showAppToast(result.message || 'تمت استعادة النسخة الاحتياطية بنجاح.');
      window.location.reload();
      return;
    }
    const parsed = JSON.parse(await file.text());
    if (Array.isArray(parsed) && parsed.some(item => item && (item.commercial_name_ar || item.commercial_name_en))) {
      showAppToast('هذا الملف ليس نسخة احتياطية صالحة. استخدم ملف النسخة الاحتياطية المصدّر من البرنامج لاستعادة البيانات.');
      fileInput.value = '';
      return;
    }
    if (!parsed.products || !parsed.categories) return showAppToast('الملف غير صالح أو لا يحتوي على بنية البيانات الصحيحة.');
    const headers = { 'Content-Type': 'application/json' };
    if (firstRunPicker) headers['X-First-Run-Restore'] = await window.rawdaDesktop?.getFirstRunRestoreToken?.() || '';
    const res = await fetch('/api/restore', { method: 'POST', headers, body: JSON.stringify(parsed) });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'فشلت استعادة النسخة الاحتياطية.');
    showAppToast(result.message || 'تمت استعادة النسخة الاحتياطية بنجاح.');
    window.location.reload();
  } catch (err) { showAppToast(err.message || 'حدث خطأ أثناء قراءة الملف أو استعادته.', { tone: 'error' }); }
  finally { if (firstRunPicker) delete fileInput.dataset.firstRunAutoRestore; }
}

document.getElementById('restore-file-input')?.addEventListener('change', event => {
  const input = event.currentTarget;
  if (input?.dataset.firstRunAutoRestore !== 'true') return;
  if (!input.files?.length) {
    delete input.dataset.firstRunAutoRestore;
    const status = document.getElementById('google-drive-restore-status');
    if (status) status.textContent = 'لم يتم اختيار ملف نسخة. اختر «استعادة نسخة محلية» للمحاولة مرة أخرى؛ لم تتغير البيانات.';
    return;
  }
  void restoreBackupFromFile();
});

async function loadScheduledBackupSettings() {
  const input = document.getElementById('backup-secondary-path');
  if (!input || !hasPermission('system_settings')) return;
  try {
    const response = await fetch('/api/network-info', { cache: 'no-store' });
    const info = await response.json();
    if (response.ok) input.value = info.backup_secondary_path || '';
  } catch (err) { console.error('[1.16-B]', err); }
}

async function saveScheduledBackupSettings() {
  if (!hasPermission('system_settings')) return showAppToast('لا تملك صلاحية إعدادات النظام.');
  const input = document.getElementById('backup-secondary-path');
  const status = document.getElementById('backup-settings-status');
  const backup_secondary_path = String(input?.value || '').trim();
  try {
    const response = await fetch('/api/config/backup-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backup_secondary_path }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر حفظ إعداد النسخ الإضافي.');
    if (status) status.textContent = result.message || 'تم الحفظ.';
  } catch (error) { if (status) status.textContent = error.message; }
}

async function loadGoogleDriveBackupStatus() {
  if (!hasPermission('system_settings')) return;
  const status = document.getElementById('google-drive-backup-status');
  const input = document.getElementById('google-drive-client-id');
  try {
    const response = await fetch('/api/google-drive-backup/status', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر فحص حالة النسخ السحابي.');
    if (input && result.client_id && !input.value) input.value = result.client_id;
    const last = result.last_uploaded?.at ? `؛ آخر رفع ${new Date(result.last_uploaded.at).toLocaleString('ar-EG-u-nu-latn')}` : '';
    const pending = `؛ نسخ مشفرة معلقة ${result.pending} (${Math.ceil((result.queued_bytes || 0) / 1024)} KB)`;
    if (status) status.textContent = result.connecting
      ? `أكمل إذن Google Drive في متصفح النظام.${pending}`
      : `${result.connected ? `متصل (${result.account || 'Google Drive'})` : result.configured ? 'المعرّف محفوظ؛ اربط الحساب لإكمال الإعداد' : 'أدخل معرّف OAuth لتطبيق Desktop'}؛ كلمة مرور الاستعادة ${result.password_configured ? 'محفوظة' : 'غير محفوظة'}${pending}${last}${result.last_error ? `؛ آخر خطأ: ${result.last_error}` : ''}`;
    if (result.connecting && !googleDriveStatusTimer) {
      googleDriveStatusTimer = setInterval(() => { void loadGoogleDriveBackupStatus(); }, 2500);
      googleDriveStatusTimer.unref?.();
    } else if (!result.connecting && googleDriveStatusTimer) { clearInterval(googleDriveStatusTimer); googleDriveStatusTimer = null; }
  } catch (error) { if (status) status.textContent = error.message; }
}

async function saveGoogleDriveClientId() {
  if (!hasPermission('system_settings')) return showAppToast('لا تملك صلاحية إعدادات النظام.');
  const status = document.getElementById('google-drive-backup-status');
  const client_id = String(document.getElementById('google-drive-client-id')?.value || '').trim();
  try {
    const response = await fetch('/api/google-drive-backup/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر حفظ معرّف Google Drive.');
    if (status) status.textContent = result.message;
    await loadGoogleDriveBackupStatus();
    return true;
  } catch (error) { if (status) status.textContent = error.message; return false; }
}

async function connectGoogleDriveBackup() {
  if (!hasPermission('system_settings')) return showAppToast('لا تملك صلاحية إعدادات النظام.');
  if (!await saveGoogleDriveClientId()) return;
  const status = document.getElementById('google-drive-backup-status');
  try {
    const response = await fetch('/api/google-drive-backup/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر بدء ربط Google Drive.');
    if (status) status.textContent = result.message || 'أكمل التفويض في متصفح النظام.';
    await loadGoogleDriveBackupStatus();
  } catch (error) { if (status) status.textContent = error.message; }
}

async function createGoogleDriveBackupNow() {
  if (!hasPermission('system_settings')) return showAppToast('لا تملك صلاحية إعدادات النظام.');
  const warning = 'تحذير: إذا نسيت كلمة مرور النسخة المشفّرة فلن يمكن استرجاعها. احتفظ بكلمة المرور في مكان آمن. هل تريد إنشاء النسخة ورفعها الآن؟';
  if (!await showAppConfirm(warning)) return;
  const status = document.getElementById('google-drive-backup-status');
  try {
    const response = await fetch('/api/google-drive-backup/backup-now', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر إنشاء النسخة المحلية.');
    if (status) status.textContent = result.message || 'أُضيفت النسخة إلى طابور التشفير والرفع.';
    setTimeout(() => { void loadGoogleDriveBackupStatus(); }, 1200);
  } catch (error) { if (status) status.textContent = error.message; }
}

async function saveGoogleDriveBackupPassword() {
  if (!hasPermission('system_settings')) return showAppToast('لا تملك صلاحية إعداد النسخ السحابي.');
  const password = String(document.getElementById('google-drive-backup-password')?.value || '');
  const status = document.getElementById('google-drive-restore-status');
  try {
    const response = await fetch('/api/google-drive-backup/password', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر حفظ كلمة المرور.');
    if (status) status.textContent = result.message || 'تم حفظ كلمة المرور بأمان.';
    const input = document.getElementById('google-drive-backup-password');
    if (input) input.value = '';
  } catch (error) { if (status) status.textContent = error.message; }
}

async function loadGoogleDriveBackups() {
  if (!hasPermission('import_export')) return showAppToast('لا تملك صلاحية استعادة النسخ.');
  const select = document.getElementById('google-drive-backup-select');
  const status = document.getElementById('google-drive-restore-status');
  if (!select) return;
  try {
    const response = await fetch('/api/google-drive-backup/list', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر قراءة قائمة Google Drive.');
    select.replaceChildren(new Option('اختر نسخة', ''));
    for (const backup of result.backups || []) {
      const date = backup.created_at ? new Date(backup.created_at).toLocaleString('ar-EG-u-nu-latn') : 'تاريخ غير معروف';
      const counts = backup.counts || {};
      const label = `${date} — ${Math.ceil(Number(backup.size || 0) / 1024)} KB — ${backup.app_version || 'إصدار قديم'} — فواتير ${counts.invoices || 0}، أصناف ${counts.products || 0}، عملاء ${counts.customers || 0}`;
      const option = new Option(label, backup.id);
      option.dataset.format = String(backup.format || '');
      select.add(option);
    }
    if (status) status.textContent = `تم تحميل ${result.backups?.length || 0} نسخة من Google Drive.`;
  } catch (error) { if (status) status.textContent = error.message; }
}

async function previewGoogleDriveRestore() {
  if (!hasPermission('import_export')) return showAppToast('لا تملك صلاحية استعادة النسخ.');
  const fileId = String(document.getElementById('google-drive-backup-select')?.value || '');
  const password = String(document.getElementById('google-drive-backup-password')?.value || '');
  const selectedOption = document.getElementById('google-drive-backup-select')?.selectedOptions?.[0];
  const selected = selectedOption?.textContent || '';
  const format = selectedOption?.dataset.format || '';
  const status = document.getElementById('google-drive-restore-status');
  if (!fileId) { if (status) status.textContent = 'اختر نسخة أولاً.'; return; }
  if (format === 'aes-256-gcm-v2-scrypt' && !password) { if (status) status.textContent = 'أدخل كلمة مرور النسخة.'; return; }
  if (!await showAppConfirm(`ستحل النسخة المحددة محل جميع البيانات الحالية.\n${selected}\n${format === 'aes-256-gcm-v1' ? 'هذه نسخة قديمة مرتبطة بالجهاز الحالي.' : 'سيحفظ النظام نسخة أمان قبل الاستبدال.'}\nهل تريد المتابعة؟`)) return;
  if (status) status.textContent = 'جارٍ التنزيل والتحقق من التشفير والبصمة…';
  try {
    const download = await fetch('/api/google-drive-backup/download-verified', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: fileId, password }) });
    if (!download.ok) { const error = await download.json(); throw new Error(error.error || 'فشل تنزيل النسخة والتحقق منها.'); }
    const restore = await fetch('/api/restore-sqlite', { method: 'POST', headers: { 'Content-Type': 'application/vnd.sqlite3' }, body: await download.arrayBuffer() });
    const result = await restore.json();
    if (!restore.ok) throw new Error(result.error || 'فشل فحص القاعدة أو استعادتها.');
    if (status) status.textContent = 'نجحت الاستعادة بعد التحقق وحفظ نسخة أمان. سيتم تحديث التطبيق.';
    showAppToast(result.message || 'تمت استعادة النسخة الاحتياطية.');
    window.location.reload();
  } catch (error) { if (status) status.textContent = `لم تتغير البيانات الحالية: ${error.message}`; }
}

function openFirstRunRestore() {
  closeModal('modal-business-setup');
  document.getElementById('app-shell')?.classList.remove('hidden');
  switchTab('settings');
  setTimeout(() => document.getElementById('settings-backup-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  const status = document.getElementById('google-drive-restore-status');
  if (status) status.textContent = 'يمكنك الآن استعادة نسخة محلية من الجهاز أو ربط Google Drive وعرض نسخه قبل إعداد النشاط.';
  if (hasPermission('import_export')) void loadGoogleDriveBackups();
}

function openFirstRunLocalRestore() {
  const input = document.getElementById('restore-file-input');
  const status = document.getElementById('google-drive-restore-status');
  if (!input) {
    if (status) status.textContent = 'تعذر فتح منتقي ملفات النسخ. افتح إعدادات النسخ الاحتياطي أو أعد تشغيل البرنامج.';
    showAppToast('تعذر فتح منتقي ملفات النسخ.', { tone: 'error' });
    return;
  }
  input.dataset.firstRunAutoRestore = 'true';
  if (status) status.textContent = 'اختر ملف نسخة احتياطية من أي مجلد على هذا الجهاز. لن يبدأ الاسترجاع قبل تأكيدك.';
  input.click();
}

async function drainGoogleDriveBackups() {
  if (!hasPermission('system_settings')) return showAppToast('لا تملك صلاحية إعدادات النظام.');
  const status = document.getElementById('google-drive-backup-status');
  try {
    const response = await fetch('/api/google-drive-backup/drain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذرت محاولة الرفع.');
    if (status) status.textContent = `${result.message} النسخ المعلقة: ${result.pending}.`;
    setTimeout(() => { void loadGoogleDriveBackupStatus(); }, 1000);
  } catch (error) { if (status) status.textContent = error.message; }
}

async function disconnectGoogleDriveBackup() {
  if (!hasPermission('system_settings')) return showAppToast('لا تملك صلاحية إعدادات النظام.');
  const status = document.getElementById('google-drive-backup-status');
  try {
    const response = await fetch('/api/google-drive-backup/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر فصل Google Drive.');
    if (status) status.textContent = result.message;
    await loadGoogleDriveBackupStatus();
  } catch (error) { if (status) status.textContent = error.message; }
}

async function loadScheduledBackups() {
  if (!hasPermission('import_export')) return;
  const select = document.getElementById('scheduled-backup-select');
  const status = document.getElementById('scheduled-backup-status');
  if (!select) return;
  try {
    const response = await fetch('/api/scheduled-backups', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر تحميل النسخ المجدولة.');
    select.replaceChildren(new Option('اختر نسخة محفوظة', ''));
    for (const backup of result.backups || []) {
      const date = new Date(backup.modified_at).toLocaleString('ar-EG-u-nu-latn');
      select.add(new Option(`${backup.name.includes('-close-') ? 'عند الإغلاق' : 'يومية'} — ${date} (${Math.ceil(backup.size / 1024)} KB)`, backup.name));
    }
    if (status) status.textContent = `${(result.backups || []).length} نسخة مجدولة محفوظة.`;
  } catch (error) { if (status) status.textContent = error.message; }
}

async function loadBackupSettings() {
  if (!hasPermission('system_settings') && !hasPermission('import_export')) return;
  try {
    const response = await fetch('/api/settings/backup', { cache: 'no-store' });
    const settings = await response.json();
    if (!response.ok) throw new Error(settings.error || 'تعذر تحميل إعدادات النسخ.');
    const enabled = document.getElementById('backup-auto-enabled'); if (enabled) enabled.checked = settings.enabled !== false;
    const frequency = document.getElementById('backup-frequency'); if (frequency) frequency.value = settings.frequency || 'daily';
    const time = document.getElementById('backup-time'); if (time) time.value = settings.time || '02:00';
    const backupPath = document.getElementById('backup-path'); if (backupPath) backupPath.value = settings.path || './backups';
    const retention = document.getElementById('backup-retention'); if (retention) retention.value = String(settings.retention || 30);
  } catch (error) { const status = document.getElementById('backup-manager-status'); if (status) status.textContent = error.message; }
}

async function saveBackupSettings() {
  if (!hasPermission('system_settings')) return showAppToast('لا تملك صلاحية تعديل إعدادات النسخ.');
  const payload = { enabled: Boolean(document.getElementById('backup-auto-enabled')?.checked), frequency: document.getElementById('backup-frequency')?.value, time: document.getElementById('backup-time')?.value, path: document.getElementById('backup-path')?.value, retention: Number(document.getElementById('backup-retention')?.value) };
  try {
    const response = await fetch('/api/settings/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'تعذر حفظ إعدادات النسخ.');
    document.getElementById('backup-manager-status').textContent = result.message;
    showAppToast(result.message, { tone: 'success' });
  } catch (error) { showAppToast(error.message, { tone: 'error' }); }
}

async function loadBackups() {
  if (!hasPermission('import_export')) return;
  const body = document.getElementById('backup-table-body'); if (!body) return;
  try {
    const response = await fetch('/api/backups', { cache: 'no-store' });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'تعذر تحميل النسخ الاحتياطية.');
    body.innerHTML = (result.backups || []).map(backup => `<tr class="border-t border-emerald-100"><td class="p-2">${escapeHtml(new Date(backup.modified_at).toLocaleString('ar-EG-u-nu-latn'))}</td><td class="p-2">${Math.ceil(Number(backup.size || 0) / 1024)} KB</td><td class="p-2"><span class="rounded-full px-2 py-1 ${backup.type === 'manual' ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-800'}">${backup.type === 'manual' ? 'يدوي' : 'تلقائي'}</span></td><td class="p-2"><div class="flex flex-wrap gap-1"><button type="button" class="rounded border border-emerald-300 bg-white px-2 py-1" onclick="downloadManagedBackup('${encodeURIComponent(backup.id)}')">تحميل</button><button type="button" class="rounded border border-amber-300 bg-white px-2 py-1" onclick="restoreManagedBackup('${encodeURIComponent(backup.id)}')">استعادة</button><button type="button" class="rounded border border-rose-300 bg-white px-2 py-1" onclick="deleteManagedBackup('${encodeURIComponent(backup.id)}')">حذف</button></div></td></tr>`).join('') || '<tr><td colspan="4" class="p-3 text-center text-emerald-800">لا توجد نسخ محفوظة.</td></tr>';
    const status = document.getElementById('backup-manager-status'); if (status) status.textContent = `${(result.backups || []).length} نسخة محفوظة.`;
  } catch (error) { body.innerHTML = `<tr><td colspan="4" class="p-3 text-center text-rose-700">${escapeHtml(error.message)}</td></tr>`; }
}

async function createBackupNow() {
  if (!hasPermission('import_export')) return showAppToast('لا تملك صلاحية إنشاء نسخة احتياطية.');
  try { const response = await fetch('/api/backups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'تعذر إنشاء النسخة.'); showAppToast(result.message, { tone: 'success' }); await loadBackups(); }
  catch (error) { showAppToast(error.message, { tone: 'error' }); }
}

function managedBackupId(value) { return decodeURIComponent(String(value || '')); }
function downloadManagedBackup(id) { const anchor = document.createElement('a'); anchor.href = `/api/backups/${encodeURIComponent(managedBackupId(id))}/download`; anchor.click(); }
async function deleteManagedBackup(id) {
  if (!hasPermission('system_settings')) return showAppToast('حذف النسخ الاحتياطية متاح لمدير النظام فقط.');
  if (!await showAppConfirm('سيتم حذف النسخة الاحتياطية نهائياً. هل تريد المتابعة؟')) return;
  const response = await fetch(`/api/backups/${encodeURIComponent(managedBackupId(id))}`, { method: 'DELETE' }); const result = await response.json(); if (!response.ok) return showAppToast(result.error || 'تعذر حذف النسخة.', { tone: 'error' }); showAppToast(result.message, { tone: 'success' }); await loadBackups();
}
async function restoreManagedBackup(id) {
  if (!isUnrestrictedAccount(currentUser)) return showAppToast('استعادة النسخ متاحة للمالك أو admin فقط.');
  if (!await showAppConfirm('سيتم أخذ نسخة أمان ثم استبدال قاعدة البيانات الحالية. متأكد؟')) return;
  const response = await fetch(`/api/backups/${encodeURIComponent(managedBackupId(id))}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true }) }); const result = await response.json(); if (!response.ok) return showAppToast(result.error || 'فشلت الاستعادة.', { tone: 'error' }); showAppToast(result.message || 'تمت الاستعادة.', { tone: 'success' }); window.setTimeout(() => window.location.reload(), 900);
}

async function restoreScheduledBackup() {
  if (!hasPermission('import_export')) return showAppToast('لا تملك صلاحية استعادة النسخ الاحتياطية.');
  const name = document.getElementById('scheduled-backup-select')?.value;
  if (!name) return showAppToast('اختر نسخة مجدولة أولاً.');
  if (!await showAppConfirm(`ستُستبدل بيانات النظام بالنسخة «${name}». سيحفظ النظام نسخة أمان من البيانات الحالية قبل الاستعادة. هل تريد المتابعة؟`)) return;
  const status = document.getElementById('scheduled-backup-status');
  try {
    const backupResponse = await fetch(`/api/scheduled-backups/${encodeURIComponent(name)}`);
    if (!backupResponse.ok) { const error = await backupResponse.json(); throw new Error(error.error || 'تعذر قراءة النسخة المختارة.'); }
    const restoreResponse = await fetch('/api/restore-sqlite', { method: 'POST', headers: { 'Content-Type': 'application/vnd.sqlite3' }, body: await backupResponse.arrayBuffer() });
    const result = await restoreResponse.json();
    if (!restoreResponse.ok) throw new Error(result.error || 'فشلت استعادة النسخة.');
    if (status) status.textContent = 'تمت الاستعادة مع حفظ نسخة أمان تلقائية.';
    showAppToast(result.message || 'تمت استعادة النسخة المجدولة.');
    window.location.reload();
  } catch (error) { if (status) status.textContent = error.message; }
}

// ----------------------------------------------------
// Modal Helpers
// ----------------------------------------------------
function bindPurchaseModalWheel() {
  const panel = document.querySelector('#modal-add-purchase > div');
  if (!panel || panel.dataset.wheelBound === 'true') return;
  panel.dataset.wheelBound = 'true';
  panel.addEventListener('wheel', event => {
    if (panel.scrollHeight <= panel.clientHeight) return;
    panel.scrollTop += event.deltaY;
    event.preventDefault();
  }, { passive: false });
}

function bindDashboardWheel() {
  if (window.__systemPosDashboardWheelBound) return;
  window.__systemPosDashboardWheelBound = true;
  document.addEventListener('wheel', event => {
    const dashboard = document.getElementById('tab-dashboard');
    const main = document.querySelector('#app-shell > .flex-1.flex.max-w-7xl > main');
    if (!dashboard || dashboard.classList.contains('hidden') || !main) return;
    const sidebar = event.target.closest?.('#app-sidebar .app-sidebar-nav');
    const scrollTarget = sidebar && sidebar.scrollHeight > sidebar.clientHeight ? sidebar : main;
    if (scrollTarget.scrollHeight <= scrollTarget.clientHeight) return;
    if (!event.target.closest?.('[data-wheel-native]')) {
      scrollTarget.scrollTop += event.deltaY;
      event.preventDefault();
    }
  }, { passive: false });
}

function setForcedPasswordChangeState(active) {
  forcedPasswordChangeActive = Boolean(active) && !IS_DEV_BUILD;
  const modal = document.getElementById('modal-change-password');
  const closeButton = modal?.querySelector('button[onclick*="modal-change-password"]');
  if (closeButton) {
    closeButton.hidden = forcedPasswordChangeActive;
    closeButton.setAttribute('aria-hidden', forcedPasswordChangeActive ? 'true' : 'false');
    closeButton.tabIndex = forcedPasswordChangeActive ? -1 : 0;
  }
}

function openForcedPasswordChange() {
  setForcedPasswordChangeState(true);
  openModal('modal-change-password');
  document.getElementById('own-current-password')?.focus();
}

function openModal(id) {
  if (id === 'modal-login') document.getElementById('app-shell')?.classList.add('hidden');
  const m = document.getElementById(id);
  if (m) {
    if (id === 'modal-add-purchase') m.classList.remove('purchase-ocr-active');
    m.classList.remove('hidden');
    if (m.classList.contains('modal-overlay')) {
      m.classList.add('show');
      m.style.display = 'grid';
    }
  }
  if (id === 'modal-add-purchase') {
    bindPurchaseModalWheel();
    const date = document.getElementById('purchase-invoice-date');
    if (date) { const now = new Date(); date.value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; }
    const status = document.getElementById('purchase-form-status'); if (status) status.textContent = '';
    renderPurchaseRows();
    void (async () => { await populatePurchaseCategoryFilter(); await searchPurchaseProducts(''); })();
  }
  syncModalBodyLock();
}

async function closeModal(id) {
  if (id === 'modal-change-password' && forcedPasswordChangeActive && currentUser?.must_change_password !== false) return false;
  if (id === 'modal-add-user' && userModalDirty && !await showAppConfirm('توجد تغييرات غير محفوظة في صلاحيات المستخدم. هل تريد الإغلاق دون حفظ؟')) return false;
  if (id === 'modal-product') void stopProductBarcodeCamera();
  const m = document.getElementById(id);
  if (m) {
    m.classList.add('hidden');
    if (m.classList.contains('modal-overlay')) {
      m.classList.remove('show');
      m.style.display = 'none';
    }
  }
  if (id === 'modal-change-password') setForcedPasswordChangeState(false);
  syncModalBodyLock();
}
function syncModalBodyLock() {
  if (!document.body) return;
  const open = Boolean(document.querySelector('.modal-backdrop:not(.hidden), #modal-input-dialog:not(.hidden), #modal-business-setup:not(.hidden)'));
  document.body.classList.toggle('modal-open', open);
}

// ----------------------------------------------------
// Theme & Wallpaper Management
// ----------------------------------------------------
const FONT_SCALE_VALUES = Object.freeze({ normal: 1, large: 1.45, xlarge: 1.75 });
const appHeaderResizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
  const height = entries[0]?.contentRect?.height;
  if (Number.isFinite(height) && height > 0) document.documentElement.style.setProperty('--app-header-height', `${Math.ceil(height)}px`);
}) : null;
const appHeaderElement = document.querySelector('#app-shell > header');
if (appHeaderElement) appHeaderResizeObserver?.observe(appHeaderElement);
function fontScaleStorageKey(user = currentUser) { return `system_font_size_${String(user?.id || user?.username || 'guest')}`; }
function enforceReadableFontSizes() { document.querySelectorAll('#app-shell [data-rawda-base-font-size]').forEach(node => { node.style.removeProperty('font-size'); node.style.removeProperty('font-weight'); delete node.dataset.rawdaBaseFontSize; }); }
function applyFontScale(value) { const selected = Object.prototype.hasOwnProperty.call(FONT_SCALE_VALUES, value) ? value : 'large'; document.documentElement.style.setProperty('--rawda-font-scale', String(FONT_SCALE_VALUES[selected])); document.body?.setAttribute('data-font-size', selected); const select = document.getElementById('font-size-setting'); if (select) select.value = selected; if (document.body) requestAnimationFrame(enforceReadableFontSizes); return selected; }
  // Intentionally ignored: saved font preference is optional
function loadSavedFontScale() { let saved = 'large'; try { saved = localStorage.getItem(fontScaleStorageKey()) || 'large'; } catch (_) {} applyFontScale(saved); }
  // Intentionally ignored: font preference persistence is best-effort
function setFontScale(value) { const selected = applyFontScale(value); try { localStorage.setItem(fontScaleStorageKey(), selected); } catch (_) {} const status = document.getElementById('font-size-status'); if (status) status.textContent = `تم حفظ حجم الخط: ${selected}`; }

function uiZoomStorageKey() { return `system_ui_zoom_${String(currentUser?.id || currentUser?.username || 'guest')}`; }
function updateZoomStatus(factor) {
  const status = document.getElementById('ui-zoom-status');
  if (status) status.textContent = `${Math.round(factor * 100)}%`;
}
async function applyUiZoom(factor, persist = true) {
  const next = Math.min(1.5, Math.max(0.75, Math.round(Number(factor) * 100) / 100 || 1));
  if (window.rawdaDesktop?.setUiZoom) await window.rawdaDesktop.setUiZoom(next);
  else document.documentElement.style.zoom = String(next);
  // Intentionally ignored: UI zoom preference persistence is best-effort
  if (persist) { try { localStorage.setItem(uiZoomStorageKey(), String(next)); } catch (_) {} }
  updateZoomStatus(next);
  return next;
}
function adjustUiZoom(delta) {
  let current = 1;
  // Intentionally ignored: missing zoom preference uses the current zoom
  try { current = Number(localStorage.getItem(uiZoomStorageKey())) || 1; } catch (_) {}
  void applyUiZoom(current + Number(delta || 0));
}
function resetUiZoom() { void applyUiZoom(1); }
async function initializeUiZoom() {
  let saved = 1;
  // Intentionally ignored: missing zoom preference uses the default zoom
  try { saved = Number(localStorage.getItem(uiZoomStorageKey())) || 1; } catch (_) {}
  await applyUiZoom(saved, false);
}

function performanceModeStorageKey() { return `system_performance_mode_${String(currentUser?.id || currentUser?.username || 'guest')}`; }
let performanceHardwareWeak = false;
function applyPerformanceMode(mode) {
  const selected = ['auto', 'on', 'off'].includes(mode) ? mode : 'auto';
  const active = selected === 'on' || (selected === 'auto' && performanceHardwareWeak);
  document.body?.classList.toggle('performance-mode', active);
  const picker = document.getElementById('performance-mode-setting');
  if (picker) picker.value = selected;
  const status = document.getElementById('typing-diagnostics-status');
  if (status) status.dataset.performanceMode = active ? 'on' : 'off';
  return { selected, active };
}
function setPerformanceMode(mode) {
  const { selected, active } = applyPerformanceMode(mode);
  // Intentionally ignored: performance preference persistence is best-effort
  try { localStorage.setItem(performanceModeStorageKey(), selected); } catch (_) {}
  showAppToast(active ? 'وضع الأداء مفعّل لتخفيف المؤثرات.' : 'تم إيقاف وضع الأداء.');
}
async function initializePerformanceMode() {
  let gpu = null;
  // Intentionally ignored: GPU capability detection is optional
  try { gpu = await window.rawdaDesktop?.getGpuFeatureStatus?.(); } catch (_) {}
  const gpuText = gpu ? Object.entries(gpu).map(([name, value]) => `${name}: ${value}`).join('، ') : 'غير متاح خارج نسخة Electron';
  const gpuLabel = document.getElementById('gpu-feature-status');
  if (gpuLabel) gpuLabel.textContent = `حالة GPU — app.getGPUFeatureStatus(): ${gpuText}`;
  const values = Object.values(gpu || {}).map(value => String(value).toLowerCase());
  performanceHardwareWeak = values.some(value => /software|disabled|unavailable/u.test(value))
    || (Number(navigator.hardwareConcurrency || 8) <= 4)
    || (Number(navigator.deviceMemory || 8) <= 4);
  let saved = 'auto';
  // Intentionally ignored: performance preference loading is best-effort
  try { saved = localStorage.getItem(performanceModeStorageKey()) || 'auto'; } catch (_) {}
  const { active } = applyPerformanceMode(saved);
  if (saved === 'auto' && active) showAppToast('تم تفعيل وضع الأداء تلقائياً لأن قدرات الرسم أو الجهاز محدودة.');
}

const typingLatencySamples = { login: [], product: [], customer: [], other: [] };
const typingKeyTimes = new WeakMap();
let typingDiagnosticsUntil = 0;
let typingDiagnosticsReport = null;
function typingLatencyGroup(target) {
  if (!target?.matches?.('input,textarea,[contenteditable="true"]')) return null;
  const id = String(target.id || '');
  if (/login|pin-(username|entry)/iu.test(id) || target.closest('#modal-login')) return 'login';
  if (target.closest('#modal-product') || /product-(name|barcode|cost|price)|new-product/iu.test(id)) return 'product';
  if (target.closest('#modal-add-customer') || /customer-(name|phone|address)|new-customer/iu.test(id)) return 'customer';
  return 'other';
}
document.addEventListener('keydown', event => {
  if (performance.now() >= typingDiagnosticsUntil || event.isComposing || event.key.length !== 1) return;
  const target = event.target;
  if (typingLatencyGroup(target)) typingKeyTimes.set(target, performance.now());
}, true);
document.addEventListener('input', event => {
  const started = typingKeyTimes.get(event.target);
  const group = typingLatencyGroup(event.target);
  if (!group || !Number.isFinite(started) || performance.now() >= typingDiagnosticsUntil) return;
  typingKeyTimes.delete(event.target);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (performance.now() > typingDiagnosticsUntil + 300) return;
    const samples = typingLatencySamples[group];
    samples.push(performance.now() - started);
    if (samples.length > 300) samples.shift();
  }));
}, true);
function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)].toFixed(1));
}
function formatTypingLatencyReport() {
  const label = group => {
    const values = typingLatencySamples[group];
    return `${group}: n=${values.length}, median=${percentile(values, 0.5) ?? '—'}ms, p95=${percentile(values, 0.95) ?? '—'}ms`;
  };
  return [`SYSTEM typing latency`, `timestamp=${new Date().toISOString()}`, `gpu=${document.getElementById('gpu-feature-status')?.textContent || 'unknown'}`, `mode=${document.getElementById('typing-diagnostics-status')?.dataset.performanceMode || 'unknown'}`, label('login'), label('product'), label('customer')].join('\n');
}
function startTypingDiagnostics() {
  Object.values(typingLatencySamples).forEach(values => values.splice(0));
  typingDiagnosticsUntil = performance.now() + 10000;
  typingDiagnosticsReport = null;
  const status = document.getElementById('typing-diagnostics-status');
  if (status) status.textContent = 'اكتب في حقول الدخول أو المنتج أو العميل خلال 10 ثوانٍ؛ سيظهر median وp95 بعد انتهاء القياس.';
  window.setTimeout(() => {
    if (performance.now() < typingDiagnosticsUntil) return;
    typingDiagnosticsReport = formatTypingLatencyReport();
    if (status) status.textContent = typingDiagnosticsReport.replace(/\n/g, ' | ');
  }, 10100);
}
async function copyTypingDiagnostics() {
  const report = typingDiagnosticsReport || formatTypingLatencyReport();
  try { await navigator.clipboard.writeText(report); showAppToast('تم نسخ تقرير الأداء.'); }
  catch (_) { showAppToast(report); }
}
void initializeUiZoom();
void initializePerformanceMode();

const SYSTEM_THEME_CLASSES = Object.freeze([
  '', 'theme-cosmic', 'theme-gold', 'theme-emerald', 'theme-light', 'theme-ivory', 'theme-rose'
]);
const LEGACY_THEME_CLASSES = Object.freeze([
  'theme-pink-luxury', 'theme-dark-royal', 'theme-lavender', 'theme-emerald',
  'theme-white-marble', 'theme-white-red', 'theme-midnight', 'theme-ice', 'theme-aurora'
]);

function selectTheme(themeClass) {
  if (themeClass === undefined || !SYSTEM_THEME_CLASSES.includes(themeClass)) themeClass = '';
  [...SYSTEM_THEME_CLASSES, ...LEGACY_THEME_CLASSES].forEach(name => { if (name) document.body.classList.remove(name); });
  if (themeClass) document.body.classList.add(themeClass);
  // A previous dashboard theme may leave an inline !important background on
  // body. Clear it before applying the selected page palette.
  document.body.style.removeProperty('background');
  const themedSidebar = document.querySelector('#app-shell .app-sidebar-nav');
  if (themedSidebar) {
    themedSidebar.style.setProperty('background-color', 'var(--system-sidebar)', 'important');
    themedSidebar.style.setProperty('background-image', 'none', 'important');
  }
  const dashboardVisible = Boolean(document.querySelector('#tab-dashboard:not(.hidden)'));
  document.body.classList.toggle('dashboard-sage-active', dashboardVisible && themeClass === 'theme-sage-metal');
  if (dashboardVisible && themeClass === 'theme-sage-metal') document.body.style.setProperty('background', 'var(--system-page)', 'important');
  else if (dashboardVisible) document.body.style.removeProperty('background');
  // Intentionally ignored: theme persistence is best-effort
  try { localStorage.setItem('system_selected_theme', themeClass); } catch (_) {}

  // Keep the dashboard swatches synchronized when a theme is restored or changed elsewhere.
  document.querySelectorAll('#tab-dashboard .theme-btn').forEach(button => {
    const active = (button.dataset.systemTheme || '') === themeClass;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  // Update active border on modal preview cards
  document.querySelectorAll('.theme-preview-card').forEach(card => {
    card.classList.remove('active-theme', 'ring-2', 'ring-[#D6336C]');
    if (card.matches('[role="radio"]')) card.setAttribute('aria-checked', 'false');
  });
  const activeCard = [...document.querySelectorAll('.theme-preview-card')]
    .find(card => (card.dataset.systemTheme || '') === themeClass);
  if (activeCard) {
    activeCard.classList.add('active-theme', 'ring-2', 'ring-[#D6336C]');
    activeCard.setAttribute('aria-checked', 'true');
  }
}

function loadSavedTheme() {
  let saved = localStorage.getItem('system_selected_theme') || '';
  if (!SYSTEM_THEME_CLASSES.includes(saved)) saved = SYSTEM_THEME_CLASSES[0];
  selectTheme(saved);
}

// The dashboard has a single approved design (the 7-theme control centre).
// The legacy alternative interfaces (classic / owner-brand / futuristic) were
// removed; this function stays so older callers keep working, and it always
// applies the one design. Colour themes are chosen with selectTheme().
function selectDashboardInterface() {
  document.body.classList.add('dashboard-system-interface');
  document.body.classList.remove('dashboard-owner-brand-interface', 'dashboard-futuristic-interface');
  // Intentionally ignored: persistence is best-effort
  try { localStorage.setItem('system_dashboard_interface', 'system'); } catch (_) {}
}

function loadSavedDashboardInterface() {
  selectDashboardInterface();
  loadDashTheme();
  initDashboardEffects();
}

// ---- Dashboard colour themes (8): dark-obsidian is the default ----------
const DASH_THEMES = ['dark-obsidian', 'sapphire', 'violet', 'emerald', 'gold-light', 'sky', 'rose', 'white'];
function setDashTheme(name) {
  const theme = DASH_THEMES.includes(name) ? name : 'dark-obsidian';
  document.body.setAttribute('data-dash-theme', theme);
  document.querySelectorAll('[data-dash-theme-choice]').forEach(btn => {
    const on = btn.dataset.dashThemeChoice === theme;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  // UI preference only (not business data)
  try { localStorage.setItem('pos_theme_choice', theme); } catch (_) {}
}
function loadDashTheme() {
  let saved = 'dark-obsidian';
  try { saved = localStorage.getItem('pos_theme_choice') || saved; } catch (_) {}
  setDashTheme(saved);
}

// ---- Dashboard shortcuts wired to existing features ----------------------
function dashboardOpenBarcodeScanner() {
  switchTab('pos');
  setTimeout(() => { try { if (typeof startPosBarcodeCamera === 'function') startPosBarcodeCamera(); } catch (_) {} }, 250);
}
function dashboardGlobalSearch(term) {
  const value = String(term || '').trim();
  if (!value) return;
  switchTab('products');
  setTimeout(() => {
    const input = document.getElementById('products-search-input');
    if (!input) return;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }, 200);
}

// ---- Background particles + button ripple (dashboard only, cheap) --------
let dashboardEffectsStarted = false;
function initDashboardEffects() {
  if (dashboardEffectsStarted) return;
  dashboardEffectsStarted = true;
  document.addEventListener('click', event => {
    const el = event.target.closest && event.target.closest('body.dashboard-preview-active .grid-action-btn, body.dashboard-preview-active .btn-refresh-top, body.dashboard-preview-active .btn-exit, body.dashboard-preview-active .btn-barcode-scan, body.dashboard-preview-active #app-sidebar .tab-btn');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.left = `${event.clientX - rect.left}px`;
    ripple.style.top = `${event.clientY - rect.top}px`;
    el.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  });
  const canvas = document.getElementById('particle-canvas');
  if (!canvas || !canvas.getContext) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ctx = canvas.getContext('2d');
  const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
  resize();
  window.addEventListener('resize', resize);
  const particles = Array.from({ length: 50 }, () => ({
    x: Math.random() * canvas.width, y: Math.random() * canvas.height,
    size: Math.random() * 2.5 + 1, vx: Math.random() * 0.8 - 0.4, vy: Math.random() * 0.8 - 0.4
  }));
  const frame = () => {
    requestAnimationFrame(frame);
    if (document.hidden || !document.body.classList.contains('dashboard-preview-active')) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--d-primary').trim() || '#00E5FF';
    ctx.globalAlpha = 0.35;
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy;
      if (p.x > canvas.width) p.x = 0; if (p.x < 0) p.x = canvas.width;
      if (p.y > canvas.height) p.y = 0; if (p.y < 0) p.y = canvas.height;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    }
  };
  frame();
}

// ----------------------------------------------------
// Employees UI & Payroll Controller
// ----------------------------------------------------
async function renderEmployees() {
  const tbody = document.getElementById('employees-table-body');
  if (!tbody) return;

  const employees = (await storage.getEmployees()).filter(e => e.is_active !== false);
  const modernBody = document.getElementById('modern-employees-body');
  if (modernBody) modernBody.innerHTML = employees.map(employee => `<tr><td>${escapeHtml(employee.name || '')}</td><td>${escapeHtml(employee.role || 'موظف')}</td><td>${escapeHtml(employee.branch_name || '—')}</td><td><span class="erp-status-pill success">نشط</span></td></tr>`).join('') || '<tr><td colspan="4" class="erp-empty-cell">لا يوجد موظفون.</td></tr>';
  const attendance = await storage.getAttendance();

  let totalBase = 0;
  let totalAdv = 0;
  let totalNet = 0;

  tbody.innerHTML = '';
  if (employees.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="text-center py-6 text-gray-400">لا يوجد موظفون مسجلون حالياً</td></tr>';
  } else {
    employees.forEach(emp => {
      totalBase += emp.base_salary;
      totalAdv += (emp.total_advances || 0);
      totalNet += (emp.net_payable || 0);

      const salaryTypeLabel = emp.salary_type === 'daily' ? 'يومية' : 'شهري';
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const todayAttendance = attendance.find(a => a.employee_id === emp.id && a.work_date === today);
      const tr = document.createElement('tr');
      tr.className = 'hover:bg-gray-50/80 transition';
      tr.innerHTML = `
        <td class="py-3 px-4">
          <div class="font-bold text-gray-900">${escapeHtml(emp.name)}</div>
          <div class="text-[10px] text-gray-400">منذ ${escapeHtml(emp.hire_date || '--')}</div>
        </td>
        <td class="py-3 px-3">
          <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-pink-light text-[#D6336C] border border-[#D6336C]/20">
            ${escapeHtml(emp.role)}
          </span>
        </td>
        <td class="py-3 px-3 font-bold text-blue-800">${escapeHtml(emp.branch_name || branchWorkspaceBranches.find(branch => Number(branch.id) === Number(emp.branch_id || currentUser?.branch_id))?.name || '--')}</td>
        <td class="py-3 px-3 font-mono text-gray-600">${escapeHtml(emp.phone || '--')}</td>
        <td class="py-3 px-3 font-bold text-gray-900">${emp.base_salary.toFixed(2)} ج.م <span class="text-[10px] text-gray-400">(${salaryTypeLabel})</span></td>
        <td class="py-3 px-3 font-bold text-red-600">${(emp.total_advances || 0).toFixed(2)} ج.م</td>
        <td class="py-3 px-3 font-bold text-green-700">+${(emp.total_bonuses || 0).toFixed(2)} ج.م</td>
        <td class="py-3 px-3 font-bold text-amber-700">-${(emp.total_deductions || 0).toFixed(2)} ج.م</td>
        <td class="py-3 px-3 font-black text-sm text-[#1A1A1A] bg-gray-50/50">${emp.net_payable.toFixed(2)} ج.م</td>
        <td class="py-3 px-4 text-center">
          <div class="flex items-center justify-center gap-1.5 flex-wrap">
            <button onclick="markEmployeeAttendance(${emp.id}, 'in')" class="px-2 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg text-[10px] font-bold">حضور</button>
            <button onclick="markEmployeeAttendance(${emp.id}, 'out')" class="px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-[10px] font-bold">انصراف</button>
            <span class="text-[10px] text-gray-500">${todayAttendance ? `${escapeHtml(todayAttendance.check_in || '--')} / ${escapeHtml(todayAttendance.check_out || '--')}` : 'لم يسجل اليوم'}</span>
            ${todayAttendance && hasPermission('edit') ? `<button onclick="editAttendanceRecord(${todayAttendance.id})" class="px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded-lg text-[10px] font-bold">تعديل الحضور</button>` : ''}
            <button onclick="openEmpTransModal(${emp.id}, 'advance')" class="px-2 py-1 bg-red-50 hover:bg-red-100 text-red-700 rounded-lg text-[10px] font-bold" title="تسجيل سلفة">💸 سلفة</button>
            <button onclick="openEmpTransModal(${emp.id}, 'bonus')" class="px-2 py-1 bg-green-50 hover:bg-green-100 text-green-700 rounded-lg text-[10px] font-bold" title="مكافأة / عمولة">🎁 مكافأة</button>
            <button onclick="openEmpTransModal(${emp.id}, 'deduction')" class="px-2 py-1 bg-amber-50 hover:bg-amber-100 text-amber-700 rounded-lg text-[10px] font-bold" title="خصم / جزاء">⚠️ خصم</button>
            <button onclick="openEmpTransModal(${emp.id}, 'settlement')" class="px-2 py-1 btn-pink rounded-lg text-[10px] font-bold" title="صرف الراتب وتصفية">💰 صرف</button>
            <button onclick="viewEmployeeLedger(${emp.id})" class="p-1 text-gray-500 hover:text-black rounded" title="كشف الحساب"><i data-lucide="file-text" class="w-4 h-4"></i></button>
            <button onclick="editEmployee(${emp.id})" class="p-1 text-amber-600 hover:text-amber-800 rounded" title="تعديل الموظف"><i data-lucide="pencil" class="w-4 h-4"></i></button>
            ${hasPermission('delete') ? `<button onclick="deleteEmployee(${emp.id})" class="p-1 text-red-600 hover:text-red-800 rounded" title="حذف الموظف"><i data-lucide="trash-2" class="w-4 h-4"></i></button>` : ''}
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  // Update stat cards
  const countEl = document.getElementById('emp-stat-count');
  const baseEl = document.getElementById('emp-stat-base-total');
  const advEl = document.getElementById('emp-stat-advances');
  const netEl = document.getElementById('emp-stat-net-total');

  if (countEl) countEl.textContent = employees.length;
  if (baseEl) baseEl.textContent = `${totalBase.toFixed(2)} ج.م`;
  if (advEl) advEl.textContent = `${totalAdv.toFixed(2)} ج.م`;
  if (netEl) netEl.textContent = `${totalNet.toFixed(2)} ج.م`;

  lucide.createIcons();
  enforceReadableFontSizes();
}

async function handleEmployeeSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('emp-new-name').value.trim();
  const role = document.getElementById('emp-new-role').value.trim();
  const phone = document.getElementById('emp-new-phone').value.trim();
  const salaryType = document.getElementById('emp-new-salary-type').value;
  const baseSalary = parseFloat(document.getElementById('emp-new-salary').value) || 0;
  const notes = document.getElementById('emp-new-notes').value.trim();
  const workStart = document.getElementById('emp-new-work-start')?.value || '09:00';
  const workEnd = document.getElementById('emp-new-work-end')?.value || '17:00';
  const workDays = document.getElementById('emp-new-work-days')?.value.trim() || 'السبت - الخميس';
  const commissionRate = Number(document.getElementById('emp-new-commission-rate')?.value || 0);
  const attendancePin = document.getElementById('emp-new-attendance-pin')?.value || '';
  const attendanceCardUid = document.getElementById('emp-new-attendance-card')?.value.trim() || '';
  const branchId = Number(document.getElementById('emp-new-branch')?.value || currentUser?.branch_id || localStorage.getItem(ACTIVE_BRANCH_KEY) || 1);

  await storage.saveEmployee({
    name,
    role,
    phone,
    salary_type: salaryType,
    base_salary: baseSalary,
    notes,
    hire_date: new Date().toISOString().slice(0, 10)
    , work_start: workStart, work_end: workEnd, work_days: workDays, commission_rate: commissionRate,
    attendance_pin: attendancePin, attendance_card_uid: attendanceCardUid, branch_id: branchId
  });

  await populateCustomerDropdowns();
  closeModal('modal-add-employee');
  document.getElementById('emp-new-name').value = '';
  document.getElementById('emp-new-role').value = '';
  document.getElementById('emp-new-phone').value = '';
  document.getElementById('emp-new-salary').value = '';
  document.getElementById('emp-new-commission-rate').value = '0';
  document.getElementById('emp-new-attendance-pin').value = '';
  document.getElementById('emp-new-attendance-card').value = '';
  document.getElementById('emp-new-notes').value = '';

  await renderEmployees();
  showAppToast(`تمت إضافة الموظف [${name}] بنجاح!`);
}

async function editEmployee(empId) {
  const emp = (await storage.getEmployees()).find(e => e.id === empId); if (!emp) return;
  let branches = [];
  // Intentionally ignored: optional branch data leaves existing employee values intact
  try { const response = await fetch('/api/branches'); if (response.ok) branches = (await response.json()).branches || []; } catch (_) {}
  const eligibleBranches = branches.filter(branch => branch.is_active !== false);
  const values = await openAppFormDialog({ title: `تعديل بيانات ${emp.name}`, subtitle: 'اترك أي قيمة كما هي إذا لم ترد تغييرها.', fields: [
    { label: 'اسم الموظف', value: emp.name }, { label: 'الوظيفة', value: emp.role }, { label: 'الهاتف', value: emp.phone || '' },
    { label: 'فرع العمل', type: 'select', value: String(emp.branch_id || currentUser?.branch_id || 1), disabled: !isUnrestrictedAccount(currentUser), options: eligibleBranches.map(branch => ({ value: branch.id, label: branch.name })) },
    { label: 'الراتب الأساسي', type: 'number', value: emp.base_salary }, { label: 'عمولة البيع (%)', type: 'number', value: Number(emp.commission_rate || 0) }, { label: 'بداية العمل', type: 'time', value: emp.work_start || '09:00' }, { label: 'نهاية العمل', type: 'time', value: emp.work_end || '17:00' }, { label: 'أيام العمل', value: emp.work_days || 'السبت - الخميس' }, { label: 'ملاحظات', value: emp.notes || '' }, { label: 'PIN جديد (اتركه فارغاً دون تغيير)', type: 'password', value: '' }, { label: 'رقم البطاقة', value: emp.attendance_card_uid || '' }
  ], submitLabel: 'حفظ التعديل' });
  if (!values) return;
  await storage.updateEmployee(empId, { name: values[0], role: values[1], phone: values[2], branch_id: Number(values[3]), base_salary: Number(values[4]) || 0, commission_rate: Number(values[5]) || 0, work_start: values[6], work_end: values[7], work_days: values[8], notes: values[9], attendance_pin: values[10], attendance_card_uid: values[11] });
  await populateCustomerDropdowns();
  await renderEmployees(); showAppToast('تم تعديل بيانات الموظف بنجاح.');
}

async function deleteEmployee(empId) {
  if (!await showAppConfirm('هل تريد حذف الموظف؟ سيتم تعطيله مع الحفاظ على سجلات الرواتب والحضور.')) return;
  try { await storage.deleteEmployee(empId); await populateCustomerDropdowns(); await renderEmployees(); showAppToast('تم حذف الموظف بنجاح.'); } catch (err) { showAppToast(err.message); }
}

async function markEmployeeAttendance(empId, action) {
  try { await storage.markAttendance(empId, action); await renderEmployees(); showAppToast(action === 'in' ? 'تم تسجيل الحضور.' : 'تم تسجيل الانصراف.'); } catch (err) { showAppToast(err.message); }
}

async function markAttendanceByCredential(action) {
  const values = await openAppFormDialog({ title: action === 'in' ? 'تسجيل حضور الموظف' : 'تسجيل انصراف الموظف', subtitle: 'امسح بطاقة الموظف أو أدخل رمز PIN المسجل له.', fields: [{ label: 'PIN أو رقم البطاقة', type: 'password', value: '' }], submitLabel: action === 'in' ? 'تسجيل الحضور' : 'تسجيل الانصراف' });
  if (!values || !values[0]) return;
  try {
    const response = await fetch(`/api/attendance/${action === 'in' ? 'check-in' : 'check-out'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: values[0] }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'تعذر تسجيل الحضور.');
    await renderEmployees(); showAppToast(`تم تسجيل ${action === 'in' ? 'الحضور' : 'الانصراف'} للموظف ${data.employee_name || ''}.`);
  } catch (error) { showAppToast(error.message); }
}

async function editAttendanceRecord(attendanceId) {
  if (!hasPermission('edit')) return showAppToast('لا تملك صلاحية تعديل كشف الحضور.');
  const attendance = (await storage.getAttendance()).find(row => row.id === attendanceId);
  if (!attendance) return showAppToast('سجل الحضور غير موجود.');
  const result = await openAppFormDialog({ title: `تعديل الحضور — ${attendance.work_date}`, subtitle: 'عدّل الأوقات والملاحظات، وسيُعاد حساب عدد الساعات تلقائياً.', fields: [
    { label: 'وقت الحضور', type: 'time', value: attendance.check_in || '' },
    { label: 'وقت الانصراف', type: 'time', value: attendance.check_out || '' },
    { label: 'ملاحظات', type: 'text', value: attendance.notes || '' }
  ], submitLabel: 'حفظ التعديل' });
  if (!result) return;
  try {
    const response = await fetch(`/api/attendance/${attendanceId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ check_in: result[0], check_out: result[1], notes: result[2] }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر تعديل سجل الحضور.');
    await renderEmployees();
    showAppToast('تم تعديل الحضور وإعادة حساب الساعات.');
  } catch (error) { showAppToast(error.message); }
}

async function openEmpTransModal(empId, transType = 'advance') {
  const employees = await storage.getEmployees();
  const emp = employees.find(e => e.id === empId);
  if (!emp) return;

  document.getElementById('trans-emp-id').value = emp.id;
  document.getElementById('trans-emp-name').value = `${emp.name} (صافي المستحق: ${emp.net_payable.toFixed(2)} ج.م)`;
  document.getElementById('trans-type').value = transType;
  document.getElementById('trans-amount').value = transType === 'settlement' ? emp.net_payable : '';
  document.getElementById('trans-notes').value = transType === 'settlement' ? `صرف راتب وتصفية مستحقات شهر ${new Date().toLocaleDateString('ar-EG-u-nu-latn', { month: 'long', year: 'numeric' })}` : '';

  updateTransTypeHint();
  openModal('modal-emp-transaction');
}

function updateTransTypeHint() {
  const type = document.getElementById('trans-type').value;
  const titleEl = document.getElementById('emp-trans-modal-title');
  const titles = {
    advance: 'تسجيل سلفة نقدية على الراتب',
    bonus: 'تسجيل مكافأة أو عمولة مبيعات',
    deduction: 'تسجيل خصم أو جزاء',
    settlement: 'صرف الراتب وتصفية الحساب'
  };
  if (titleEl) titleEl.textContent = titles[type] || 'تسجيل حركة مالية لموظف';
}

async function handleEmpTransactionSubmit(e) {
  e.preventDefault();
  const empId = parseInt(document.getElementById('trans-emp-id').value);
  const type = document.getElementById('trans-type').value;
  const amount = parseFloat(document.getElementById('trans-amount').value) || 0;
  const notes = document.getElementById('trans-notes').value.trim();

  if (amount <= 0) {
    showAppToast('يرجى إدخال مبلغ صحيح أكبر من صفر.');
    return;
  }

  await storage.addEmployeeTransaction({
    employee_id: empId,
    type,
    amount,
    notes
  });

  closeModal('modal-emp-transaction');
  await renderEmployees();
  showAppToast('تم تسجيل العملية المالية بنجاح!');
}

async function viewEmployeeLedger(empId) {
  const employees = await storage.getEmployees();
  const emp = employees.find(e => e.id === empId);
  if (!emp) return;

  document.getElementById('emp-ledger-title').textContent = `كشف حساب الموظف: ${emp.name}`;
  document.getElementById('emp-ledger-subtitle').textContent = `الوظيفة: ${emp.role} | الراتب الأساسي: ${emp.base_salary} ج.م | صافي المستحق: ${emp.net_payable} ج.م`;

  const tbody = document.getElementById('emp-ledger-table-body');
  const transactions = await storage.getEmployeeTransactions(empId);

  tbody.innerHTML = '';
  if (transactions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center py-6 text-gray-400">لا توجد حركات مالية مسجلة لهذا الموظف حتى الآن.</td></tr>';
  } else {
    const typeBadges = {
      advance: { label: 'سلفة نقدية', class: 'bg-red-50 text-red-700' },
      bonus: { label: 'مكافأة / عمولة', class: 'bg-green-50 text-green-700' },
      deduction: { label: 'خصم / جزاء', class: 'bg-amber-50 text-amber-800' },
      settlement: { label: 'صرف راتب وتصفية', class: 'bg-purple-50 text-purple-700' }
    };

    transactions.forEach(t => {
      const badge = typeBadges[t.type] || { label: t.type, class: 'bg-gray-100 text-gray-700' };
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="py-2.5 px-3 font-mono text-gray-500">${escapeHtml(t.created_at)}</td>
        <td class="py-2.5 px-3">
          <span class="px-2 py-0.5 rounded text-[10px] font-bold ${badge.class}">${badge.label}</span>
        </td>
        <td class="py-2.5 px-3 font-black text-gray-900">${t.amount.toFixed(2)} ج.م</td>
        <td class="py-2.5 px-3 text-gray-700">${escapeHtml(t.notes || '--')}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  openModal('modal-emp-ledger');
}

// ----------------------------------------------------
// Network Sharing & Database Location Controller
// ----------------------------------------------------
let networkInfo = {
  local_ip: 'localhost',
  port: 3000,
  local_url: 'http://localhost:3000',
  network_url: 'http://localhost:3000',
  database_path: 'database.sqlite',
  business_profile: { business_name: '', owner_name: '', activity: '', address: '', phone: '', logo_url: '', is_configured: false }
};

function applyBusinessProfile(profile = {}) {
  // Intentionally ignored: cached business profile persistence is optional
  try { localStorage.setItem('business_profile', JSON.stringify(profile)); } catch (_) {}
  refreshPosIdentity(profile);
  const name = String(profile.business_name || '').trim();
  const ownerName = String(profile.owner_name || '').trim();
  const activity = String(profile.activity || '').trim();
  const address = String(profile.address || '');
  const phone = String(profile.phone || '');
  const logo = String(profile.logo_url || '');
  const headerLogo = document.getElementById('app-brand-logo');
  if (headerLogo) {
    headerLogo.src = 'assets/system-primary-logo.png';
    headerLogo.alt = 'الشعار الرسمي لبرنامج SYSTEM';
  }
  const headerName = document.getElementById('app-brand-name');
  if (headerName) headerName.textContent = ownerName || name || 'SYSTEM — برنامج مبيعات متكامل';
  const headerTagline = document.getElementById('app-brand-tagline');
  if (headerTagline) headerTagline.textContent = ownerName && name && ownerName !== name ? name : 'SYSTEM Business POS';
  document.querySelectorAll('.business-logo').forEach(image => {
    image.src = logo;
    image.alt = name ? `شعار ${name}` : 'شعار النشاط';
    image.classList.toggle('hidden', !logo);
  });
  const dashboardLogoPlaceholder = document.getElementById('business-dashboard-logo-placeholder');
  if (dashboardLogoPlaceholder) dashboardLogoPlaceholder.classList.toggle('hidden', Boolean(logo));
  if (logo) {
    const safeLogo = logo.replace(/"/g, '%22').replace(/[\r\n]/g, '');
    document.documentElement.style.setProperty('--business-watermark', `url("${safeLogo}")`);
  } else {
    document.documentElement.style.removeProperty('--business-watermark');
  }
  const setText = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
  setText('business-dashboard-owner-name', ownerName || name || 'صاحب النشاط');
  setText('business-dashboard-welcome', name);
  setText('receipt-business-name', name);
  setText('receipt-business-activity', activity);
  setText('receipt-business-address', address);
  setText('receipt-business-address-footer', address);
  const receiptThanks = document.getElementById('receipt-thanks');
  if (receiptThanks && !receiptThanks.dataset.returnNote) receiptThanks.textContent = name ? `شكراً لزيارتكم ${name}!` : 'شكراً لزيارتكم';
  setText('rec-contact-phone', phone);
  document.getElementById('receipt-business-activity')?.classList.toggle('hidden', !activity);
  document.getElementById('receipt-business-address-row')?.classList.toggle('hidden', !address);
  document.getElementById('receipt-business-address-footer-row')?.classList.toggle('hidden', !address);
  const profileFields = {
    'business-profile-name': name,
    'business-profile-owner-name': ownerName,
    'business-profile-activity': activity,
    'business-profile-address': address,
    'business-profile-email': String(profile.email || ''),
    'business-profile-currency': String(profile.currency || 'EGP'),
    'business-profile-currency-symbol': String(profile.currency_symbol || 'ج.م'),
    'business-profile-timezone': String(profile.timezone || 'Africa/Cairo'),
    'business-profile-language': String(profile.language || 'ar'),
    'contact-phone-input': String(profile.phone || '')
  };
  Object.entries(profileFields).forEach(([id, value]) => { const input = document.getElementById(id); if (input) input.value = value; });
  const logoName = document.getElementById('business-profile-logo-name');
  if (logoName && !document.getElementById('business-profile-logo-file')?.files?.length) logoName.textContent = profile.logo_url?.startsWith('data:image/') ? 'تم حفظ لوجو النشاط.' : 'لم يتم اختيار صورة جديدة.';
  const title = document.getElementById('document-business-title');
  if (title) title.textContent = window.t?.('SYSTEM — برنامج مبيعات متكامل') || 'SYSTEM — برنامج مبيعات متكامل';
  document.title = window.t?.('SYSTEM — برنامج مبيعات متكامل') || 'SYSTEM — برنامج مبيعات متكامل';
}

async function saveInitialBusinessProfile(event) {
  event?.preventDefault();
  const status = document.getElementById('initial-business-setup-status');
  const submit = document.getElementById('initial-business-setup-submit');
  const file = document.getElementById('initial-business-logo')?.files?.[0];
  const payload = {
    business_name: document.getElementById('initial-business-name')?.value.trim() || '',
    owner_name: document.getElementById('initial-business-owner-name')?.value.trim() || '',
    owner_username: document.getElementById('initial-owner-username')?.value.trim() || '',
    owner_password: document.getElementById('initial-owner-password')?.value || '',
    activity: document.getElementById('initial-business-activity')?.value.trim() || '',
    phone: document.getElementById('initial-business-phone')?.value.trim() || '',
    address: document.getElementById('initial-business-address')?.value.trim() || ''
  };
  if (!payload.business_name) { if (status) status.textContent = 'اكتب اسم النشاط للمتابعة.'; return; }
  if (!payload.owner_username || payload.owner_username.length < 3) { if (status) status.textContent = 'اكتب اسم مستخدم المالك (3 أحرف على الأقل).'; return; }
  if (payload.owner_password.length < 8) { if (status) status.textContent = 'كلمة مرور المالك يجب أن تكون 8 أحرف على الأقل.'; return; }
  if (DEFAULT_BOOTSTRAP_PASSWORDS.includes(payload.owner_password.toLocaleLowerCase())) { if (status) status.textContent = 'اختر كلمة مرور مالك غير الافتراضية.'; return; }
  if (file && file.size > 4 * 1024 * 1024) { if (status) status.textContent = 'حجم الشعار يجب ألا يتجاوز 4 ميجابايت.'; return; }
  if (submit) submit.disabled = true;
  if (status) status.textContent = 'جارٍ حفظ بيانات النشاط…';
  try {
    if (file) payload.logo_data_url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('تعذرت قراءة صورة الشعار.'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(file);
    });
    const response = await fetch('/api/config/business-profile/initial', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر حفظ بيانات النشاط.');
    networkInfo.business_profile = result.business_profile;
    networkInfo.contact_phone = result.business_profile?.phone || '';
    applyBusinessProfile(result.business_profile || {});
    closeModal('modal-business-setup');
    if (currentUser) {
      await loadAuthorizedWorkspace();
      document.getElementById('app-shell')?.classList.remove('hidden');
      switchTab(activeTab);
    } else {
      openModal('modal-login');
      document.getElementById('pin-username')?.focus();
    }
  } catch (error) {
    if (status) status.textContent = error.message || 'تعذر حفظ بيانات النشاط.';
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function loadNetworkAndConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const data = await res.json();
      networkInfo = data;
      applyBusinessProfile(data.business_profile || {});
    }
  } catch (e) {
    networkInfo.database_path = localStorage.getItem('system_custom_db_path') || 'database.sqlite';
  }
  if (currentUser) {
    // Intentionally ignored: missing network config uses safe defaults
    try {
      const response = await fetch('/api/network-info', { cache: 'no-store' });
      if (response.ok) Object.assign(networkInfo, await response.json());
    } catch (_) {}
  }

  // Update DOM displays
  const activePathEl = document.getElementById('active-db-path-display');
  const customPathInput = document.getElementById('custom-db-path-input');
  const settingsNetUrl = document.getElementById('settings-network-url');
  const modalNetUrl = document.getElementById('modal-network-url-text');
  const networkCaDownload = document.getElementById('network-ca-download');
  const hostInput = document.getElementById('network-host-input');
  const portInput = document.getElementById('network-port-input');
  const publicUrlInput = document.getElementById('network-public-url-input');
  const trustProxyInput = document.getElementById('network-trust-proxy-input');
  const backupSecondaryPathInput = document.getElementById('backup-secondary-path');

  if (activePathEl) activePathEl.textContent = networkInfo.database_path || 'database.sqlite';
  if (customPathInput && !customPathInput.value) customPathInput.value = networkInfo.database_path || '';
  const networkUrlText = networkInfo.network_url || 'الجهاز غير متصل بشبكة محلية';
  if (settingsNetUrl) settingsNetUrl.textContent = networkUrlText;
  if (modalNetUrl) modalNetUrl.textContent = networkUrlText;
  if (networkCaDownload) {
    if (networkInfo.ca_download_url) { networkCaDownload.href = networkInfo.ca_download_url; networkCaDownload.classList.remove('hidden'); }
    else networkCaDownload.classList.add('hidden');
  }
  if (hostInput) hostInput.value = networkInfo.host || '0.0.0.0';
  if (portInput) portInput.value = networkInfo.port || 3000;
  if (publicUrlInput) publicUrlInput.value = networkInfo.public_url || '';
  if (trustProxyInput) trustProxyInput.value = Array.isArray(networkInfo.trust_proxy) ? networkInfo.trust_proxy.join(', ') : String(networkInfo.trust_proxy || '0');
  if (backupSecondaryPathInput && hasPermission('system_settings')) backupSecondaryPathInput.value = networkInfo.backup_secondary_path || '';
  const contactInput = document.getElementById('contact-phone-input');
  if (contactInput && !contactInput.value) contactInput.value = networkInfo.contact_phone || '';
  const loginPhone = document.getElementById('login-contact-number');
  const receiptPhone = document.getElementById('rec-contact-phone');
  if (loginPhone) loginPhone.textContent = networkInfo.contact_phone || '';
  if (receiptPhone) receiptPhone.textContent = networkInfo.contact_phone || '';
}

function showBusinessProfileLogoName(event) {
  const file = event?.target?.files?.[0];
  const label = document.getElementById('business-profile-logo-name');
  if (label) label.textContent = file ? `الصورة المحددة: ${file.name}` : 'لم يتم اختيار صورة جديدة.';
}

async function saveBusinessProfile(options = {}) {
  if (!hasPermission('system_settings')) { showAppToast('لا تملك صلاحية تعديل بيانات النشاط.'); return; }
  const status = document.getElementById('business-profile-status');
  const fileInput = document.getElementById('business-profile-logo-file');
  const file = options.removeLogo ? null : fileInput?.files?.[0];
  if (file && file.size > 4 * 1024 * 1024) {
    if (status) status.textContent = 'حجم اللوجو يجب ألا يتجاوز 4 ميجابايت.';
    return;
  }
  const payload = {
    business_name: document.getElementById('business-profile-name')?.value.trim(),
    owner_name: document.getElementById('business-profile-owner-name')?.value.trim(),
    activity: document.getElementById('business-profile-activity')?.value.trim(),
    address: document.getElementById('business-profile-address')?.value.trim(),
    phone: document.getElementById('contact-phone-input')?.value.trim(),
    email: document.getElementById('business-profile-email')?.value.trim(),
    currency: document.getElementById('business-profile-currency')?.value.trim().toUpperCase(),
    currency_symbol: document.getElementById('business-profile-currency-symbol')?.value.trim(),
    timezone: document.getElementById('business-profile-timezone')?.value.trim(),
    language: document.getElementById('business-profile-language')?.value || 'ar',
    remove_logo: Boolean(options.removeLogo)
  };
  try {
    if (file) payload.logo_data_url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('تعذرت قراءة صورة اللوجو.'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(file);
    });
    const response = await fetch('/api/business-profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر حفظ بيانات النشاط.');
    networkInfo.business_profile = result.business_profile;
    networkInfo.contact_phone = result.contact_phone || '';
    applyBusinessProfile(result.business_profile || {});
    if (fileInput) fileInput.value = '';
    if (status) status.textContent = result.message || 'تم حفظ بيانات النشاط.';
  } catch (error) {
    if (status) status.textContent = error.message;
  }
}

function removeBusinessProfileLogo() {
  const fileInput = document.getElementById('business-profile-logo-file');
  if (fileInput) fileInput.value = '';
  saveBusinessProfile({ removeLogo: true });
}

async function saveContactPhone() {
  if (!hasPermission('system_settings')) { showAppToast('لا تملك صلاحية إعدادات النظام.'); return; }
  const phone = document.getElementById('contact-phone-input')?.value.trim();
  if (!phone) { showAppToast('اكتب رقم التواصل أولاً.'); return; }
  try {
    const res = await fetch('/api/config/contact-phone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'تعذر حفظ رقم التواصل');
    networkInfo.contact_phone = result.contact_phone;
    document.getElementById('rec-contact-phone').textContent = result.contact_phone;
    showAppToast(result.message);
  } catch (error) { showAppToast(error.message); }
}

async function saveNetworkConfig() {
  if (!hasPermission('system_settings')) {
    showAppToast('لا تملك صلاحية إعدادات النظام.');
    return;
  }
  const host = document.getElementById('network-host-input')?.value.trim();
  const port = Number(document.getElementById('network-port-input')?.value);
  const public_url = document.getElementById('network-public-url-input')?.value.trim() || '';
  const proxyText = document.getElementById('network-trust-proxy-input')?.value.trim() || '0';
  const trust_proxy = /^\d+$/.test(proxyText) ? Number(proxyText) : proxyText.split(',').map(value => value.trim()).filter(Boolean);
  try {
    const res = await fetch('/api/config/network', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port, public_url, trust_proxy })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'فشل حفظ إعدادات الشبكة');
    showAppToast(`${json.message}\nالعنوان: ${host}\nالمنفذ: ${port}${public_url ? `\nالرابط العام: ${public_url}` : ''}`);
  } catch (err) {
    showAppToast(err.message);
  }
}

function openNetworkModal() {
  loadNetworkAndConfig();
  openModal('modal-network-share');
}

async function copyNetworkUrl() {
  const url = networkInfo.network_url || window.location.origin;
  const display = document.getElementById('modal-network-url-text');
  try {
    await navigator.clipboard.writeText(url);
    if (display) display.textContent = `تم نسخ الرابط: ${url}`;
  } catch (_) {
    let copied = false;
    const field = document.createElement('textarea');
    field.value = url;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed'; field.style.opacity = '0'; field.style.fontSize = '16px';
    document.body.appendChild(field);
    field.focus(); field.select();
    // Intentionally ignored: clipboard failure uses the manual copy fallback
    try { copied = document.execCommand('copy'); } catch (_) {}
    field.remove();
    if (display) {
      display.textContent = copied ? `تم نسخ الرابط: ${url}` : `انسخ الرابط يدوياً بالضغط المطوّل: ${url}`;
      display.tabIndex = 0; display.focus();
      const range = document.createRange(); range.selectNodeContents(display);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }
  }
}

async function saveCustomDatabasePath() {
  const input = document.getElementById('custom-db-path-input');
  const newPath = input?.value.trim();

  if (!newPath) {
    showAppToast('يرجى كتابة مسار صالح لحفظ قاعدة البيانات.');
    return;
  }

  try {
    let confirmedPath = newPath;
    let continuedRisk = false;
    if (window.rawdaDesktop?.confirmDatabasePath) {
      const choice = await window.rawdaDesktop.confirmDatabasePath(newPath);
      if (!choice?.path) return;
      confirmedPath = choice.path;
      continuedRisk = choice.continued === true;
      if (input) input.value = confirmedPath;
    }
    const res = await fetch('/api/config/db-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: confirmedPath, allow_risky_path: continuedRisk })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'فشل تغيير المسار');

    networkInfo.database_path = json.new_path || newPath;
    localStorage.setItem('system_custom_db_path', networkInfo.database_path);

    const activePathEl = document.getElementById('active-db-path-display');
    if (activePathEl) activePathEl.textContent = networkInfo.database_path;

    showAppToast(`✅ ${json.message || 'تم تحديث مسار حفظ قاعدة البيانات بنجاح!'}\nالمسار الجديد:\n${networkInfo.database_path}`);
  } catch (err) {
    showAppToast(`تعذر حفظ قاعدة البيانات في المسار المحدد:\n${err.message}`);
  }
}

async function chooseDatabaseFolder() {
  if (!window.rawdaDesktop?.chooseDatabaseFolder) {
    showAppToast('اختيار المجلد متاح من نسخة سطح المكتب فقط. يمكنك كتابة المسار يدويًا.');
    return;
  }
  const folder = await window.rawdaDesktop.chooseDatabaseFolder();
  if (folder) {
    const input = document.getElementById('custom-db-path-input');
    if (input) input.value = `${folder}\\database.sqlite`;
  }
}

async function openDatabaseFolder() {
  const pathValue = document.getElementById('active-db-path-display')?.textContent?.trim() || document.getElementById('custom-db-path-input')?.value?.trim();
  if (window.rawdaDesktop?.openDatabaseFolder && pathValue) await window.rawdaDesktop.openDatabaseFolder(pathValue);
  else showAppToast('افتح المسار الظاهر يدويًا من مستكشف الملفات.');
}

// The interface contains legacy inline button handlers. Explicitly expose the
// handlers so they continue to work in Chromium/Electron regardless of script
// isolation and so edit/payment/return buttons cannot silently do nothing.
Object.assign(window, {
  openModal, closeModal, switchTab, openBranchWarehousePage, renderBranchWarehousePage, filterPosCategory, setPosStockTab, clearCart, setPaymentMethod, posOpenPaymentModal, printReceipt, renderReceiptModal, finishSale,
  posSetPriceMode, posOpenCustomerModal, posOpenDeliveryModal, posToggleCredit, posOpenNotesModal, posCalcTotal, posAddToCart, processBarcodeInput,
  openSelfOrderQueue, acceptSelfOrder, rejectSelfOrder,
  showInPageInputDialog, startPurchaseBarcodeCamera, stopPurchaseBarcodeCamera,
  readPurchaseInvoiceFile, addReviewedOcrPurchaseRows, startPosBarcodeCamera, startProductBarcodeCamera,
  suspendCurrentSale, renderSuspendedSales, resumeSuspendedSale, discardSuspendedSale,
  renderPosProducts, renderProducts, updateCartItemQtyFromInput, updatePosCreditTerms, openPosNavigationDrawer, togglePosSubnav,
  importBusinessCatalogFile, updateBusinessCatalogField, removeBusinessCatalogRow, addBusinessCatalogRow, closeBusinessCatalogReview, commitBusinessCatalogImport, setBusinessCatalogRowSelected, setBusinessCatalogPage, selectAllBusinessCatalogRows, deleteSelectedBusinessCatalogRows, deleteEntireBusinessCatalog, saveBusinessCatalogEdits, loadBusinessCatalog, openBusinessCatalog,
   setQuickCash, completeSale, refreshDashboard, refreshPhase1Notifications, togglePhase1Notifications, markPhase1NotificationsRead, applySalesHistoryFilters, clearSalesHistoryFilters, toggleSidebarCollapse, openProductModal, saveCategory,
  editCategory, deleteCategory, filterInventory, openStockAdjustModal, addPurchaseRow,
  searchPurchaseProducts, selectPurchaseSearchProduct, handlePurchaseSearchKeydown,
  removePurchaseRow, renderPurchaseRows, editPurchasePayment, cancelPurchaseInvoice,
  reprintInvoice, shareReceiptOnWhatsApp, returnSaleFromArchive, editSaleFromArchive, showCustomerLedger,
  recordCustomerPayment, editCustomerRecord, deleteCustomerRecord, showSupplierLedger,
  searchPosCustomerByPhone, openCustomerFromPhoneSearch,
  recordSupplierPayment, editSupplierRecord, deleteSupplierRecord, editProduct,
  deleteProduct, quickStockAdjust, updateCartItemQty, removeFromCart, handleLogout, toggleProfileMenu, logoutAllDevices, loadMaintenanceStatus, loadMaintenanceSettings, saveMaintenanceSettings, updatePasswordStrength,
  quickLogin, handleLoginSubmit, generateAutoBarcode, printBarcodeSheet,
  exportReportToExcel, exportBusinessReportToExcel, buildReportWorkbook, refreshAuditLogs, saveCustomDatabasePath, openNetworkModal,
  exportReportToCSV,
  copyNetworkUrl, downloadBackup, restoreBackupFromFile, saveNetworkConfig, loadBackupSettings, saveBackupSettings, loadBackups, createBackupNow, downloadManagedBackup, deleteManagedBackup, restoreManagedBackup,
  selectTheme, openEmpTransModal, viewEmployeeLedger, editUser, toggleUserStatus, deleteUser,
  loadHardwareSettings, saveHardwareSettings, testReceiptPrinter, printReceiptFromSettings, chooseHardwareSerial, testCashDrawer, readHardwareScale, testCustomerDisplay,
 loadScheduledBackupSettings, saveScheduledBackupSettings, loadScheduledBackups, restoreScheduledBackup,
 loadGoogleDriveBackupStatus, saveGoogleDriveClientId, connectGoogleDriveBackup, createGoogleDriveBackupNow, drainGoogleDriveBackups, disconnectGoogleDriveBackup, saveGoogleDriveBackupPassword, loadGoogleDriveBackups, previewGoogleDriveRestore, openFirstRunRestore,
  toggleNavigationLayout, loadNavigationLayout,
  openNetworkModal, editEmployee, deleteEmployee, markEmployeeAttendance, editAttendanceRecord, renderSalesHistory,
  chooseDatabaseFolder, openDatabaseFolder, saveContactPhone, openActivation, activateOfflineLicense, activateTextLicense, activateCentralLicense, copyLicenseDeviceId,
  showBusinessProfileLogoName, saveBusinessProfile, removeBusinessProfileLogo,
  saveSettingsMaster, loadPrintSettings, savePrintSettings, downloadSettingsBackup, restoreSettingsBackup, loadSettingsMasterLicense, activateSettingsLicense, switchSettingsMasterTab,
  openDashboardReport, openReportCard, openDashboardMetricDetail, renderShiftReport, addExpense, openNewUserModal, createBranch, editBranch, toggleBranch, openBranchUsers, saveBranchUsers, deleteBranch, saveBranch, goBackInApp, openKeyboardShortcuts,
  saveUiVisibility, toggleUiVisibilityGroup, saveTaxSettings, renderTaxReport, loadTallySettings, saveTallySettings, testTallyConnection, syncSalesToTally, renderServiceOrders, createServiceOrder,
  renderPurchaseOrders, addPurchaseOrderItem, removePurchaseOrderItem, createPurchaseOrder, setPurchaseOrderStatus, receivePurchaseOrder,
  updateServiceOrderStatus, collectServiceOrderPayment, renderInstallments,
  createInstallmentContract, payInstallment, renderPromotions, createPromotion, deactivatePromotion,
  renderOfferMessages, filterOfferCustomers, updateOfferMessageCount, saveOfferMessage, deleteOfferMessage,
  previewOfferMessage, startOfferMessageQueue, openCurrentOfferWhatsApp, advanceOfferMessageQueue, stopOfferMessageQueue
});

loadSidebarCollapse();

// Ribbon commands map the Office-style groups to existing screens and actions.
const ribbonGroups = {
 overview:[['لوحة التحكم','layout-dashboard','dashboard'],['طلبات التوصيل','bike','delivery'],['بحث عن أوردر','search','delivery-search'],['إدارة الطيارين','contact-round','delivery-riders'],['إقفال عهدة الطيارين','hand-coins','rider-settlement']],
 settings:[['لوحة التحكم','layout-dashboard','dashboard'],['إضافة مخزن','warehouse','inventory'],['إضافة موظف','user-round-plus','employee-add'],['طباعة باركود','barcode','barcodes'],['إعدادات واتساب والرسائل','message-circle','settings'],['تفعيل البرنامج','key','activate']],
 customers:[['قائمة العملاء','users','customers'],['إضافة عميل','user-plus','customer-add']],
 suppliers:[['قائمة الموردين','truck','suppliers'],['إضافة مورد','user-plus','supplier-add']],
 purchases:[['شاشة المشتريات','shopping-basket','purchases'],['المخزون المتاح','boxes','inventory'],['المنتجات','package','products'],['الفئات','tags','categories']],
 sales:[['شاشة المبيعات','shopping-cart','pos'],['سجل المبيعات','receipt','sales-history'],['العروض الترويجية','badge-percent','promotions'],['رسائل العروض','message-circle','offer-messages']],
 reports:[['المركز المالي','landmark','reports'],['الأرباح والخسائر','chart-no-axes-combined','report-profit'],['تقارير الورديات','clipboard-list','report-shifts'],['المصروفات','wallet','report-expenses'],['إحصائيات بالرسم البياني','chart-pie','reports']],
 employees:[['شئون الموظفين','users-round','employees'],['المستخدمون والصلاحيات','shield-check','users']],
 cash:[['الخزائن والتقارير المالية','wallet-cards','reports'],['المبيعات والتحصيل','banknote','sales-history']],
 installments:[['إدارة عقود التقسيط','calendar-clock','installments'],['العملاء والحسابات','contact-round','customers'],['المعاملات المالية','hand-coins','reports']],
 database:[['لوحة التحكم','layout-dashboard','dashboard'],['إضافة مخزن','warehouse','inventory','add'],['إضافة موظف','user-round-plus','employee-add','add'],['طباعة باركود','barcode','barcodes','print_pdf'],['إعدادات واتساب والرسائل','message-circle','settings','system_settings'],['تفعيل البرنامج','key','activate'],['إعدادات البرنامج','settings-2','settings'],['النسخ الاحتياطي','database','backup-settings','import_export'],['أجهزة الشبكة','wifi','settings','system_settings'],['الميزان والطابعة','printer','settings','system_settings'],['سجل النشاط','file-clock','audit-logs','view']],
 catalog:[['كتالوج المنتجات','package-open','business-catalog']]
};
function openProgramBackupRibbon() {
  switchTab('settings');
  if (activeTab !== 'settings') return;
  selectRibbonGroup('database');
  setActiveRibbonToolForScreen('database', 'settings');
  requestAnimationFrame(() => document.getElementById('settings-backup-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}
function setActiveRibbonToolForScreen(group, tabId) {
  const buttons = [...document.querySelectorAll('#ribbon-tools .ribbon-tool')];
  const preferred = group === 'database' && tabId === 'settings'
    ? buttons.find(button => button.textContent.trim() === 'النسخ الاحتياطي')
    : buttons.find(button => button.dataset.ribbonTarget === tabId);
  buttons.forEach(button => button.classList.toggle('active', button === preferred));
}
function selectRibbonGroup(group) {
 document.querySelectorAll('.ribbon-tab').forEach(b=>b.classList.toggle('active',b.dataset.group===group));
 const host=document.getElementById('ribbon-tools'); if(!host)return;
  host.innerHTML=(ribbonGroups[group]||[]).filter(([,,target,required])=>!isUiHidden('tab',ribbonTargetTab(target)) && (group!=='database' || ((!required || hasPermission(required)) && (!ribbonTargetTab(target) || isTabAllowedForCurrentUser(ribbonTargetTab(target)))))).map(([label,icon,target])=>`<button class="ribbon-tool" data-ribbon-target="${ribbonTargetTab(target)||target}" onclick="${target==='activate'?'openActivation()':target==='backup-settings'?'openProgramBackupRibbon()':target==='delivery-search'?'openDeliverySearch()':target==='rider-settlement'?'openDeliverySettlement()':target==='customer-add'?"openModal('modal-add-customer')":target==='employee-add'?"openModal('modal-add-employee')":target==='supplier-add'?"openModal('modal-add-supplier')":target==='business-catalog'?'openBusinessCatalog()':target.startsWith('report-')?`openDashboardReport('${target.slice(7)}')`:`switchTab('${target}')`}"><i data-lucide="${icon}"></i><span>${label}</span></button>`).join('');
 setActiveRibbonToolForScreen(group, activeTab);
 if(window.lucide) lucide.createIcons();
 applyActionButtonPermissions(host);
 applyAllLayoutOrders();
}
function openPosNavigationDrawer() {
  const drawer = document.getElementById('pos-navigation-drawer');
  const tools = document.getElementById('ribbon-tools');
  if (!drawer || !tools) return;
  if (!drawer.classList.contains('hidden')) { drawer.classList.add('hidden'); return; }
  selectRibbonGroup('sales');
  drawer.innerHTML = `<div class="pos-drawer-card"><div class="pos-drawer-heading"><strong>قائمة التنقل</strong><button type="button" onclick="document.getElementById('pos-navigation-drawer').classList.add('hidden')">إغلاق</button></div><div class="pos-drawer-links">${tools.innerHTML}</div></div>`;
  drawer.classList.remove('hidden');
  drawer.querySelectorAll('.ribbon-tool').forEach(button => button.addEventListener('click', () => drawer.classList.add('hidden')));
  if (window.lucide) lucide.createIcons();
}
function togglePosSubnav() {
  const visible = document.body.classList.toggle('pos-subnav-visible');
  const toggle = document.getElementById('pos-subnav-toggle');
  if (toggle) { toggle.setAttribute('aria-pressed', String(visible)); toggle.textContent = visible ? 'إخفاء الشريط الفرعي' : 'إظهار الشريط الفرعي'; }
}

function openDeliverySearch() {
  switchTab('delivery');
  requestAnimationFrame(() => { const input = document.getElementById('delivery-search-input'); input?.focus(); input?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
}
function openDeliverySettlement() {
  switchTab('delivery');
  requestAnimationFrame(() => document.getElementById('delivery-settlements-list')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}
function openBusinessCatalog() {
  openUnifiedCatalogPage();
}
function openBusinessProfileSettings() {
  switchTab('settings');
  requestAnimationFrame(() => document.getElementById('business-profile-name')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}
function openUiVisibilitySettings() {
  switchTab('settings');
  requestAnimationFrame(() => document.getElementById('ui-visibility-list')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}
function openWholesaleSale() { switchTab('pos'); }
function updateAppClocks(){
 const now=new Date(), english=document.documentElement.lang==='en';
 const date=new Intl.DateTimeFormat(english?'en-US':'ar-EG-u-nu-latn',{weekday:'long',year:'numeric',month:'long',day:'numeric'}).format(now);
 const time=new Intl.DateTimeFormat(english?'en-US':'ar-EG-u-nu-latn',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:english}).format(now);
 for(const id of ['pin-date','status-date']){const el=document.getElementById(id);if(el)el.textContent=date;}
 for(const id of ['pin-clock','status-clock']){const el=document.getElementById(id);if(el)el.textContent=time;}
}
function appendPin(digit){const el=document.getElementById('pin-entry');if(el&&el.value.length<12)el.value+=digit;}
function clearPin(){const el=document.getElementById('pin-entry');if(el)el.value='';}
function submitPin(){
 const username=document.getElementById('pin-username')?.value.trim()||'', pin=document.getElementById('pin-entry')?.value||'';
 if(!username){showAppToast('اكتب اسم المستخدم أولاً.');document.getElementById('pin-username')?.focus();return;}
  const pass=pin;
 document.getElementById('login-username').value=username;document.getElementById('login-password').value=pass;
 handleLoginSubmit(new Event('submit',{cancelable:true}));
}
function scanCard(){const el=document.getElementById('pin-entry');if(!el)return;el.value='';el.placeholder='مرر البطاقة الآن';el.focus();}
function openActivation(){
  openModal('modal-activation');
  updateActivationSupportLink();
  if (window.rawdaDesktop?.getDeviceId) window.rawdaDesktop.getDeviceId().then(id=>{const input=document.getElementById('license-device-id');if(input)input.value=id;updateActivationSupportLink();});
}
function activationSupportInternationalPhone(phone = ACTIVATION_SUPPORT_PHONE) {
  const digits = String(phone).replace(/\D/g, '');
  return digits.startsWith('0') ? `20${digits.slice(1)}` : digits;
}
function updateActivationSupportLink() {
  const link = document.getElementById('activation-whatsapp-link');
  const phone = document.getElementById('activation-support-phone');
  if (phone) phone.textContent = ACTIVATION_SUPPORT_PHONE;
  if (!link) return;
  const deviceId = document.getElementById('license-device-id')?.value.trim() || '';
  const message = `السلام عليكم، أريد تفعيل تطبيق SYSTEM.${deviceId ? `\nمعرّف الجهاز: ${deviceId}` : ''}`;
  link.href = `https://wa.me/${activationSupportInternationalPhone()}?text=${encodeURIComponent(message)}`;
  const label = link.querySelector('span');
  if (label) label.textContent = 'اتصل بنا لتفعيل التطبيق';
}
async function copyActivationSupportPhone() {
  try { await navigator.clipboard.writeText(ACTIVATION_SUPPORT_PHONE); }
  catch (_) { const status=document.getElementById('license-status-message'); if(status)status.textContent=`رقم التواصل: ${ACTIVATION_SUPPORT_PHONE}`; }
}

// POS peripherals are configured per Windows computer. Web Serial intentionally
// asks the operator to grant access to each device rather than guessing ports.
const hardwarePortCache = {};
const hardwarePortKinds = ['printer', 'drawer', 'scale', 'display'];
function getHardwareSettings() {
  try { return JSON.parse(localStorage.getItem('system_pos_hardware') || '{}') || {}; }
  catch (_) { return {}; }
}
function loadHardwareSettings() {
  const config = getHardwareSettings();
  const setValue = (id, value) => { const el = document.getElementById(id); if (el && value !== undefined) el.value = value; };
  const setChecked = (id, value) => { const el = document.getElementById(id); if (el && value !== undefined) el.checked = Boolean(value); };
  setValue('hw-printer-model', config.printerModel);
  setValue('hw-printer-baud', config.printerBaud);
  setValue('hw-drawer-mode', config.drawerMode);
  setValue('hw-drawer-pin', config.drawerPin);
  setValue('hw-scale-protocol', config.scaleProtocol);
  setValue('hw-scale-baud', config.scaleBaud);
  setValue('hw-customer-display-model', config.displayModel);
  setValue('hw-display-baud', config.displayBaud);
  setValue('hw-payment-device', config.paymentDevice);
  setValue('hw-payment-qr-text', config.paymentQrText);
  setChecked('hw-scale-enabled', config.scaleEnabled);
  setChecked('hw-customer-display-enabled', config.displayEnabled);
  setChecked('hw-show-payment-qr', config.showPaymentQr);
  document.querySelectorAll('input[name="hw-paper-width"]').forEach(el => { el.checked = el.value === String(config.paperWidth || '80'); });
  document.querySelectorAll('input[name="hw-print-mode"]').forEach(el => { el.checked = el.value === String(config.printMode || 'image'); });
  for (const kind of hardwarePortKinds) {
    const saved = config.ports?.[kind];
    const status = document.getElementById(`hw-${kind === 'display' ? 'display' : kind}-port-status`);
    if (status && saved) status.textContent = `تم حفظ تعريف المنفذ ${saved.usbVendorId ? `(USB ${saved.usbVendorId.toString(16)}:${Number(saved.usbProductId || 0).toString(16)})` : ''}. قد يحتاج النظام اختيار المنفذ مجددًا بعد تغيير الجهاز.`;
  }
  applyReceiptHardwareSettings(config);
}
function collectHardwareSettings() {
  const get = id => document.getElementById(id)?.value || '';
  const checked = id => Boolean(document.getElementById(id)?.checked);
  const radio = name => document.querySelector(`input[name="${name}"]:checked`)?.value;
  const old = getHardwareSettings();
  return {
    printerModel: get('hw-printer-model') || 'system', printerBaud: Number(get('hw-printer-baud')) || 9600,
    paperWidth: radio('hw-paper-width') || '80', printMode: radio('hw-print-mode') || 'image',
    drawerMode: get('hw-drawer-mode') || 'none', drawerPin: get('hw-drawer-pin') || '0',
    scaleEnabled: checked('hw-scale-enabled'), scaleProtocol: get('hw-scale-protocol') || 'auto', scaleBaud: Number(get('hw-scale-baud')) || 9600,
    displayEnabled: checked('hw-customer-display-enabled'), displayModel: get('hw-customer-display-model') || 'epson', displayBaud: Number(get('hw-display-baud')) || 9600,
    paymentDevice: get('hw-payment-device') || 'none', showPaymentQr: checked('hw-show-payment-qr'), paymentQrText: get('hw-payment-qr-text').trim(),
    ports: old.ports || {}, qrImageData: old.qrImageData || ''
  };
}
function applyReceiptHardwareSettings(config = getHardwareSettings()) {
  const width = Number(config.paperWidth) === 58 ? 58 : 80;
  document.documentElement.dataset.receiptWidth = String(width);
  let style = document.getElementById('receipt-paper-style');
  if (!style) { style = document.createElement('style'); style.id = 'receipt-paper-style'; document.head.appendChild(style); }
  style.textContent = `@media print { @page { size: ${width}mm auto; } #printable-receipt { width: ${width}mm !important; max-width: ${width}mm !important; } }`;
}
function saveHardwareSettings() {
  try {
    const config = collectHardwareSettings();
    localStorage.setItem('system_pos_hardware', JSON.stringify(config));
    applyReceiptHardwareSettings(config);
    const status = document.getElementById('hw-settings-status');
    if (status) status.textContent = 'تم حفظ إعدادات الأجهزة على هذا الكمبيوتر.';
    return true;
  } catch (error) {
    const status = document.getElementById('hw-settings-status');
    if (status) status.textContent = `تعذر حفظ الإعدادات: ${error.message}`;
    return false;
  }
}
function hardwarePortStatus(kind, message) {
  const id = kind === 'display' ? 'hw-display-port-status' : `hw-${kind}-port-status`;
  const el = document.getElementById(id); if (el) el.textContent = message;
}
async function chooseHardwareSerial(kind) {
  if (!navigator.serial) {
    hardwarePortStatus(kind, 'اختيار المنافذ التسلسلية غير متاح في هذا المتصفح. افتح التطبيق في نسخة سطح المكتب الحديثة أو استخدم طابعة Windows المثبتة.');
    return false;
  }
  try {
    const port = await navigator.serial.requestPort();
    hardwarePortCache[kind] = port;
    const info = port.getInfo?.() || {};
    const config = getHardwareSettings();
    config.ports ||= {};
    config.ports[kind] = { usbVendorId: info.usbVendorId || null, usbProductId: info.usbProductId || null };
    localStorage.setItem('system_pos_hardware', JSON.stringify(config));
    hardwarePortStatus(kind, 'تم اختيار المنفذ. احفظ الإعدادات بعد ضبط بقية الخيارات.');
    return true;
  } catch (error) {
    hardwarePortStatus(kind, error.name === 'NotFoundError' ? 'لم يتم اختيار منفذ. أعد المحاولة بعد توصيل الجهاز، أو استخدم الطباعة عبر تعريف Windows.' : `تعذر اختيار المنفذ: ${error.message}`);
    return false;
  }
}
async function getHardwareSerial(kind, baudRate) {
  if (!navigator.serial) throw new Error('واجهة Web Serial غير متاحة في هذا المتصفح.');
  if (hardwarePortCache[kind]) return hardwarePortCache[kind];
  const saved = getHardwareSettings().ports?.[kind];
  const ports = await navigator.serial.getPorts();
  const known = ports.find(port => {
    const info = port.getInfo?.() || {};
    return saved && Number(info.usbVendorId || 0) === Number(saved.usbVendorId || 0) && Number(info.usbProductId || 0) === Number(saved.usbProductId || 0);
  });
  if (known) return hardwarePortCache[kind] = known;
  throw new Error('اختر المنفذ من زر «اختيار منفذ» أولاً.');
}
async function writeHardwareSerial(kind, baudRate, bytes) {
  const port = await getHardwareSerial(kind, baudRate);
  if (!port.writable) await port.open({ baudRate });
  const writer = port.writable.getWriter();
  try { await writer.write(new Uint8Array(bytes)); }
  finally { writer.releaseLock(); await port.close().catch(() => {}); }
}
async function testCashDrawer() {
  const config = collectHardwareSettings();
  if (config.drawerMode === 'none') return showAppToast('اختَر طريقة توصيل الدرج أولاً.');
  try {
    await writeHardwareSerial('drawer', 9600, [0x1b, 0x70, Number(config.drawerPin) || 0, 0x19, 0xfa]);
    hardwarePortStatus('drawer', 'أُرسل أمر فتح الدرج بنجاح. إذا لم يفتح، راجع نوع الكابل والمنفذ وموديل الطابعة.');
  } catch (error) { hardwarePortStatus('drawer', error.message); showAppToast(`تعذر إرسال أمر فتح الدرج: ${error.message}`); }
}
async function triggerConfiguredCashDrawer() {
  try {
    if (window.rawdaHardware?.openDrawer) {
      await window.rawdaHardware.openDrawer({ source: 'sale-cash' });
      console.log('[HARDWARE] cash drawer opened via Electron IPC');
      return;
    }
    const response = await fetch('/api/hardware/drawer/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (response.ok) {
      console.log('[HARDWARE] cash drawer opened via Mock API');
      return;
    }
  } catch (error) { console.warn('[HARDWARE] cash drawer mock/native bridge failed:', error.message); }
  const config = getHardwareSettings();
  if (!config.drawerMode || config.drawerMode === 'none') return;
  // Intentionally ignored: drawer failure is reported by the existing warning
  try { await writeHardwareSerial('drawer', 9600, [0x1b, 0x70, Number(config.drawerPin) || 0, 0x19, 0xfa]); }
  catch (error) { console.warn('Cash drawer pulse failed:', error.message); }
}
async function readHardwareScale() {
  const config = collectHardwareSettings();
  const output = document.getElementById('hw-scale-reading');
  if (!config.scaleEnabled) { if (output) output.textContent = 'فعّل خيار وجود الميزان أولاً.'; return; }
  try {
    const port = await getHardwareSerial('scale', config.scaleBaud);
    if (!port.readable) await port.open({ baudRate: config.scaleBaud });
    const reader = port.readable.getReader();
    const decoder = new TextDecoder(); let text = '';
    try {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !/[\r\n]/.test(text)) {
        const next = await Promise.race([reader.read(), new Promise(resolve => setTimeout(() => resolve({ timeout: true }), Math.max(1, deadline - Date.now())))]);
        if (next.timeout || next.done) break;
        text += decoder.decode(next.value, { stream: true });
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await port.close().catch(() => {}); }
    const normalized = text.trim();
    if (output) output.textContent = normalized ? `قراءة الميزان: ${normalized}` : 'لم تصل قراءة خلال 4 ثوانٍ. راجع البروتوكول والسرعة والتوصيل.';
  } catch (error) { if (output) output.textContent = `تعذر قراءة الميزان: ${error.message}`; }
}
async function testCustomerDisplay() {
  const config = collectHardwareSettings();
  if (!config.displayEnabled) return showAppToast('فعّل خيار شاشة العميل أولاً.');
  try {
    await writeHardwareSerial('display', config.displayBaud, [0x0c, ...new TextEncoder().encode('WELCOME  POS')]);
    hardwarePortStatus('display', 'تم إرسال رسالة الاختبار. يدعم موديل الشاشة عرض النص ASCII.');
  } catch (error) { hardwarePortStatus('display', error.message); showAppToast(`تعذر اختبار الشاشة: ${error.message}`); }
}
function savePaymentQrImage(event) {
  const file = event.target.files?.[0]; if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
    event.target.value = ''; return showAppToast('اختر صورة PNG أو JPG أو WebP لا يتجاوز حجمها 2 ميجابايت.');
  }
  const reader = new FileReader();
  reader.onload = () => {
    const config = getHardwareSettings(); config.qrImageData = String(reader.result || '');
    localStorage.setItem('system_pos_hardware', JSON.stringify(config));
    const status = document.getElementById('hw-settings-status');
    if (status) status.textContent = 'تم حفظ صورة QR للدفع على هذا الكمبيوتر.';
  };
  reader.onerror = () => showAppToast('تعذر قراءة صورة QR.');
  reader.readAsDataURL(file);
}
function openCustomerDisplay() {
  if (!saveHardwareSettings()) return;
  const display = window.open('/customer-display.html', 'pos-customer-display', 'width=900,height=650,resizable=yes');
  if (!display) showAppToast('اسمح بفتح نافذة شاشة العميل الثانية ثم أعد المحاولة.');
  else broadcastCustomerDisplay();
}
function broadcastCustomerDisplay() {
  // Intentionally ignored: customer display failure is reported by the existing warning
  try {
    const config = getHardwareSettings();
    const customer = document.getElementById('pos-customer-select');
    const discount = Number(document.getElementById('pos-discount-input')?.value || 0);
    const subtotal = cart.reduce((sum, item) => sum + Number(item.unit_price || 0) * Number(item.quantity || 0) - Number(item.discount || 0) - promotionDiscountForCartItem(item), 0);
    const taxable = Math.max(0, subtotal - discount);
    const tax = taxSettings.enabled ? Number((taxable * Number(taxSettings.rate || 0) / 100).toFixed(2)) : 0;
    const payload = {
      items: cart.map(item => ({ name: item.product_name, quantity: item.quantity, unitPrice: Number(item.unit_price) || 0, total: (Number(item.unit_price) || 0) * (Number(item.quantity) || 0) - (Number(item.discount) || 0) - promotionDiscountForCartItem(item) })),
      subtotal, discount, tax, total: taxable + tax, customer: customer?.selectedIndex >= 0 ? customer.options[customer.selectedIndex]?.textContent : 'عميل نقدي',
      payment: paymentMethod, showQr: Boolean(config.showPaymentQr), qrText: config.paymentQrText || '', qrImageData: config.qrImageData || '', updatedAt: Date.now()
    };
    localStorage.setItem('rawda_customer_display_payload', JSON.stringify(payload));
    if (typeof BroadcastChannel !== 'undefined') { const channel = new BroadcastChannel('rawda-pos-customer-display'); channel.postMessage(payload); channel.close(); }
  } catch (error) { console.warn('Customer display update failed:', error.message); }
}
function buildEscposReceipt(sale) {
  const text = [
    '\u001b@', networkInfo.business_profile?.business_name || 'نقطة البيع',
    `فاتورة: ${sale.invoice_number || 'TEST'}`, sale.created_at || new Date().toLocaleString('ar-EG-u-nu-latn'),
    '--------------------------------',
    ...(sale.items || []).map(item => `${item.product_name || item.name || ''}  x${item.quantity}  ${Number(item.total || (Number(item.unit_price || 0) * Number(item.quantity || 0))).toFixed(2)}`),
    '--------------------------------', ...(Number(sale.tax_amount || 0) > 0 ? [`ضريبة المبيعات (${Number(sale.tax_rate || 0)}%): ${Number(sale.tax_amount).toFixed(2)} ج.م`] : []),
    `الإجمالي: ${Number(sale.total || 0).toFixed(2)} ج.م`,
    `المدفوع: ${Number(sale.paid_amount || sale.total || 0).toFixed(2)} ج.م`,
    `الباقي: ${Number(sale.change_amount || 0).toFixed(2)} ج.م`,
    'برمجة وتصميم خالد ويجا 01039301300', '\n\n\n'
  ].join('\n');
  return [...new Uint8Array([0x1b,0x40]), ...new TextEncoder().encode(text), 0x1d,0x56,0x42,0x00];
}
async function printReceiptFromSettings() {
  const config = getHardwareSettings();
  if (config.printMode === 'escpos') {
    if (!lastRenderedReceipt) return showAppToast('لا توجد فاتورة جاهزة للطباعة.');
    try { await writeHardwareSerial('printer', Number(config.printerBaud) || 9600, buildEscposReceipt(lastRenderedReceipt)); }
    catch (error) { showAppToast(`تعذر الطباعة المباشرة: ${error.message}`); }
    return;
  }
  window.print();
}
function testReceiptPrinter() {
  const config = collectHardwareSettings();
  applyReceiptHardwareSettings(config);
  if (config.printMode === 'escpos') {
    writeHardwareSerial('printer', Number(config.printerBaud) || 9600, buildEscposReceipt({ invoice_number:'TEST', created_at:new Date().toLocaleString('ar-EG-u-nu-latn'), items:[{name:'اختبار الطابعة',quantity:1,total:0}], total:0, paid_amount:0, change_amount:0 }))
      .then(() => showAppToast('تم إرسال صفحة الاختبار إلى الطابعة التسلسلية.'))
      .catch(error => showAppToast(`تعذر اختبار الطباعة المباشرة: ${error.message}`));
    return;
  }
  const test = window.open('', '_blank');
  if (!test) return showAppToast('اسمح بفتح نافذة الطباعة للاختبار ثم أعد المحاولة.');
  const width = Number(config.paperWidth) === 58 ? '58mm' : '80mm';
  test.document.write(`<!doctype html><html dir="rtl"><meta charset="utf-8"><title>اختبار الطابعة</title><style>@page{size:${width} auto;margin:3mm}body{width:${width};margin:0 auto;font-family:Arial,sans-serif;text-align:center;color:#111;font-size:12pt}h2{font-size:15pt}hr{border:0;border-top:1px dashed #333}</style><body><h2>اختبار طابعة الفواتير</h2><p>نشاط تجاري / نقطة بيع</p><hr><p>مقاس الورق: ${width}</p><p>اختبار الحروف العربية والأرقام 12345</p><hr><p>تم إعداد الطابعة بنجاح</p><script>window.onload=()=>{window.print();window.onafterprint=()=>window.close()}</script></body></html>`);
  test.document.close();
}
async function activateOfflineLicense(){
  const result=await window.rawdaDesktop?.activateOffline?.();
  if(!result||result.canceled)return;
  if(!result.active){document.getElementById('license-status-message').textContent=result.reason||'فشل التفعيل.';return;}
  showAppToast('تم تفعيل هذا الجهاز بنجاح.');window.location.reload();
}
async function activateTextLicense(){
  let result;
  try {
    const response=await fetch('/api/license/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({licenseText:document.getElementById('license-text-key')?.value||''})});
    result=await response.json();
    if(!response.ok)throw new Error(result.error||result.reason||'فشل التفعيل.');
  } catch(error) { const message=document.getElementById('license-status-message');if(message)message.textContent=error.message||'فشل التفعيل.';return; }
  if(!result?.active){const message=document.getElementById('license-status-message');if(message)message.textContent=result?.reason||'فشل التفعيل.';return;}
  showAppToast('تم التفعيل على هذا الجهاز.');window.location.reload();
}
async function activateCentralLicense(){
  const result=await window.rawdaDesktop?.activateCentral?.({serverUrl:document.getElementById('license-server-url')?.value,licenseKey:document.getElementById('license-key')?.value});
  if(!result?.active){document.getElementById('license-status-message').textContent=result?.reason||'تعذر تفعيل الجهاز.';return;}
  showAppToast('تم ربط الجهاز بالترخيص المركزي بنجاح.');window.location.reload();
}
function setLoginBackground(style) {
  const allowed = ['sage-metal', 'ivory-gold', 'navy-steel', 'neon-night', 'neon-wide'];
  const selected = allowed.includes(style) ? style : 'sage-metal';
  document.body.dataset.loginBackground = selected;
  document.querySelectorAll('[data-login-background]').forEach(button => {
    const active = button.dataset.loginBackground === selected;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  // Intentionally ignored: login background preference is optional
  try { localStorage.setItem('system_login_background', selected); } catch (_) {}
}
try { setLoginBackground(localStorage.getItem('system_login_background') || 'sage-metal'); } catch (_) { setLoginBackground('sage-metal'); }
async function copyLicenseDeviceId(){const input=document.getElementById('license-device-id');const id=input?.value||'';try{await navigator.clipboard.writeText(id);const status=document.getElementById('license-status-message');if(status)status.textContent='تم نسخ معرّف الجهاز.';}catch(_){input?.focus();input?.select();const status=document.getElementById('license-status-message');if(status)status.textContent='تعذر النسخ التلقائي؛ تم تحديد المعرّف، اضغط Ctrl+C لنسخه.';}}
function forgotPin(){showAppToast('يرجى التواصل مع مدير النظام لإعادة تعيين رمز الدخول.');}
function contactSupport(){const phone=String(networkInfo.contact_phone||'').replace(/\D/g,'');if(!phone)return showAppToast('أدخل رقم التواصل من إعدادات النشاط أولاً.');const wa=phone.startsWith('0')?'2'+phone:phone;window.open('https://wa.me/'+wa,'_blank','noopener');}
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&!document.getElementById('modal-login')?.classList.contains('hidden'))submitPin();});

// Move between editable fields with Enter while preserving each screen's own
// Enter behavior (search, barcode, PIN, and autocomplete handlers).
document.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
  const field = event.target;
  if (!(field instanceof HTMLElement) || field.isContentEditable || field.closest('[contenteditable]:not([contenteditable="false"])')) return;
  if (field.matches('textarea') || field.dataset.enter === 'native') return;
  const loginModal = document.getElementById('modal-login');
  if (loginModal && !loginModal.classList.contains('hidden')) return;
  if (!field.matches('select, input')) return;
  if (field.matches('input') && !['text', 'number', 'search', 'date', 'email', 'tel'].includes((field.type || 'text').toLowerCase())) return;
  if (field.disabled || field.readOnly || field.type === 'hidden' || field.hidden || field.closest('.hidden, [hidden], [inert]')) return;

  const controls = field.getAttribute('aria-controls');
  const controlledPopup = controls ? document.getElementById(controls) : null;
  const combo = field.closest('[role="combobox"]');
  const comboPopupId = combo?.getAttribute('aria-controls');
  const comboPopup = comboPopupId ? document.getElementById(comboPopupId) : null;
  const popupIsVisible = popup => Boolean(popup && !popup.hidden && !popup.closest('.hidden, [hidden], [inert]') && popup.getClientRects().length);
  if (field.getAttribute('aria-expanded') === 'true' || combo?.getAttribute('aria-expanded') === 'true' || field.dataset.autocompleteOpen === 'true' || popupIsVisible(controlledPopup) || popupIsVisible(comboPopup) || (field.list?.options.length > 0)) return;

  const modal = field.closest('.modal-backdrop:not(.hidden), [role="dialog"]:not(.hidden)');
  const screen = field.closest('.tab-content:not(.hidden)');
  const scope = field.form || modal || screen || document;
  const candidates = [...scope.querySelectorAll('input, select')].filter(candidate => {
    if (candidate.matches('input') && !['text', 'number', 'search', 'date', 'email', 'tel'].includes((candidate.type || 'text').toLowerCase())) return false;
    return !candidate.disabled && !candidate.readOnly && candidate.type !== 'hidden' && !candidate.hidden && !candidate.closest('.hidden, [hidden], [inert]') && candidate.getClientRects().length > 0;
  });
  const index = candidates.indexOf(field);
  if (index < 0) return;
  const next = candidates[index + 1];
  if (next) {
    event.preventDefault();
    next.focus();
    return;
  }
  const form = field.form;
  const submitter = form?.querySelector('button[type="submit"]:not(:disabled), input[type="submit"]:not(:disabled)');
  if (form && submitter) {
    event.preventDefault();
    if (typeof form.requestSubmit === 'function') form.requestSubmit(submitter);
    else submitter.click();
  }
});

document.getElementById('remember-login')?.addEventListener('change', event => {
  if (!event.target.checked) window.rawdaDesktop?.clearRememberedLogin?.();
});
void loadMaintenanceStatus();
maintenancePollTimer = window.setInterval(() => { void loadMaintenanceStatus(); }, 30000);
function setTheme(themeClass, btn) {
  if (!SYSTEM_THEME_CLASSES.includes(themeClass)) themeClass = '';
  selectTheme(themeClass);
  if (btn) btn.focus({ preventScroll: true });
}

window.switchTab = switchTab;
window.posAddToCart = posAddToCart;
window.posSetPriceMode = posSetPriceMode;
window.posOpenPaymentModal = posOpenPaymentModal;
window.posOpenDeliveryModal = posOpenDeliveryModal;
window.posToggleCredit = posToggleCredit;
window.posOpenNotesModal = posOpenNotesModal;
window.clearPosCart = clearCart;
// --- جسر POS موحّد ---
(function attachPosBridges() {
  const coreAddToCart = addToCart;
  // توافق مع زر التفريغ القديم الذي يكتب في window.posCart مباشرة.
  Object.defineProperty(window, 'posCart', {
    configurable: true,
    get: () => cart,
    set: value => { cart = Array.isArray(value) ? value : []; }
  });

  // الاستدعاء القديم من index.html يرسل اسم الصنف؛ نستبدله بمعرّف الصنف
  // الموجود في قاعدة البيانات حتى يظل السعر والمخزون والتسوية محكومة بالمصدر الحقيقي.
  window.addToCart = async (productIdOrName) => {
    const numericId = Number(productIdOrName);
    if (Number.isInteger(numericId) && numericId > 0) return coreAddToCart(numericId);
    const requestedName = String(productIdOrName ?? '').trim();
    if (!requestedName) return false;
    const products = await storage.getProducts();
    const normalizedName = requestedName.toLocaleLowerCase('ar');
    const product = products.find(item => String(item.name ?? '').trim().toLocaleLowerCase('ar') === normalizedName);
    if (!product) {
      showAppToast(`الصنف «${requestedName}» غير موجود في قائمة الأصناف.`, { tone: 'error' });
      return false;
    }
    return coreAddToCart(product.id);
  };
  window.posAddToCart = coreAddToCart;
  window.renderPosCart = renderCart;
  window.renderPosProducts = renderPosProducts;
  window.posCalculateTotal = calculateCartTotals;
  window.posCalculateChange = calculateChange;
  window.capturePosWeight = capturePosWeight;
  window.processPosPayment = (p) => completeSale(Boolean(p));
  window.closePosReceipt = finishSale;
  window.posUpdateQty = (i, d) => {
    const item = cart[Number(i)];
    if (item) updateCartItemQty(Number(item.product_id), Number(d) || 0);
  };
  window.setPosPayment = (m, b) => {
    const method = /wallet|محفظ/i.test(String(m)) ? 'محفظة إلكترونية' : /visa|card|بطاق/i.test(String(m)) ? 'بطاقة' : 'نقدي';
    if (method !== 'محفظة إلكترونية') {
      window.__posSelectedWalletId = null;
      window.__posSelectedWalletSnapshot = null;
    }
    setPaymentMethod(method, b);
    // توافق مع أزرار شاشة البيع الحالية التي تستخدم payment-methods.
    document.querySelectorAll('.payment-methods button').forEach(item => item.classList.toggle('active', item === b));
  };
  window.setPosMode = (m, b) => {
    const lvl = /wholesale|جملة/i.test(String(m)) ? 'wholesale'
      : /special|خاص/i.test(String(m)) ? 'special' : 'retail';
    void posSetPriceMode(lvl, b);
    // توافق مع أزرار شاشة البيع الحالية التي تستخدم price-mode-row.
    document.querySelectorAll('.price-mode-row button').forEach(item => item.classList.toggle('active', item === b));
  };
  window.saveDelivery = () => {
    const fee = Math.max(0, Number(document.getElementById('delivery-fee')?.value || 0));
    const target = document.getElementById('pos-delivery-customer-fee');
    if (target) target.value = fee.toFixed(2);
    void closeModal('delivery-modal');
    calculateCartTotals();
  };
  window.saveCredit = () => { setPaymentMethod('دفع آجل'); void closeModal('credit-modal'); };
  window.openPosModal = openModal;
  window.closePosModal = closeModal;
  window.openPosDeliveryModal = posOpenDeliveryModal;
  window.openPosCreditModal = posToggleCredit;
  window.openPosNotesModal = posOpenNotesModal;
  window.startPosBarcodeCamera = startPosBarcodeCamera;
  window.stopPosBarcodeCamera = stopPosBarcodeCamera;
  window.startSalesHistoryBarcodeCamera = startSalesHistoryBarcodeCamera;
  window.stopSalesHistoryBarcodeCamera = stopSalesHistoryBarcodeCamera;
  window.openCashierShift = openCashierShift;
  window.closeCashierShift = closeCashierShift;
  window.startShift = window.openCashierShift;
  window.closeShift = window.closeCashierShift;
  window.filterPosCategory = filterPosCategory;

  // هذا الاستدعاء موجود في بطاقة اختيار العميل القديمة في index.html.
  window.selectCustomer = async (name) => {
    const customerName = String(name || 'عميل نقدي');
    document.getElementById('customer-display')?.replaceChildren(document.createTextNode(customerName));
    document.getElementById('credit-customer-name')?.replaceChildren(document.createTextNode(customerName));
    try {
      const customers = await storage.getCustomers();
      const exact = customers.find(customer => String(customer.name || '').trim() === customerName);
      const selected = exact || (customerName !== 'عميل نقدي' ? customers.find(customer => Number(customer.id) !== 1) : null);
      posSelectedCustomerId = Number(selected?.id || 1);
    } catch (_) {
      posSelectedCustomerId = 1;
    }
    void closeModal('customer-modal');
  };
})();
