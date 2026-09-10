const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET, authenticateToken } = require('../middleware/auth');

const USERS_FILE = path.join(__dirname, '..', 'data', 'users.json');
const ACTIVITY_FILE = path.join(__dirname, '..', 'data', 'activity.json');

function getUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) {
      fs.writeFileSync(USERS_FILE, '[]', 'utf8');
      return [];
    }
    const data = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error('Error reading users file:', err);
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function logActivity(title, description, type = 'auth', icon = '🔑') {
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

// Initial seed if users is empty
(async () => {
  const users = getUsers();
  if (users.length === 0) {
    const hashedPassword = await bcrypt.hash('admin123', 10);
    users.push({
      id: 'usr_' + Date.now(),
      username: 'admin',
      email: 'admin@smarthub.local',
      password: hashedPassword,
      createdAt: new Date().toISOString()
    });
    saveUsers(users);
  }
})();

// Register
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const users = getUsers();
    const existing = users.find(
      u => u.username.toLowerCase() === username.toLowerCase() || (email && u.email && u.email.toLowerCase() === email.toLowerCase())
    );

    if (existing) {
      return res.status(400).json({ error: 'Username or email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
      id: 'usr_' + Date.now(),
      username: username.trim(),
      email: (email || `${username.trim()}@smarthub.local`).trim(),
      password: hashedPassword,
      createdAt: new Date().toISOString()
    };

    users.push(newUser);
    saveUsers(users);

    const token = jwt.sign(
      { id: newUser.id, username: newUser.username, email: newUser.email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    logActivity('User Registered', `New user '${newUser.username}' registered to Smart Hub`, 'auth', '👤');

    res.status(201).json({
      message: 'User registered successfully',
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email
      }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error during registration' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const users = getUsers();
    const user = users.find(
      u => u.username.toLowerCase() === username.toLowerCase() || (u.email && u.email.toLowerCase() === username.toLowerCase())
    );

    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    logActivity('User Logged In', `User '${user.username}' authenticated with JWT`, 'auth', '🔑');

    res.json({
      message: 'Authentication successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// Current User Profile
router.get('/me', authenticateToken, (req, res) => {
  res.json({
    user: req.user
  });
});

module.exports = router;
