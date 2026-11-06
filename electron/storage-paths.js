'use strict';

const path = require('node:path');

function resolveElectronStoragePaths({ appDataPath, isPackaged, env = process.env } = {}) {
  if (!appDataPath) throw new TypeError('appDataPath is required');
  // Explicit test isolation must also work in packaged Electron builds. The
  // The production default is kept outside the installation directory.
  const requestedTestPath = String(env.SYSTEM_TEST_USER_DATA_DIR || '').trim();
  const userDataPath = path.resolve(requestedTestPath || path.join(appDataPath, 'SystemPOS'));
  const testIsolation = Boolean(requestedTestPath);
  return {
    userDataPath,
    testIsolation,
    env: {
      RAWDA_DATA_DIR: userDataPath,
      RAWDA_USER_DATA_DIR: userDataPath,
      RAWDA_CONFIG_PATH: path.join(userDataPath, 'config.json'),
      RAWDA_DB_PATH: path.join(userDataPath, 'database.sqlite'),
      RAWDA_CATALOG_PATH: path.join(userDataPath, 'business-catalog.json'),
      RAWDA_LICENSE_FILE: path.join(userDataPath, 'license.json'),
      RAWDA_TRIAL_STATE_PATH: path.join(userDataPath, 'trial-state.json')
    }
  };
}

module.exports = { resolveElectronStoragePaths };
