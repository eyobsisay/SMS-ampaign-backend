const express = require('express');
const {
  registerOrUpdateDevice,
  pullJobs,
  updateMessageStatus,
  batchUpdateStatuses,
  touchHeartbeat,
  resolveJobBatchSize,
  MAX_JOB_BATCH_SIZE,
  getDeviceTokenByToken,
} = require('../db/database');
const { gatewayId } = require('../utils/ids');

const router = express.Router();

function refreshDeviceToken(req) {
  if (!req.deviceToken?.token) return req.deviceToken || null;
  return getDeviceTokenByToken(req.deviceToken.token) || req.deviceToken;
}

/** Resolve which deviceIdentifier this request may act as. */
function resolveGatewayDeviceIdentifier(req, requestedRaw) {
  const deviceToken = refreshDeviceToken(req);
  const requested = String(requestedRaw || '').trim();

  if (deviceToken) {
    if (!deviceToken.deviceIdentifier) {
      return {
        error: 'Register this device token first (POST /api/gateway/register)',
        status: 400,
      };
    }
    if (
      deviceToken.clientDeviceIdentifier &&
      requested &&
      requested !== deviceToken.clientDeviceIdentifier &&
      requested !== deviceToken.deviceIdentifier
    ) {
      return {
        error:
          'This token is bound to another device. Create a new device token for this phone.',
        status: 403,
      };
    }
    return { deviceIdentifier: deviceToken.deviceIdentifier, deviceToken };
  }

  if (!requested) {
    return { error: 'deviceIdentifier is required', status: 400 };
  }
  return { deviceIdentifier: requested, deviceToken: null };
}

/**
 * POST /api/gateway/register
 * Body: { deviceIdentifier, deviceName, androidVersion, appVersion }
 * Auth: device Bearer token (preferred) or legacy company token
 */
router.post('/register', (req, res) => {
  try {
    const { deviceIdentifier, deviceName, androidVersion, appVersion } = req.body || {};

    if (!deviceIdentifier || !deviceName) {
      return res.status(400).json({
        success: false,
        error: 'deviceIdentifier and deviceName are required',
      });
    }

    const deviceToken = refreshDeviceToken(req);
    const result = registerOrUpdateDevice({
      companyId: req.company.id,
      deviceIdentifier: String(deviceIdentifier).trim(),
      deviceName: String(deviceName).trim(),
      androidVersion,
      appVersion,
      gatewayId: gatewayId(),
      deviceToken,
    });

    return res.json({
      success: true,
      message: 'Registered',
      gatewayId: result.gatewayId,
      deviceIdentifier: result.deviceIdentifier,
      boundToDeviceToken: Boolean(deviceToken),
    });
  } catch (err) {
    const msg = err.message || 'Registration failed';
    const status = /already bound|another company|revoked/i.test(msg) ? 403 : 500;
    if (status === 500) console.error('register error:', err);
    return res.status(status).json({ success: false, error: msg });
  }
});

/**
 * GET /api/gateway/jobs?deviceIdentifier=...
 * Returns QUEUED jobs for Active campaigns assigned to this device.
 * Each job includes campaignId + campaignTitle (also as campaignName).
 */
router.get('/jobs', (req, res) => {
  try {
    const resolved = resolveGatewayDeviceIdentifier(req, req.query.deviceIdentifier);
    if (resolved.error) {
      return res.status(resolved.status).json({ success: false, error: resolved.error });
    }

    const requested = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 1), MAX_JOB_BATCH_SIZE)
      : resolveJobBatchSize(req.company);

    const jobs = pullJobs(req.company.id, resolved.deviceIdentifier, limit);

    return res.json({
      success: true,
      jobs,
      limit,
    });
  } catch (err) {
    console.error('jobs error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch jobs' });
  }
});

/**
 * POST /api/gateway/status
 * Updates only messages belonging to this company
 */
router.post('/status', (req, res) => {
  try {
    const {
      messageId,
      campaignId,
      deviceIdentifier,
      status,
      failureReason,
      timestamp,
      simSlot,
    } = req.body || {};

    if (!messageId || !status) {
      return res.status(400).json({
        success: false,
        error: 'messageId and status are required',
      });
    }

    if (deviceIdentifier || req.deviceToken) {
      const resolved = resolveGatewayDeviceIdentifier(req, deviceIdentifier);
      if (resolved.error) {
        return res.status(resolved.status).json({ success: false, error: resolved.error });
      }
      touchHeartbeat(resolved.deviceIdentifier, req.company.id);
    }

    const result = updateMessageStatus({
      companyId: req.company.id,
      messageId,
      status,
      failureReason,
      simSlot,
      timestamp,
    });

    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.error });
    }

    void campaignId;

    return res.json({ success: true });
  } catch (err) {
    console.error('status error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update status' });
  }
});

/**
 * POST /api/gateway/batch-sync
 */
router.post('/batch-sync', (req, res) => {
  try {
    const { deviceIdentifier, events } = req.body || {};

    if (!Array.isArray(events)) {
      return res.status(400).json({
        success: false,
        error: 'events array is required',
      });
    }

    if (deviceIdentifier || req.deviceToken) {
      const resolved = resolveGatewayDeviceIdentifier(req, deviceIdentifier);
      if (resolved.error) {
        return res.status(resolved.status).json({ success: false, error: resolved.error });
      }
      touchHeartbeat(resolved.deviceIdentifier, req.company.id);
    }

    const result = batchUpdateStatuses(req.company.id, events);

    return res.json({
      success: true,
      updated: result.updated,
      errors: result.errors.length ? result.errors : undefined,
    });
  } catch (err) {
    console.error('batch-sync error:', err);
    return res.status(500).json({ success: false, error: 'Batch sync failed' });
  }
});

router.post('/heartbeat', (req, res) => {
  try {
    const { deviceIdentifier } = req.body || {};
    const resolved = resolveGatewayDeviceIdentifier(req, deviceIdentifier);
    if (resolved.error) {
      return res.status(resolved.status).json({ success: false, error: resolved.error });
    }
    touchHeartbeat(resolved.deviceIdentifier, req.company.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('heartbeat error:', err);
    return res.status(500).json({ success: false, error: 'Heartbeat failed' });
  }
});

module.exports = router;
