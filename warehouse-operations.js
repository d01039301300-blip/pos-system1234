'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const requestContext = new AsyncLocalStorage();
const WAREHOUSE_INITIALIZATION_VERSION = 2;

function warehouseInitializationIsCurrent(db) {
  const marker = db.getInitializationMarker?.('warehouse');
  if (!marker || marker.version !== WAREHOUSE_INITIALIZATION_VERSION) return false;
  if (!['warehouses', 'warehouse_categories', 'warehouse_products', 'warehouse_inventory', 'warehouse_stock_movements']
    .every(key => Array.isArray(db.data[key]))) return false;
  const summary = db.storageAdapter.collectionSummary(['stock_movements', 'warehouse_stock_movements', 'warehouses']);
  // A normal committed movement creates its warehouse mirror in the same
  // transaction. Matching counts and a nonempty warehouse list are a fast
  // launch check; restore clears this marker and performs the full repair.
  return summary.warehouses.count > 0 && summary.stock_movements.count === summary.warehouse_stock_movements.count;
}

function ensureWarehouseTables(db) {
  if (warehouseInitializationIsCurrent(db)) return false;
  const arrays = ['warehouses', 'warehouse_categories', 'warehouse_products', 'warehouse_inventory', 'warehouse_stock_movements'];
  let changed = false;
  for (const key of arrays) {
    if (!Array.isArray(db.data[key])) { db.data[key] = []; changed = true; }
  }
  let nextWarehouseInventoryId = db.nextId('warehouse_inventory');
  for (const branch of db.data.branches || []) {
    if (branch.deleted_at) continue;
    let warehouse = db.data.warehouses.find(row => Number(row.branch_id) === Number(branch.id) && row.is_default);
    if (!warehouse) {
      warehouse = { id: db.nextId('warehouses'), branch_id: Number(branch.id), name: branch.is_default ? 'المخزن الرئيسي' : `مخزن ${branch.name}`, is_default: true, is_active: true, created_at: new Date().toISOString() };
      db.data.warehouses.push(warehouse);
      changed = true;
      for (const row of db.data.branch_inventory || []) {
        if (Number(row.branch_id) === Number(branch.id)) {
          db.data.warehouse_inventory.push({ id: nextWarehouseInventoryId++, warehouse_id: warehouse.id, branch_id: Number(branch.id), product_id: Number(row.product_id), quantity: Math.max(0, Number(row.quantity) || 0), min_stock: Math.max(0, Number(row.min_stock) || 0) });
        }
      }
    }
  }
  // Build lookup maps once. The previous initialization called Array.some/find
  // over 10k+ movement, sale, purchase, and warehouse arrays for every
  // historical movement, making startup quadratic on established databases.
  const seenSourceMovementIds = new Set((db.data.warehouse_stock_movements || []).map(row => Number(row.source_movement_id)));
  const saleWarehouseByInvoice = new Map();
  for (const row of db.data.sales || []) if (!saleWarehouseByInvoice.has(row.invoice_number)) saleWarehouseByInvoice.set(row.invoice_number, row.warehouse_id);
  const purchaseWarehouseById = new Map();
  for (const row of db.data.purchases || []) if (!purchaseWarehouseById.has(Number(row.id))) purchaseWarehouseById.set(Number(row.id), row.warehouse_id);
  const warehousesByIdBranch = new Map();
  const warehousesByBranch = new Map();
  const addWarehouseLookup = warehouse => {
    const branchId = Number(warehouse.branch_id);
    const idKey = `${branchId}:${Number(warehouse.id)}`;
    if (!warehousesByIdBranch.has(idKey)) warehousesByIdBranch.set(idKey, warehouse);
    const rows = warehousesByBranch.get(branchId) || [];
    rows.push(warehouse);
    warehousesByBranch.set(branchId, rows);
  };
  for (const warehouse of db.data.warehouses || []) addWarehouseLookup(warehouse);
  const defaultWarehouseFromIndex = branchId => {
    const rows = warehousesByBranch.get(Number(branchId)) || [];
    return rows.find(row => row.is_default && row.is_active !== false)
      || rows.find(row => row.is_active !== false) || null;
  };
  let nextWarehouseMovementId = db.nextId('warehouse_stock_movements');
  // Current branch quantities already include all historical activity. Mark
  // existing movements as imported without applying them a second time.
  for (const movement of db.data.stock_movements || []) {
    if (seenSourceMovementIds.has(Number(movement.id))) continue;
    const branchId = Number(movement.branch_id || db.data.default_branch_id);
    const ref = String(movement.reference_id || '');
    let warehouseId = 0;
    if (movement.type === 'sale' || movement.type === 'return') warehouseId = Number(saleWarehouseByInvoice.get(ref) || 0);
    if (movement.type === 'purchase' || ref.startsWith('CANCEL-PUR-')) {
      const purchaseId = Number(ref.replace(/^CANCEL-PUR-|^PUR-/, ''));
      warehouseId ||= Number(purchaseWarehouseById.get(purchaseId) || 0);
    }
    const warehouse = warehousesByIdBranch.get(`${branchId}:${warehouseId}`) || defaultWarehouseFromIndex(branchId);
    if (warehouse) {
      db.data.warehouse_stock_movements.push({ id: nextWarehouseMovementId++, source_movement_id: movement.id, warehouse_id: warehouse.id, branch_id: branchId, product_id: Number(movement.product_id), type: movement.type, quantity: Number(movement.quantity || 0), reference_id: ref, created_at: movement.created_at || new Date().toISOString(), imported: true });
      seenSourceMovementIds.add(Number(movement.id));
    }
    changed = true;
  }
  if (changed) db.save();
  db.setInitializationMarker?.('warehouse', {
    version: WAREHOUSE_INITIALIZATION_VERSION,
    initialized_at: new Date().toISOString()
  });
  return true;
}

