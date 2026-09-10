const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { authenticateToken } = require('../middleware/auth');

let STORAGE_ROOT = path.resolve(__dirname, '..', 'hub_storage');
const ACTIVITY_FILE = path.resolve(__dirname, '..', 'data', 'activity.json');

function logActivity(title, description, type = 'file', icon = '📄') {
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

// Automatically seed initial files if storage directory is empty (e.g. on fresh Render deploy)
function seedInitialStorage(dir) {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const existing = fs.readdirSync(dir);
    if (existing.length === 0) {
      // 1. User manual
      fs.writeFileSync(
        path.join(dir, 'SmartDrive_User_Guide.pdf'),
        Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\nSmartDrive Hardware Storage Gateway User Guide\nVersion 2.4 - Production Ready')
      );
      // 2. Gateway firmware binary
      const firmwareBuffer = Buffer.alloc(1024 * 64, 0xAA); // 64 KB binary
      fs.writeFileSync(path.join(dir, 'gateway_firmware_v2.4.bin'), firmwareBuffer);
      // 3. Sensor & telemetry log
      const csvData = `timestamp,device_id,temperature_c,storage_usage_pct,network_traffic_kb\n2026-09-10T12:00:00Z,SMARTDRIVE-GW-01,38.5,27.4,1420\n2026-09-10T12:05:00Z,SMARTDRIVE-GW-01,38.7,27.4,1890\n2026-09-10T12:10:00Z,SMARTDRIVE-GW-01,39.1,27.5,2140\n`;
      fs.writeFileSync(path.join(dir, 'telemetry_logs_2026.csv'), csvData, 'utf8');
      // 4. Backup folder with system configs
      const backupDir = path.join(dir, 'Backups');
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(
        path.join(backupDir, 'network_config.bak'),
        '# SmartDrive Gateway Network Configuration\nINTERFACE=eth0\nDHCP=true\nGATEWAY_PORT=3000\nFALLBACK_IP=192.168.1.105\n'
      );
      fs.writeFileSync(
        path.join(backupDir, 'system_manifest.json'),
        JSON.stringify({ model: 'SmartDrive-Hub-v2', serial: 'SD-9942-8812', storage_bus: 'USB 3.2', status: 'verified' }, null, 2)
      );
      logActivity('Storage Initialized', 'Default gateway storage seeded with system files and manuals', 'storage', '💾');
    }
  } catch (err) {
    console.error('Failed to seed initial storage:', err);
  }
}

seedInitialStorage(STORAGE_ROOT);

// Security: Resolve and ensure path is strictly within current STORAGE_ROOT
function safeResolve(relPath = '/') {
  const sanitized = String(relPath || '/').replace(/\\/g, '/').replace(/\.\./g, '');
  const relativeTarget = '.' + (sanitized.startsWith('/') ? sanitized : '/' + sanitized);
  const resolved = path.resolve(STORAGE_ROOT, relativeTarget);
  if (!resolved.toLowerCase().startsWith(STORAGE_ROOT.toLowerCase())) {
    return STORAGE_ROOT;
  }
  if (!fs.existsSync(resolved)) {
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch (e) {
      return STORAGE_ROOT;
    }
  }
  return resolved;
}

// Configure Multer for real file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const targetPath = req.query.path || req.body.path || '/';
    const resolvedDir = safeResolve(targetPath);
    if (!fs.existsSync(resolvedDir)) {
      fs.mkdirSync(resolvedDir, { recursive: true });
    }
    cb(null, resolvedDir);
  },
  filename: (req, file, cb) => {
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const sanitizedName = originalName.replace(/[^\w\d\.\-\s_()]/g, '_');
    cb(null, sanitizedName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }
});

// GET /api/files?path=/
router.get('/files', (req, res) => {
  try {
    const requestedPath = req.query.path || '/';
    const targetDir = safeResolve(requestedPath);

    if (!fs.existsSync(targetDir)) {
      return res.json({ path: '/', storage_root: STORAGE_ROOT, items: [] });
    }

    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Specified path is not a directory' });
    }

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const folders = [];
    const files = [];

    for (const entry of entries) {
      const fullPath = path.join(targetDir, entry.name);
      try {
        const itemStat = fs.statSync(fullPath);
        if (entry.isDirectory()) {
          folders.push({
            type: 'folder',
            name: entry.name,
            modified: itemStat.mtime.toISOString()
          });
        } else if (entry.isFile()) {
          files.push({
            type: 'file',
            name: entry.name,
            size_bytes: itemStat.size,
            modified: itemStat.mtime.toISOString()
          });
        }
      } catch (e) {
        console.error('Error stating file:', entry.name, e);
      }
    }

    folders.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    const displayPath = '/' + path.relative(STORAGE_ROOT, targetDir).replace(/\\/g, '/');
    const normalizedDisplay = (displayPath === '/.' || displayPath === '') ? '/' : displayPath;

    res.json({
      path: normalizedDisplay,
      storage_root: STORAGE_ROOT,
      items: [...folders, ...files]
    });
  } catch (err) {
    console.error('Files read error:', err);
    res.json({ path: '/', storage_root: STORAGE_ROOT, items: [] });
  }
});

