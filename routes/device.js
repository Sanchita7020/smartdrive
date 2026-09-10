const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { authenticateToken } = require('../middleware/auth');

const STORAGE_ROOT = path.join(__dirname, '..', 'hub_storage');
const DEVICE_CONFIG_FILE = path.join(__dirname, '..', 'data', 'deviceConfig.json');
const ACTIVITY_FILE = path.join(__dirname, '..', 'data', 'activity.json');

// In-memory cache for live physical gateway agent
let activeAgentHeartbeat = null;
const AGENT_TIMEOUT_MS = 45000; // 45 seconds

function logActivity(title, description, type = 'storage', icon = '⚙️') {
  try {
    let activities = [];
    if (fs.existsSync(ACTIVITY_FILE)) {
      activities = JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8') || '[]');
    }
    activities.unshift({
      id: 'act_' + Date.now(),
      title,
      description,
      timestamp: new Date().toISOString(),
      type,
      icon
    });
    if (activities.length > 50) activities = activities.slice(0, 50);
    fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(activities, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to log activity:', e);
  }
}

// Check if running on cloud container (e.g. Render, Vercel, Docker)
function isCloudEnvironment() {
  return Boolean(
    process.env.RENDER ||
    process.env.RENDER_SERVICE_ID ||
    process.env.VERCEL ||
    process.env.RAILWAY_STATIC_URL ||
    process.env.FLY_APP_NAME ||
    (os.hostname() && os.hostname().startsWith('srv-'))
  );
}

// Get saved or default device config
function getDeviceConfig() {
  const defaults = {
    device_id: process.env.DEVICE_ID || 'SMARTDRIVE-GW-01',
    device_name: process.env.DEVICE_NAME || 'SmartDrive Hardware Gateway',
    hardware: process.env.DEVICE_HARDWARE || 'SmartDrive Hub v2.4 (Quad-Core Cortex-A72)',
    storage_type: process.env.DEVICE_STORAGE_TYPE || 'USB 3.2 High-Speed Storage (SanDisk Ultra 512GB)',
    network: process.env.DEVICE_NETWORK || (process.env.RENDER_EXTERNAL_HOSTNAME ? `${process.env.RENDER_EXTERNAL_HOSTNAME} (Cloud Gateway)` : 'Gigabit LAN (192.168.1.105)'),
    total_bytes: process.env.DEVICE_TOTAL_GB ? parseFloat(process.env.DEVICE_TOTAL_GB) * 1024 * 1024 * 1024 : 536870912000, // 500 GB default
    used_bytes: process.env.DEVICE_USED_GB ? parseFloat(process.env.DEVICE_USED_GB) * 1024 * 1024 * 1024 : 147111280640,  // 137 GB default
    mode: 'Storage Gateway / Active',
    auto_detect: false
  };

  if (!fs.existsSync(DEVICE_CONFIG_FILE)) {
    try {
      fs.writeFileSync(DEVICE_CONFIG_FILE, JSON.stringify(defaults, null, 2), 'utf8');
    } catch (e) {}
    return defaults;
  }

  try {
    const data = JSON.parse(fs.readFileSync(DEVICE_CONFIG_FILE, 'utf8') || '{}');
    return { ...defaults, ...data };
  } catch (e) {
    return defaults;
  }
}

function saveDeviceConfig(cfg) {
  fs.writeFileSync(DEVICE_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

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

// Real USB drive detection on Windows (safe for Linux/Cloud)
let cachedUsb = null;
let lastUsbCheck = 0;

function getUsbDriveInfo() {
  const now = Date.now();
  if (cachedUsb && (now - lastUsbCheck < 15000)) {
    return cachedUsb;
  }

  if (process.platform === 'win32') {
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
      cachedUsb = `Host Storage (Drive ${path.parse(STORAGE_ROOT).root || 'C:'})`;
    }
  } else {
    // Linux / Cloud container
    if (isCloudEnvironment()) {
      cachedUsb = `Cloud Virtual Gateway (Attached Storage)`;
    } else {
      cachedUsb = `Physical Linux Gateway Storage (/dev/sda)`;
    }
  }

  lastUsbCheck = now;
  return cachedUsb;
}

// Check if a remote physical gateway agent is actively connected
function isAgentActive() {
  if (!activeAgentHeartbeat) return false;
  return (Date.now() - activeAgentHeartbeat.receivedAt) < AGENT_TIMEOUT_MS;
}

// GET /api/status
router.get('/status', (req, res) => {
  const { totalBytes: hubBytes, fileCount: localFileCount } = calculateHubStorageUsage(STORAGE_ROOT);
  const config = getDeviceConfig();
  const agentActive = isAgentActive();

  let statusPayload;

  if (agentActive) {
    // 1. Live stream from physical gateway agent (e.g. Raspberry Pi / Local PC)
    statusPayload = {
      online: true,
      device_id: activeAgentHeartbeat.device_id || config.device_id,
      hardware: activeAgentHeartbeat.hardware || config.hardware,
      storage_type: activeAgentHeartbeat.storage_type || config.storage_type,
      network: activeAgentHeartbeat.network || config.network,
      mode: 'Physical Gateway (Live Sync)',
      agent_connected: true,
      hub_used_bytes: activeAgentHeartbeat.hub_used_bytes != null ? activeAgentHeartbeat.hub_used_bytes : hubBytes,
      used_bytes: activeAgentHeartbeat.used_bytes != null ? activeAgentHeartbeat.used_bytes : config.used_bytes,
      total_bytes: activeAgentHeartbeat.total_bytes != null ? activeAgentHeartbeat.total_bytes : config.total_bytes,
      free_bytes: (activeAgentHeartbeat.total_bytes != null && activeAgentHeartbeat.used_bytes != null)
        ? (activeAgentHeartbeat.total_bytes - activeAgentHeartbeat.used_bytes)
        : (config.total_bytes - config.used_bytes),
      file_count: activeAgentHeartbeat.file_count != null ? activeAgentHeartbeat.file_count : localFileCount,
      uptime_seconds: activeAgentHeartbeat.uptime_seconds || Math.floor(os.uptime()),
      timestamp: new Date().toISOString(),
      source: 'physical_agent'
    };
  } else if (!config.auto_detect || isCloudEnvironment()) {
    // 2. Configured SmartDrive profile (Render / Cloud deployment or user preference)
    const effectiveTotal = config.total_bytes || 536870912000;
    const effectiveUsed = config.used_bytes ? (config.used_bytes + hubBytes) : hubBytes;
    const effectiveFree = Math.max(0, effectiveTotal - effectiveUsed);

    statusPayload = {
      online: true,
      device_id: config.device_id,
      hardware: config.hardware,
      storage_type: config.storage_type,
      network: config.network,
      mode: isCloudEnvironment() ? 'Cloud Gateway / Active' : (config.mode || 'Storage Gateway / Active'),
      agent_connected: false,
      hub_used_bytes: hubBytes,
      used_bytes: effectiveUsed,
      total_bytes: effectiveTotal,
      free_bytes: effectiveFree,
      file_count: localFileCount,
      uptime_seconds: Math.floor(os.uptime()),
      timestamp: new Date().toISOString(),
      source: isCloudEnvironment() ? 'cloud_profile' : 'configured'
    };
  } else {
    // 3. Direct local OS telemetry (only when running on local machine with auto_detect enabled)
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

    const cpuModel = (os.cpus() && os.cpus()[0] && os.cpus()[0].model) ? os.cpus()[0].model.trim() : 'Host CPU';
    const coreCount = os.cpus() ? os.cpus().length : 1;

    statusPayload = {
      online: true,
      device_id: os.hostname(),
      hardware: `${cpuModel} (${coreCount} Cores)`,
      storage_type: getUsbDriveInfo(),
      network: getRealNetwork(),
      mode: 'Storage Gateway / Direct Local',
      agent_connected: false,
      hub_used_bytes: hubBytes,
      used_bytes: usedDiskBytes,
      total_bytes: totalDiskBytes,
      free_bytes: freeDiskBytes,
      file_count: localFileCount,
      uptime_seconds: Math.floor(os.uptime()),
      timestamp: new Date().toISOString(),
      source: 'local_os'
    };
  }

  // Sync to Firebase Firestore if configured
  try {
    const { getDb, isConfigured } = require('../config/firebase');
    const db = getDb ? getDb() : null;
    if (isConfigured() && db) {
      db.collection('devices').doc(statusPayload.device_id).set(statusPayload, { merge: true }).catch(() => {});
    }
  } catch (e) {}

  res.json(statusPayload);
});

// GET /api/device/config
router.get('/device/config', (req, res) => {
  const config = getDeviceConfig();
  res.json({
    config,
    isCloud: isCloudEnvironment(),
    agentConnected: isAgentActive(),
    agentLastSeen: activeAgentHeartbeat ? activeAgentHeartbeat.receivedAt : null
  });
});

// POST /api/device/config - Update device identity and profile
router.post('/device/config', authenticateToken, (req, res) => {
  try {
    const current = getDeviceConfig();
    const {
      device_id,
      device_name,
      hardware,
      storage_type,
      network,
      total_gb,
      used_gb,
      auto_detect
    } = req.body;

    const updated = {
      ...current,
      ...(device_id ? { device_id: String(device_id).trim() } : {}),
      ...(device_name ? { device_name: String(device_name).trim() } : {}),
      ...(hardware ? { hardware: String(hardware).trim() } : {}),
      ...(storage_type ? { storage_type: String(storage_type).trim() } : {}),
      ...(network ? { network: String(network).trim() } : {}),
      ...(total_gb ? { total_bytes: Math.round(parseFloat(total_gb) * 1024 * 1024 * 1024) } : {}),
      ...(used_gb ? { used_bytes: Math.round(parseFloat(used_gb) * 1024 * 1024 * 1024) } : {}),
      ...(typeof auto_detect === 'boolean' ? { auto_detect } : {})
    };

    saveDeviceConfig(updated);
    logActivity('Device Config Updated', `Device Profile updated: ${updated.device_id} (${updated.hardware})`, 'storage', '⚙️');

    res.json({
      message: 'Device configuration updated successfully',
      config: updated
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gateway/heartbeat - Telemetry pushed from local physical gateway agent
router.post('/gateway/heartbeat', (req, res) => {
  const payload = req.body;
  if (!payload || !payload.device_id) {
    return res.status(400).json({ error: 'Device ID is required in heartbeat payload' });
  }

  const wasAgentActive = isAgentActive();

  activeAgentHeartbeat = {
    device_id: payload.device_id,
    hardware: payload.hardware || 'Physical Gateway Device',
    storage_type: payload.storage_type || 'Attached Storage',
    network: payload.network || 'LAN Connection',
    hub_used_bytes: payload.hub_used_bytes || 0,
    used_bytes: payload.used_bytes || 0,
    total_bytes: payload.total_bytes || 0,
    file_count: payload.file_count || 0,
    uptime_seconds: payload.uptime_seconds || 0,
    receivedAt: Date.now()
  };

  if (!wasAgentActive) {
    logActivity(
      'Physical Gateway Connected',
      `Live hardware '${payload.device_id}' connected to Cloud Portal from ${payload.network}`,
      'storage',
      '🔗'
    );
  }

  res.json({
    ok: true,
    message: 'Heartbeat received',
    timestamp: new Date().toISOString()
  });
});

// GET /api/gateway/status
router.get('/gateway/status', (req, res) => {
  res.json({
    connected: isAgentActive(),
    lastSeen: activeAgentHeartbeat ? activeAgentHeartbeat.receivedAt : null,
    agentInfo: isAgentActive() ? activeAgentHeartbeat : null
  });
});

module.exports = router;
