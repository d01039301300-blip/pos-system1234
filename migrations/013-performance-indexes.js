'use strict';

// Phase 3 performance indexes. JSON collections stay in storage_rows, so the
// equivalent indexes use partial JSON expressions; accounting and wallet data
// use their native tables.
function migratePerformanceIndexes(connection) {
  const currentVersion = Number(connection.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (currentVersion >= 13) return;
  connection.exec('BEGIN IMMEDIATE');
  try {
    connection.exec(`
      CREATE INDEX IF NOT EXISTS idx_perf_sales_created_at
        ON storage_rows(json_extract(payload, '$.created_at')) WHERE collection='sales';
      CREATE INDEX IF NOT EXISTS idx_perf_sales_invoice_number
        ON storage_rows(json_extract(payload, '$.invoice_number')) WHERE collection='sales';
      CREATE INDEX IF NOT EXISTS idx_perf_sales_branch_id
        ON storage_rows(json_extract(payload, '$.branch_id')) WHERE collection='sales';
      CREATE INDEX IF NOT EXISTS idx_perf_sales_customer_id
        ON storage_rows(json_extract(payload, '$.customer_id')) WHERE collection='sales';
      CREATE INDEX IF NOT EXISTS idx_perf_sales_user_id
        ON storage_rows(json_extract(payload, '$.user_id')) WHERE collection='sales';
      CREATE INDEX IF NOT EXISTS idx_perf_sale_items_sale_id
        ON storage_rows(json_extract(payload, '$.sale_id')) WHERE collection='sale_items';
      CREATE INDEX IF NOT EXISTS idx_perf_sale_items_product_id
        ON storage_rows(json_extract(payload, '$.product_id')) WHERE collection='sale_items';
      CREATE INDEX IF NOT EXISTS idx_perf_products_barcode
        ON storage_rows(json_extract(payload, '$.barcode')) WHERE collection='products';
      CREATE INDEX IF NOT EXISTS idx_perf_products_item_number
        ON storage_rows(json_extract(payload, '$.item_number')) WHERE collection='products';
      CREATE INDEX IF NOT EXISTS idx_perf_products_category_id
        ON storage_rows(json_extract(payload, '$.category_id')) WHERE collection='products';
      CREATE INDEX IF NOT EXISTS idx_perf_products_quantity
        ON storage_rows(COALESCE(json_extract(payload, '$.quantity'), json_extract(payload, '$.stock'))) WHERE collection='products';
      CREATE INDEX IF NOT EXISTS idx_perf_audit_logs_created_at
        ON storage_rows(json_extract(payload, '$.created_at')) WHERE collection='audit_logs';
      CREATE INDEX IF NOT EXISTS idx_perf_users_username
        ON storage_rows(json_extract(payload, '$.username')) WHERE collection='users';
      CREATE INDEX IF NOT EXISTS idx_perf_journal_lines_account
        ON journal_lines(account_id, id);
      CREATE INDEX IF NOT EXISTS idx_perf_journal_lines_entry
        ON journal_lines(entry_id, id);
      CREATE INDEX IF NOT EXISTS idx_perf_journal_entries_date
        ON journal_entries(entry_date, id);
      CREATE INDEX IF NOT EXISTS idx_perf_journal_entries_reference
        ON journal_entries(reference_type, reference_id);
      CREATE INDEX IF NOT EXISTS idx_perf_wallet_transactions_wallet_created
        ON wallet_transactions(wallet_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_perf_wallet_transactions_branch
        ON wallet_transactions(branch_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_perf_sms_messages_received_status
        ON sms_messages(received_at, status, id);
      CREATE INDEX IF NOT EXISTS idx_perf_pending_wallet_status_expiry
        ON pending_wallet_payments(status, expires_at, id);
      CREATE INDEX IF NOT EXISTS idx_perf_hardware_profiles_branch_type_active
        ON hardware_profiles(branch_id, profile_type, is_active);
      PRAGMA user_version=13;
    `);
    connection.exec('COMMIT');
    console.log('[PERFORMANCE_MIGRATION] user_version=13 indexes=23');
  } catch (error) {
    try { connection.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

module.exports = { migratePerformanceIndexes };