function defaultWarehouse(db, branchId) {
  return db.data.warehouses.find(row => Number(row.branch_id) === Number(branchId) && row.is_default && row.is_active !== false)
    || db.data.warehouses.find(row => Number(row.branch_id) === Number(branchId) && row.is_active !== false)
    || null;
}

function ensureBranchWarehouse(db, branchId, { save = true } = {}) {
  const branch = (db.data.branches || []).find(row => Number(row.id) === Number(branchId) && !row.deleted_at && row.is_active !== false);
  if (!branch || defaultWarehouse(db, branchId)) return defaultWarehouse(db, branchId);
  const warehouse = { id: db.nextId('warehouses'), branch_id: Number(branchId), name: branch.is_default ? 'المخزن الرئيسي' : `مخزن ${branch.name}`, is_default: true, is_active: true, created_at: new Date().toISOString() };
  db.data.warehouses.push(warehouse);
  let nextWarehouseInventoryId = db.nextId('warehouse_inventory');
  for (const row of db.data.branch_inventory || []) if (Number(row.branch_id) === Number(branchId)) db.data.warehouse_inventory.push({ id: nextWarehouseInventoryId++, warehouse_id: warehouse.id, branch_id: Number(branchId), product_id: Number(row.product_id), quantity: Math.max(0, Number(row.quantity) || 0), min_stock: Math.max(0, Number(row.min_stock) || 0) });
  if (save) db.save();
  return warehouse;
}

function inventoryRow(db, warehouseId, branchId, productId, create = false) {
  let row = db.data.warehouse_inventory.find(item => Number(item.warehouse_id) === Number(warehouseId) && Number(item.product_id) === Number(productId));
  if (!row && create) {
    row = { id: db.nextId('warehouse_inventory'), warehouse_id: Number(warehouseId), branch_id: Number(branchId), product_id: Number(productId), quantity: 0, min_stock: 0 };
    db.data.warehouse_inventory.push(row);
  }
  return row || null;
}

