'use strict';

const PROFILE_TYPES = ['printer_invoice', 'printer_report', 'printer_a4', 'cash_drawer', 'scale', 'scanner'];
const CONNECTION_TYPES = ['usb', 'network', 'serial', 'windows_spooler', 'hid', 'mock'];
const MOCK_NAMES = {
  printer_invoice: 'طابعة فواتير تجريبية',
  printer_report: 'طابعة تقارير تجريبية',
  printer_a4: 'طابعة A4 تجريبية',
  cash_drawer: 'درج نقدية تجريبي',
  scale: 'ميزان تجريبي',
  scanner: 'ماسح تجريبي'
};

function branchIds(connection) {
  const rows = connection.prepare("SELECT payload FROM storage_rows WHERE collection='branches'").all();
  const ids = rows.map(row => { try { return Number(JSON.parse(row.payload)?.id); } catch (_) { return 0; } })
    .filter(id => Number.isInteger(id) && id > 0);
  return [...new Set(ids.length ? ids : [1])];
}

function migrateHardwareProfiles(connection) {
  const currentVersion = Number(connection.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (currentVersion >= 11) return;
  connection.exec('BEGIN IMMEDIATE');
  try {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS hardware_profiles (
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
      CREATE INDEX IF NOT EXISTS idx_hardware_profiles_branch ON hardware_profiles(branch_id, is_active);
      CREATE INDEX IF NOT EXISTS idx_hardware_profiles_type ON hardware_profiles(profile_type, is_active);
    `);
    const insert = connection.prepare(`
      INSERT OR IGNORE INTO hardware_profiles
        (branch_id, profile_type, name, connection_type, connection_details, settings, is_default, is_active, is_mock)
      VALUES (?, ?, ?, 'mock', ?, ?, 1, 1, 1)
    `);
    for (const branchId of branchIds(connection)) {
      for (const profileType of PROFILE_TYPES) {
        insert.run(
          branchId,
          profileType,
          MOCK_NAMES[profileType],
          JSON.stringify({ mode: 'mock' }),
          JSON.stringify({ mock: true, auto_open: profileType === 'cash_drawer', paper_width: profileType.startsWith('printer_') ? '80mm' : null })
        );
      }
    }
    connection.exec('PRAGMA user_version=11');
    connection.exec('COMMIT');
    console.log(`[HARDWARE_MIGRATION] user_version=11 profiles=${connection.prepare('SELECT COUNT(*) AS count FROM hardware_profiles').get().count}`);
  } catch (error) {
    try { connection.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }
}

function seedHardwareProfilesForBranch(connection, branchId) {
  const insert = connection.prepare(`
    INSERT OR IGNORE INTO hardware_profiles
      (branch_id, profile_type, name, connection_type, connection_details, settings, is_default, is_active, is_mock)
    VALUES (?, ?, ?, 'mock', ?, ?, 1, 1, 1)
  `);
  for (const profileType of PROFILE_TYPES) insert.run(
    Number(branchId), profileType, MOCK_NAMES[profileType], JSON.stringify({ mode: 'mock' }),
    JSON.stringify({ mock: true, auto_open: profileType === 'cash_drawer', paper_width: profileType.startsWith('printer_') ? '80mm' : null })
  );
  return connection.prepare('SELECT COUNT(*) AS count FROM hardware_profiles WHERE branch_id=?').get(Number(branchId)).count;
}

module.exports = { migrateHardwareProfiles, seedHardwareProfilesForBranch, PROFILE_TYPES, CONNECTION_TYPES };
