const fs = require('fs');
const path = require('path');
const { createBusinessCatalogStorage } = require('./business-catalog-storage');
const { createSqliteStorageAdapter } = require('./storage-adapter');
const { createChangeTracker } = require('./change-tracker');
const { isDeepStrictEqual } = require('node:util');
const { performance } = require('node:perf_hooks');

const LARGE_UNTRACKED_COLLECTIONS = [
  'products', 'branch_inventory', 'sales', 'sale_items', 'sale_returns', 'sale_return_items', 'purchases', 'purchase_items',
  'stock_movements', 'cash_transactions', 'cash_audit_chain', 'customer_transactions', 'supplier_transactions', 'audit_logs',
  'warehouse_inventory', 'warehouse_stock_movements'
];
const SCHEMA_INITIALIZATION_VERSION = 3;

function normalizeSqlitePath(value, baseDirectory) {
  let resolved = path.isAbsolute(value) ? value : path.resolve(baseDirectory, value);
  const extension = path.extname(resolved).toLowerCase();
  if (!extension) return path.join(resolved, 'database.sqlite');
  if (extension === '.sqlite') return resolved;
  return path.join(path.dirname(resolved), `${path.basename(resolved, path.extname(resolved))}.sqlite`);
}

function writeConfigAtomically(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

// Default initial database schema & seed data
const initialData = {
  business_profile: null,
  categories: [],
  products: [],
  users: [
    {
      "id": 1,
      "name": "مدير النظام",
      "username": "admin",
      "password_hash": "pbkdf2-sha256$600000$1tYA8TEGlIfJq0U6802kDw$vmR1kQh_3nT3NG49KBT07npv0-naUb6mZGA1Wkaxnxo",
      "must_change_password": true,
      "bootstrap_password_initialized": true,
      "role": "admin",
      "permissions": ["view", "add", "edit", "delete", "import_export", "print_pdf", "system_settings", "user_management", "image_management"],
      "is_active": true,
      "is_owner": false,
      "created_at": "2026-10-31 00:00:00"
    },

    {
      "id": 2,
      "name": "مسؤول المخزن",
      "username": "inventory",
      "password_hash": "pbkdf2-sha256$600000$0xonucivbpTlGm0eLiY5wQ$PCno0C3j5QYk0hdWeIERFSSbovPHz1gAPTC0JLaMPCE",
      "role": "inventory_manager",
      "permissions": [
        "view",
        "add",
        "edit",
        "import_export",
        "print_pdf"
      ],
      "is_active": true,
      "created_at": "2026-10-05 09:00:00"
    },
    {
      "id": 3,
      "name": "موظف المبيعات",
      "username": "cashier",
      "password_hash": "pbkdf2-sha256$600000$2Fhj5GDsy_2dy_hDBmjOcw$HKB7DgCIVaqC6I7ROWCfLezJMF3GtRM8Ui3AF1XYIz0",
      "role": "cashier",
      "permissions": [
        "view",
        "add",
        "print_pdf"
      ],
      "is_active": true,
      "created_at": "2026-10-05 09:00:00"
    }
  ],
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
  self_order_requests: [],
  suspended_sales: [],
  sale_items: [],
  sale_returns: [],
  sale_return_items: [],
  purchases: [],
  purchase_items: [],
  purchase_orders: [],
  purchase_order_items: [],
  waste_records: [],
  delivery_riders: [],
  delivery_assignments: [],
  delivery_settlements: [],
  customer_transactions: [],
  supplier_transactions: [],
  cash_transactions: [],
  cash_audit_chain: [],
  loyalty_transactions: [],
  ai_insights: [],
  loyalty_settings: { enabled: false, spend_per_point: 10 },
  tax_settings: { enabled: false, rate: 0, registration_number: '' },
  accounting_settings: { tally: { endpoint: 'http://127.0.0.1:9000', company_name: '', sales_ledger: '', cash_ledger: '', receivables_ledger: '', tax_ledger: '' }, tally_exported_sale_ids: [] },
  ui_settings: { hidden: ['tab:medicine-catalog'] },
  cashier_shifts: [],
  service_orders: [],
  installment_contracts: [],
  promotions: [],
  whatsapp_offer_message: null,
  stock_movements: [],
  employees: [],
  employee_transactions: [],
  attendance: [],
  audit_logs: [
    {
      "id": 1,
      "user_id": 1,
      "action": "تهيئة النظام",
      "entity": "system",
      "entity_id": 1,
      "details": "بدء تهيئة قاعدة بيانات نقطة البيع",
      "created_at": "2026-10-05 09:00:00"
    }
  ],
};

// Database persistence manager
class Database {
  constructor() {
    const profileStart = performance.now();
    const profilePhase = name => { if (process.env.RAWDA_PROFILE === '1') console.error(`[PROFILE] database ${name}: ${(performance.now() - profileStart).toFixed(2)}ms`); };
    this.data = null;
    const dataDir = process.env.RAWDA_DATA_DIR;
    this.configPath = process.env.RAWDA_CONFIG_PATH
      || (dataDir ? path.join(dataDir, 'config.json') : path.join(__dirname, 'config.json'));
    this.dbFile = this.resolveDbPath();
    const hasExistingSqlite = fs.existsSync(this.dbFile) && fs.statSync(this.dbFile).size > 0;
    this.storageAdapter = createSqliteStorageAdapter(this.dbFile);
    profilePhase('adapter-open');
    if (hasExistingSqlite) {
      this.data = this.storageAdapter.load();
      profilePhase('load');
      if (!this.data || !Array.isArray(this.data.products) || !Array.isArray(this.data.categories) || !Array.isArray(this.data.users)) {
        this.storageAdapter.close();
        throw new Error(`قاعدة SQLite لا تحتوي على المجموعات الأساسية المطلوبة: ${this.dbFile}`);
      }
    } else {
      this.data = JSON.parse(JSON.stringify(initialData));
      this.storageAdapter.save(this.data);
      profilePhase('seed');
    }
    this.businessCatalogStorage = createBusinessCatalogStorage({
      databaseFile: this.dbFile,
      catalogFile: process.env.RAWDA_CATALOG_PATH || undefined,
      logger: console
    });
    this.activateChangeTracking();
    profilePhase('tracking-activate');
    const catalogMarker = this.storageAdapter.getMeta('catalog_initialization');
    const canFastInitializeCatalog = catalogMarker?.version === 1
      && this.data.business_catalog_storage_version === 1
      && typeof this.businessCatalogStorage.initializeFast === 'function';
    if (canFastInitializeCatalog) this.businessCatalogStorage.initializeFast({ data: this.data });
    else this.businessCatalogStorage.initialize({ data: this.data, saveMainData: () => this.save() });
    this.storageAdapter.setMeta('catalog_initialization', { version: 1, initialized_at: new Date().toISOString() });
    profilePhase('catalog-initialize');
    this.attachBusinessCatalogView();
    this.ensureSchema();
    profilePhase('schema-normalize-and-save');
  }

  schemaInitializationIsCurrent() {
    const marker = this.storageAdapter.getMeta('schema_initialization');
    if (!marker || marker.version !== SCHEMA_INITIALIZATION_VERSION) return false;
    if (!Array.isArray(this.data.products) || !Array.isArray(this.data.branches) || !Array.isArray(this.data.branch_inventory)) return false;
    if (!this.data.branches.length || !Number.isInteger(Number(this.data.default_branch_id))) return false;
    const summary = this.storageAdapter.collectionSummary(['products', 'branch_inventory', 'branches']);
    // This is intentionally constant-time per collection. It catches a partial
    // restore or a missing core collection without rebuilding 30k rows at each
    // launch; restore explicitly clears the marker for a complete rebuild.
    return summary.branches.count > 0
      && (summary.products.count === 0 || summary.branch_inventory.count > 0);
  }

  markSchemaInitialized() {
    this.storageAdapter.setMeta('schema_initialization', {
      version: SCHEMA_INITIALIZATION_VERSION,
      initialized_at: new Date().toISOString()
    });
  }

  invalidateInitializationMarkers() {
    this.storageAdapter.deleteMeta('schema_initialization');
    this.storageAdapter.deleteMeta('warehouse_initialization');
    this.storageAdapter.deleteMeta('catalog_initialization');
  }

  getInitializationMarker(name) { return this.storageAdapter.getMeta(`${name}_initialization`); }
  setInitializationMarker(name, value) { this.storageAdapter.setMeta(`${name}_initialization`, value); }

  ensureSchema({ force = false } = {}) {
    if (!force && this.schemaInitializationIsCurrent()) return false;
    let schemaChanged = false;
    const usedProductNumbers = new Set();
    let nextProductNumber = 1;
    for (const product of this.data.products || []) {
      const existing = Number(product.item_number);
      if (Number.isSafeInteger(existing) && existing > 0 && !usedProductNumbers.has(existing)) {
        usedProductNumbers.add(existing);
        nextProductNumber = Math.max(nextProductNumber, existing + 1);
        continue;
      }
      while (usedProductNumbers.has(nextProductNumber)) nextProductNumber += 1;
      product.item_number = nextProductNumber;
      usedProductNumbers.add(nextProductNumber);
      nextProductNumber += 1;
      schemaChanged = true;
    }
    // The original fresh database has no persisted item counter. Add/maintain
    // it only after product records exist or an older SQLite database already
    // carries it, preserving the source's first-run state exactly.
    if (this.data.products.length || Object.hasOwn(this.data, 'next_product_item_number')) {
      const persistedNextProductNumber = Number(this.data.next_product_item_number);
      if (!Number.isSafeInteger(persistedNextProductNumber) || persistedNextProductNumber < nextProductNumber) {
        this.data.next_product_item_number = nextProductNumber;
        schemaChanged = true;
      }
    }
    // Keep every pre-existing record and place it in the initial main branch.
    if (!Array.isArray(this.data.branches)) { this.data.branches = []; schemaChanged = true; }
    if (!Array.isArray(this.data.branch_inventory)) { this.data.branch_inventory = []; schemaChanged = true; }
    if (!this.data.branches.length) { this.data.branches.push({ id: 1, name: 'الفرع الرئيسي', address: '', phone: '', is_active: true, is_default: true, created_at: new Date().toISOString() }); schemaChanged = true; }
    const mainBranch = this.data.branches.find(branch => branch.is_default) || this.data.branches[0];
    mainBranch.id = Number(mainBranch.id) || 1; mainBranch.is_active = mainBranch.is_active !== false; mainBranch.is_default = true;
    this.data.default_branch_id = mainBranch.id;
    for (const branch of this.data.branches) { branch.id = Number(branch.id); branch.is_active = branch.is_active !== false; if (branch.id !== mainBranch.id) branch.is_default = false; }
    for (const user of this.data.users || []) if (!user.is_owner) user.branch_id = Number(user.branch_id) || mainBranch.id;
    const branchTables = ['sales','purchases','purchase_orders','cashier_shifts','cash_transactions','customer_transactions','supplier_transactions','stock_movements','waste_records','service_orders','installment_contracts','delivery_riders','delivery_assignments','delivery_settlements','promotions','employees','employee_transactions','attendance','suspended_sales'];
    for (const table of branchTables) { if (!Array.isArray(this.data[table])) { this.data[table] = []; schemaChanged = true; } for (const row of this.data[table]) if (!Number.isInteger(Number(row.branch_id))) { row.branch_id = mainBranch.id; schemaChanged = true; } }
    const saleBranchById = new Map((this.data.sales || []).map(sale => [Number(sale.id), Number(sale.branch_id) || mainBranch.id]));
    const purchaseBranchById = new Map((this.data.purchases || []).map(row => [Number(row.id), Number(row.branch_id) || mainBranch.id]));
    const orderBranchById = new Map((this.data.purchase_orders || []).map(row => [Number(row.id), Number(row.branch_id) || mainBranch.id]));
    for (const row of this.data.sale_items || []) { const branchId = saleBranchById.get(Number(row.sale_id)) || mainBranch.id; if (Number(row.branch_id) !== Number(branchId)) { row.branch_id = Number(branchId); schemaChanged = true; } }
    for (const row of this.data.sale_returns || []) { const branchId = saleBranchById.get(Number(row.sale_id)) || mainBranch.id; if (Number(row.branch_id) !== Number(branchId)) { row.branch_id = Number(branchId); schemaChanged = true; } }
    for (const row of this.data.purchase_items || []) { const branchId = purchaseBranchById.get(Number(row.purchase_id)) || mainBranch.id; if (Number(row.branch_id) !== Number(branchId)) { row.branch_id = Number(branchId); schemaChanged = true; } }
    for (const row of this.data.purchase_order_items || []) { const branchId = orderBranchById.get(Number(row.purchase_order_id)) || mainBranch.id; if (Number(row.branch_id) !== Number(branchId)) { row.branch_id = Number(branchId); schemaChanged = true; } }
    const assignedProductIds = new Set((this.data.branch_inventory || []).filter(row => Number(row.branch_id) === mainBranch.id).map(row => Number(row.product_id)));
    let nextBranchInventoryId = (this.data.branch_inventory || []).reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
    for (const product of this.data.products || []) {
      const productId = Number(product.id);
      if (assignedProductIds.has(productId)) continue;
      this.data.branch_inventory.push({ id: nextBranchInventoryId++, branch_id: mainBranch.id, product_id: productId, quantity: Math.max(0, Number(product.quantity) || 0), min_stock: Math.max(0, Number(product.min_stock) || 0) });
      assignedProductIds.add(productId);
      schemaChanged = true;
    }
    ['sale_returns', 'customer_transactions', 'supplier_transactions', 'cash_transactions', 'attendance', 'suspended_sales', 'loyalty_transactions', 'ai_insights', 'cashier_shifts', 'service_orders', 'installment_contracts', 'promotions'].forEach(table => {
      if (!Array.isArray(this.data[table])) { this.data[table] = []; schemaChanged = true; }
    });
    if (this.data.whatsapp_offer_message !== null && typeof this.data.whatsapp_offer_message !== 'string') {
      this.data.whatsapp_offer_message = null;
      schemaChanged = true;
    }
    if (!this.data.loyalty_settings || typeof this.data.loyalty_settings !== 'object') {
      this.data.loyalty_settings = { enabled: false, spend_per_point: 10 };
      schemaChanged = true;
    }
    if (!this.data.tax_settings || typeof this.data.tax_settings !== 'object') {
      this.data.tax_settings = { enabled: false, rate: 0, registration_number: '' };
      schemaChanged = true;
    }
    if (!this.data.ui_settings || typeof this.data.ui_settings !== 'object' || !Array.isArray(this.data.ui_settings.hidden)) {
      this.data.ui_settings = { hidden: [] };
      schemaChanged = true;
    }
    if (schemaChanged) {
      this.save();
    }
    this.markSchemaInitialized();
    return true;
  }

  resolveDbPath() {
    try {
      if (fs.existsSync(this.configPath)) {
        const conf = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        if (conf.database_path) return normalizeSqlitePath(conf.database_path, __dirname);
      }
    } catch (e) {
      console.error("Config read error:", e);
    }
    const configuredPath = process.env.RAWDA_DB_PATH
      || (process.env.RAWDA_DATA_DIR ? path.join(process.env.RAWDA_DATA_DIR, 'database.sqlite') : path.join(__dirname, 'database.sqlite'));
    return normalizeSqlitePath(configuredPath, __dirname);
  }

  save(data = this.data, hint = null, beforeCommit = null) {
    const saveStarted = performance.now();
    const saveProfile = message => { if (process.env.RAWDA_PROFILE === '1') console.error(`[PROFILE] db.save ${message}: ${(performance.now() - saveStarted).toFixed(2)}ms`); };
    if (process.env.RAWDA_PROFILE === '1') console.error('[PROFILE] db.save entered');
    const rowHint = data?.rowHints === true ? data : hint?.rowHints === true ? hint : null;
    if (rowHint) {
      if (data === rowHint) data = this.data;
      const result = this.storageAdapter.saveHinted(rowHint, beforeCommit);
      if (process.env.NODE_ENV === 'test' && process.env.RAWDA_VERIFY_STORAGE === '1') this.verifyStorageMatchesMemory();
      return result;
    }
    if (Array.isArray(data) || (data && typeof data === 'object'
      && (Object.hasOwn(data, 'collections') || Object.hasOwn(data, 'tables')))) {
      hint = data;
      data = this.data;
    }
    if (data === this.data && hint === null && this.changeTracker && typeof this.storageAdapter.saveTracked === 'function'
      && LARGE_UNTRACKED_COLLECTIONS.every(name => !Object.hasOwn(this.data, name))) {
      if (process.env.RAWDA_PROFILE === '1') console.error('[PROFILE] db.save before snapshot');
      const changes = this.changeTracker.snapshotChanges();
      saveProfile(`snapshot ${changes.collections.map(collection => `${collection.name}=${collection.replace ? collection.rows.length : collection.rows.length + (collection.deletes?.length || 0)}`).join(',') || 'empty'}`);
      if (!changes.collections.length && !changes.values.length && !changes.deleteValues.length) {
        return { writtenRows: 0, deletedRows: 0, changedCollections: [], fallbackCollections: [] };
      }
      const result = this.storageAdapter.saveTracked(changes);
      saveProfile('sqlite-transaction');
      this.changeTracker.markSaved(changes);
      saveProfile('mark-saved');
      if (process.env.NODE_ENV === 'test' && process.env.RAWDA_VERIFY_STORAGE === '1') this.verifyStorageMatchesMemory();
      return result;
    }
    const result = this.storageAdapter.save(data, hint, beforeCommit);
    if (data === this.data) this.changeTracker?.markSaved();
    if (data === this.data && process.env.NODE_ENV === 'test' && process.env.RAWDA_VERIFY_STORAGE === '1') this.verifyStorageMatchesMemory();
    return result;
  }

  transaction(collections, operation, beforeCommit = null) {
    if (!Array.isArray(collections) || !collections.length || typeof operation !== 'function') {
      throw new TypeError('Database transaction requires collection names and a synchronous operation.');
    }
    const names = [...new Set(collections.map(String))];
    const snapshots = new Map(names.map(name => [name, JSON.parse(JSON.stringify(this.data[name]))]));
    try {
      const result = operation();
      if (result && typeof result.then === 'function') throw new TypeError('Database.transaction operation must be synchronous.');
      if (result !== null && result !== undefined && typeof beforeCommit === 'function') {
        this.save(names, null, beforeCommit);
      } else {
        this.save(names);
      }
      return result;
    } catch (error) {
      for (const [name, snapshot] of snapshots) {
        if (Array.isArray(snapshot) && Array.isArray(this.data[name])) {
          const target = this.data[name];
          target.length = 0;
          for (const row of snapshot) target.push(row);
        } else {
          this.data[name] = snapshot;
        }
      }
      throw error;
    }
  }

  withSqlTransaction(operation) {
    return this.storageAdapter.withTransaction(operation);
  }

  verifyStorageMatchesMemory() {
    const persisted = this.storageAdapter.load();
    const memory = JSON.parse(JSON.stringify(this.data));
    if (!isDeepStrictEqual(persisted, memory)) {
      const groups = new Set([...Object.keys(persisted), ...Object.keys(memory)]);
      const differing = [...groups].filter(name => !isDeepStrictEqual(persisted[name], memory[name]));
      throw new Error(`SQLite/memory verification failed after save; differing groups: ${differing.join(', ')}`);
    }
  }

  getBusinessCatalog() {
    return this.businessCatalogStorage.getRows();
  }

  attachBusinessCatalogView() {
    if (!this.data || Object.prototype.hasOwnProperty.call(this.data, 'business_catalog')) return;
    Object.defineProperty(this.data, 'business_catalog', {
      configurable: true, enumerable: false,
      get: () => this.businessCatalogStorage.getRows(),
      set: rows => this.businessCatalogStorage.setRows(rows)
    });
  }

  setData(data) {
    if (data === this.data) return this.data;
    this.data = this.changeTracker?.unwrap(data) || data;
    this.attachBusinessCatalogView();
    this.activateChangeTracking();
    return this.data;
  }

  activateChangeTracking() {
    this.changeTracker = createChangeTracker(this.data, { excludedCollections: ['business_catalog', ...LARGE_UNTRACKED_COLLECTIONS] });
    this.data = this.changeTracker.data;
  }

  saveBusinessCatalog(rows = this.getBusinessCatalog()) {
    return this.businessCatalogStorage.setRows(rows);
  }

  getFullSnapshot(data = this.data) {
    const snapshot = this.businessCatalogStorage.getSnapshot(data);
    // Keep the legacy backup contract: even a fresh empty database exposes
    // the next product item number as one, without persisting a counter field
    // into the original first-run db.data shape.
    if (!Number.isSafeInteger(Number(snapshot.next_product_item_number)) || Number(snapshot.next_product_item_number) < 1) {
      const maxExisting = Math.max(0, ...(snapshot.products || []).map(product => Number(product.item_number) || 0));
      snapshot.next_product_item_number = maxExisting + 1;
    }
    return snapshot;
  }

  getBusinessCatalogLoadError() {
    return this.businessCatalogStorage.getLoadError();
  }

  getBusinessCatalogFilePath() {
    return this.businessCatalogStorage.getFilePath();
  }

  getAutomaticSnapshot() {
    const snapshot = { ...this.data };
    const reference = this.businessCatalogStorage.getAutomaticSnapshotReference();
    if (reference) snapshot.business_catalog_snapshot = reference;
    return snapshot;
  }

  readAutomaticCatalogSnapshot(reference, scheduledBackupDirectory) {
    return this.businessCatalogStorage.readSnapshotReference(reference, scheduledBackupDirectory);
  }

  getAutomaticCatalogSnapshotPath(reference) {
    return this.businessCatalogStorage.getContentAddressedSnapshotPath(reference);
  }

  restoreFullSnapshot(restoredData) {
    const catalogRows = Array.isArray(restoredData.business_catalog) ? restoredData.business_catalog : [];
    const mainData = { ...restoredData };
    delete mainData.business_catalog;
    delete mainData.business_catalog_snapshot;
    mainData.business_catalog_storage_version = 1;
    this.businessCatalogStorage.replaceFromSnapshot(catalogRows, () => this.save(mainData), mainData);
    this.setData(mainData);
    this.invalidateInitializationMarkers();
    return this.data;
  }

  findUserByUsername(username) {
    const persisted = this.storageAdapter.findUserByUsername(username);
    if (persisted) return persisted.is_active ? persisted : null;
    return this.data.users.find(user => user.username === username && user.is_active) || null;
  }
  getDatabasePath() {
    return this.dbFile;
  }

  close() {
    this.storageAdapter.close();
  }

  useStorageAdapter(adapter, { reload = true } = {}) {
    if (!adapter || typeof adapter.load !== 'function' || typeof adapter.save !== 'function') {
      throw new TypeError('Storage adapter must provide load() and save().');
    }
    const previous = this.storageAdapter;
    this.storageAdapter = adapter;
    try {
      if (reload) this.setData(adapter.load());
      if (adapter.filePath) this.dbFile = adapter.filePath;
      return previous;
    } catch (error) {
      this.storageAdapter = previous;
      throw error;
    }
  }

  setDatabasePath(newCustomPath, userId = 1) {
    if (!newCustomPath || !newCustomPath.trim()) {
      throw new Error('يرجى تحديد مسار صالح لحفظ قاعدة البيانات.');
    }

    let resolved = path.isAbsolute(newCustomPath)
      ? newCustomPath
      : path.join(__dirname, newCustomPath);

    // Accept a folder path as well as a SQLite file path. A legacy .json name is
    // normalized to .sqlite; its contents are never read or changed.
    resolved = normalizeSqlitePath(resolved, __dirname);

    const targetDir = path.dirname(resolved);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const oldPath = this.dbFile;
    if (path.resolve(oldPath) === path.resolve(resolved)) return { success: true, new_path: resolved };
    const nextAdapter = createSqliteStorageAdapter(resolved);
    try {
      if (Object.keys(nextAdapter.load()).length) throw new Error('ملف SQLite المحدد يحتوي بيانات؛ لم يتم استبداله.');
      nextAdapter.save(this.data);
    } catch (error) {
      nextAdapter.close();
      throw error;
    }
    this.businessCatalogStorage.setDatabaseFile(resolved);
    const previousAdapter = this.storageAdapter;
    this.storageAdapter = nextAdapter;
    this.dbFile = resolved;
    previousAdapter.close();

    // Update config.json
    try {
      let conf = {};
      if (fs.existsSync(this.configPath)) {
        conf = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      }
      conf.database_path = resolved;
      writeConfigAtomically(this.configPath, conf);
    } catch (e) {
      console.error("Failed to update config.json:", e);
    }

    this.logAudit(userId, 'تغيير مسار قاعدة البيانات', 'system', 1, `تم تغيير مكان حفظ قاعدة البيانات من [${oldPath}] إلى [${resolved}] بنجاح`);
    return { success: true, new_path: resolved };
  }

  nextProductItemNumber() {
    const maxExisting = Math.max(0, ...(this.data.products || []).map(product => Number(product.item_number) || 0));
    const persistedNext = Number(this.data.next_product_item_number);
    const nextNumber = Math.max(1, Number.isSafeInteger(persistedNext) ? persistedNext : 1, maxExisting + 1);
    this.data.next_product_item_number = nextNumber + 1;
    return nextNumber;
  }

  nextId(table) {
    const rows = table === 'business_catalog' ? this.getBusinessCatalog() : this.data[table];
    if (!rows || !rows.length) return 1;
    let max = 0;
    for (const item of rows) { const id = Number(item.id) || 0; if (id > max) max = id; }
    return max + 1;
  }

  logAudit(userId, action, entity, entityId, details, { save = true } = {}) {
    const log = {
      id: this.nextId('audit_logs'),
      user_id: userId ?? null,
      action,
      entity,
      entity_id: entityId || null,
      details: typeof details === 'object' ? JSON.stringify(details) : String(details),
      created_at: new Date().toISOString().replace('T', ' ').substring(0, 19)
    };
    this.data.audit_logs.unshift(log);
    if (save) this.save();
    return log;
  }
}

const db = new Database();
module.exports = db;
