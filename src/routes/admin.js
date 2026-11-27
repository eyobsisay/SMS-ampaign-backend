const express = require('express');
const {
  getOverviewStats,
  createCampaign,
  setCampaignStatus,
  setCampaignDevice,
  updateCampaign,
  deleteCampaign,
  normalizeCampaignStatus,
  listCampaigns,
  listMessages,
  listDevices,
  getCampaign,
  usersDictForCompany,
  listContactGroups,
  getContactGroup,
  createContactGroupsWithSplit,
  renameContactGroup,
  deleteContactGroup,
  clearGroupContacts,
  listContacts,
  importContactsToGroup,
  getGroupRecipients,
  updateContact,
  deleteContact,
  resolveJobBatchSize,
  updateCompanySettings,
  regenerateCompanyToken,
  publicCompany,
  MAX_JOB_BATCH_SIZE,
  DEFAULT_JOB_BATCH_SIZE,
  requeueMessages,
  VALID_STATUSES,
} = require('../db/database');
const { campaignId } = require('../utils/ids');

const router = express.Router();

function normalizePhone(raw) {
  if (raw === null || raw === undefined) return '';
  let number = String(raw).trim().replace(/[\s\-().]/g, '');
  if (number.includes(':')) number = number.split(':').pop();
  return number;
}

function isValidPhone(number) {
  const digits = String(number || '').replace(/\D/g, '');
  return digits.length >= 7;
}

/** Returns { phones, names } from textarea (supports "Name:phone" lines) */
function parsePhoneList(raw) {
  if (!raw || typeof raw !== 'string') return { phones: [], names: [] };

  const parts = raw
    .split(/[\n,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const phones = [];
  const names = [];
  const seen = new Set();

  for (const part of parts) {
    let name = '';
    let numberPart = part;
    // "Name:+2519..." or "Name, +2519..." already split by comma above for pure lists;
    // prefer Name:phone when colon present before digits dominate
    const colonIdx = part.indexOf(':');
    if (colonIdx > 0) {
      name = part.slice(0, colonIdx).trim();
      numberPart = part.slice(colonIdx + 1).trim();
    }
    const number = normalizePhone(numberPart);
    if (!isValidPhone(number)) continue;
    if (seen.has(number)) continue;
    seen.add(number);
    phones.push(number);
    names.push(name);
  }

  return { phones, names };
}

/** Accepts [{ phoneNumber, recipientName }] from Excel import */
function parseRecipientsArray(recipients) {
  const phones = [];
  const names = [];
  const seen = new Set();

  if (!Array.isArray(recipients)) return { phones, names };

  for (const r of recipients) {
    if (!r) continue;
    const number = normalizePhone(r.phoneNumber ?? r.phone ?? r.mobile);
    if (!isValidPhone(number)) continue;
    if (seen.has(number)) continue;
    seen.add(number);
    phones.push(number);
    names.push(String(r.recipientName ?? r.name ?? '').trim());
  }

  return { phones, names };
}

/** GET /api/admin/me — current company + users dict (+ apiToken for Android gateway) */
router.get('/me', (req, res) => {
  try {
    const company = req.company;
    const jobBatchSize = resolveJobBatchSize(company);
    return res.json({
      success: true,
      company: {
        id: company.id,
        name: company.name,
        apiToken: company.apiToken,
        createdAt: company.createdAt,
        jobBatchSize,
      },
      users: usersDictForCompany(company.id),
    });
  } catch (err) {
    console.error('me error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load company' });
  }
});

/** GET /api/admin/settings — gateway / pull settings for this company */
router.get('/settings', (req, res) => {
  try {
    const jobBatchSize = resolveJobBatchSize(req.company);
    return res.json({
      success: true,
      settings: {
        jobBatchSize,
        jobBatchSizeMin: 1,
        jobBatchSizeMax: MAX_JOB_BATCH_SIZE,
        jobBatchSizeDefault: DEFAULT_JOB_BATCH_SIZE,
      },
    });
  } catch (err) {
    console.error('settings get error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load settings' });
  }
});

/**
 * POST /api/admin/regenerate-token
 * Rotates this company's Android gateway API token.
 */
router.post('/regenerate-token', (req, res) => {
  try {
    const company = regenerateCompanyToken(req.company.id);
    if (!company) {
      return res.status(404).json({ success: false, error: 'Company not found' });
    }
    req.company.apiToken = company.apiToken;
    return res.json({
      success: true,
      company: publicCompany(company),
    });
  } catch (err) {
    console.error('regenerate token error:', err);
    return res.status(500).json({ success: false, error: 'Failed to regenerate token' });
  }
});

