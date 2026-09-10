const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const ACTIVITY_FILE = path.join(__dirname, '..', 'data', 'activity.json');

function getActivity() {
  try {
    if (!fs.existsSync(ACTIVITY_FILE)) {
      return [];
    }
    const data = fs.readFileSync(ACTIVITY_FILE, 'utf8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error('Error reading activity file:', err);
    return [];
  }
}

// GET /api/activity
router.get('/activity', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  const items = getActivity();
  res.json({
    items: items.slice(0, limit)
  });
});

module.exports = router;
