-- System POS v4.16.0 SQLite schema (generated from clean database)
PRAGMA foreign_keys=ON;

CREATE TABLE accounting_counters (
        counter_key TEXT PRIMARY KEY,
        current_value INTEGER NOT NULL DEFAULT 0
      );

CREATE TABLE accounts (
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

CREATE TABLE hardware_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        branch_id INTEGER NOT NULL,
        profile_type TEXT NOT NULL CHECK (profile_type IN ('printer_invoice','printer_report','printer_a4','cash_drawer','scale','scanner')),
        name TEXT NOT NULL,
        connection_type TEXT NOT NULL CHECK (connection_type IN ('usb','network','serial','windows_spooler','hid','mock')),
        connection_details TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(connection_details)),
        settings TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings)),
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
        is_mock INTEGER NOT NULL DEFAULT 0 CHECK (is_mock IN (0,1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(branch_id, profile_type, name)
      );

CREATE TABLE journal_entries (
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

CREATE TABLE journal_lines (
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

CREATE TABLE pending_wallet_payments (
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

CREATE TABLE permission_constraints (
        user_id INTEGER PRIMARY KEY,
        max_discount_percent REAL NOT NULL DEFAULT 100,
        max_invoice_amount REAL NOT NULL DEFAULT 0,
        can_delete_invoice INTEGER NOT NULL DEFAULT 0 CHECK (can_delete_invoice IN (0,1)),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE permissions (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name_ar TEXT NOT NULL,
        category TEXT NOT NULL
      );

CREATE TABLE role_defaults (
        role TEXT NOT NULL,
        permission_id INTEGER NOT NULL,
        granted INTEGER NOT NULL DEFAULT 0 CHECK (granted IN (0,1)),
        PRIMARY KEY (role, permission_id),
        FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
      );

CREATE TABLE sms_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_id INTEGER NOT NULL REFERENCES wallets(id),
        device_token TEXT NOT NULL UNIQUE,
        device_name TEXT NOT NULL DEFAULT '',
        last_seen_at TEXT,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

CREATE TABLE sms_messages (
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

CREATE TABLE sqlite_sequence(name,seq);

CREATE TABLE storage_collections (name TEXT PRIMARY KEY) WITHOUT ROWID;

CREATE TABLE storage_meta (
          key TEXT PRIMARY KEY,
          payload TEXT NOT NULL CHECK (json_valid(payload))
        ) WITHOUT ROWID;

CREATE TABLE storage_rows (
          collection TEXT NOT NULL,
          row_key TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          payload TEXT NOT NULL CHECK (json_valid(payload)),
          PRIMARY KEY (collection, row_key)
        ) WITHOUT ROWID;

CREATE TABLE storage_values (
          key TEXT PRIMARY KEY,
          payload TEXT NOT NULL CHECK (json_valid(payload))
        ) WITHOUT ROWID;

CREATE TABLE user_branches (
        user_id INTEGER NOT NULL,
        branch_id INTEGER NOT NULL,
        access_level TEXT NOT NULL DEFAULT 'write' CHECK (access_level IN ('read','write','none')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, branch_id)
      );

CREATE TABLE user_permissions (
        user_id INTEGER NOT NULL,
        permission_id INTEGER NOT NULL,
        granted INTEGER NOT NULL DEFAULT 0 CHECK (granted IN (0,1)),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, permission_id),
        FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
      );

CREATE TABLE wallet_alerts (
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

CREATE TABLE wallet_transactions (
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

CREATE TABLE wallets (
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

CREATE INDEX idx_hardware_profiles_branch ON hardware_profiles(branch_id, is_active);

CREATE INDEX idx_hardware_profiles_type ON hardware_profiles(profile_type, is_active);

CREATE INDEX idx_journal_entries_date ON journal_entries(entry_date, id);

CREATE INDEX idx_journal_entries_reference ON journal_entries(reference_type, reference_id);

CREATE INDEX idx_journal_lines_account ON journal_lines(account_id, id);

CREATE INDEX idx_journal_lines_entry ON journal_lines(entry_id);

CREATE INDEX idx_journal_lines_party ON journal_lines(party_type, party_id, id);

CREATE INDEX idx_pending_wallet_status_expiry ON pending_wallet_payments(wallet_id, status, expires_at);

CREATE INDEX idx_perf_audit_logs_created_at
        ON storage_rows(json_extract(payload, '$.created_at')) WHERE collection='audit_logs';

CREATE INDEX idx_perf_hardware_profiles_branch_type_active
        ON hardware_profiles(branch_id, profile_type, is_active);

CREATE INDEX idx_perf_journal_entries_date
        ON journal_entries(entry_date, id);

CREATE INDEX idx_perf_journal_entries_reference
        ON journal_entries(reference_type, reference_id);

CREATE INDEX idx_perf_journal_lines_account
        ON journal_lines(account_id, id);

CREATE INDEX idx_perf_journal_lines_entry
        ON journal_lines(entry_id, id);

CREATE INDEX idx_perf_pending_wallet_status_expiry
        ON pending_wallet_payments(status, expires_at, id);

CREATE INDEX idx_perf_products_barcode
        ON storage_rows(json_extract(payload, '$.barcode')) WHERE collection='products';

CREATE INDEX idx_perf_products_category_id
        ON storage_rows(json_extract(payload, '$.category_id')) WHERE collection='products';

CREATE INDEX idx_perf_products_item_number
        ON storage_rows(json_extract(payload, '$.item_number')) WHERE collection='products';

CREATE INDEX idx_perf_products_quantity
        ON storage_rows(COALESCE(json_extract(payload, '$.quantity'), json_extract(payload, '$.stock'))) WHERE collection='products';

CREATE INDEX idx_perf_sale_items_product_id
        ON storage_rows(json_extract(payload, '$.product_id')) WHERE collection='sale_items';

CREATE INDEX idx_perf_sale_items_sale_id
        ON storage_rows(json_extract(payload, '$.sale_id')) WHERE collection='sale_items';

CREATE INDEX idx_perf_sales_branch_id
        ON storage_rows(json_extract(payload, '$.branch_id')) WHERE collection='sales';

CREATE INDEX idx_perf_sales_created_at
        ON storage_rows(json_extract(payload, '$.created_at')) WHERE collection='sales';

CREATE INDEX idx_perf_sales_customer_id
        ON storage_rows(json_extract(payload, '$.customer_id')) WHERE collection='sales';

CREATE INDEX idx_perf_sales_invoice_number
        ON storage_rows(json_extract(payload, '$.invoice_number')) WHERE collection='sales';

CREATE INDEX idx_perf_sales_user_id
        ON storage_rows(json_extract(payload, '$.user_id')) WHERE collection='sales';

CREATE INDEX idx_perf_sms_messages_received_status
        ON sms_messages(received_at, status, id);

CREATE INDEX idx_perf_users_username
        ON storage_rows(json_extract(payload, '$.username')) WHERE collection='users';

CREATE INDEX idx_perf_wallet_transactions_branch
        ON wallet_transactions(branch_id, created_at, id);

CREATE INDEX idx_perf_wallet_transactions_wallet_created
        ON wallet_transactions(wallet_id, created_at, id);

CREATE INDEX idx_products_barcode
            ON storage_rows(json_extract(payload, '$.barcode')) WHERE collection='products';

CREATE INDEX idx_products_name
            ON storage_rows(json_extract(payload, '$.name')) WHERE collection='products';

CREATE INDEX idx_products_stock_category
            ON storage_rows(COALESCE(json_extract(payload, '$.quantity'), json_extract(payload, '$.stock')), json_extract(payload, '$.category_id'))
            WHERE collection='products';

CREATE INDEX idx_role_defaults_role ON role_defaults(role);

CREATE INDEX idx_sms_devices_wallet_active ON sms_devices(wallet_id, is_active);

CREATE INDEX idx_sms_messages_device_received ON sms_messages(device_token, received_at, id);

CREATE INDEX idx_sms_messages_status_received ON sms_messages(status, received_at, id);

CREATE INDEX idx_sms_messages_wallet_status ON sms_messages(matched_wallet_id, status, received_at);

CREATE INDEX idx_storage_audit_created_at
            ON storage_rows(json_extract(payload, '$.created_at')) WHERE collection='audit_logs';

CREATE INDEX idx_storage_employee_transactions_created
            ON storage_rows(json_extract(payload, '$.created_at'))
            WHERE collection='employee_transactions';

CREATE INDEX idx_storage_employee_transactions_employee
            ON storage_rows(json_extract(payload, '$.employee_id'))
            WHERE collection='employee_transactions';

CREATE INDEX idx_storage_products_barcode
            ON storage_rows(json_extract(payload, '$.barcode')) WHERE collection='products';

CREATE INDEX idx_storage_products_item_number
            ON storage_rows(json_extract(payload, '$.item_number')) WHERE collection='products';

CREATE INDEX idx_storage_rider_transactions_created
            ON storage_rows(json_extract(payload, '$.created_at'))
            WHERE collection='delivery_rider_transactions';

CREATE INDEX idx_storage_rider_transactions_rider
            ON storage_rows(json_extract(payload, '$.rider_id'))
            WHERE collection='delivery_rider_transactions';

CREATE INDEX idx_storage_sales_created_at
            ON storage_rows(json_extract(payload, '$.created_at')) WHERE collection='sales';

CREATE INDEX idx_storage_sales_invoice_number
            ON storage_rows(json_extract(payload, '$.invoice_number')) WHERE collection='sales';

CREATE INDEX idx_storage_users_username
            ON storage_rows(json_extract(payload, '$.username')) WHERE collection='users';

CREATE INDEX idx_user_branches_branch_access ON user_branches(branch_id, access_level, user_id);

CREATE INDEX idx_user_permissions_user ON user_permissions(user_id);

CREATE INDEX idx_wallet_alerts_branch_unresolved ON wallet_alerts(branch_id, is_resolved, created_at);

CREATE INDEX idx_wallet_alerts_wallet_period ON wallet_alerts(wallet_id, period, threshold_type);

CREATE INDEX idx_wallet_transactions_branch_date ON wallet_transactions(branch_id, created_at, id);

CREATE INDEX idx_wallet_transactions_reference ON wallet_transactions(reference_id, type);

CREATE INDEX idx_wallet_transactions_wallet_date ON wallet_transactions(wallet_id, created_at, id);

CREATE INDEX idx_wallets_branch_active ON wallets(branch_id, is_active);
