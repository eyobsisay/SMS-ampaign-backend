const {
  getCompanyByToken,
  resolveAuthByToken,
  touchDeviceTokenUsed,
} = require('../db/database');

function extractBearer(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Resolves Bearer token → company (and optional per-device token).
 * Device tokens and legacy company apiToken both work.
 */
function companyAuth(req, res, next) {
  const token = extractBearer(req);
  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Missing Authorization Bearer token',
    });
  }

  const resolved = resolveAuthByToken(token);
  if (!resolved?.company) {
    return res.status(401).json({
      success: false,
      error: 'Invalid API token',
    });
  }

  req.company = resolved.company;
  req.deviceToken = resolved.deviceToken || null;
  if (req.deviceToken) {
    // Device tokens are for /api/gateway only — not the dashboard admin API
    if (String(req.originalUrl || req.url || '').includes('/api/admin')) {
      return res.status(403).json({
        success: false,
        error: 'Device tokens cannot access the admin API. Use a company login session.',
      });
    }
    touchDeviceTokenUsed(req.deviceToken.id);
  }
  next();
}

/** Master admin only (creates/manages companies) */
function masterAuth(req, res, next) {
  const token = extractBearer(req);
  const expected = process.env.MASTER_ADMIN_TOKEN;

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Missing Authorization Bearer token',
    });
  }

  if (!expected || token !== expected) {
    return res.status(401).json({
      success: false,
      error: 'Invalid master admin token',
    });
  }

  req.isMaster = true;
  next();
}

/**
 * Accepts either master admin OR a company token.
 * Sets req.isMaster and optionally req.company
 */
function masterOrCompanyAuth(req, res, next) {
  const token = extractBearer(req);
  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Missing Authorization Bearer token',
    });
  }

  if (process.env.MASTER_ADMIN_TOKEN && token === process.env.MASTER_ADMIN_TOKEN) {
    req.isMaster = true;
    return next();
  }

  const resolved = resolveAuthByToken(token);
  if (resolved?.company) {
    req.company = resolved.company;
    req.deviceToken = resolved.deviceToken || null;
    req.isMaster = false;
    if (req.deviceToken) {
      touchDeviceTokenUsed(req.deviceToken.id);
    }
    return next();
  }

  return res.status(401).json({
    success: false,
    error: 'Invalid API token',
  });
}

module.exports = {
  extractBearer,
  companyAuth,
  masterAuth,
  masterOrCompanyAuth,
};
