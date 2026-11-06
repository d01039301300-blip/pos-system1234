function migrateUserBranches(connection) {
  const currentVersion = Number(connection.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (currentVersion >= 9) return;
  connection.exec('BEGIN IMMEDIATE');
  try {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS user_branches (
        user_id INTEGER NOT NULL,
        branch_id INTEGER NOT NULL,
        access_level TEXT NOT NULL DEFAULT 'write' CHECK (access_level IN ('read','write','none')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, branch_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_branches_branch_access ON user_branches(branch_id, access_level, user_id);
      PRAGMA user_version=9;
    `);
    console.log('[USER_BRANCHES_MIGRATION] user_version=9 table=user_branches');
    connection.exec('COMMIT');
  } catch (error) {
    try { connection.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

module.exports = { migrateUserBranches };