function warehouseForMovement(db, movement, context) {
  const ref = String(movement.reference_id || '');
  const branchId = Number(movement.branch_id || context?.branchId || db.data.default_branch_id);
  if (context?.warehouseId && Number(context.branchId) === branchId) return Number(context.warehouseId);
  if (movement.type === 'sale' || movement.type === 'return') {
    const sale = (db.data.sales || []).find(row => row.invoice_number === ref);
    if (sale?.warehouse_id) return Number(sale.warehouse_id);
  }
  if (movement.type === 'purchase' || (movement.type === 'adjustment' && ref.startsWith('CANCEL-PUR-'))) {
    const id = Number(ref.replace(/^CANCEL-PUR-|^PUR-/, ''));
    const purchase = (db.data.purchases || []).find(row => Number(row.id) === id);
    if (purchase?.warehouse_id) return Number(purchase.warehouse_id);
  }
  if (movement.type === 'waste') {
    const wasteId = Number(ref.replace(/^WASTE-/, ''));
    const waste = (db.data.waste_records || []).find(row => Number(row.id) === wasteId);
    if (waste?.warehouse_id) return Number(waste.warehouse_id);
  }
  return Number(defaultWarehouse(db, branchId)?.id || 0);
}

function attachWarehouseSaveHook(db, logger = console) {
  if (db.__warehouseSaveHookInstalled) return;
  const originalSave = db.save.bind(db);
  let initializingAfterRestore = false;
  db.save = (data, hint, beforeCommit = null) => {
    if (initializingAfterRestore) return originalSave(data, hint, beforeCommit);
    if (!Array.isArray(db.data.warehouse_inventory) || !Array.isArray(db.data.warehouse_stock_movements)) {
      initializingAfterRestore = true;
      try { ensureWarehouseTables(db); } finally { initializingAfterRestore = false; }
    }
    const context = requestContext.getStore();
    const warehouseRows = db.data.warehouse_inventory;
    const movementRows = db.data.warehouse_stock_movements;
    const beforeInventoryLength = warehouseRows.length;
    const changedInventory = new Map();
    const beforeMovementLength = movementRows.length;
    const beforeDocWarehouse = [];
    const rowHint = data?.rowHints === true ? data : hint?.rowHints === true ? hint : null;
    try {
      const knownMovementIds = new Set(movementRows.map(row => Number(row.source_movement_id)));
      const newMovements = (db.data.stock_movements || []).filter(movement => !knownMovementIds.has(Number(movement.id)));
      let nextWarehouseMovementId = db.nextId('warehouse_stock_movements');
      for (const movement of newMovements) {
        const branchId = Number(movement.branch_id || context?.branchId || db.data.default_branch_id);
        const warehouseId = warehouseForMovement(db, movement, context);
        const warehouse = db.data.warehouses.find(row => Number(row.id) === warehouseId && Number(row.branch_id) === branchId && row.is_active !== false);
        if (!warehouse) throw new Error('تعذر تحديد مخزن نشط تابع للفرع لحركة المخزون.');
        if (movement.type === 'sale') {
          const sale = (db.data.sales || []).find(row => row.invoice_number === movement.reference_id);
          if (sale && !sale.warehouse_id) { beforeDocWarehouse.push([sale, sale.warehouse_id]); sale.warehouse_id = warehouseId; }
        } else if (movement.type === 'purchase') {
          const id = Number(String(movement.reference_id || '').replace(/^PUR-/, ''));
          const purchase = (db.data.purchases || []).find(row => Number(row.id) === id);
          if (purchase && !purchase.warehouse_id) { beforeDocWarehouse.push([purchase, purchase.warehouse_id]); purchase.warehouse_id = warehouseId; }
        } else if (movement.type === 'waste') {
          const id = Number(String(movement.reference_id || '').replace(/^WASTE-/, ''));
          const waste = (db.data.waste_records || []).find(row => Number(row.id) === id);
          if (waste && !waste.warehouse_id) { beforeDocWarehouse.push([waste, waste.warehouse_id]); waste.warehouse_id = warehouseId; }
        }
        const product = db.data.products.find(row => Number(row.id) === Number(movement.product_id));
        if (movement.type === 'sale' && (product?.is_service === true || String(product?.unit || '').trim() === 'خدمة')) continue;
        const row = inventoryRow(db, warehouseId, branchId, movement.product_id, true);
        if (!changedInventory.has(row)) changedInventory.set(row, row.quantity);
        const next = Number(row.quantity || 0) + Number(movement.quantity || 0);
        if (next < -0.0001) throw new Error(`رصيد المخزن غير كافٍ للصنف ${movement.product_id}.`);
        row.quantity = Math.max(0, Number(next.toFixed(3)));
        movementRows.push({ id: nextWarehouseMovementId++, source_movement_id: movement.id, warehouse_id: warehouseId, branch_id: branchId, product_id: Number(movement.product_id), type: movement.type, quantity: Number(movement.quantity || 0), reference_id: movement.reference_id || '', created_at: movement.created_at || new Date().toISOString() });
      }
      if (rowHint) {
        const inventoryHint = rowHint.collections.warehouse_inventory ||= { rows: [] };
        for (const row of changedInventory.keys()) inventoryHint.rows.push({ row, ordinal: warehouseRows.indexOf(row) });
        const movementsHint = rowHint.collections.warehouse_stock_movements ||= { rows: [] };
        for (let index = beforeMovementLength; index < movementRows.length; index += 1) movementsHint.rows.push({ row: movementRows[index], ordinal: index });
      }
      return originalSave(data, hint, beforeCommit);
    } catch (error) {
      for (const [row, quantity] of changedInventory) row.quantity = quantity;
      warehouseRows.length = beforeInventoryLength;
      movementRows.length = beforeMovementLength;
      for (const [row, warehouseId] of beforeDocWarehouse) {
        if (warehouseId === undefined) delete row.warehouse_id;
        else row.warehouse_id = warehouseId;
      }
      logger.error('Warehouse stock update failed:', error.message);
      throw error;
    }
  };
  db.__warehouseSaveHookInstalled = true;
}

