'use strict';

function migrateWeightedProducts(connection) {
  const currentVersion = Number(connection.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (currentVersion >= 12) return;
  connection.exec('BEGIN IMMEDIATE');
  try {
    const rows = connection.prepare("SELECT collection, row_key, payload FROM storage_rows WHERE collection='products'").all();
    const update = connection.prepare('UPDATE storage_rows SET payload=? WHERE collection=? AND row_key=?');
    for (const row of rows) {
      let product;
      try { product = JSON.parse(row.payload); } catch (_) { continue; }
      if (!Object.prototype.hasOwnProperty.call(product, 'is_weighted')) {
        product.is_weighted = 0;
        update.run(JSON.stringify(product), row.collection, row.row_key);
      }
    }
    connection.exec('PRAGMA user_version=12');
    connection.exec('COMMIT');
    console.log(`[WEIGHTED_PRODUCTS_MIGRATION] user_version=12 products=${rows.length}`);
  } catch (error) {
    try { connection.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

module.exports = { migrateWeightedProducts };
