'use strict';

const ACCOUNT_SEED = [
  { code: '1000', name_ar: 'الأصول', name_en: 'Assets', type: 'asset', level: 1, is_postable: 0 },
  { code: '1100', name_ar: 'النقدية', name_en: 'Cash and cash equivalents', type: 'asset', parent_code: '1000', level: 2, is_postable: 0 },
  { code: '1110', name_ar: 'الصندوق', name_en: 'Cash on hand', type: 'asset', parent_code: '1100', level: 3, is_postable: 1 },
  { code: '1120', name_ar: 'البنك', name_en: 'Bank', type: 'asset', parent_code: '1100', level: 3, is_postable: 1 },
  { code: '1200', name_ar: 'العملاء', name_en: 'Accounts receivable', type: 'asset', parent_code: '1000', level: 2, is_postable: 1 },
  { code: '1300', name_ar: 'المخزون', name_en: 'Inventory', type: 'asset', parent_code: '1000', level: 2, is_postable: 1 },
  { code: '2000', name_ar: 'الالتزامات', name_en: 'Liabilities', type: 'liability', level: 1, is_postable: 0 },
  { code: '2100', name_ar: 'الموردون', name_en: 'Accounts payable', type: 'liability', parent_code: '2000', level: 2, is_postable: 1 },
  { code: '2200', name_ar: 'ضريبة القيمة المضافة المستحقة', name_en: 'VAT payable', type: 'liability', parent_code: '2000', level: 2, is_postable: 1 },
  { code: '3000', name_ar: 'حقوق الملكية', name_en: 'Equity', type: 'equity', level: 1, is_postable: 0 },
  { code: '3100', name_ar: 'رأس المال', name_en: 'Capital', type: 'equity', parent_code: '3000', level: 2, is_postable: 1 },
  { code: '3200', name_ar: 'الأرباح المحتجزة', name_en: 'Retained earnings', type: 'equity', parent_code: '3000', level: 2, is_postable: 1 },
  { code: '4000', name_ar: 'الإيرادات', name_en: 'Revenue', type: 'revenue', level: 1, is_postable: 0 },
  { code: '4100', name_ar: 'إيرادات المبيعات', name_en: 'Sales revenue', type: 'revenue', parent_code: '4000', level: 2, is_postable: 1 },
  { code: '4900', name_ar: 'إيرادات أخرى', name_en: 'Other income', type: 'revenue', parent_code: '4000', level: 2, is_postable: 1 },
  { code: '5000', name_ar: 'المصروفات', name_en: 'Expenses', type: 'expense', level: 1, is_postable: 0 },
  { code: '5100', name_ar: 'تكلفة المبيعات', name_en: 'Cost of sales', type: 'expense', parent_code: '5000', level: 2, is_postable: 1 },
  { code: '5200', name_ar: 'الرواتب', name_en: 'Salaries', type: 'expense', parent_code: '5000', level: 2, is_postable: 1 },
  { code: '5300', name_ar: 'الإيجار', name_en: 'Rent', type: 'expense', parent_code: '5000', level: 2, is_postable: 1 },
  { code: '5400', name_ar: 'الكهرباء والمياه', name_en: 'Utilities', type: 'expense', parent_code: '5000', level: 2, is_postable: 1 },
  { code: '5900', name_ar: 'مصروفات متنوعة', name_en: 'Miscellaneous expenses', type: 'expense', parent_code: '5000', level: 2, is_postable: 1 }
];

function migrateAccounting(connection) {
  connection.exec('BEGIN IMMEDIATE');
  try {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name_ar TEXT NOT NULL,
        name_en TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
        parent_id INTEGER REFERENCES accounts(id),
        level INTEGER NOT NULL DEFAULT 1,
        is_postable INTEGER NOT NULL DEFAULT 1 CHECK (is_postable IN (0,1)),
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS accounting_counters (
        counter_key TEXT PRIMARY KEY,
        current_value INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS journal_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_number TEXT NOT NULL UNIQUE,
        entry_date TEXT NOT NULL,
        description TEXT NOT NULL,
        reference_type TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        branch_id INTEGER,
        created_by INTEGER,
        is_posted INTEGER NOT NULL DEFAULT 0 CHECK (is_posted IN (0,1)),
        created_at TEXT NOT NULL,
        UNIQUE(reference_type, reference_id)
      );
      CREATE TABLE IF NOT EXISTS journal_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        debit REAL NOT NULL DEFAULT 0 CHECK (debit >= 0),
        credit REAL NOT NULL DEFAULT 0 CHECK (credit >= 0),
        description TEXT NOT NULL DEFAULT '',
        party_type TEXT,
        party_id INTEGER,
        CHECK (NOT (debit > 0 AND credit > 0)),
        CHECK (debit > 0 OR credit > 0)
      );
      CREATE INDEX IF NOT EXISTS idx_journal_entries_date ON journal_entries(entry_date, id);
      CREATE INDEX IF NOT EXISTS idx_journal_entries_reference ON journal_entries(reference_type, reference_id);
      CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry_id);
      CREATE INDEX IF NOT EXISTS idx_journal_lines_account ON journal_lines(account_id, id);
      CREATE INDEX IF NOT EXISTS idx_journal_lines_party ON journal_lines(party_type, party_id, id);
    `);

    const insertAccount = connection.prepare(`
      INSERT INTO accounts(code, name_ar, name_en, type, level, is_postable, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(code) DO NOTHING
    `);
    for (const account of ACCOUNT_SEED) {
      insertAccount.run(account.code, account.name_ar, account.name_en, account.type, account.level, account.is_postable);
    }
    const updateParent = connection.prepare(`
      UPDATE accounts
      SET parent_id = (SELECT id FROM accounts WHERE code = ?), updated_at = CURRENT_TIMESTAMP
      WHERE code = ?
    `);
    for (const account of ACCOUNT_SEED) {
      if (account.parent_code) updateParent.run(account.parent_code, account.code);
    }
    connection.prepare(`
      INSERT INTO accounting_counters(counter_key, current_value)
      VALUES ('journal_entry', 0)
      ON CONFLICT(counter_key) DO NOTHING
    `).run();
    const currentVersion = Number(connection.prepare('PRAGMA user_version').get()?.user_version || 0);
    if (currentVersion < 6) connection.exec('PRAGMA user_version=6');
    connection.exec('COMMIT');
    console.log(`[ACCOUNTING_MIGRATION] user_version=6 accounts=${ACCOUNT_SEED.length}`);
  } catch (error) {
    try { connection.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

module.exports = { ACCOUNT_SEED, migrateAccounting };
