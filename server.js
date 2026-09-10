const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const authRoutes = require('./routes/auth');
const deviceRoutes = require('./routes/device');
const fileRoutes = require('./routes/files');
const activityRoutes = require('./routes/activity');
const firebaseRoutes = require('./routes/firebase');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure directories exist
['data', 'hub_storage', 'public', 'config'].forEach(dir => {
  const dirPath = path.join(__dirname, dir);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
});

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/firebase', firebaseRoutes);
app.use('/api', deviceRoutes);
app.use('/api', fileRoutes);
app.use('/api', activityRoutes);

// Single page app fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`SmartDrive Server running on http://localhost:${PORT}`);
  console.log(`Real Storage Root: ${path.join(__dirname, 'hub_storage')}`);
  console.log(`========================================`);
});