// POST /api/upload
router.post('/upload', authenticateToken, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file was uploaded' });
    }

    const uploadedRelPath = req.query.path || req.body.path || '/';
    const displayFolder = uploadedRelPath === '/' ? 'root' : uploadedRelPath;
    const username = req.user ? req.user.username : 'User';

    logActivity(
      'File Uploaded',
      `'${req.file.filename}' (${(req.file.size / 1024).toFixed(1)} KB) uploaded by ${username} to ${displayFolder}`,
      'file',
      '⬆️'
    );

    res.status(201).json({
      message: 'File uploaded successfully',
      file: {
        name: req.file.filename,
        size_bytes: req.file.size,
        path: uploadedRelPath
      }
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// POST /api/gateway/sync-files - Physical Gateway Agent upload endpoint
router.post('/gateway/sync-files', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file received' });
    }
    const targetPath = req.query.path || '/';
    logActivity(
      'File Synced from Hardware',
      `'${req.file.filename}' (${(req.file.size / 1024).toFixed(1)} KB) synced from physical gateway`,
      'file',
      '🔄'
    );
    res.status(201).json({
      message: 'File synced successfully',
      file: {
        name: req.file.filename,
        size_bytes: req.file.size,
        path: targetPath
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/download?path=/filename
router.get('/download', (req, res) => {
  try {
    const filePathParam = req.query.path;
    if (!filePathParam) {
      return res.status(400).json({ error: 'File path parameter is required' });
    }

    const resolvedFile = safeResolve(filePathParam);

    if (!fs.existsSync(resolvedFile)) {
      return res.status(404).json({ error: 'File not found on storage' });
    }

    const stat = fs.statSync(resolvedFile);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Cannot download a directory directly' });
    }

    const fileName = path.basename(resolvedFile);

    logActivity(
      'File Downloaded',
      `'${fileName}' downloaded from storage`,
      'file',
      '⬇️'
    );

    res.download(resolvedFile, fileName);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// POST /api/folders (Create new folder)
router.post('/folders', authenticateToken, (req, res) => {
  try {
    const { path: parentPath = '/', name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Folder name is required' });
    }

    const sanitizedFolderName = name.trim().replace(/[^\w\d\-\s_]/g, '_');
    const targetParent = safeResolve(parentPath);
    const newFolderPath = path.join(targetParent, sanitizedFolderName);

    if (fs.existsSync(newFolderPath)) {
      return res.status(400).json({ error: 'Folder already exists' });
    }

    fs.mkdirSync(newFolderPath, { recursive: true });

    logActivity(
      'Folder Created',
      `Directory '${sanitizedFolderName}' created in ${parentPath}`,
      'folder',
      '📁'
    );

    res.status(201).json({
      message: 'Folder created successfully',
      name: sanitizedFolderName
    });
  } catch (err) {
    console.error('Create folder error:', err);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

// POST /api/storage/target - Allow setting real directory or USB drive
router.post('/storage/target', authenticateToken, (req, res) => {
  try {
    const { targetPath } = req.body;
    if (!targetPath || !fs.existsSync(targetPath)) {
      const isCloud = Boolean(process.env.RENDER || process.env.VERCEL || (process.platform === 'linux' && targetPath && targetPath.includes(':')));
      const errorMsg = isCloud
        ? `Cannot mount '${targetPath}'. When deployed in the cloud (Render), local Windows drive paths (e.g. C:\\ or E:\\) are not physically attached to the cloud server. Use the SmartDrive Gateway Agent to stream your physical drive to this cloud instance.`
        : 'Specified path does not exist on this machine';
      return res.status(400).json({ error: errorMsg });
    }
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Specified path is not a directory' });
    }
    STORAGE_ROOT = path.resolve(targetPath);
    logActivity('Storage Root Changed', `Storage location mounted to: ${STORAGE_ROOT}`, 'storage', '💾');
    res.json({ message: 'Storage location updated', storage_root: STORAGE_ROOT });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
