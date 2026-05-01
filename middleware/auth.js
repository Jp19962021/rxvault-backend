// ── middleware/auth.js ────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function clinicMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (!['clinic_admin', 'clinic_staff', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Clinic access required' });
    }
    next();
  });
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

module.exports = { authMiddleware, clinicMiddleware, adminMiddleware };
