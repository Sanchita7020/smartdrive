// firebase-admin v14 uses modular sub-package imports
const { cert, initializeApp, getApps, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const path = require('path');
const fs = require('fs');

const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'serviceAccountKey.json');
let isConfigured = false;
let db = null;
let fireAuth = null;

async function initFirebase(customKeyObj = null) {
  try {
    let serviceAccount = customKeyObj;

    // Fall back to saved key on disk
    if (!serviceAccount && fs.existsSync(SERVICE_ACCOUNT_PATH)) {
      serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
    }

    if (!serviceAccount || !serviceAccount.project_id || !serviceAccount.private_key) {
      // No key available — skip silently
      return false;
    }

    // Delete any existing app instances before re-initializing
    const existingApps = getApps();
    for (const app of existingApps) {
      await deleteApp(app);
    }

    const app = initializeApp({
      credential: cert(serviceAccount)
    });

    db = getFirestore(app);
    fireAuth = getAuth(app);
    isConfigured = true;
    console.log('[Firebase]: Successfully initialized for project:', serviceAccount.project_id);
    return true;
  } catch (err) {
    console.error('[Firebase]: Error initializing service account:', err.message);
    isConfigured = false;
    db = null;
    fireAuth = null;
    return false;
  }
}

// Try to auto-init from saved key on startup
initFirebase();

module.exports = {
  getDb: () => db,
  getAuth: () => fireAuth,
  isConfigured: () => isConfigured,
  initFirebase
};
