const express = require('express');
const { loginWithPassword, getMasterWorkspace, publicCompany } = require('../db/database');

const router = express.Router();

/**
 * POST /api/auth/login
 * Body: { username, password }
 *
 * Tries company user first, then master admin credentials from .env.
 * Returns a Bearer token the dashboard can use for subsequent API calls.
 * Android gateway still uses company.apiToken directly.
 */
router.post('/login', (req, res) => {
  try {
    const username = String((req.body || {}).username || '').trim();
    const password = String((req.body || {}).password || '');

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: 'username and password are required',
      });
    }

    // Master admin (from .env)
    const masterUser = process.env.MASTER_ADMIN_USERNAME || 'master';
    const masterPass = process.env.MASTER_ADMIN_PASSWORD;
    if (
      masterPass &&
      username.toLowerCase() === String(masterUser).toLowerCase() &&
      password === masterPass
    ) {
      const workspace = getMasterWorkspace();
      return res.json({
        success: true,
        mode: 'master',
        token: process.env.MASTER_ADMIN_TOKEN,
        workspace: publicCompany(workspace),
        user: {
          username: masterUser,
          name: 'Master Admin',
          role: 'master',
        },
      });
    }

    // Company user
    const result = loginWithPassword(username, password);
    if (!result) {
      return res.status(401).json({
        success: false,
        error: 'Invalid username or password',
      });
    }

    return res.json({
      success: true,
      mode: 'company',
      token: result.company.apiToken,
      company: {
        id: result.company.id,
        name: result.company.name,
        apiToken: result.company.apiToken,
        createdAt: result.company.createdAt,
      },
      user: result.user,
    });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ success: false, error: 'Login failed' });
  }
});

module.exports = router;
