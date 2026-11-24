const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { newId, companyId, apiToken } = require('../utils/ids');
const { hashPassword, verifyPassword } = require('../utils/passwords');

const dataDir = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'sms_portal.db');
const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS Company (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    apiToken TEXT NOT NULL UNIQUE,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS User (
    id TEXT PRIMARY KEY,
    companyId TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    username TEXT,
    passwordHash TEXT,
    role TEXT NOT NULL DEFAULT 'admin',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (companyId) REFERENCES Company(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS Device (
    id TEXT PRIMARY KEY,
    deviceIdentifier TEXT NOT NULL UNIQUE,
    deviceName TEXT NOT NULL,
    androidVersion TEXT,
    appVersion TEXT,
    lastHeartbeat TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS Campaign (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    messageBody TEXT NOT NULL,
    totalMessages INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS MessageJob (
    id TEXT PRIMARY KEY,
    campaignId TEXT NOT NULL,
    recipientName TEXT NOT NULL DEFAULT '',
    phoneNumber TEXT NOT NULL,
    body TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'QUEUED',
    failureReason TEXT,
    simUsed INTEGER NOT NULL DEFAULT -1,
    preferredSim INTEGER NOT NULL DEFAULT -1,
    scheduledTime TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (campaignId) REFERENCES Campaign(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ContactGroup (
    id TEXT PRIMARY KEY,
    companyId TEXT NOT NULL,
    name TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (companyId) REFERENCES Company(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS Contact (
    id TEXT PRIMARY KEY,
    companyId TEXT NOT NULL,
    groupId TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    phoneNumber TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (companyId) REFERENCES Company(id) ON DELETE CASCADE,
    FOREIGN KEY (groupId) REFERENCES ContactGroup(id) ON DELETE CASCADE
  );
`);

function tableColumns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function ensureColumn(table, column, definition) {
  const cols = tableColumns(table);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Migrate older DBs / add columns before creating indexes on them
ensureColumn('Device', 'companyId', 'TEXT');
ensureColumn('Campaign', 'companyId', 'TEXT');
ensureColumn('MessageJob', 'companyId', 'TEXT');
ensureColumn('User', 'username', 'TEXT');
ensureColumn('User', 'passwordHash', 'TEXT');
ensureColumn('Company', 'jobBatchSize', 'INTEGER');
ensureColumn('Company', 'isMasterWorkspace', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('Campaign', 'status', "TEXT NOT NULL DEFAULT 'ACTIVE'");

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_user_company ON User(companyId);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_user_username ON User(username);
  CREATE INDEX IF NOT EXISTS idx_device_company ON Device(companyId);
  CREATE INDEX IF NOT EXISTS idx_campaign_company ON Campaign(companyId);
  CREATE INDEX IF NOT EXISTS idx_messagejob_company ON MessageJob(companyId);
  CREATE INDEX IF NOT EXISTS idx_messagejob_status ON MessageJob(status);
  CREATE INDEX IF NOT EXISTS idx_messagejob_campaign ON MessageJob(campaignId);
  CREATE INDEX IF NOT EXISTS idx_messagejob_company_status ON MessageJob(companyId, status);
  CREATE INDEX IF NOT EXISTS idx_messagejob_priority ON MessageJob(priority DESC, createdAt ASC);
  CREATE INDEX IF NOT EXISTS idx_device_identifier ON Device(deviceIdentifier);
  CREATE INDEX IF NOT EXISTS idx_company_token ON Company(apiToken);
  CREATE INDEX IF NOT EXISTS idx_contactgroup_company ON ContactGroup(companyId);
  CREATE INDEX IF NOT EXISTS idx_contact_group ON Contact(groupId);
  CREATE INDEX IF NOT EXISTS idx_contact_company ON Contact(companyId);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_group_phone ON Contact(groupId, phoneNumber);
`);

const VALID_STATUSES = new Set([
  'QUEUED',
  'PROCESSING',
  'SENT',
  'DELIVERED',
  'SEND_FAILED',
  'DELIVERY_FAILED',
]);

const DEFAULT_JOB_BATCH_SIZE = 10;
const MAX_JOB_BATCH_SIZE = 50;

function normalizeStatus(status) {
  if (!status) return null;
  const s = String(status).toUpperCase().trim();
  return VALID_STATUSES.has(s) ? s : null;
}

/** Clamp to 1..50; returns null if invalid/empty */
function clampJobBatchSize(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, 1), MAX_JOB_BATCH_SIZE);
}

/**
 * Effective jobs-per-pull for a company.
 * Uses Company.jobBatchSize when set; else JOB_BATCH_SIZE env; else 10.
 */
function resolveJobBatchSize(company) {
  const fromCompany = clampJobBatchSize(company?.jobBatchSize);
  if (fromCompany != null) return fromCompany;
  return clampJobBatchSize(process.env.JOB_BATCH_SIZE) || DEFAULT_JOB_BATCH_SIZE;
}

function updateCompanySettings(companyIdValue, { jobBatchSize } = {}) {
  const company = getCompanyById(companyIdValue);
  if (!company) {
    throw new Error('Company not found');
  }

  if (jobBatchSize !== undefined) {
    const clamped = clampJobBatchSize(jobBatchSize);
    if (clamped == null) {
      throw new Error(`jobBatchSize must be a number between 1 and ${MAX_JOB_BATCH_SIZE}`);
    }
    db.prepare('UPDATE Company SET jobBatchSize = ? WHERE id = ?').run(clamped, companyIdValue);
  }

  return getCompanyById(companyIdValue);
}

function withTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {
      /* ignore */
    }
    throw err;
  }
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    email: row.email,
    username: row.username,
    role: row.role,
    createdAt: row.createdAt,
  };
}

function usersDictForCompany(companyIdValue) {
  const rows = db
    .prepare(
      `SELECT id, companyId, name, email, username, role, createdAt
       FROM User WHERE companyId = ? ORDER BY createdAt ASC`
    )
    .all(companyIdValue);
  const users = {};
  for (const row of rows) {
    users[row.id] = publicUser(row);
  }
  return users;
}

function findUserByUsername(username) {
  if (!username) return null;
  return (
    db
      .prepare('SELECT * FROM User WHERE lower(username) = lower(?)')
      .get(String(username).trim()) || null
  );
}

/**
 * Company user login with username + password.
 * Returns { user, company } or null
 */
function loginWithPassword(username, password) {
  const user = findUserByUsername(username);
  if (!user || !user.passwordHash) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  const company = getCompanyById(user.companyId);
  if (!company) return null;
  return { user: publicUser(user), company };
}

function getCompanyByToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM Company WHERE apiToken = ?').get(token) || null;
}

function getCompanyById(id) {
  return db.prepare('SELECT * FROM Company WHERE id = ?').get(id) || null;
}

function listCompanies() {
  const companies = db
    .prepare(
      `SELECT * FROM Company
       WHERE COALESCE(isMasterWorkspace, 0) = 0
       ORDER BY createdAt DESC`
    )
    .all();
  return companies.map((c) => {
    const users = usersDictForCompany(c.id);
    return {
      ...c,
      users,
      userCount: Object.keys(users).length,
      campaignCount: db.prepare('SELECT COUNT(*) AS c FROM Campaign WHERE companyId = ?').get(c.id).c,
      deviceCount: db.prepare('SELECT COUNT(*) AS c FROM Device WHERE companyId = ?').get(c.id).c,
    };
  });
}

/**
 * Dedicated tenant for Master Admin to send campaigns like a company.
 * Hidden from the companies list. Android gateway uses this company's apiToken.
 */
function ensureMasterWorkspace() {
  let row = db.prepare('SELECT * FROM Company WHERE COALESCE(isMasterWorkspace, 0) = 1 LIMIT 1').get();
  if (row) return row;

  const id = companyId();
  const token = apiToken();
  const now = new Date().toISOString();

  withTransaction(() => {
    db.prepare(
      `INSERT INTO Company (id, name, apiToken, createdAt, isMasterWorkspace)
       VALUES (?, ?, ?, ?, 1)`
    ).run(id, 'Master Workspace', token, now);

    const uid = newId();
    db.prepare(
      `INSERT INTO User (id, companyId, name, email, username, passwordHash, role)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uid,
      id,
      'Master Admin',
      'master@workspace.local',
      '_master_workspace',
      hashPassword(apiToken()),
      'admin'
    );
  });

  return getCompanyById(id);
}

function getMasterWorkspace() {
  return ensureMasterWorkspace();
}

function publicCompany(company) {
  if (!company) return null;
  return {
    id: company.id,
    name: company.name,
    apiToken: company.apiToken,
    createdAt: company.createdAt,
    jobBatchSize: company.jobBatchSize,
    isMasterWorkspace: !!company.isMasterWorkspace,
  };
}

// Boot: ensure master SMS workspace exists
ensureMasterWorkspace();

/**
 * Create company with required users list.
 * users: [{ name, email, username, password, role? }, ...] — at least one required
 * Returns company + users as a dictionary keyed by user id
 */
function createCompany({ name, users }) {
  if (!name || !String(name).trim()) {
    throw new Error('Company name is required');
  }
  if (!Array.isArray(users) || users.length === 0) {
    throw new Error('At least one user is required');
  }

  const normalized = [];
  const seenUsernames = new Set();

  for (const u of users) {
    if (!u || !String(u.name || '').trim() || !String(u.email || '').trim()) {
      throw new Error('Each user needs name and email');
    }
    const username = String(u.username || '').trim().toLowerCase();
    const password = String(u.password || '');
    if (!username || username.length < 3) {
      throw new Error('Each user needs a username (min 3 characters)');
    }
    if (!/^[a-z0-9._-]+$/.test(username)) {
      throw new Error(`Invalid username "${username}" (use letters, numbers, . _ -)`);
    }
    if (password.length < 6) {
      throw new Error(`Password for "${username}" must be at least 6 characters`);
    }
    if (seenUsernames.has(username)) {
      throw new Error(`Duplicate username "${username}" in request`);
    }
    seenUsernames.add(username);

    const existing = findUserByUsername(username);
    if (existing) {
      throw new Error(`Username "${username}" is already taken`);
    }

    normalized.push({
      name: String(u.name).trim(),
      email: String(u.email).trim().toLowerCase(),
      username,
      password,
      role: String(u.role || 'admin').trim() || 'admin',
    });
  }

  const id = companyId();
  const token = apiToken();
  const now = new Date().toISOString();
  const usersDict = {};

  withTransaction(() => {
    db.prepare(
      `INSERT INTO Company (id, name, apiToken, createdAt) VALUES (?, ?, ?, ?)`
    ).run(id, String(name).trim(), token, now);

    const insertUser = db.prepare(
      `INSERT INTO User (id, companyId, name, email, username, passwordHash, role)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    for (const u of normalized) {
      const uid = newId();
      const profile = {
        id: uid,
        companyId: id,
        name: u.name,
        email: u.email,
        username: u.username,
        role: u.role,
        createdAt: now,
      };
      insertUser.run(uid, id, u.name, u.email, u.username, hashPassword(u.password), u.role);
      usersDict[uid] = profile;
    }
  });

  return {
    id,
    name: String(name).trim(),
    apiToken: token,
    createdAt: now,
    users: usersDict,
  };
}

/**
 * Update company name and/or users.
 * users items with id → update existing (password optional)
 * users items without id → create new (password required)
 * removeUserIds → delete those users (cannot remove last user)
 */
function updateCompany(id, { name, users, removeUserIds = [] } = {}) {
  const company = getCompanyById(id);
  if (!company) {
    throw new Error('Company not found');
  }

  const currentUsers = usersDictForCompany(id);
  const currentIds = new Set(Object.keys(currentUsers));

  if (Array.isArray(removeUserIds)) {
    for (const rid of removeUserIds) {
      if (!currentIds.has(rid)) {
        throw new Error(`User ${rid} not found on this company`);
      }
    }
    const remaining = currentIds.size - removeUserIds.length;
    const adding = Array.isArray(users) ? users.filter((u) => !u.id).length : 0;
    if (remaining + adding < 1) {
      throw new Error('Company must keep at least one user');
    }
  }

  const seenUsernames = new Set();

  if (Array.isArray(users)) {
    for (const u of users) {
      if (!u || !String(u.name || '').trim() || !String(u.email || '').trim()) {
        throw new Error('Each user needs name and email');
      }
      const username = String(u.username || '').trim().toLowerCase();
      if (!username || username.length < 3) {
        throw new Error('Each user needs a username (min 3 characters)');
      }
      if (!/^[a-z0-9._-]+$/.test(username)) {
        throw new Error(`Invalid username "${username}"`);
      }
      if (seenUsernames.has(username)) {
        throw new Error(`Duplicate username "${username}"`);
      }
      seenUsernames.add(username);

      const other = findUserByUsername(username);
      if (other && other.id !== u.id) {
        throw new Error(`Username "${username}" is already taken`);
      }

      if (u.id) {
        if (!currentIds.has(u.id)) {
          throw new Error(`User ${u.id} not found on this company`);
        }
        if (u.password && String(u.password).length > 0 && String(u.password).length < 6) {
          throw new Error(`Password for "${username}" must be at least 6 characters`);
        }
      } else {
        const password = String(u.password || '');
        if (password.length < 6) {
          throw new Error(`New user "${username}" needs a password (min 6 characters)`);
        }
      }
    }
  }

  withTransaction(() => {
    if (name && String(name).trim()) {
      db.prepare('UPDATE Company SET name = ? WHERE id = ?').run(String(name).trim(), id);
    }

    if (Array.isArray(removeUserIds)) {
      const del = db.prepare('DELETE FROM User WHERE id = ? AND companyId = ?');
      for (const rid of removeUserIds) {
        del.run(rid, id);
      }
    }

    if (Array.isArray(users)) {
      const updateUser = db.prepare(
        `UPDATE User
         SET name = ?, email = ?, username = ?, role = ?,
             passwordHash = CASE WHEN ? IS NOT NULL THEN ? ELSE passwordHash END
         WHERE id = ? AND companyId = ?`
      );
      const insertUser = db.prepare(
        `INSERT INTO User (id, companyId, name, email, username, passwordHash, role)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );

      for (const u of users) {
        const username = String(u.username).trim().toLowerCase();
        const email = String(u.email).trim().toLowerCase();
        const uname = String(u.name).trim();
        const role = String(u.role || 'admin').trim() || 'admin';
        const newPass = u.password && String(u.password).length >= 6 ? hashPassword(u.password) : null;

        if (u.id) {
          updateUser.run(uname, email, username, role, newPass, newPass, u.id, id);
        } else {
          insertUser.run(newId(), id, uname, email, username, hashPassword(u.password), role);
        }
      }
    }
  });

  const updated = getCompanyById(id);
  return {
    ...updated,
    users: usersDictForCompany(id),
  };
}

function regenerateCompanyToken(id) {
  const company = getCompanyById(id);
  if (!company) return null;
  const token = apiToken();
  db.prepare('UPDATE Company SET apiToken = ? WHERE id = ?').run(token, id);
  return { ...company, apiToken: token, users: usersDictForCompany(id) };
}

function deleteCompany(id) {
  const company = getCompanyById(id);
  if (company && Number(company.isMasterWorkspace) === 1) {
    throw new Error('Cannot delete the Master Workspace');
  }
  if (!company) return false;
  withTransaction(() => {
    db.prepare('DELETE FROM Contact WHERE companyId = ?').run(id);
    db.prepare('DELETE FROM ContactGroup WHERE companyId = ?').run(id);
    db.prepare('DELETE FROM MessageJob WHERE companyId = ?').run(id);
    db.prepare('DELETE FROM Campaign WHERE companyId = ?').run(id);
    db.prepare('DELETE FROM Device WHERE companyId = ?').run(id);
    db.prepare('DELETE FROM User WHERE companyId = ?').run(id);
    db.prepare('DELETE FROM Company WHERE id = ?').run(id);
  });
  return true;
}

function listContactGroups(companyIdValue) {
  return db
    .prepare(
      `SELECT g.*,
        (SELECT COUNT(*) FROM Contact c WHERE c.groupId = g.id) AS contactCount
       FROM ContactGroup g
       WHERE g.companyId = ?
       ORDER BY g.createdAt DESC`
    )
    .all(companyIdValue);
}

function getContactGroup(companyIdValue, groupId) {
  return db
    .prepare('SELECT * FROM ContactGroup WHERE id = ? AND companyId = ?')
    .get(groupId, companyIdValue);
}

function createContactGroup(companyIdValue, name) {
  if (!name || !String(name).trim()) {
    throw new Error('Group name is required');
  }
  const id = `grp_${newId().replace(/-/g, '').slice(0, 12)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO ContactGroup (id, companyId, name, createdAt) VALUES (?, ?, ?, ?)`
  ).run(id, companyIdValue, String(name).trim(), now);
  return { id, companyId: companyIdValue, name: String(name).trim(), createdAt: now, contactCount: 0 };
}

/**
 * Create one group (full) or many split groups.
 * splitSize empty/0/null => one group with all contacts named `name`
 * splitSize 500 with 2000 contacts => name_1 … name_4 (500 each)
 */
function createContactGroupsWithSplit(companyIdValue, { name, contacts = [], splitSize = null }) {
  const baseName = String(name || '').trim();
  if (!baseName) throw new Error('Group name is required');

  const list = Array.isArray(contacts) ? contacts : [];
  const size = splitSize === null || splitSize === undefined || splitSize === ''
    ? 0
    : parseInt(splitSize, 10);

  if (Number.isNaN(size) || size < 0) {
    throw new Error('Split size must be a positive number, or leave empty for full');
  }

  // No contacts, or no split → single group
  if (list.length === 0 || !size) {
    const group = createContactGroup(companyIdValue, baseName);
    let importResult = null;
    if (list.length > 0) {
      importResult = importContactsToGroup(companyIdValue, group.id, list);
      group.contactCount = importResult.contactCount;
    }
    return {
      groups: [group],
      totalContacts: importResult ? importResult.added : 0,
      splitSize: null,
    };
  }

  if (size < 1) {
    throw new Error('Split size must be at least 1');
  }

  const chunks = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }

  const groups = [];
  let totalAdded = 0;

  chunks.forEach((chunk, index) => {
    const groupName = `${baseName}_${index + 1}`;
    const group = createContactGroup(companyIdValue, groupName);
    const importResult = importContactsToGroup(companyIdValue, group.id, chunk);
    group.contactCount = importResult.contactCount;
    totalAdded += importResult.added;
    groups.push(group);
  });

  return {
    groups,
    totalContacts: totalAdded,
    splitSize: size,
  };
}

function clearGroupContacts(companyIdValue, groupId) {
  const group = getContactGroup(companyIdValue, groupId);
  if (!group) throw new Error('Group not found');
  const result = db
    .prepare('DELETE FROM Contact WHERE groupId = ? AND companyId = ?')
    .run(groupId, companyIdValue);
  return { deleted: result.changes, groupId };
}

function renameContactGroup(companyIdValue, groupId, name) {
  if (!name || !String(name).trim()) {
    throw new Error('Group name is required');
  }
  const result = db
    .prepare('UPDATE ContactGroup SET name = ? WHERE id = ? AND companyId = ?')
    .run(String(name).trim(), groupId, companyIdValue);
  if (result.changes === 0) throw new Error('Group not found');
  return getContactGroup(companyIdValue, groupId);
}

function deleteContactGroup(companyIdValue, groupId) {
  const group = getContactGroup(companyIdValue, groupId);
  if (!group) return false;
  withTransaction(() => {
    db.prepare('DELETE FROM Contact WHERE groupId = ? AND companyId = ?').run(groupId, companyIdValue);
    db.prepare('DELETE FROM ContactGroup WHERE id = ? AND companyId = ?').run(groupId, companyIdValue);
  });
  return true;
}

function listContacts(companyIdValue, groupId) {
  return db
    .prepare(
      `SELECT * FROM Contact
       WHERE companyId = ? AND groupId = ?
       ORDER BY name ASC, phoneNumber ASC`
    )
    .all(companyIdValue, groupId);
}

/**
 * Import contacts into a group.
 * contacts: [{ name, phoneNumber }]
 * Returns { added, skipped }
 */
function importContactsToGroup(companyIdValue, groupId, contacts) {
  const group = getContactGroup(companyIdValue, groupId);
  if (!group) throw new Error('Group not found');
  if (!Array.isArray(contacts) || contacts.length === 0) {
    throw new Error('At least one contact is required');
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO Contact (id, companyId, groupId, name, phoneNumber)
     VALUES (?, ?, ?, ?, ?)`
  );

  let added = 0;
  let skipped = 0;

  withTransaction(() => {
    for (const c of contacts) {
      let phone = String(c.phoneNumber ?? c.phone ?? '').trim().replace(/[\s\-().]/g, '');
      if (phone.includes(':')) phone = phone.split(':').pop();
      const digits = phone.replace(/\D/g, '');
      if (digits.length < 7) {
        skipped += 1;
        continue;
      }
      const name = String(c.name ?? c.recipientName ?? '').trim();
      const result = insert.run(newId(), companyIdValue, groupId, name, phone);
      if (result.changes > 0) added += 1;
      else skipped += 1;
    }
  });

  return { added, skipped, groupId, contactCount: listContacts(companyIdValue, groupId).length };
}

function getGroupRecipients(companyIdValue, groupId) {
  const rows = listContacts(companyIdValue, groupId);
  return {
    phones: rows.map((r) => r.phoneNumber),
    names: rows.map((r) => r.name || ''),
  };
}

function deleteContact(companyIdValue, contactId) {
  const result = db
    .prepare('DELETE FROM Contact WHERE id = ? AND companyId = ?')
    .run(contactId, companyIdValue);
  return result.changes > 0;
}

function getOverviewStats(companyIdValue) {
  const campaigns = db
    .prepare('SELECT COUNT(*) AS c FROM Campaign WHERE companyId = ?')
    .get(companyIdValue).c;
  const byStatus = db
    .prepare('SELECT status, COUNT(*) AS c FROM MessageJob WHERE companyId = ? GROUP BY status')
    .all(companyIdValue);

  const counts = {
    totalCampaigns: campaigns,
    totalQueued: 0,
    totalProcessing: 0,
    totalSent: 0,
    totalDelivered: 0,
    totalFailed: 0,
    totalMessages: 0,
  };

  for (const row of byStatus) {
    counts.totalMessages += row.c;
    if (row.status === 'QUEUED') counts.totalQueued = row.c;
    else if (row.status === 'PROCESSING') counts.totalProcessing = row.c;
    else if (row.status === 'SENT') counts.totalSent = row.c;
    else if (row.status === 'DELIVERED') counts.totalDelivered = row.c;
    else if (row.status === 'SEND_FAILED' || row.status === 'DELIVERY_FAILED') {
      counts.totalFailed += row.c;
    }
  }

  return counts;
}

/** Master dashboard: aggregate + per-company SMS stats (includes Master Workspace). */
function getMasterOverview() {
  const companies = db
    .prepare(
      `SELECT * FROM Company
       ORDER BY COALESCE(isMasterWorkspace, 0) DESC, createdAt DESC`
    )
    .all();

  const totals = {
    totalCompanies: 0,
    totalCampaigns: 0,
    totalQueued: 0,
    totalProcessing: 0,
    totalSent: 0,
    totalDelivered: 0,
    totalFailed: 0,
    totalMessages: 0,
    totalDevices: 0,
  };

  const rows = companies.map((c) => {
    const stats = getOverviewStats(c.id);
    const userCount = db
      .prepare('SELECT COUNT(*) AS c FROM User WHERE companyId = ?')
      .get(c.id).c;
    const deviceCount = db
      .prepare('SELECT COUNT(*) AS c FROM Device WHERE companyId = ?')
      .get(c.id).c;
    const isMasterWorkspace = !!c.isMasterWorkspace;

    if (!isMasterWorkspace) totals.totalCompanies += 1;
    totals.totalCampaigns += stats.totalCampaigns;
    totals.totalQueued += stats.totalQueued;
    totals.totalProcessing += stats.totalProcessing;
    totals.totalSent += stats.totalSent;
    totals.totalDelivered += stats.totalDelivered;
    totals.totalFailed += stats.totalFailed;
    totals.totalMessages += stats.totalMessages;
    totals.totalDevices += deviceCount;

    return {
      id: c.id,
      name: c.name,
      isMasterWorkspace,
      userCount,
      deviceCount,
      createdAt: c.createdAt,
      ...stats,
    };
  });

  return { totals, companies: rows };
}

function registerOrUpdateDevice({
  companyId: companyIdValue,
  deviceIdentifier,
  deviceName,
  androidVersion,
  appVersion,
  gatewayId,
}) {
  const now = new Date().toISOString();
  const existing = db
    .prepare('SELECT * FROM Device WHERE deviceIdentifier = ?')
    .get(deviceIdentifier);

  if (existing) {
    // Device moves to the company whose token was used to register
    db.prepare(
      `UPDATE Device
       SET companyId = ?, deviceName = ?, androidVersion = ?, appVersion = ?, lastHeartbeat = ?
       WHERE deviceIdentifier = ?`
    ).run(
      companyIdValue,
      deviceName,
      androidVersion || null,
      appVersion || null,
      now,
      deviceIdentifier
    );
    return existing.id;
  }

  db.prepare(
    `INSERT INTO Device (id, companyId, deviceIdentifier, deviceName, androidVersion, appVersion, lastHeartbeat)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    gatewayId,
    companyIdValue,
    deviceIdentifier,
    deviceName,
    androidVersion || null,
    appVersion || null,
    now
  );

  return gatewayId;
}

function touchHeartbeat(deviceIdentifier, companyIdValue) {
  const now = new Date().toISOString();
  if (companyIdValue) {
    db.prepare(
      'UPDATE Device SET lastHeartbeat = ? WHERE deviceIdentifier = ? AND companyId = ?'
    ).run(now, deviceIdentifier, companyIdValue);
  } else {
    db.prepare('UPDATE Device SET lastHeartbeat = ? WHERE deviceIdentifier = ?').run(
      now,
      deviceIdentifier
    );
  }
}

function pullJobs(companyIdValue, deviceIdentifier, limit) {
  touchHeartbeat(deviceIdentifier, companyIdValue);

  const select = db.prepare(
    `SELECT m.id, m.campaignId, m.recipientName, m.phoneNumber, m.body, m.priority, m.scheduledTime, m.preferredSim
     FROM MessageJob m
     INNER JOIN Campaign c ON c.id = m.campaignId
     WHERE m.status = 'QUEUED'
       AND m.companyId = ?
       AND UPPER(COALESCE(c.status, 'ACTIVE')) = 'ACTIVE'
     ORDER BY m.priority DESC, m.createdAt ASC
     LIMIT ?`
  );

  const markProcessing = db.prepare(
    `UPDATE MessageJob
     SET status = 'PROCESSING', updatedAt = ?
     WHERE id = ? AND status = 'QUEUED' AND companyId = ?`
  );

  return withTransaction(() => {
    const rows = select.all(companyIdValue, limit);
    const now = new Date().toISOString();
    const claimed = [];

    for (const row of rows) {
      const result = markProcessing.run(now, row.id, companyIdValue);
      if (result.changes > 0) {
        claimed.push({
          id: row.id,
          campaignId: row.campaignId,
          recipientName: row.recipientName || '',
          phoneNumber: row.phoneNumber,
          body: row.body,
          priority: row.priority,
          scheduledTime: row.scheduledTime,
          preferredSim: row.preferredSim,
        });
      }
    }
    return claimed;
  });
}

function updateMessageStatus({ companyId: companyIdValue, messageId, status, failureReason, simSlot }) {
  const normalized = normalizeStatus(status);
  if (!normalized) {
    return { ok: false, error: `Invalid status: ${status}` };
  }

  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE MessageJob
       SET status = ?,
           failureReason = ?,
           simUsed = COALESCE(?, simUsed),
           updatedAt = ?
       WHERE id = ? AND companyId = ?`
    )
    .run(
      normalized,
      failureReason || null,
      simSlot !== undefined && simSlot !== null ? Number(simSlot) : null,
      now,
      messageId,
      companyIdValue
    );

  if (result.changes === 0) {
    return { ok: false, error: 'Message not found' };
  }
  return { ok: true };
}

function batchUpdateStatuses(companyIdValue, events) {
  const updateOne = db.prepare(
    `UPDATE MessageJob
     SET status = ?,
         failureReason = ?,
         simUsed = COALESCE(?, simUsed),
         updatedAt = ?
     WHERE id = ? AND companyId = ?`
  );

  return withTransaction(() => {
    let updated = 0;
    const errors = [];

    for (const event of events) {
      const normalized = normalizeStatus(event.status);
      if (!normalized) {
        errors.push({ messageId: event.messageId, error: `Invalid status: ${event.status}` });
        continue;
      }
      const now = event.timestamp || new Date().toISOString();
      const result = updateOne.run(
        normalized,
        event.failureReason || null,
        event.simSlot !== undefined && event.simSlot !== null ? Number(event.simSlot) : null,
        now,
        event.messageId,
        companyIdValue
      );
      if (result.changes > 0) updated += 1;
      else errors.push({ messageId: event.messageId, error: 'Message not found' });
    }

    return { updated, errors };
  });
}

/**
 * Bulk reset messages back to QUEUED so gateways can pull them again.
 * Options (at least one of fromStatuses / messageIds required):
 * - campaignId: optional scope
 * - fromStatuses: statuses to reverse (e.g. PROCESSING, SEND_FAILED)
 * - messageIds: specific job ids
 */
function requeueMessages({
  companyId: companyIdValue,
  campaignId: campaignIdValue,
  fromStatuses,
  messageIds,
} = {}) {
  const ids = Array.isArray(messageIds)
    ? [...new Set(messageIds.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];

  let statuses = [];
  if (Array.isArray(fromStatuses)) {
    statuses = [
      ...new Set(
        fromStatuses
          .map((s) => normalizeStatus(s))
          .filter((s) => s && s !== 'QUEUED')
      ),
    ];
  }

  if (ids.length === 0 && statuses.length === 0) {
    throw new Error('Provide fromStatuses and/or messageIds');
  }

  const now = new Date().toISOString();
  const params = [now, companyIdValue];
  const where = [`companyId = ?`, `status != 'QUEUED'`];

  if (campaignIdValue) {
    where.push('campaignId = ?');
    params.push(String(campaignIdValue).trim());
  }

  if (ids.length > 0) {
    where.push(`id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }

  if (statuses.length > 0) {
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }

  const sql = `
    UPDATE MessageJob
    SET status = 'QUEUED',
        failureReason = NULL,
        updatedAt = ?
    WHERE ${where.join(' AND ')}
  `;

  const result = db.prepare(sql).run(...params);
  return {
    updated: result.changes || 0,
    fromStatuses: statuses,
    campaignId: campaignIdValue || null,
    messageIdCount: ids.length,
  };
}

function normalizeCampaignStatus(status) {
  const s = String(status || 'ACTIVE').toUpperCase().trim();
  return s === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
}

function createCampaign({
  companyId: companyIdValue,
  id,
  title,
  messageBody,
  phones,
  recipientNames = [],
  status = 'ACTIVE',
}) {
  const campaignStatus = normalizeCampaignStatus(status);
  const insertCampaign = db.prepare(
    `INSERT INTO Campaign (id, companyId, title, messageBody, totalMessages, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertJob = db.prepare(
    `INSERT INTO MessageJob (id, companyId, campaignId, recipientName, phoneNumber, body, priority, status)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'QUEUED')`
  );

  withTransaction(() => {
    insertCampaign.run(id, companyIdValue, title, messageBody, phones.length, campaignStatus);
    for (let i = 0; i < phones.length; i++) {
      insertJob.run(newId(), companyIdValue, id, recipientNames[i] || '', phones[i], messageBody);
    }
  });

  return { id, totalMessages: phones.length, status: campaignStatus };
}

function setCampaignStatus(companyIdValue, campaignIdValue, status) {
  const campaignStatus = normalizeCampaignStatus(status);
  const result = db
    .prepare(
      `UPDATE Campaign SET status = ? WHERE id = ? AND companyId = ?`
    )
    .run(campaignStatus, campaignIdValue, companyIdValue);
  if (!result.changes) {
    throw new Error('Campaign not found');
  }
  return getCampaign(companyIdValue, campaignIdValue);
}

function listCampaigns(companyIdValue) {
  return db
    .prepare(
      `SELECT c.*,
        COALESCE(c.status, 'ACTIVE') AS status,
        (SELECT COUNT(*) FROM MessageJob m WHERE m.campaignId = c.id AND m.status = 'QUEUED') AS queued,
        (SELECT COUNT(*) FROM MessageJob m WHERE m.campaignId = c.id AND m.status = 'PROCESSING') AS processing,
        (SELECT COUNT(*) FROM MessageJob m WHERE m.campaignId = c.id AND m.status = 'SENT') AS sent,
        (SELECT COUNT(*) FROM MessageJob m WHERE m.campaignId = c.id AND m.status = 'DELIVERED') AS delivered,
        (SELECT COUNT(*) FROM MessageJob m WHERE m.campaignId = c.id AND m.status IN ('SEND_FAILED','DELIVERY_FAILED')) AS failed
       FROM Campaign c
       WHERE c.companyId = ?
       ORDER BY c.createdAt DESC`
    )
    .all(companyIdValue);
}

function listMessages({ companyId: companyIdValue, limit = 100, offset = 0, status, campaignId } = {}) {
  let sql = `
    SELECT m.*, c.title AS campaignTitle
    FROM MessageJob m
    LEFT JOIN Campaign c ON c.id = m.campaignId
    WHERE m.companyId = ?
  `;
  const params = [companyIdValue];

  if (status) {
    sql += ' AND m.status = ?';
    params.push(status);
  }
  if (campaignId) {
    sql += ' AND m.campaignId = ?';
    params.push(campaignId);
  }

  sql += ' ORDER BY m.updatedAt DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

function listDevices(companyIdValue) {
  return db
    .prepare('SELECT * FROM Device WHERE companyId = ? ORDER BY lastHeartbeat DESC')
    .all(companyIdValue);
}

function getCampaign(companyIdValue, id) {
  return db
    .prepare('SELECT * FROM Campaign WHERE id = ? AND companyId = ?')
    .get(id, companyIdValue);
}

module.exports = {
  db,
  VALID_STATUSES,
  DEFAULT_JOB_BATCH_SIZE,
  MAX_JOB_BATCH_SIZE,
  normalizeStatus,
  clampJobBatchSize,
  resolveJobBatchSize,
  updateCompanySettings,
  getCompanyByToken,
  getCompanyById,
  listCompanies,
  ensureMasterWorkspace,
  getMasterWorkspace,
  publicCompany,
  createCompany,
  updateCompany,
  regenerateCompanyToken,
  deleteCompany,
  usersDictForCompany,
  loginWithPassword,
  findUserByUsername,
  publicUser,
  getOverviewStats,
  getMasterOverview,
  registerOrUpdateDevice,
  touchHeartbeat,
  pullJobs,
  updateMessageStatus,
  batchUpdateStatuses,
  requeueMessages,
  createCampaign,
  setCampaignStatus,
  normalizeCampaignStatus,
  listCampaigns,
  listMessages,
  listDevices,
  getCampaign,
  listContactGroups,
  getContactGroup,
  createContactGroup,
  createContactGroupsWithSplit,
  renameContactGroup,
  deleteContactGroup,
  clearGroupContacts,
  listContacts,
  importContactsToGroup,
  getGroupRecipients,
  deleteContact,
};
