'use strict';

const COLLECTION_TO_TABLE = Object.freeze({
  branches: 'branches',
  categories: 'categories',
  users: 'users',
  customers: 'customers',
  suppliers: 'suppliers',
  warehouses: 'warehouses',
  cashier_shifts: 'shifts',
  employees: 'employees',
  attendance: 'attendance',
  delivery_riders: 'delivery_riders',
  products: 'products',
  warehouse_products: 'warehouse_products',
  // 7-G.1-fix: 4 collections removed from sync scope — no proper PG
  // target table exists (only stub via pg-create-target-tables.js).
  // Deferred to a future task with real table schema.
  sales: 'sales',
  sale_items: 'sale_items',
  purchases: 'purchases',
  purchase_items: 'purchase_items',
  purchase_orders: 'purchase_orders',
  purchase_order_items: 'purchase_order_items',
  cash_transactions: 'cash_transactions',
  stock_movements: 'stock_movements',
  service_orders: 'service_orders',
  delivery_assignments: 'delivery_assignments',
  delivery_rider_transactions: 'delivery_rider_transactions',
  delivery_settlements: 'delivery_settlements',
  employee_transactions: 'employee_transactions',
  installment_contracts: 'installments',
  loyalty_transactions: 'loyalty_transactions',
  promotions: 'promotions',
  sale_returns: 'sale_returns',
  self_order_requests: 'self_order_requests',
  supplier_transactions: 'supplier_transactions',
  suspended_sales: 'suspended_sales',
  waste_records: 'inventory_waste',
  cash_audit_chain: 'cash_audit_chain',
  audit_logs: 'audit_logs',
  customer_transactions: 'customer_transactions',
  ai_insights: 'ai_insights'
});

const PRIMARY_KEY = Object.freeze({
  // الافتراضي: ['id'] لكل الجداول ما لم يُذكر خلاف ذلك
  // استثناءات معروفة:
  settings: ['key'],
  migration_log: ['collection']
});

const SOURCE_IDENTITY = Object.freeze({
  // عمود يُستخدم كـrow_key في pg_sync_queue (الافتراضي: 'id')
  // استثناءات:
  settings: 'key'
});

const SYNC_EXCLUDED_COLLECTIONS = Object.freeze([
  'business_catalog',
  // أضف هنا أي collection تعرف أنها كبيرة/غير صفية
]);

const SYNC_EXCLUDED_STATEMENTS = Object.freeze([
  'updateOrdinal',
  'addCollection',
  'deleteCollection'
]);

module.exports = {
  COLLECTION_TO_TABLE,
  PRIMARY_KEY,
  SOURCE_IDENTITY,
  SYNC_EXCLUDED_COLLECTIONS,
  SYNC_EXCLUDED_STATEMENTS,
  DEFAULT_PRIMARY_KEY: ['id'],
  DEFAULT_SOURCE_IDENTITY: 'id'
};
