const { getCompanyByToken } = require('../db/database');

function extractBearer(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/** Resolves Bearer token → company and attaches req.company */
function companyAuth(req, res, next) {
  const token = extractBearer(req);
  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Missing Authorization Bearer token',
    });
  }

  const company = getCompanyByToken(token);
  if (!company) {
    return res.status(401).json({
      success: false,
      error: 'Invalid API token',
    });
  }

  req.company = company;
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

  const company = getCompanyByToken(token);
  if (company) {
    req.company = company;
    req.isMaster = false;
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