/**
 * PATCH /api/admin/settings
 * Body: { jobBatchSize: number }  // 1..50 — jobs returned per gateway pull
 */
router.patch('/settings', (req, res) => {
  try {
    const { jobBatchSize } = req.body || {};
    if (jobBatchSize === undefined) {
      return res.status(400).json({
        success: false,
        error: 'jobBatchSize is required',
      });
    }

    const company = updateCompanySettings(req.company.id, { jobBatchSize });
    const resolved = resolveJobBatchSize(company);

    // Keep auth middleware company object in sync for this request
    req.company.jobBatchSize = company.jobBatchSize;

    return res.json({
      success: true,
      settings: {
        jobBatchSize: resolved,
        jobBatchSizeMin: 1,
        jobBatchSizeMax: MAX_JOB_BATCH_SIZE,
        jobBatchSizeDefault: DEFAULT_JOB_BATCH_SIZE,
      },
    });
  } catch (err) {
    const status = err.message === 'Company not found' ? 404 : 400;
    return res.status(status).json({ success: false, error: err.message });
  }
});

/** GET /api/admin/stats */
router.get('/stats', (req, res) => {
  try {
    const stats = getOverviewStats(req.company.id);
    return res.json({ success: true, stats });
  } catch (err) {
    console.error('stats error:', err);
    return res.status(500).json({ success: false, error: 'Failed to load stats' });
  }
});

/** GET /api/admin/campaigns */
router.get('/campaigns', (req, res) => {
  try {
    const campaigns = listCampaigns(req.company.id);
    return res.json({ success: true, campaigns });
  } catch (err) {
    console.error('campaigns list error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list campaigns' });
  }
});

/** GET /api/admin/campaigns/:id */
router.get('/campaigns/:id', (req, res) => {
  try {
    const campaign = getCampaign(req.company.id, req.params.id);
    if (!campaign) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }
    return res.json({ success: true, campaign });
  } catch (err) {
    console.error('campaign get error:', err);
    return res.status(500).json({ success: false, error: 'Failed to get campaign' });
  }
});

/**
 * POST /api/admin/campaigns
 * Preferred: { title, messageBody, groupId }
 * Also supports: recipients[] or phoneNumbers (manual)
 */
router.post('/campaigns', (req, res) => {
  try {
    const {
      title,
      messageBody,
      phoneNumbers,
      recipients,
      groupId,
      status,
      assignedDeviceIdentifier,
    } = req.body || {};

    if (!title || !String(title).trim()) {
      return res.status(400).json({ success: false, error: 'title is required' });
    }
    if (!messageBody || !String(messageBody).trim()) {
      return res.status(400).json({ success: false, error: 'messageBody is required' });
    }

    let phones = [];
    let names = [];

    if (groupId) {
      const group = getContactGroup(req.company.id, groupId);
      if (!group) {
        return res.status(404).json({ success: false, error: 'Contact group not found' });
      }
      ({ phones, names } = getGroupRecipients(req.company.id, groupId));
    } else if (Array.isArray(recipients) && recipients.length > 0) {
      ({ phones, names } = parseRecipientsArray(recipients));
    } else {
      ({ phones, names } = parsePhoneList(phoneNumbers));
    }

    if (phones.length === 0) {
      return res.status(400).json({
        success: false,
        error: groupId
          ? 'Selected group has no contacts. Import contacts into the group first.'
          : 'At least one valid phone number is required',
      });
    }

    const id = campaignId();
    // New campaigns default to INACTIVE until the user Activates them.
    const campaignStatus = normalizeCampaignStatus(
      status === undefined || status === null || status === '' ? 'INACTIVE' : status
    );
    if (!assignedDeviceIdentifier || !String(assignedDeviceIdentifier).trim()) {
      return res.status(400).json({
        success: false,
        error: 'A gateway device is required',
      });
    }

    const result = createCampaign({
      companyId: req.company.id,
      id,
      title: String(title).trim(),
      messageBody: String(messageBody).trim(),
      phones,
      recipientNames: names,
      status: campaignStatus,
      assignedDeviceIdentifier,
    });

    return res.status(201).json({
      success: true,
      campaign: {
        id: result.id,
        title: String(title).trim(),
        totalMessages: result.totalMessages,
        status: result.status,
        assignedDeviceIdentifier: result.assignedDeviceIdentifier || null,
        groupId: groupId || null,
      },
    });
  } catch (err) {
    console.error('create campaign error:', err);
    const bad =
      err.message === 'Assigned device not found for this company' ||
      err.message === 'A gateway device is required';
    return res.status(bad ? 400 : 500).json({
      success: false,
      error: bad ? err.message : 'Failed to create campaign',
    });
  }
});

