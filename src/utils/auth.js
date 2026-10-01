const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Constant-time comparison so response timing doesn't leak the password.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function checkAdminPassword(password) {
  return safeEqual(password, process.env.ADMIN_PASSWORD || '');
}

function issueAdminToken() {
  return jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  });
}

function verifyToken(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(h.slice(7), process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Admin access is by bearer token only. The old ?key=<password> query
// parameter was removed because it leaked the password into logs and history.
function requireAdmin(req, res, next) {
  verifyToken(req, res, () => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    next();
  });
}

module.exports = { checkAdminPassword, issueAdminToken, verifyToken, requireAdmin };
