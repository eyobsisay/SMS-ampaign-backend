const express = require('express');
const {
  registerOrUpdateDevice,
  pullJobs,
  updateMessageStatus,
  batchUpdateStatuses,
  touchHeartbeat,
  resolveJobBatchSize,
  MAX_JOB_BATCH_SIZE,
} = require('../db/database');
const { gatewayId } = require('../utils/ids');

const router = express.Router();

/**
 * POST /api/gateway/register
 * Body: { deviceIdentifier, deviceName, androidVersion, appVersion }
 * Auth: company Bearer token → device belongs to that company only
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

    const id = registerOrUpdateDevice({
      companyId: req.company.id,
      deviceIdentifier: String(deviceIdentifier).trim(),
      deviceName: String(deviceName).trim(),
      androidVersion,
      appVersion,
      gatewayId: gatewayId(),
    });

    return res.json({
      success: true,
      message: 'Registered',
      gatewayId: id,
    });
  } catch (err) {
    console.error('register error:', err);
    return res.status(500).json({ success: false, error: 'Registration failed' });
  }
});

/**
 * GET /api/gateway/jobs?deviceIdentifier=...
 * Only returns QUEUED jobs for this company
 */
router.get('/jobs', (req, res) => {
  try {
    const deviceIdentifier = (req.query.deviceIdentifier || '').trim();
    if (!deviceIdentifier) {
      return res.status(400).json({
        success: false,
        error: 'deviceIdentifier query parameter is required',
      });
    }

    // Batch size comes from the APK (?limit=). Portal setting is fallback only.
    const requested = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 1), MAX_JOB_BATCH_SIZE)
      : resolveJobBatchSize(req.company);

    const jobs = pullJobs(req.company.id, deviceIdentifier, limit);

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

    if (deviceIdentifier) {
      touchHeartbeat(String(deviceIdentifier).trim(), req.company.id);
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

    if (deviceIdentifier) {
      touchHeartbeat(String(deviceIdentifier).trim(), req.company.id);
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
    if (!deviceIdentifier) {
      return res.status(400).json({ success: false, error: 'deviceIdentifier is required' });
    }
    touchHeartbeat(String(deviceIdentifier).trim(), req.company.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('heartbeat error:', err);
    return res.status(500).json({ success: false, error: 'Heartbeat failed' });
  }
});

module.exports = router;
