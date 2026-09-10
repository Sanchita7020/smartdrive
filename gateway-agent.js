#!/usr/bin/env node

/**
 * SmartDrive Gateway Agent
 * Connects your physical hardware & storage to the SmartDrive Cloud Portal (Render / Vercel).
 * 
 * Usage:
 *   node gateway-agent.js --cloud https://your-app.onrender.com --storage E:\
 *   node gateway-agent.js --cloud http://localhost:3000
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

// Parse CLI arguments
const args = process.argv.slice(2);
function getArg(flag, fallback) {
  const index = args.indexOf(flag);
  if (index !== -1 && args[index + 1]) {
    return args[index + 1];
  }
  return fallback;
}

const CLOUD_URL = (getArg('--cloud', process.env.SMARTDRIVE_CLOUD_URL || 'http://localhost:3000')).replace(/\/+$/, '');
const STORAGE_PATH = path.resolve(getArg('--storage', process.env.SMARTDRIVE_STORAGE_PATH || path.join(__dirname, 'hub_storage')));
const DEVICE_ID = getArg('--device-id', process.env.SMARTDRIVE_DEVICE_ID || os.hostname());
const HEARTBEAT_INTERVAL_MS = parseInt(getArg('--interval', '15000'), 10);

console.log('====================================================');
console.log('       SmartDrive Physical Gateway Agent            ');
console.log('====================================================');
console.log(`📡 Cloud Target   : ${CLOUD_URL}`);
console.log(`💾 Physical Storage: ${STORAGE_PATH}`);
console.log(`🆔 Device ID       : ${DEVICE_ID}`);
console.log(`⏱  Interval        : ${HEARTBEAT_INTERVAL_MS / 1000}s`);
console.log('====================================================\n');

// Detect local network IP
function getLocalNetwork() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return `${name} (${net.address})`;
      }
    }
  }
  return 'Localhost (127.0.0.1)';
}

// Detect USB drive / local storage description
function getStorageDescription() {
  if (process.platform === 'win32') {
    try {
      const psCmd = "Get-CimInstance Win32_DiskDrive | Where-Object { $_.InterfaceType -eq 'USB' } | Select-Object -ExpandProperty Model";
      const out = execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${psCmd}"`, {
        timeout: 2500,
        encoding: 'utf8'
      }).trim();
      if (out) return `USB Storage (${out})`;
    } catch (e) {}
  }
  return `Local Gateway Storage (${path.parse(STORAGE_PATH).root || STORAGE_PATH})`;
}

// Calculate directory usage
function calculateStorageUsage(dir) {
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

// Send HTTP POST request
function sendHeartbeat(payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${CLOUD_URL}/api/gateway/heartbeat`);
    const data = JSON.stringify(payload);
    const client = url.protocol === 'https:' ? https : http;

    const req = client.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'SmartDrive-Agent/1.0'
      },
      timeout: 8000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(body || '{}'));
        } else {
          reject(new Error(`Server returned HTTP ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Connection timed out'));
    });

    req.write(data);
    req.end();
  });
}

// Collect real hardware telemetry
function collectTelemetry() {
  const { totalBytes: hubBytes, fileCount } = calculateStorageUsage(STORAGE_PATH);

  let totalDiskBytes = 500 * 1024 * 1024 * 1024;
  let freeDiskBytes = 350 * 1024 * 1024 * 1024;
  let usedDiskBytes = 150 * 1024 * 1024 * 1024;

  try {
    if (fs.existsSync(STORAGE_PATH)) {
      const stats = fs.statfsSync(STORAGE_PATH);
      totalDiskBytes = stats.blocks * stats.bsize;
      freeDiskBytes = stats.bavail * stats.bsize;
      usedDiskBytes = totalDiskBytes - freeDiskBytes;
    }
  } catch (e) {}

  const cpuModel = (os.cpus() && os.cpus()[0] && os.cpus()[0].model) ? os.cpus()[0].model.trim() : 'Physical Gateway CPU';
  const coreCount = os.cpus() ? os.cpus().length : 1;

  return {
    device_id: DEVICE_ID,
    hardware: `${cpuModel} (${coreCount} Cores)`,
    storage_type: getStorageDescription(),
    network: getLocalNetwork(),
    hub_used_bytes: hubBytes,
    used_bytes: usedDiskBytes,
    total_bytes: totalDiskBytes,
    file_count: fileCount,
    uptime_seconds: Math.floor(os.uptime())
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// Main execution loop
async function runLoop() {
  try {
    const telemetry = collectTelemetry();
    await sendHeartbeat(telemetry);
    const now = new Date().toLocaleTimeString();
    console.log(`[${now}] 🟢 Heartbeat OK: ${telemetry.device_id} | Net: ${telemetry.network} | Storage: ${formatBytes(telemetry.used_bytes)} / ${formatBytes(telemetry.total_bytes)} (${telemetry.file_count} files)`);
  } catch (err) {
    const now = new Date().toLocaleTimeString();
    console.error(`[${now}] 🔴 Sync Failed: ${err.message}`);
  }
}

// Initial pulse and start interval
runLoop();
setInterval(runLoop, HEARTBEAT_INTERVAL_MS);
