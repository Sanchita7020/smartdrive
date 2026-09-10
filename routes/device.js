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
const AGENT_TIMEOUT_MS = 45000;

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

// Clean & professional hardware detection helpers
function getCleanHardware() {
  const cpus = os.cpus();
  const rawModel = (cpus && cpus[0] && cpus[0].model) ? cpus[0].model : 'Host CPU';
  const coreCount = cpus ? cpus.length : 1;
  const cleanCpu = rawModel
    .replace(/\(R\)/gi, '')
    .replace(/\(TM\)/gi, '')
    .replace(/@\s*[\d\.]+GHz/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${cleanCpu} • ${coreCount} Cores (High-Performance Host)`;
}

function getCleanDeviceId() {
  const host = os.hostname();
  if (host.startsWith('DESKTOP-')) {
    return `SmartDrive-${host.replace('DESKTOP-', '')}`;
  }
  if (host.startsWith('LAPTOP-')) {
    return `SmartDrive-${host.replace('LAPTOP-', '')}`;
  }
  if (host.startsWith('srv-')) {
    return 'SmartDrive-Cloud-Gateway';
  }
  return `SmartDrive-${host}`;
}

let cachedStorageType = null;
let lastStorageCheck = 0;

function getCleanStorageType() {
  const now = Date.now();
  if (cachedStorageType && (now - lastStorageCheck < 60000)) {
    return cachedStorageType;
  }

  const driveRoot = path.parse(STORAGE_ROOT).root || 'C:';

  if (process.platform === 'win32') {
    try {
      const psCmd = "Get-CimInstance Win32_DiskDrive | Where-Object InterfaceType -eq 'USB' | Select-Object -First 1 -ExpandProperty Model";
      const usbOut = execSync(`powershell.exe -NoProfile -Command "${psCmd}"`, { timeout: 2000, encoding: 'utf8' }).trim();
      if (usbOut) {
        cachedStorageType = `USB Removable Storage (${usbOut})`;
        lastStorageCheck = now;
        return cachedStorageType;
      }
    } catch (e) {}

    try {
      const psCmd = "Get-CimInstance Win32_DiskDrive | Select-Object -First 1 -ExpandProperty Model";
      const diskOut = execSync(`powershell.exe -NoProfile -Command "${psCmd}"`, { timeout: 2000, encoding: 'utf8' }).trim();
      if (diskOut) {
        const clean = diskOut.replace(/\s+SDEQNRK[^\s]*/gi, '').replace(/\s+/g, ' ').trim();
        cachedStorageType = `${clean} NVMe SSD (Drive ${driveRoot} • High-Speed PCIe)`;
        lastStorageCheck = now;
        return cachedStorageType;
      }
    } catch (e) {}

    cachedStorageType = `Physical Drive Storage (Drive ${driveRoot} • High-Speed Storage)`;
  } else if (isCloudEnvironment()) {
    cachedStorageType = 'Cloud Virtual Storage (Attached Gateway Drive)';
  } else {
    cachedStorageType = 'Physical Linux Gateway Storage (/dev/sda)';
  }

  lastStorageCheck = now;
  return cachedStorageType;
}

function getCleanNetwork() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        let type = 'Gigabit LAN';
        const lower = name.toLowerCase();
        if (lower.includes('wi-fi') || lower.includes('wlan') || lower.includes('wireless')) {
          type = 'Wi-Fi Network';
        } else if (lower.includes('ethernet') || lower.includes('eth')) {
          type = 'Gigabit Ethernet';
        }
        return `${type} • ${net.address} (${name})`;
      }
    }
  }
  return 'Local Network (127.0.0.1)';
}

// Calculate actual file size in hub_storage
function calculateHubStorageUsage(dir) {
  let totalBytes = 0;
  let fileCount = 0;

  function traverse(current) {
    if (!fs.existsSync(current)) return;
    try {
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
        } catch (e) {}
      }
    } catch (e) {}
  }

  traverse(dir);
  return { totalBytes, fileCount };
}

// Check if a remote physical gateway agent is actively connected
function isAgentActive() {
  if (!activeAgentHeartbeat) return false;
  return (Date.now() - activeAgentHeartbeat.receivedAt) < AGENT_TIMEOUT_MS;
}

let inMemoryConfig = null;

function getDeviceConfig() {
  if (inMemoryConfig) {
    return inMemoryConfig;
  }

  const defaults = {
    device_id: getCleanDeviceId(),
    device_name: 'SmartDrive Hardware Gateway',
    hardware: getCleanHardware(),
    storage_type: getCleanStorageType(),
    network: getCleanNetwork(),
    total_bytes: 196755845120,
    used_bytes: 112704045056,
    mode: isCloudEnvironment() ? 'Cloud Gateway / Active' : 'SmartDrive Hardware Gateway / Active',
    auto_detect: true
  };

  if (!fs.existsSync(DEVICE_CONFIG_FILE)) {
    try {
      fs.writeFileSync(DEVICE_CONFIG_FILE, JSON.stringify(defaults, null, 2), 'utf8');
    } catch (e) {}
    inMemoryConfig = defaults;
    return defaults;
  }

  try {
    const data = JSON.parse(fs.readFileSync(DEVICE_CONFIG_FILE, 'utf8') || '{}');
    inMemoryConfig = { ...defaults, ...data };
    return inMemoryConfig;
  } catch (e) {
    inMemoryConfig = defaults;
    return defaults;
  }
}

function saveDeviceConfig(cfg) {
  inMemoryConfig = { ...cfg };
  try {
    fs.writeFileSync(DEVICE_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write device config to disk:', e);
  }
}

// GET /api/device/detect-client - Detect client device visiting the site
router.get('/device/detect-client', (req, res) => {
  const ua = req.headers['user-agent'] || '';
  const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const clientIp = rawIp.split(',')[0].trim().replace(/^::ffff:/, '');
  const isMobile = req.headers['sec-ch-ua-mobile'] === '?1' || /Android|iPhone|iPad|iPod|Mobile/i.test(ua);

  let device_id = 'SmartDrive-Device';
  let hardware = 'High-Speed Client Architecture';
  let storage_type = 'Client Flash Storage (Ready)';
  let network = clientIp ? `Mobile / Client Network • ${clientIp}` : 'Active Gateway Connection';
  let mode = isMobile ? 'Mobile Gateway / Active' : 'Client Gateway / Active';

  if (/iPhone/i.test(ua)) {
    device_id = 'SmartDrive-iPhone';
    hardware = 'Apple A-Series Bionic (Mobile iOS)';
    storage_type = 'Apple NVMe Flash Storage (Ready)';
    mode = 'Mobile Gateway / Active';
  } else if (/iPad/i.test(ua)) {
    device_id = 'SmartDrive-iPad';
    hardware = 'Apple M-Series / Bionic (iPadOS)';
    storage_type = 'Apple NVMe Flash Storage (Ready)';
    mode = 'Tablet Gateway / Active';
  } else if (/Android/i.test(ua)) {
    let model = 'Android Device';
    const match = ua.match(/Android[^;]+;\s*([^;)]+)\s*[;)]/i);
    if (match && match[1]) {
      const candidate = match[1].replace(/Build\/.*/i, '').trim();
      if (candidate.length > 2 && candidate.length < 35 && !candidate.startsWith('K') && !candidate.startsWith('wv')) {
        model = candidate;
      }
    }
    device_id = `SmartDrive-${model.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'Android'}`;
    hardware = `${model} • Octa-Core (Mobile SoC)`;
    storage_type = 'High-Speed UFS Mobile Flash (Ready)';
    mode = 'Mobile Gateway / Active';
  } else if (/Windows/i.test(ua)) {
    device_id = getCleanDeviceId();
    hardware = getCleanHardware();
    storage_type = getCleanStorageType();
    network = getCleanNetwork();
    mode = 'SmartDrive Hardware Gateway / Active';
  } else if (/Macintosh|Mac OS X/i.test(ua)) {
    device_id = 'SmartDrive-Mac';
    hardware = 'Apple Silicon / macOS Host';
    storage_type = 'Apple APFS High-Speed SSD';
    mode = 'Host Gateway / Active';
  }

  res.json({
    device_id,
    hardware,
    storage_type,
    network,
    mode,
    clientIp,
    isMobile
  });
});

// GET /api/status
router.get('/status', (req, res) => {
  const { totalBytes: hubBytes, fileCount: localFileCount } = calculateHubStorageUsage(STORAGE_ROOT);
  const config = getDeviceConfig();
  const agentActive = isAgentActive();

  let statusPayload;

  if (agentActive) {
    // 1. Live stream from physical gateway agent
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
  } else {
    // Both Cloud and Local: ALWAYS use the active configured device values!
    const effectiveDeviceId = config.device_id || getCleanDeviceId();
    const effectiveHardware = config.hardware || getCleanHardware();
    const effectiveStorageType = config.storage_type || getCleanStorageType();
    const effectiveNetwork = config.network || getCleanNetwork();
    const effectiveMode = config.mode || (isCloudEnvironment() ? 'Cloud Gateway / Active' : 'SmartDrive Hardware Gateway / Active');

    let totalDiskBytes = config.total_bytes || (183.24 * 1024 * 1024 * 1024);
    let usedDiskBytes = config.used_bytes || (104.96 * 1024 * 1024 * 1024);
    let freeDiskBytes = Math.max(0, totalDiskBytes - usedDiskBytes);

    if (!isCloudEnvironment()) {
      try {
        const stats = fs.statfsSync(STORAGE_ROOT);
        const realTotal = stats.blocks * stats.bsize;
        const realFree = stats.bavail * stats.bsize;
        const realUsed = realTotal - realFree;
        if (!config.total_bytes || config.auto_detect) {
          totalDiskBytes = realTotal;
          freeDiskBytes = realFree;
          usedDiskBytes = realUsed;
        }
      } catch (e) {}
    }

    statusPayload = {
      online: true,
      device_id: effectiveDeviceId,
      hardware: effectiveHardware,
      storage_type: effectiveStorageType,
      network: effectiveNetwork,
      mode: effectiveMode,
      agent_connected: false,
      hub_used_bytes: hubBytes,
      used_bytes: usedDiskBytes,
      total_bytes: totalDiskBytes,
      free_bytes: freeDiskBytes,
      file_count: localFileCount,
      uptime_seconds: Math.floor(os.uptime()),
      timestamp: new Date().toISOString(),
      source: isCloudEnvironment() ? 'cloud_profile' : 'local_hardware'
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
    detected: {
      device_id: getCleanDeviceId(),
      hardware: getCleanHardware(),
      storage_type: getCleanStorageType(),
      network: getCleanNetwork()
    },
    isCloud: isCloudEnvironment(),
    agentConnected: isAgentActive(),
    agentLastSeen: activeAgentHeartbeat ? activeAgentHeartbeat.receivedAt : null
  });
});

// POST /api/device/config - Update device identity and profile
router.post('/device/config', (req, res) => {
  try {
    const current = getDeviceConfig();
    const {
      device_id,
      device_name,
      hardware,
      storage_type,
      network,
      mode,
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
      ...(mode ? { mode: String(mode).trim() } : {}),
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

// POST /api/gateway/heartbeat
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
      `Live hardware '${payload.device_id}' connected from ${payload.network}`,
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
