'use strict';

function migrateSms(connection) {
  const currentVersion = Number(connection.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (currentVersion >= 8) return;
  connection.exec('BEGIN IMMEDIATE');
  try {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS sms_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_id INTEGER NOT NULL REFERENCES wallets(id),
        device_token TEXT NOT NULL UNIQUE,
        device_name TEXT NOT NULL DEFAULT '',
        last_seen_at TEXT,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sms_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_token TEXT NOT NULL,
        sender TEXT NOT NULL DEFAULT '',
        raw_text TEXT NOT NULL DEFAULT '',
        received_at TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT 'unknown' CHECK (direction IN ('in','out','unknown')),
        parsed_amount REAL,
        parsed_phone TEXT,
        parsed_txn_id TEXT,
        status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','matched','mismatched','manual','ignored')),
        matched_sale_id INTEGER,
        matched_wallet_id INTEGER REFERENCES wallets(id),
        message_hash TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        UNIQUE(device_token, message_hash)
      );

      CREATE TABLE IF NOT EXISTS pending_wallet_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL UNIQUE,
        wallet_id INTEGER NOT NULL REFERENCES wallets(id),
        expected_amount REAL NOT NULL CHECK (expected_amount > 0),
        status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','matched','mismatched','expired','manual')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT NOT NULL,
        matched_sms_id INTEGER REFERENCES sms_messages(id),
        notes TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_sms_devices_wallet_active ON sms_devices(wallet_id, is_active);
      CREATE INDEX IF NOT EXISTS idx_sms_messages_status_received ON sms_messages(status, received_at, id);
      CREATE INDEX IF NOT EXISTS idx_sms_messages_device_received ON sms_messages(device_token, received_at, id);
      CREATE INDEX IF NOT EXISTS idx_sms_messages_wallet_status ON sms_messages(matched_wallet_id, status, received_at);
      CREATE INDEX IF NOT EXISTS idx_pending_wallet_status_expiry ON pending_wallet_payments(wallet_id, status, expires_at);
      PRAGMA user_version=8;
    `);
    connection.exec('COMMIT');
    console.log('[SMS_MIGRATION] user_version=8 tables=sms_devices,sms_messages,pending_wallet_payments');
  } catch (error) {
    try { connection.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

module.exports = { migrateSms };