function registerWarehouseOperations({ app, db, requireOwner, isUnrestrictedAccount = user => Boolean(user?.is_owner), logger = console }) {
  ensureWarehouseTables(db);
  attachWarehouseSaveHook(db, logger);

  app.use('/api', (req, res, next) => {
    if (!req.authUser || req.method !== 'POST' || !(['/sales', '/purchases', '/inventory/waste'].includes(req.path) || /^\/purchase-orders\/\d+\/receive$/.test(req.path))) return next();
    const branchId = Number(req.branchId || db.data.default_branch_id);
    ensureBranchWarehouse(db, branchId);
    const requestedId = Number(req.body?.warehouse_id);
    const warehouse = Number.isInteger(requestedId) && requestedId > 0
      ? db.data.warehouses.find(row => Number(row.id) === requestedId && Number(row.branch_id) === branchId && row.is_active !== false)
      : defaultWarehouse(db, branchId);
    if (!warehouse) return res.status(400).json({ error: 'اختر مخزناً نشطاً تابعاً للفرع.' });
    req.warehouseId = Number(warehouse.id);
    const requestedItems = req.path === '/sales' ? req.body?.items : req.path === '/inventory/waste' ? [{ product_id: req.body?.product_id, quantity: req.body?.quantity }] : null;
    if (Array.isArray(requestedItems)) {
      const totals = new Map();
      for (const item of requestedItems) totals.set(Number(item.product_id), (totals.get(Number(item.product_id)) || 0) + Number(item.quantity || 0));
      for (const [productId, quantity] of totals) {
        const product = db.data.products.find(row => Number(row.id) === Number(productId));
        if (product?.is_service === true || String(product?.unit || '').trim() === 'خدمة') continue;
        const stock = Number(inventoryRow(db, req.warehouseId, branchId, productId)?.quantity || 0);
        if (quantity > stock) return res.status(400).json({ error: `رصيد المخزن المحدد من الصنف ${productId} هو ${stock} فقط.` });
      }
    }
    requestContext.run({ warehouseId: req.warehouseId, branchId }, next);
  });

  app.get('/api/warehouses', (req, res) => {
    const unrestricted = isUnrestrictedAccount(req.authUser);
    const branchId = unrestricted && Number(req.query.branch_id) > 0 ? Number(req.query.branch_id) : Number(req.branchId);
    ensureBranchWarehouse(db, branchId);
    const includeInactive = unrestricted && String(req.query.include_inactive || '') === '1';
    const rows = db.data.warehouses.filter(row => Number(row.branch_id) === branchId && (includeInactive || row.is_active !== false));
    res.json({ warehouses: rows, default_warehouse_id: defaultWarehouse(db, branchId)?.id || null });
  });
  app.get('/api/warehouse-inventory-summary', (req, res) => {
    if (!isUnrestrictedAccount(req.authUser)) return res.status(403).json({ error: 'إجمالي مخزون جميع الفروع متاح لمالك النظام أو حساب admin فقط.' });
    const warehouseIds = new Set((db.data.warehouses || []).map(row => Number(row.id)));
    const products = new Set();
    const stockedProducts = new Set();
    let totalQuantity = 0;
    for (const row of db.data.warehouse_inventory || []) {
      if (!warehouseIds.has(Number(row.warehouse_id))) continue;
      const productId = Number(row.product_id);
      if (!Number.isInteger(productId) || productId <= 0) continue;
      const quantity = Number(row.quantity) || 0;
      products.add(productId);
      if (quantity > 0) stockedProducts.add(productId);
      totalQuantity += quantity;
    }
    res.json({
      warehouse_count: warehouseIds.size,
      product_count: products.size,
      stocked_product_count: stockedProducts.size,
      total_quantity: Number(totalQuantity.toFixed(3))
    });
  });
  app.post('/api/warehouses', (req, res) => {
    if (!isUnrestrictedAccount(req.authUser)) return res.status(403).json({ error: 'إدارة المخازن متاحة لمالك النظام أو حساب admin فقط.' });
    const branchId = Number(req.body?.branch_id || req.branchId);
    const branch = db.data.branches.find(row => Number(row.id) === branchId && row.is_active !== false);
    const name = String(req.body?.name || '').trim().slice(0, 100);
    if (!branch || !name) return res.status(400).json({ error: 'اختر فرعاً نشطاً واكتب اسم المخزن.' });
    if (db.data.warehouses.some(row => Number(row.branch_id) === branchId && row.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return res.status(409).json({ error: 'اسم المخزن موجود بالفعل في هذا الفرع.' });
    const row = { id: db.nextId('warehouses'), branch_id: branchId, name, is_default: false, parent_warehouse_id: Number(req.body?.parent_warehouse_id) || null, is_active: true, created_at: new Date().toISOString() };
    if (row.parent_warehouse_id && !db.data.warehouses.some(parent => Number(parent.id) === row.parent_warehouse_id && Number(parent.branch_id) === branchId)) return res.status(400).json({ error: 'المخزن الرئيسي المحدد لا يتبع الفرع.' });
    db.data.warehouses.push(row); db.save(); db.logAudit(req.authUser.id, 'إضافة مخزن', 'warehouses', row.id, name); res.status(201).json(row);
  });
  app.get('/api/warehouse-inventory', (req, res) => {
    const warehouseId = Number(req.query.warehouse_id);
    const warehouse = db.data.warehouses.find(row => Number(row.id) === warehouseId && Number(row.branch_id) === Number(req.branchId));
    if (!warehouse) return res.status(404).json({ error: 'المخزن غير موجود في هذا الفرع.' });
    const branchWarehouses = db.data.warehouses.filter(row => Number(row.branch_id) === Number(req.branchId) && row.is_active !== false);
    const descendants = new Set([warehouseId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of branchWarehouses) {
        const parentId = Number(candidate.parent_warehouse_id || 0);
        if (parentId && descendants.has(parentId) && !descendants.has(Number(candidate.id))) {
          descendants.add(Number(candidate.id));
          changed = true;
        }
      }
    }
    const totals = new Map();
    for (const row of db.data.warehouse_inventory) {
      if (!descendants.has(Number(row.warehouse_id))) continue;
      const productId = Number(row.product_id);
      const aggregate = totals.get(productId) || { product_id: productId, warehouse_id: warehouseId, branch_id: Number(req.branchId), direct_quantity: 0, quantity: 0, min_stock: 0 };
      aggregate.quantity += Number(row.quantity || 0);
      if (Number(row.warehouse_id) === warehouseId) {
        aggregate.id = row.id;
        aggregate.direct_quantity += Number(row.quantity || 0);
        aggregate.min_stock = Number(row.min_stock || 0);
      }
      totals.set(productId, aggregate);
    }
    res.json([...totals.values()].map(row => ({ ...row, quantity: Number(row.quantity.toFixed(3)), direct_quantity: Number(row.direct_quantity.toFixed(3)), product: db.data.products.find(product => Number(product.id) === row.product_id) || null })));
  });
  app.get('/api/warehouse-history', (req, res) => {
    const warehouseId = Number(req.query.warehouse_id || 0);
    const rows = db.data.warehouse_stock_movements.filter(row => Number(row.branch_id) === Number(req.branchId) && (!warehouseId || Number(row.warehouse_id) === warehouseId)).sort((a, b) => b.id - a.id).slice(0, 500);
    res.json(rows.map(row => ({ ...row, product_name: db.data.products.find(product => Number(product.id) === Number(row.product_id))?.name || 'صنف غير معروف', warehouse_name: db.data.warehouses.find(warehouse => Number(warehouse.id) === Number(row.warehouse_id))?.name || '' })));
  });
  app.get('/api/warehouse-categories', (req, res) => {
    const warehouseId = Number(req.query.warehouse_id);
    if (!db.data.warehouses.some(row => Number(row.id) === warehouseId && Number(row.branch_id) === Number(req.branchId))) return res.status(404).json({ error: 'المخزن غير موجود في هذا الفرع.' });
    res.json(db.data.warehouse_categories.filter(row => Number(row.warehouse_id) === warehouseId && Number(row.branch_id) === Number(req.branchId)));
  });
  app.get('/api/warehouse-products', (req, res) => {
    const warehouseId = Number(req.query.warehouse_id);
    if (!db.data.warehouses.some(row => Number(row.id) === warehouseId && Number(row.branch_id) === Number(req.branchId))) return res.status(404).json({ error: 'المخزن غير موجود في هذا الفرع.' });
    const rows = db.data.warehouse_products.filter(row => {
      if (Number(row.warehouse_id) !== warehouseId || Number(row.branch_id) !== Number(req.branchId)) return false;
      const assignment = db.data.branch_inventory.some(item => Number(item.branch_id) === Number(req.branchId) && Number(item.product_id) === Number(row.product_id));
      if (!assignment) return false;
      if (!row.category_id) return true;
      return db.data.warehouse_categories.some(category => Number(category.id) === Number(row.category_id) && Number(category.warehouse_id) === warehouseId && Number(category.branch_id) === Number(req.branchId));
    });
    res.json(rows.map(row => ({ ...row, product: db.data.products.find(product => Number(product.id) === Number(row.product_id)) || null })));
  });
  app.post('/api/warehouse-categories', (req, res) => {
    if (!isUnrestrictedAccount(req.authUser) && !(req.authUser.permissions || []).includes('add')) return res.status(403).json({ error: 'إضافة فئات المخزن تتطلب صلاحية الإضافة في هذا الفرع.' });
    const warehouseId = Number(req.body?.warehouse_id), name = String(req.body?.name || '').trim().slice(0, 100);
    const warehouse = db.data.warehouses.find(row => Number(row.id) === warehouseId && Number(row.branch_id) === Number(req.branchId));
    if (!warehouse || !name) return res.status(400).json({ error: 'اختر مخزناً واكتب اسم الفئة.' });
    const category = { id: db.nextId('warehouse_categories'), branch_id: Number(req.branchId), warehouse_id: warehouseId, name, created_at: new Date().toISOString() };
    db.data.warehouse_categories.push(category); db.save(); db.logAudit(req.authUser.id, 'إضافة فئة مخزن', 'warehouse_categories', category.id, name); res.status(201).json(category);
  });
  app.post('/api/warehouse-products', (req, res) => {
    if (!isUnrestrictedAccount(req.authUser) && !(req.authUser.permissions || []).includes('add')) return res.status(403).json({ error: 'إضافة أصناف للمخزن تتطلب صلاحية الإضافة في هذا الفرع.' });
    const warehouseId = Number(req.body?.warehouse_id), productId = Number(req.body?.product_id), categoryId = Number(req.body?.category_id) || null;
    const requestedQuantity = Math.max(0, Number(req.body?.quantity) || 0);
    const requestedCost = Math.max(0, Number(req.body?.cost_price) || 0);
    const warehouse = db.data.warehouses.find(row => Number(row.id) === warehouseId && Number(row.branch_id) === Number(req.branchId));
    const product = db.data.products.find(row => Number(row.id) === productId);
    if (!warehouse || !product) return res.status(400).json({ error: 'المخزن أو الصنف غير صالح.' });
    const branchAssignment = db.data.branch_inventory.some(row => Number(row.branch_id) === Number(req.branchId) && Number(row.product_id) === productId);
    if (!branchAssignment) return res.status(400).json({ error: 'الصنف غير مرتبط بهذا الفرع.' });
    if (categoryId && !db.data.warehouse_categories.some(row => Number(row.id) === categoryId && Number(row.warehouse_id) === warehouseId && Number(row.branch_id) === Number(req.branchId))) return res.status(400).json({ error: 'الفئة لا تتبع هذا المخزن والفرع.' });
    let row = db.data.warehouse_products.find(item => Number(item.branch_id) === Number(req.branchId) && Number(item.warehouse_id) === warehouseId && Number(item.product_id) === productId);
    if (!row) { row = { id: db.nextId('warehouse_products'), branch_id: Number(req.branchId), warehouse_id: warehouseId, product_id: productId, category_id: categoryId, created_at: new Date().toISOString() }; db.data.warehouse_products.push(row); }
    else row.category_id = categoryId;
    const inventory = inventoryRow(db, warehouseId, req.branchId, productId, true);
    if (requestedQuantity > 0) {
      const referenceId = `WAREHOUSE-OPENING-${warehouseId}-${productId}-${Date.now()}`;
      inventory.quantity = Number((Number(inventory.quantity || 0) + requestedQuantity).toFixed(3));
      if (requestedCost > 0) product.cost_price = requestedCost;
      const movement = { id: db.nextId('stock_movements'), branch_id: Number(req.branchId), product_id: productId, type: 'adjustment', quantity: requestedQuantity, reference_id: referenceId, created_at: new Date().toISOString() };
      db.data.stock_movements.push(movement);
      db.data.warehouse_stock_movements.push({ id: db.nextId('warehouse_stock_movements'), source_movement_id: movement.id, warehouse_id: warehouseId, branch_id: Number(req.branchId), product_id: productId, type: 'adjustment', quantity: requestedQuantity, reference_id: referenceId, created_at: movement.created_at, imported: false });
    }
    db.save(['warehouse_products', 'warehouse_inventory', 'products', 'stock_movements', 'warehouse_stock_movements', 'audit_logs']); res.status(201).json({ ...row, inventory });
  });
}

module.exports = { registerWarehouseOperations, ensureWarehouseTables, ensureBranchWarehouse, defaultWarehouse, inventoryRow };
