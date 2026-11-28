require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

const { companyAuth, masterAuth } = require('./src/middleware/auth');
const gatewayRoutes = require('./src/routes/gateway');
const adminRoutes = require('./src/routes/admin');
const masterRoutes = require('./src/routes/master');
const authRoutes = require('./src/routes/auth');

// Ensure DB initializes on boot (also migrates legacy data)
require('./src/db/database');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.MASTER_ADMIN_TOKEN || process.env.MASTER_ADMIN_TOKEN === 'change-me-master-admin') {
  console.warn(
    '[WARN] MASTER_ADMIN_TOKEN is using a weak/default value. Set a strong token in .env.'
  );
}
if (!process.env.MASTER_ADMIN_PASSWORD) {
  console.warn('[WARN] MASTER_ADMIN_PASSWORD is not set. Master username/password login will fail.');
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    service: 'SMS Campaign Portal',
    multiTenant: true,
    auth: 'username-password',
    time: new Date().toISOString(),
  });
});

// Public login (username + password)
app.use('/api/auth', authRoutes);

// Android Gateway — company Bearer token (data isolated per company)
app.use('/api/gateway', companyAuth, gatewayRoutes);

// Company admin dashboard API — company Bearer token (issued after login)
app.use('/api/admin', companyAuth, adminRoutes);

// Master admin — create/manage companies
app.use('/api/master', masterAuth, masterRoutes);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`SMS Campaign Portal running at http://localhost:${PORT}`);
  console.log(`Gateway API:  /api/gateway  (device token or legacy company token)`);
  console.log(`Company API:  /api/admin    (company token)`);
  console.log(`Master API:   /api/master   (MASTER_ADMIN_TOKEN)`);
});