/**
 * PUT /api/admin/campaigns/:id
 * Body: { title?, messageBody?, assignedDeviceIdentifier?, groupId? }
 * groupId replaces contacts only when all jobs are still Queued.
 */
router.put('/campaigns/:id', (req, res) => {
  try {
    const { title, messageBody, assignedDeviceIdentifier, groupId } = req.body || {};
    if (
      title === undefined &&
      messageBody === undefined &&
      assignedDeviceIdentifier === undefined &&
      groupId === undefined
    ) {
      return res.status(400).json({
        success: false,
        error: 'Provide title, messageBody, assignedDeviceIdentifier, and/or groupId',
      });
    }
    const campaign = updateCampaign(req.company.id, req.params.id, {
      title,
      messageBody,
      assignedDeviceIdentifier,
      groupId,
    });
    return res.json({ success: true, campaign });
  } catch (err) {
    const code =
      err.message === 'Campaign not found' || err.message === 'Contact group not found'
        ? 404
        : 400;
    return res.status(code).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/admin/campaigns/:id/status
 * Body: { status: "ACTIVE" | "INACTIVE" }
 * Only ACTIVE campaigns are pulled by the Android gateway.
 * Pausing (INACTIVE) rejects further sends and requeues PROCESSING jobs.
 */
router.patch('/campaigns/:id/status', (req, res) => {
  try {
    const status = normalizeCampaignStatus((req.body || {}).status);
    const campaign = setCampaignStatus(req.company.id, req.params.id, status);
    return res.json({ success: true, campaign });
  } catch (err) {
    const code = err.message === 'Campaign not found' ? 404 : 400;
    return res.status(code).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/admin/campaigns/:id/device
 * Body: { assignedDeviceIdentifier: string } — required registered gateway.
 */
router.patch('/campaigns/:id/device', (req, res) => {
  try {
    const assignedDeviceIdentifier = (req.body || {}).assignedDeviceIdentifier;
    if (!assignedDeviceIdentifier || !String(assignedDeviceIdentifier).trim()) {
      return res.status(400).json({
        success: false,
        error: 'A gateway device is required',
      });
    }
    const campaign = setCampaignDevice(
      req.company.id,
      req.params.id,
      assignedDeviceIdentifier
    );
    return res.json({ success: true, campaign });
  } catch (err) {
    const code =
      err.message === 'Campaign not found'
        ? 404
        : err.message === 'Assigned device not found for this company' ||
            err.message === 'A gateway device is required'
          ? 400
          : 400;
    return res.status(code).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/admin/campaigns/:id
 * Deletes the campaign and all its message jobs.
 */
router.delete('/campaigns/:id', (req, res) => {
  try {
    const result = deleteCampaign(req.company.id, req.params.id);
    return res.json({ success: true, ...result });
  } catch (err) {
    const code = err.message === 'Campaign not found' ? 404 : 400;
    return res.status(code).json({ success: false, error: err.message });
  }
});

/** GET /api/admin/messages */
router.get('/messages', (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 5000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const status = req.query.status || undefined;
    const campaignIdFilter = req.query.campaignId || undefined;

    const messages = listMessages({
      companyId: req.company.id,
      limit,
      offset,
      status,
      campaignId: campaignIdFilter,
    });

    return res.json({ success: true, messages });
  } catch (err) {
    console.error('messages error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list messages' });
  }
});

/**
 * POST /api/admin/messages/requeue
 * Bulk set selected messages back to QUEUED (gateway can pull again).
 * Body: {
 *   campaignId?: string,
 *   fromStatuses?: string[],   // e.g. ["PROCESSING","SEND_FAILED"]
 *   messageIds?: string[]     // optional specific ids
 * }
 */
router.post('/messages/requeue', (req, res) => {
  try {
    const { campaignId: campaignIdFilter, fromStatuses, messageIds } = req.body || {};

    if (Array.isArray(fromStatuses)) {
      for (const s of fromStatuses) {
        const n = String(s || '').toUpperCase().trim();
        if (n && n !== 'QUEUED' && !VALID_STATUSES.has(n)) {
          return res.status(400).json({
            success: false,
            error: `Invalid status in fromStatuses: ${s}`,
          });
        }
      }
    }

    const result = requeueMessages({
      companyId: req.company.id,
      campaignId: campaignIdFilter || undefined,
      fromStatuses,
      messageIds,
    });

    return res.json({
      success: true,
      updated: result.updated,
      fromStatuses: result.fromStatuses,
      campaignId: result.campaignId,
    });
  } catch (err) {
    const status = /fromStatuses|messageIds/i.test(err.message) ? 400 : 500;
    if (status === 500) console.error('requeue error:', err);
    return res.status(status).json({ success: false, error: err.message || 'Failed to requeue' });
  }
});

/** GET /api/admin/devices */
router.get('/devices', (req, res) => {
  try {
    const devices = listDevices(req.company.id);
    return res.json({ success: true, devices });
  } catch (err) {
    console.error('devices error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list devices' });
  }
});

/** GET /api/admin/groups */
router.get('/groups', (req, res) => {
  try {
    const groups = listContactGroups(req.company.id);
    return res.json({ success: true, groups });
  } catch (err) {
    console.error('list groups error:', err);
    return res.status(500).json({ success: false, error: 'Failed to list groups' });
  }
});

/**
 * POST /api/admin/groups
 * Body: { name, contacts?: [{ name, phoneNumber }], splitSize?: number|null }
 * splitSize empty/omitted = one full group.
 * splitSize 500 with 2000 contacts => name_1 … name_4
 */
router.post('/groups', (req, res) => {
  try {
    const { name, contacts, splitSize, excludeExistingInOtherGroups } = req.body || {};
    const result = createContactGroupsWithSplit(req.company.id, {
      name,
      contacts: Array.isArray(contacts) ? contacts : [],
      splitSize,
      excludeExistingInOtherGroups: Boolean(excludeExistingInOtherGroups),
    });
    return res.status(201).json({
      success: true,
      groups: result.groups,
      group: result.groups[0] || null,
      totalContacts: result.totalContacts,
      skippedElsewhere: result.skippedElsewhere || 0,
      splitSize: result.splitSize,
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message || 'Failed to create group' });
  }
});

/** PUT /api/admin/groups/:id  Body: { name } */
router.put('/groups/:id', (req, res) => {
  try {
    const group = renameContactGroup(req.company.id, req.params.id, (req.body || {}).name);
    return res.json({ success: true, group });
  } catch (err) {
    const status = err.message === 'Group not found' ? 404 : 400;
    return res.status(status).json({ success: false, error: err.message });
  }
});

/** DELETE /api/admin/groups/:id — also deletes all contacts in the group */
router.delete('/groups/:id', (req, res) => {
  try {
    const ok = deleteContactGroup(req.company.id, req.params.id);
    if (!ok) return res.status(404).json({ success: false, error: 'Group not found' });
    return res.json({ success: true, deletedContacts: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to delete group' });
  }
});

/** DELETE /api/admin/groups/:id/contacts — clear all contacts, keep group */
router.delete('/groups/:id/contacts', (req, res) => {
  try {
    const result = clearGroupContacts(req.company.id, req.params.id);
    return res.json({ success: true, ...result });
  } catch (err) {
    const status = err.message === 'Group not found' ? 404 : 400;
    return res.status(status).json({ success: false, error: err.message });
  }
});

/** GET /api/admin/groups/:id/contacts */
router.get('/groups/:id/contacts', (req, res) => {
  try {
    const group = getContactGroup(req.company.id, req.params.id);
    if (!group) return res.status(404).json({ success: false, error: 'Group not found' });
    const contacts = listContacts(req.company.id, req.params.id);
    return res.json({ success: true, group, contacts });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to list contacts' });
  }
});

/**
 * POST /api/admin/groups/:id/import
 * Body: { contacts: [{ name, phoneNumber }], excludeExistingInOtherGroups?: boolean }
 */
router.post('/groups/:id/import', (req, res) => {
  try {
    const { contacts, excludeExistingInOtherGroups } = req.body || {};
    const result = importContactsToGroup(req.company.id, req.params.id, contacts, {
      excludeExistingInOtherGroups: Boolean(excludeExistingInOtherGroups),
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    const status = err.message === 'Group not found' ? 404 : 400;
    return res.status(status).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/admin/contacts/:id
 * Body: { name?, phoneNumber? }
 */
router.put('/contacts/:id', (req, res) => {
  try {
    const { name, phoneNumber } = req.body || {};
    if (name === undefined && phoneNumber === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Provide name and/or phoneNumber',
      });
    }
    const contact = updateContact(req.company.id, req.params.id, { name, phoneNumber });
    return res.json({ success: true, contact });
  } catch (err) {
    const status =
      err.message === 'Contact not found'
        ? 404
        : err.message === 'phoneNumber is required' ||
            err.message === 'Another contact in this group already has that phone number'
          ? 400
          : 400;
    return res.status(status).json({ success: false, error: err.message });
  }
});

/** DELETE /api/admin/contacts/:id */
router.delete('/contacts/:id', (req, res) => {
  try {
    const ok = deleteContact(req.company.id, req.params.id);
    if (!ok) return res.status(404).json({ success: false, error: 'Contact not found' });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to delete contact' });
  }
});

module.exports = router;
