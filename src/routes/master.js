const express = require('express');
const {
  listCompanies,
  createCompany,
  updateCompany,
  getCompanyById,
  regenerateCompanyToken,
  deleteCompany,
  usersDictForCompany,
} = require('../db/database');

const router = express.Router();

/** GET /api/master/companies */
router.get('/companies', (req, res) => {
  try {
    const companies = listCompanies();
    return res.json({ success: true, companies });
  } catch (err) {
    console.error('list companies error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list companies' });
  }
});

/**
 * POST /api/master/companies
 * Body: { name, users: [{ name, email, role? }, ...] }
 * users is required (at least one). Returned as a dictionary keyed by user id.
 */
router.post('/companies', (req, res) => {
  try {
    const { name, users } = req.body || {};
    const company = createCompany({ name, users });
    return res.status(201).json({ success: true, company });
  } catch (err) {
    console.error('create company error:', err);
    return res.status(400).json({ success: false, error: err.message || 'Failed to create company' });
  }
});

/** GET /api/master/companies/:id */
router.get('/companies/:id', (req, res) => {
  try {
    const company = getCompanyById(req.params.id);
    if (!company) {
      return res.status(404).json({ success: false, error: 'Company not found' });
    }
    return res.json({
      success: true,
      company: {
        ...company,
        users: usersDictForCompany(company.id),
      },
    });
  } catch (err) {
    console.error('get company error:', err);
    return res.status(500).json({ success: false, error: 'Failed to get company' });
  }
});

/**
 * PUT /api/master/companies/:id
 * Body: { name?, users?: [...], removeUserIds?: [...] }
 */
router.put('/companies/:id', (req, res) => {
  try {
    const { name, users, removeUserIds } = req.body || {};
    const company = updateCompany(req.params.id, { name, users, removeUserIds });
    return res.json({ success: true, company });
  } catch (err) {
    console.error('update company error:', err);
    const status = err.message === 'Company not found' ? 404 : 400;
    return res.status(status).json({ success: false, error: err.message || 'Failed to update company' });
  }
});

/** POST /api/master/companies/:id/regenerate-token */
router.post('/companies/:id/regenerate-token', (req, res) => {
  try {
    const company = regenerateCompanyToken(req.params.id);
    if (!company) {
      return res.status(404).json({ success: false, error: 'Company not found' });
    }
    return res.json({ success: true, company });
  } catch (err) {
    console.error('regenerate token error:', err);
    return res.status(500).json({ success: false, error: 'Failed to regenerate token' });
  }
});

/** DELETE /api/master/companies/:id */
router.delete('/companies/:id', (req, res) => {
  try {
    const ok = deleteCompany(req.params.id);
    if (!ok) {
      return res.status(404).json({ success: false, error: 'Company not found' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('delete company error:', err);
    return res.status(500).json({ success: false, error: 'Failed to delete company' });
  }
});

module.exports = router;
