const jwt = require('jsonwebtoken');
const { getAuth, isConfigured: isFirebaseConfigured } = require('../config/firebase');

const JWT_SECRET = process.env.JWT_SECRET || 'smart-usb-hub-secret-key-2026';

async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      error: 'Authentication required. Please sign in.'
    });
  }

  // 1. Try Firebase Auth if configured
  const fbAuth = getAuth ? getAuth() : null;
  if (isFirebaseConfigured() && fbAuth) {
    try {
      const decoded = await fbAuth.verifyIdToken(token);
      req.user = {
        id: decoded.uid,
        username: decoded.email ? decoded.email.split('@')[0] : (decoded.name || decoded.uid),
        email: decoded.email || '',
        firebase: true
      };
      return next();
    } catch (firebaseErr) {
      // Fall through to local JWT
    }
  }

  // 2. Fallback to Local JWT verification
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({
        error: 'Invalid or expired session. Please sign in again.'
      });
    }
    req.user = user;
    next();
  });
}

module.exports = {
  JWT_SECRET,
  authenticateToken
};
