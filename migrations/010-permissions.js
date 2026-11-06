'use strict';

const PERMISSION_SEEDS = [
  ['sales.view', 'عرض المبيعات', 'sales'], ['sales.create', 'إنشاء بيع', 'sales'],
  ['sales.delete', 'حذف بيع', 'sales'], ['sales.return', 'مرتجع مبيعات', 'sales'],
  ['sales.discount', 'خصم على البيع', 'sales'], ['sales.edit_price', 'تعديل سعر البيع', 'sales'],
  ['sales.view_profit', 'عرض ربح البيع', 'sales'], ['sales.view_cost', 'عرض تكلفة البيع', 'sales'],
  ['sales.reprint', 'إعادة طباعة البيع', 'sales'],
  ['purchases.view', 'عرض المشتريات', 'purchases'], ['purchases.create', 'إنشاء شراء', 'purchases'],
  ['purchases.delete', 'حذف شراء', 'purchases'], ['purchases.edit_price', 'تعديل سعر الشراء', 'purchases'],
  ['inventory.view', 'عرض المخزون', 'inventory'], ['inventory.create', 'إضافة مخزون', 'inventory'],
  ['inventory.edit', 'تعديل المخزون', 'inventory'], ['inventory.delete', 'حذف مخزون', 'inventory'],
  ['inventory.adjust', 'تسوية المخزون', 'inventory'],
  ['reports.view', 'عرض التقارير', 'reports'], ['reports.profit', 'تقرير الأرباح', 'reports'],
  ['reports.cost', 'تقرير التكلفة', 'reports'], ['reports.export', 'تصدير التقارير', 'reports'],
  ['accounting.view', 'عرض المحاسبة', 'accounting'], ['accounting.journal', 'عرض اليومية', 'accounting'],
  ['accounting.edit', 'تعديل القيود', 'accounting'], ['accounting.reports', 'تقارير المحاسبة', 'accounting'],
  ['accounting.coa', 'دليل الحسابات', 'accounting'],
  ['wallets.view', 'عرض المحافظ', 'wallets'], ['wallets.create', 'إضافة محفظة', 'wallets'],
  ['wallets.edit', 'تعديل محفظة', 'wallets'], ['wallets.transfer', 'تحويل بين المحافظ', 'wallets'],
  ['wallets.view_all_branches', 'عرض محافظ كل الفروع', 'wallets'],
  ['sms.view', 'عرض رسائل SMS', 'sms'], ['sms.devices', 'إدارة أجهزة SMS', 'sms'],
  ['sms.manual_match', 'مطابقة دفع SMS يدوياً', 'sms'],
  ['settings.view', 'عرض الإعدادات', 'settings'], ['settings.edit', 'تعديل الإعدادات', 'settings'],
  ['users.view', 'عرض المستخدمين', 'users'], ['users.create', 'إضافة مستخدم', 'users'],
  ['users.edit', 'تعديل مستخدم', 'users'], ['users.delete', 'تعطيل مستخدم', 'users'],
  ['users.manage_permissions', 'إدارة صلاحيات المستخدمين', 'users'],
  ['branches.view', 'عرض الفروع', 'branches'], ['branches.create', 'إضافة فرع', 'branches'],
  ['branches.edit', 'تعديل فرع', 'branches'], ['branches.switch', 'تبديل الفرع', 'branches'],
  ['branches.view_all', 'عرض كل الفروع', 'branches'],
  ['backup.create', 'إنشاء نسخة احتياطية', 'backup'], ['backup.restore', 'استعادة نسخة احتياطية', 'backup'],
  ['pos.open_shift', 'فتح وردية', 'pos'], ['pos.close_shift', 'إغلاق وردية', 'pos'],
  ['pos.void_sale', 'إلغاء بيع', 'pos']
];

const OWNER = new Set(PERMISSION_SEEDS.map(([code]) => code));
const MANAGER_EXCLUDED = new Set(['users.manage_permissions', 'backup.restore', 'settings.edit', 'branches.create']);
const CASHIER = new Set(['sales.view', 'sales.create', 'sales.return', 'pos.open_shift', 'pos.close_shift']);
const ACCOUNTANT = new Set([
  'reports.view', 'reports.profit', 'reports.cost', 'reports.export',
  'accounting.view', 'accounting.journal', 'accounting.reports',
  'wallets.view', 'wallets.view_all_branches', 'branches.view', 'branches.view_all'
]);

function migratePermissions(connection) {
  const currentVersion = Number(connection.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (currentVersion >= 10) return;
  connection.exec('BEGIN IMMEDIATE');
  try {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS permissions (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name_ar TEXT NOT NULL,
        category TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_permissions (
        user_id INTEGER NOT NULL,
        permission_id INTEGER NOT NULL,
        granted INTEGER NOT NULL DEFAULT 0 CHECK (granted IN (0,1)),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, permission_id),
        FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS role_defaults (
        role TEXT NOT NULL,
        permission_id INTEGER NOT NULL,
        granted INTEGER NOT NULL DEFAULT 0 CHECK (granted IN (0,1)),
        PRIMARY KEY (role, permission_id),
        FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS permission_constraints (
        user_id INTEGER PRIMARY KEY,
        max_discount_percent REAL NOT NULL DEFAULT 100,
        max_invoice_amount REAL NOT NULL DEFAULT 0,
        can_delete_invoice INTEGER NOT NULL DEFAULT 0 CHECK (can_delete_invoice IN (0,1)),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id);
      CREATE INDEX IF NOT EXISTS idx_role_defaults_role ON role_defaults(role);
    `);
    const addPermission = connection.prepare('INSERT OR IGNORE INTO permissions(code,name_ar,category) VALUES (?,?,?)');
    for (const [code, nameAr, category] of PERMISSION_SEEDS) addPermission.run(code, nameAr, category);
    const permissionId = connection.prepare('SELECT id FROM permissions WHERE code=?');
    const addRole = connection.prepare('INSERT OR IGNORE INTO role_defaults(role,permission_id,granted) VALUES (?,?,?)');
    for (const role of ['owner', 'manager', 'cashier', 'accountant']) {
      for (const [code] of PERMISSION_SEEDS) {
        const id = permissionId.get(code)?.id;
        const granted = role === 'owner' || (role === 'manager' && !MANAGER_EXCLUDED.has(code))
          || (role === 'cashier' && CASHIER.has(code)) || (role === 'accountant' && ACCOUNTANT.has(code));
        addRole.run(role, id, granted ? 1 : 0);
      }
    }
    connection.exec('PRAGMA user_version=10');
    console.log(`[PERMISSIONS_MIGRATION] user_version=10 permissions=${PERMISSION_SEEDS.length} roles=4`);
    connection.exec('COMMIT');
  } catch (error) {
    try { connection.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

module.exports = { migratePermissions, PERMISSION_SEEDS };
