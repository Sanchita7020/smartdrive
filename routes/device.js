const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const STORAGE_ROOT = path.join(__dirname, '..', 'hub_storage');

// Calculate actual file size in hub_storage
function calculateHubStorageUsage(dir) {
  let totalBytes = 0;
  let fileCount = 0;

  function traverse(current) {
    if (!fs.existsSync(current)) return;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          traverse(fullPath);
        } else if (entry.isFile()) {
          const stat = fs.statSync(fullPath);
          totalBytes += stat.size;
          fileCount++;
        }
      } catch (e) {
        console.error('Error reading file stat:', e);
      }
    }
  }

  traverse(dir);
  return { totalBytes, fileCount };
}

// Real network interface detector
function getRealNetwork() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return `${name} (${net.address})`;
      }
    }
  }
  return 'Local Network (127.0.0.1)';
}

// Real USB drive detection on Windows
let cachedUsb = null;
let lastUsbCheck = 0;

function getUsbDriveInfo() {
  const now = Date.now();
  if (cachedUsb && (now - lastUsbCheck < 10000)) {
    return cachedUsb;
  }
  try {
    const psCmd = "Get-CimInstance Win32_DiskDrive | Where-Object { $_.InterfaceType -eq 'USB' } | Select-Object -ExpandProperty Model";
    const out = execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${psCmd}"`, {
      timeout: 2500,
      encoding: 'utf8'
    }).trim();

    if (out) {
      cachedUsb = `USB Storage (${out})`;
    } else {
      cachedUsb = `Host Storage (USB 3.20 Controller Ready)`;
    }
  } catch (e) {
    cachedUsb = `Host Storage (Drive ${path.parse(STORAGE_ROOT).root})`;
  }
  lastUsbCheck = now;
  return cachedUsb;
}

router.get('/status', (req, res) => {
  const { totalBytes: hubBytes, fileCount } = calculateHubStorageUsage(STORAGE_ROOT);

  // Real disk space from OS
  let totalDiskBytes = 0;
  let freeDiskBytes = 0;
  let usedDiskBytes = 0;

  try {
    const stats = fs.statfsSync(STORAGE_ROOT);
    totalDiskBytes = stats.blocks * stats.bsize;
    freeDiskBytes = stats.bavail * stats.bsize;
    usedDiskBytes = totalDiskBytes - freeDiskBytes;
  } catch (e) {
    console.error('statfs error:', e);
  }

  const cpuModel = (os.cpus() && os.cpus()[0] && os.cpus()[0].model) ? os.cpus()[0].model.trim() : 'Generic Host CPU';
  const coreCount = os.cpus() ? os.cpus().length : 1;

  const statusPayload = {
    online: true,
    device_id: os.hostname(),
    hardware: `${cpuModel} (${coreCount} Cores)`,
    storage_type: getUsbDriveInfo(),
    network: getRealNetwork(),
    mode: 'Storage Gateway / Active',
    hub_used_bytes: hubBytes,
    used_bytes: usedDiskBytes,
    total_bytes: totalDiskBytes,
    free_bytes: freeDiskBytes,
    file_count: fileCount,
    uptime_seconds: Math.floor(os.uptime()),
    timestamp: new Date().toISOString()
  };

  // Sync to Firebase Firestore if configured
  try {
    const { getDb, isConfigured } = require('../config/firebase');
    const db = getDb ? getDb() : null;
    if (isConfigured() && db) {
      db.collection('devices').doc(os.hostname()).set(statusPayload, { merge: true }).catch(() => {});
    }
  } catch (e) {}

  res.json(statusPayload);
});

module.exports = router;
