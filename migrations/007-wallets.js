'use strict';

const WALLET_ACCOUNT = {
  code: '1130',
  name_ar: 'المحافظ الإلكترونية',
  name_en: 'E-Wallets',
  type: 'asset',
  parent_code: '1100',
  level: 3,
  is_postable: 0
};

function migrateWallets(connection) {
  const currentVersion = Number(connection.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (currentVersion >= 7) return;
  connection.exec('BEGIN IMMEDIATE');
  try {
    const parent = connection.prepare('SELECT id FROM accounts WHERE code=?').get(WALLET_ACCOUNT.parent_code);
    if (!parent) throw new Error('الحساب الأب 1100 غير موجود قبل Migration 007.');
    connection.prepare(`
      INSERT INTO accounts(code, name_ar, name_en, type, parent_id, level, is_postable, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(code) DO UPDATE SET
        name_ar=excluded.name_ar,
        name_en=excluded.name_en,
        type=excluded.type,
        parent_id=excluded.parent_id,
        level=excluded.level,
        is_postable=excluded.is_postable,
        is_active=1,
        updated_at=CURRENT_TIMESTAMP
    `).run(WALLET_ACCOUNT.code, WALLET_ACCOUNT.name_ar, WALLET_ACCOUNT.name_en, WALLET_ACCOUNT.type, parent.id, WALLET_ACCOUNT.level, WALLET_ACCOUNT.is_postable);

    connection.exec(`
      CREATE TABLE IF NOT EXISTS wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        wallet_number TEXT NOT NULL,
        wallet_type TEXT NOT NULL CHECK (wallet_type IN ('vodafone','instapay','bank','other')),
        branch_id INTEGER NOT NULL,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        balance REAL NOT NULL DEFAULT 0 CHECK (balance >= 0),
        deposit_limit REAL NOT NULL CHECK (deposit_limit > 0),
        withdraw_limit REAL NOT NULL CHECK (withdraw_limit > 0),
        fee_percent REAL NOT NULL DEFAULT 0 CHECK (fee_percent >= 0 AND fee_percent <= 100),
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
        alert_threshold_warning REAL NOT NULL DEFAULT 0.80 CHECK (alert_threshold_warning > 0 AND alert_threshold_warning <= 1),
        alert_threshold_critical REAL NOT NULL DEFAULT 0.95 CHECK (alert_threshold_critical > 0 AND alert_threshold_critical <= 1),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(branch_id, wallet_number),
        UNIQUE(account_id)
      );
      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_id INTEGER NOT NULL REFERENCES wallets(id),
        branch_id INTEGER NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('deposit','withdraw','transfer_in','transfer_out','sale')),
        amount REAL NOT NULL CHECK (amount > 0),
        fee REAL NOT NULL DEFAULT 0 CHECK (fee >= 0),
        reference_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        user_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        notes TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS wallet_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_id INTEGER NOT NULL REFERENCES wallets(id),
        branch_id INTEGER NOT NULL,
        threshold_type TEXT NOT NULL CHECK (threshold_type IN ('warning','critical','full')),
        consumed_percent REAL NOT NULL CHECK (consumed_percent >= 0),
        period TEXT NOT NULL,
        notified_users TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(notified_users)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        is_resolved INTEGER NOT NULL DEFAULT 0 CHECK (is_resolved IN (0,1)),
        UNIQUE(wallet_id, threshold_type, period)
      );
      CREATE INDEX IF NOT EXISTS idx_wallets_branch_active ON wallets(branch_id, is_active);
      CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_date ON wallet_transactions(wallet_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_wallet_transactions_branch_date ON wallet_transactions(branch_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_wallet_transactions_reference ON wallet_transactions(reference_id, type);
      CREATE INDEX IF NOT EXISTS idx_wallet_alerts_branch_unresolved ON wallet_alerts(branch_id, is_resolved, created_at);
      CREATE INDEX IF NOT EXISTS idx_wallet_alerts_wallet_period ON wallet_alerts(wallet_id, period, threshold_type);
      PRAGMA user_version=7;
    `);
    connection.exec('COMMIT');
    console.log('[WALLET_MIGRATION] user_version=7 tables=wallets,wallet_transactions,wallet_alerts account=1130');
  } catch (error) {
    try { connection.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

module.exports = { migrateWallets, WALLET_ACCOUNT };
