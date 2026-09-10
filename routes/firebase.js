const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { isConfigured, initFirebase } = require('../config/firebase');

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'firebaseConfig.json');
const SERVICE_ACCOUNT_FILE = path.join(__dirname, '..', 'config', 'serviceAccountKey.json');

router.get('/config', (req, res) => {
  let clientConfig = null;
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      clientConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {}
  }

  res.json({
    backendConfigured: isConfigured(),
    clientConfig
  });
});

router.post('/config', (req, res) => {
  try {
    let config = req.body;
    if (typeof config === 'string') {
      try { config = JSON.parse(config); } catch (e) {}
    }
    if (!config || !config.apiKey || !config.projectId) {
      return res.status(400).json({ error: 'Valid Firebase config object with apiKey and projectId is required' });
    }

    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    res.json({
      message: 'Firebase client config saved successfully',
      config
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/service-account', async (req, res) => {
  try {
    let keyData = req.body;

    // Accept raw string body
    if (typeof keyData === 'string') {
      try { keyData = JSON.parse(keyData); } catch (e) {
        return res.status(400).json({ error: 'Could not parse JSON. Make sure you paste valid JSON from the downloaded serviceAccountKey.json file.' });
      }
    }

    // Validate required fields
    if (!keyData || typeof keyData !== 'object') {
      return res.status(400).json({ error: 'No data received. Please upload or paste the service account JSON.' });
    }
    if (!keyData.project_id) {
      return res.status(400).json({ error: 'Missing "project_id" field. Make sure you downloaded the correct Service Account key from Firebase.' });
    }
    if (!keyData.private_key) {
      return res.status(400).json({ error: 'Missing "private_key" field. This file may be incomplete or corrupted.' });
    }

    // Save key to disk
    fs.writeFileSync(SERVICE_ACCOUNT_FILE, JSON.stringify(keyData, null, 2), 'utf8');

    // Re-initialize firebase-admin with new key
    const success = await initFirebase(keyData);

    if (!success) {
      return res.status(500).json({ error: 'Firebase Admin SDK rejected the key. Check that this project has Firestore enabled and the key is not expired.' });
    }

    res.json({
      message: 'Backend Firebase Service Account activated successfully',
      project_id: keyData.project_id
    });
  } catch (err) {
    console.error('[firebase route] service-account error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
