(() => {
  const TOKEN_KEY = 'sms_portal_token';
  const MODE_KEY = 'sms_portal_mode';
  const USER_KEY = 'sms_portal_user';
  const MASTER_TOKEN_KEY = 'sms_portal_master_token';
  const WORKSPACE_TOKEN_KEY = 'sms_portal_workspace_token';

  let token = localStorage.getItem(TOKEN_KEY) || '';
  let mode = localStorage.getItem(MODE_KEY) || 'company';
  let masterToken = localStorage.getItem(MASTER_TOKEN_KEY) || '';
  let workspaceToken = localStorage.getItem(WORKSPACE_TOKEN_KEY) || '';
  let signedInUser = null;
  try {
    signedInUser = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    signedInUser = null;
  }

  let refreshTimer = null;
  let currentView = 'overview';
  let companyUsers = {};
  let companyApiToken = '';
  let masterWorkspace = null;

  const $ = (id) => document.getElementById(id);

  const authScreen = $('auth-screen');
  const app = $('app');
  const authError = $('auth-error');

  /** In-app alert (replaces window.alert) */
  function appAlert(message, title = 'Notice') {
    return new Promise((resolve) => {
      const dialog = $('app-dialog');
      const cancelBtn = $('app-dialog-cancel');
      const okBtn = $('app-dialog-ok');
      $('app-dialog-title').textContent = title;
      $('app-dialog-message').textContent = message;
      cancelBtn.classList.add('hidden');
      okBtn.textContent = 'OK';
      okBtn.className =
        'rounded-xl bg-ink-900 hover:bg-ink-800 text-white px-4 py-2 text-sm font-semibold';

      const close = () => {
        dialog.classList.add('hidden');
        okBtn.onclick = null;
        $('app-dialog-backdrop').onclick = null;
        resolve();
      };
      okBtn.onclick = close;
      $('app-dialog-backdrop').onclick = close;
      dialog.classList.remove('hidden');
      okBtn.focus();
    });
  }

  /** In-app confirm (replaces window.confirm) — returns true/false */
  function appConfirm(message, title = 'Confirm', { danger = false, confirmLabel } = {}) {
    return new Promise((resolve) => {
      const dialog = $('app-dialog');
      const cancelBtn = $('app-dialog-cancel');
      const okBtn = $('app-dialog-ok');
      $('app-dialog-title').textContent = title;
      $('app-dialog-message').textContent = message;
      cancelBtn.classList.remove('hidden');
      okBtn.textContent = confirmLabel || (danger ? 'Delete' : 'Confirm');
      okBtn.className = danger
        ? 'rounded-xl bg-danger hover:bg-red-700 text-white px-4 py-2 text-sm font-semibold'
        : 'rounded-xl bg-ink-900 hover:bg-ink-800 text-white px-4 py-2 text-sm font-semibold';

      const finish = (value) => {
        dialog.classList.add('hidden');
        okBtn.onclick = null;
        cancelBtn.onclick = null;
        $('app-dialog-backdrop').onclick = null;
        resolve(value);
      };
      okBtn.onclick = () => finish(true);
      cancelBtn.onclick = () => finish(false);
      $('app-dialog-backdrop').onclick = () => finish(false);
      dialog.classList.remove('hidden');
      (danger ? cancelBtn : okBtn).focus();
    });
  }

  async function api(path, options = {}) {
    let authToken = token;
    if (mode === 'master') {
      if (path.startsWith('/api/master')) authToken = masterToken || token;
      else if (path.startsWith('/api/admin') || path.startsWith('/api/gateway')) {
        authToken = workspaceToken || token;
      }
    }
    const headers = {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(options.headers || {}),
    };
    const res = await fetch(path, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/auth/login') {
      lock();
      throw new Error(data.error || 'Unauthorized');
    }
    if (!res.ok || data.success === false) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  function persistSession(nextToken, nextMode, user) {
    token = nextToken;
    mode = nextMode;
    signedInUser = user || null;
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(MODE_KEY, mode);
    if (signedInUser) localStorage.setItem(USER_KEY, JSON.stringify(signedInUser));
    else localStorage.removeItem(USER_KEY);
  }

  function setPortalNavMode(isMaster) {
    const companyNav = $('nav-company');
    const masterNav = $('nav-master');
    if (companyNav) companyNav.classList.toggle('hidden', !!isMaster);
    if (masterNav) masterNav.classList.toggle('hidden', !isMaster);
    if ($('portal-brand')) $('portal-brand').textContent = isMaster ? 'Master Admin' : 'SMS Portal';
    if ($('page-subtitle')) {
      $('page-subtitle').textContent = isMaster ? 'One portal · companies + Master SMS' : 'Company dashboard';
    }
  }

  function unlockCompany() {
    authScreen.classList.add('hidden');
    app.classList.remove('hidden');
    setPortalNavMode(false);
    if (signedInUser) {
      $('signed-in-user').textContent = signedInUser.username || signedInUser.name || '—';
    }
    startPolling();
    loadView(currentView);
  }

  async function unlockMaster() {
    authScreen.classList.add('hidden');
    app.classList.remove('hidden');
    setPortalNavMode(true);
    if (signedInUser) {
      $('signed-in-user').textContent = signedInUser.username || 'master';
    }
    if ($('company-name')) $('company-name').textContent = 'Master Workspace';

    if (!workspaceToken) {
      try {
        const data = await api('/api/master/workspace');
        masterWorkspace = data.workspace;
        workspaceToken = data.workspace?.apiToken || '';
        if (workspaceToken) localStorage.setItem(WORKSPACE_TOKEN_KEY, workspaceToken);
      } catch (err) {
        console.error(err);
      }
    }

    if (workspaceToken) {
      try {
        await loadMe();
      } catch (err) {
        console.error(err);
      }
    }

    hideCreateCompany();
    hideEditCompany();
    currentView = 'companies';
    startPolling();
    switchView('companies');
  }

  let editRemovedUserIds = [];

  function showCreateCompany() {
    hideEditCompany();
    hideCompanyOverview();
    if (mode === 'master') switchView('companies');
    const modal = $('create-company-modal');
    if ($('company-feedback')) {
      $('company-feedback').textContent = '';
      $('company-feedback').className = 'text-sm';
    }
    if ($('new-token-box')) $('new-token-box').classList.add('hidden');
    if ($('company-form')) $('company-form').reset();
    modal?.classList.remove('hidden');
    $('co-name')?.focus();
  }

  function hideCreateCompany() {
    $('create-company-modal')?.classList.add('hidden');
    if ($('company-form')) $('company-form').reset();
    if ($('company-feedback')) {
      $('company-feedback').textContent = '';
      $('company-feedback').className = 'text-sm';
    }
    if ($('new-token-box')) $('new-token-box').classList.add('hidden');
  }

  function hideEditCompany() {
    $('edit-company-panel').classList.add('hidden');
    $('edit-company-form').reset();
    $('edit-users-list').innerHTML = '';
    $('edit-company-feedback').textContent = '';
    editRemovedUserIds = [];
  }

  function userEditRow(user = null) {
    const id = user?.id || '';
    const isNew = !id;
    const rowKey = id || `new_${Math.random().toString(36).slice(2, 8)}`;
    return `
      <div class="edit-user-row rounded-xl border border-slate-200 bg-slate-50/80 p-4 space-y-3" data-user-id="${escapeHtml(id)}">
        <div class="grid sm:grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Full Name</label>
            <input type="text" data-field="name" required placeholder="e.g. Jane Doe" value="${escapeHtml(user?.name || '')}"
              class="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent" />
          </div>
          <div>
            <label class="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Email</label>
            <input type="email" data-field="email" required placeholder="e.g. jane@company.com" value="${escapeHtml(user?.email || '')}"
              class="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent" />
          </div>
          <div>
            <label class="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Role</label>
            <select data-field="role" class="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent">
              <option value="admin" ${user?.role === 'admin' || !user ? 'selected' : ''}>admin</option>
              <option value="member" ${user?.role === 'member' ? 'selected' : ''}>member</option>
            </select>
          </div>
        </div>
        <div class="rounded-xl border border-amber-200 bg-amber-50/70 p-3 space-y-3">
          <p class="text-xs font-semibold uppercase tracking-wide text-amber-800">Company login (username &amp; password)</p>
          <div class="grid sm:grid-cols-2 gap-3">
            <div class="sm:col-span-2">
              <label class="block text-xs font-semibold uppercase tracking-wide text-slate-600 mb-1">Login username</label>
              <input type="text" data-field="username" required minlength="3" placeholder="e.g. jane" value="${escapeHtml(user?.username || '')}"
                class="w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent" />
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase tracking-wide text-slate-600 mb-1">${isNew ? 'Password' : 'New password (optional)'}</label>
              <div class="relative">
                <input type="password" data-field="password" id="pw-${rowKey}" minlength="6" placeholder="${isNew ? 'min 6 characters' : 'leave blank to keep current'}"
                  class="w-full rounded-lg border border-amber-200 bg-white px-3 py-2 pr-14 text-sm outline-none focus:border-accent" ${isNew ? 'required' : ''} />
                <button type="button" data-toggle-password="pw-${rowKey}" class="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-medium text-slate-500 hover:text-ink-900 px-1">Show</button>
              </div>
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase tracking-wide text-slate-600 mb-1">Confirm password</label>
              <div class="relative">
                <input type="password" data-field="passwordConfirm" id="pwc-${rowKey}" minlength="6" placeholder="re-enter if changing"
                  class="w-full rounded-lg border border-amber-200 bg-white px-3 py-2 pr-14 text-sm outline-none focus:border-accent" ${isNew ? 'required' : ''} />
                <button type="button" data-toggle-password="pwc-${rowKey}" class="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-medium text-slate-500 hover:text-ink-900 px-1">Show</button>
              </div>
            </div>
          </div>
        </div>
        <div class="flex justify-end">
          <button type="button" data-remove-user class="rounded-lg border border-red-200 text-danger text-sm font-medium px-3 py-1.5 hover:bg-red-50">Remove user</button>
        </div>
      </div>`;
  }

  async function openEditCompany(id) {
    hideCreateCompany();
    hideCompanyOverview();
    editRemovedUserIds = [];
    const data = await api(`/api/master/companies/${id}`);
    const company = data.company;
    $('edit-co-id').value = company.id;
    $('edit-co-name').value = company.name;
    $('edit-company-feedback').textContent = '';
    const users = Object.values(company.users || {});
    $('edit-users-list').innerHTML = users.map((u) => userEditRow(u)).join('') || userEditRow();
    $('edit-company-panel').classList.remove('hidden');
    $('edit-co-name').focus();
    $('edit-company-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function lock() {
    token = '';
    mode = 'company';
    masterToken = '';
    workspaceToken = '';
    masterWorkspace = null;
    signedInUser = null;
    companyUsers = {};
    companyApiToken = '';
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(MODE_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(MASTER_TOKEN_KEY);
    localStorage.removeItem(WORKSPACE_TOKEN_KEY);
    stopPolling();
    app.classList.add('hidden');
    authScreen.classList.remove('hidden');
    $('login-password').value = '';
  }

  function startPolling() {
    stopPolling();
    refreshTimer = setInterval(() => {
      if (currentView === 'companies') loadCompanies();
      if (currentView === 'company-overview' && viewingCompanyOverviewId) {
        loadCompanyOverview(viewingCompanyOverviewId);
      }
      if (currentView === 'all-overview') loadAllOverview();
      if (currentView === 'overview') loadOverview();
      if (currentView === 'campaigns') loadCampaigns();
      if (currentView === 'campaign-detail' && detailCampaignId) loadCampaignDetail();
      if (currentView === 'groups') loadGroups();
      if (currentView === 'monitor') loadMessages();
      if (currentView === 'gateways') loadDevices();
      if (currentView === 'users') loadUsers();
      if (currentView === 'settings') loadSettings();
    }, 5000);
  }

  function stopPolling() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  const PAGE_TITLES = {
    companies: 'Companies',
    'company-overview': 'Company overview',
    'all-overview': 'All overview',
    overview: 'Overview',
    campaigns: 'Campaigns',
    'campaign-detail': 'Campaign detail',
    groups: 'Contact Groups',
    monitor: 'Live Monitor',
    gateways: 'Gateways',
    users: 'Users',
    settings: 'Settings',
  };

  let cachedDevices = [];

  async function loadCampaignDeviceOptions(selectId, selectedId = '') {
    const select = $(selectId);
    if (!select) return;
    try {
      const data = await api('/api/admin/devices');
      cachedDevices = data.devices || [];
      const emptyLabel =
        selectId === 'edit-camp-device'
          ? 'No device — campaign will be Inactive'
          : cachedDevices.length
            ? 'Select a device…'
            : 'No devices — register a gateway first';
      if (!cachedDevices.length) {
        select.innerHTML = `<option value="">${emptyLabel}</option>`;
        select.value = '';
        return;
      }
      select.innerHTML =
        `<option value="">${emptyLabel}</option>` +
        cachedDevices
          .map(
            (d) =>
              `<option value="${escapeHtml(d.deviceIdentifier)}">${escapeHtml(
                d.deviceName || d.deviceIdentifier
              )}</option>`
          )
          .join('');
      if (selectedId) select.value = selectedId;
    } catch (err) {
      console.error(err);
      select.innerHTML = '<option value="">Select a device…</option>';
    }
  }

  function closeEditCampaignModal() {
    $('edit-campaign-modal')?.classList.add('hidden');
  }

  async function loadEditCampaignGroups() {
    const select = $('edit-camp-group');
    if (!select) return;
    try {
      const data = await api('/api/admin/groups');
      cachedGroups = data.groups || [];
      select.innerHTML = '<option value="">Keep current contacts</option>';
      for (const g of cachedGroups) {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = `${g.name} (${g.contactCount})`;
        opt.dataset.count = String(g.contactCount);
        select.appendChild(opt);
      }
    } catch (err) {
      console.error(err);
      select.innerHTML = '<option value="">Keep current contacts</option>';
    }
  }

  async function openEditCampaign(campaignId) {
    const campaign = cachedCampaigns[campaignId];
    if (!campaign) return;
    if ($('edit-camp-feedback')) {
      $('edit-camp-feedback').textContent = '';
      $('edit-camp-feedback').className = 'text-sm';
    }
    $('edit-camp-id').value = campaign.id;
    $('edit-camp-title').value = campaign.title || '';
    if ($('edit-camp-body')) $('edit-camp-body').value = campaign.messageBody || '';

    const started =
      (Number(campaign.processing) || 0) +
      (Number(campaign.sent) || 0) +
      (Number(campaign.delivered) || 0) +
      (Number(campaign.failed) || 0);
    const canChangeGroup = campaign.canChangeGroup === true || campaign.allQueued === true || started === 0;

    const groupSelect = $('edit-camp-group');
    const groupHint = $('edit-camp-group-hint');
    const groupWrap = $('edit-camp-group-wrap');
    if (groupSelect) {
      await loadEditCampaignGroups();
      groupSelect.value = '';
      groupSelect.disabled = !canChangeGroup;
      if (groupWrap) groupWrap.classList.toggle('opacity-60', !canChangeGroup);
      if (groupHint) {
        groupHint.textContent = canChangeGroup
          ? 'Pick a group to replace all queued contacts with that group’s current list. Leave as Keep current to only update name/message/device.'
          : 'Group/contacts locked — sending already started (not all Queued).';
      }
    }

    await loadCampaignDeviceOptions('edit-camp-device', campaign.assignedDeviceIdentifier || '');
    $('edit-campaign-modal')?.classList.remove('hidden');
    $('edit-camp-title')?.focus();
  }

  function openCreateCampaignModal() {
    const modal = $('create-campaign-modal');
    if (!modal) return;
    if ($('create-feedback')) {
      $('create-feedback').textContent = '';
      $('create-feedback').className = 'text-sm';
    }
    if ($('camp-status')) $('camp-status').value = 'INACTIVE';
    loadCampaignGroups();
    loadCampaignDeviceOptions('camp-device', '');
    modal.classList.remove('hidden');
    $('camp-title')?.focus();
  }

  function closeCreateCampaignModal() {
    const modal = $('create-campaign-modal');
    if (!modal) return;
    modal.classList.add('hidden');
  }

  function closeEditGroupModal() {
    $('edit-group-modal')?.classList.add('hidden');
  }

  function openEditGroup(groupId) {
    const group = cachedGroups.find((g) => g.id === groupId);
    if (!group) return;
    if ($('edit-group-feedback')) {
      $('edit-group-feedback').textContent = '';
      $('edit-group-feedback').className = 'text-sm';
    }
    $('edit-group-id').value = group.id;
    $('edit-group-name').value = group.name || '';
    $('edit-group-modal')?.classList.remove('hidden');
    $('edit-group-name')?.focus();
  }

  function closeEditContactModal() {
    $('edit-contact-modal')?.classList.add('hidden');
  }

  function openEditContact(contactId) {
    const contact = cachedGroupContacts.find((c) => c.id === contactId);
    if (!contact) return;
    if ($('edit-contact-feedback')) {
      $('edit-contact-feedback').textContent = '';
      $('edit-contact-feedback').className = 'text-sm';
    }
    $('edit-contact-id').value = contact.id;
    $('edit-contact-name').value = contact.name || '';
    $('edit-contact-phone').value = contact.phoneNumber || '';
    $('edit-contact-modal')?.classList.remove('hidden');
    $('edit-contact-name')?.focus();
  }

  function switchView(name) {
    if (name === 'create') name = 'campaigns';
    currentView = name;
    document.querySelectorAll('#app .view').forEach((el) => el.classList.add('hidden'));
    const navView = name === 'campaign-detail' ? 'campaigns' : name;
    document.querySelectorAll('#app .nav-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === navView);
    });
    const view = $(`view-${name}`);
    if (view) view.classList.remove('hidden');
    if ($('page-title')) {
      $('page-title').textContent =
        name === 'campaign-detail' && detailCampaignMeta?.title
          ? detailCampaignMeta.title
          : PAGE_TITLES[name] || 'Dashboard';
    }
    loadView(name);
  }

  function loadView(name) {
    if (name === 'companies') loadCompanies();
    if (name === 'company-overview' && viewingCompanyOverviewId) {
      loadCompanyOverview(viewingCompanyOverviewId);
    }
    if (name === 'all-overview') loadAllOverview();
    if (name === 'overview') loadOverview();
    if (name === 'campaigns') loadCampaigns();
    if (name === 'campaign-detail') {
      if (detailCampaignId) loadCampaignDetail();
      else switchView('campaigns');
    }
    if (name === 'groups') loadGroups();
    if (name === 'monitor') loadMessages();
    if (name === 'gateways') loadDevices();
    if (name === 'users') loadUsers();
    if (name === 'settings') loadSettings();
  }

  function statusBadge(status) {
    const map = {
      QUEUED: 'bg-amber-50 text-amber-700',
      PROCESSING: 'bg-sky-50 text-sky-700',
      SENT: 'bg-teal-50 text-teal-700',
      DELIVERED: 'bg-emerald-50 text-emerald-700',
      SEND_FAILED: 'bg-red-50 text-red-700',
      DELIVERY_FAILED: 'bg-rose-50 text-rose-700',
    };
    const cls = map[status] || 'bg-slate-100 text-slate-600';
    return `<span class="status-pill ${cls}"><span class="dot"></span>${escapeHtml(status || 'UNKNOWN')}</span>`;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z');
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString();
    } catch {
      return iso;
    }
  }

  function isOnline(lastHeartbeat) {
    if (!lastHeartbeat) return false;
    const t = new Date(
      lastHeartbeat.endsWith('Z') || lastHeartbeat.includes('+')
        ? lastHeartbeat
        : lastHeartbeat + 'Z'
    ).getTime();
    return Date.now() - t < 2 * 60 * 1000;
  }

  function parseRecipientLines(raw) {
    const parts = String(raw || '')
      .split(/[\n,;]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    const seen = new Set();
    const recipients = [];
    for (const part of parts) {
      let name = '';
      let numberPart = part;
      const colonIdx = part.indexOf(':');
      if (colonIdx > 0) {
        name = part.slice(0, colonIdx).trim();
        numberPart = part.slice(colonIdx + 1).trim();
      }
      let number = numberPart.replace(/[\s\-().]/g, '');
      const digits = number.replace(/\D/g, '');
      if (digits.length < 7) continue;
      if (seen.has(number)) continue;
      seen.add(number);
      recipients.push({ recipientName: name, phoneNumber: number });
    }
    return recipients;
  }

  function countPhones(raw) {
    return parseRecipientLines(raw).length;
  }

  function findColumnIndex(headers, candidates) {
    const normalized = headers.map((h) =>
      String(h || '')
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .trim()
    );
    for (const cand of candidates) {
      const idx = normalized.findIndex((h) => h === cand || h.includes(cand));
      if (idx >= 0) return idx;
    }
    return -1;
  }

  function parseExcelRows(rows) {
    if (!rows || !rows.length) return [];
    const header = rows[0].map((c) => String(c ?? ''));
    let nameIdx = findColumnIndex(header, [
      'name',
      'full name',
      'fullname',
      'recipient',
      'customer',
      'client',
    ]);
    let phoneIdx = findColumnIndex(header, [
      'phone',
      'phone number',
      'mobile',
      'tel',
      'telephone',
      'msisdn',
      'number',
      'cell',
    ]);

    let startRow = 1;
    // No header match — assume col0=name, col1=phone (or col0=phone only)
    if (phoneIdx < 0) {
      const first = String(rows[0][0] ?? '');
      const second = String(rows[0][1] ?? '');
      const firstDigits = first.replace(/\D/g, '');
      if (firstDigits.length >= 7) {
        phoneIdx = 0;
        nameIdx = -1;
        startRow = 0;
      } else if (String(second).replace(/\D/g, '').length >= 7) {
        nameIdx = 0;
        phoneIdx = 1;
        startRow = 0;
      } else {
        nameIdx = 0;
        phoneIdx = Math.min(1, header.length - 1);
      }
    }

    const seen = new Set();
    const recipients = [];
    for (let i = startRow; i < rows.length; i++) {
      const row = rows[i] || [];
      const phoneRaw = row[phoneIdx];
      if (phoneRaw === null || phoneRaw === undefined || phoneRaw === '') continue;
      let number = String(phoneRaw).trim().replace(/[\s\-().]/g, '');
      // Excel sometimes stores phones as numbers
      if (/e\+/i.test(number)) number = Number(phoneRaw).toFixed(0);
      const digits = number.replace(/\D/g, '');
      if (digits.length < 7) continue;
      if (seen.has(number)) continue;
      seen.add(number);
      const name = nameIdx >= 0 ? String(row[nameIdx] ?? '').trim() : '';
      recipients.push({ recipientName: name, phoneNumber: number });
    }
    return recipients;
  }

  let selectedGroupId = '';
  let cachedGroups = [];
  let cachedGroupContacts = [];
  let createGroupMode = 'excel';
  let pendingCreateContacts = []; // from Excel chosen before create

  function renderContactsTable(contacts) {
    const tbody = $('contacts-tbody');
    const q = ($('contact-search')?.value || '').trim().toLowerCase();
    const filtered = !q
      ? contacts
      : contacts.filter((c) => {
          const name = String(c.name || '').toLowerCase();
          const phone = String(c.phoneNumber || '').toLowerCase();
          return name.includes(q) || phone.includes(q);
        });

    $('contact-total-count').textContent = String(contacts.length);
    $('contact-search-count').textContent = String(filtered.length);

    if (!contacts.length) {
      tbody.innerHTML =
        '<tr><td colspan="3" class="px-4 py-8 text-center text-slate-400">No contacts yet. Import Excel or add manually below.</td></tr>';
      return;
    }
    if (!filtered.length) {
      tbody.innerHTML =
        '<tr><td colspan="3" class="px-4 py-8 text-center text-slate-400">No contacts match your search.</td></tr>';
      return;
    }
    tbody.innerHTML = filtered
      .map(
        (c) => `
      <tr class="hover:bg-slate-50/80" data-contact-id="${escapeHtml(c.id)}">
        <td class="px-4 py-3">${escapeHtml(c.name || '—')}</td>
        <td class="px-4 py-3 font-mono text-xs">${escapeHtml(c.phoneNumber)}</td>
        <td class="px-4 py-3 text-right whitespace-nowrap">
          <button data-c-action="edit" class="text-xs font-medium text-accent hover:underline mr-2">Edit</button>
          <button data-c-action="delete" class="text-xs font-medium text-danger hover:underline">Remove</button>
        </td>
      </tr>`
      )
      .join('');
  }

  function setCreateGroupMode(mode) {
    createGroupMode = mode;
    document.querySelectorAll('.group-add-mode').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.groupAddMode === mode);
    });
    $('create-mode-excel').classList.toggle('hidden', mode !== 'excel');
    $('create-mode-manual').classList.toggle('hidden', mode !== 'manual');
    $('create-mode-skip').classList.toggle('hidden', mode !== 'skip');
  }

  function showCreateGroupPanel() {
    $('create-group-panel').classList.remove('hidden');
    $('new-group-name').value = '';
    $('create-manual-contacts').value = '';
    $('create-manual-count').textContent = '0';
    $('create-excel-status').textContent =
      'Columns: Name + Phone. File is applied when you create the group.';
    $('create-excel-status').className = 'text-xs text-slate-500';
    $('group-create-feedback').textContent = '';
    pendingCreateContacts = [];
    $('split-size').value = '';
    setCreateGroupMode('excel');
    $('new-group-name').focus();
  }

  function hideCreateGroupPanel() {
    $('create-group-panel').classList.add('hidden');
    pendingCreateContacts = [];
    $('create-group-excel').value = '';
  }

  function getContactsForCreate() {
    if (createGroupMode === 'skip') return [];
    if (createGroupMode === 'excel') return pendingCreateContacts;
    return parseRecipientLines($('create-manual-contacts').value).map((r) => ({
      name: r.recipientName || '',
      phoneNumber: r.phoneNumber,
    }));
  }

  async function loadGroups() {
    try {
      const data = await api('/api/admin/groups');
      cachedGroups = data.groups || [];
      const tbody = $('groups-tbody');
      if (!cachedGroups.length) {
        tbody.innerHTML =
          '<tr><td colspan="3" class="px-4 py-8 text-center text-slate-400">No groups yet. Create one above.</td></tr>';
        return;
      }
      tbody.innerHTML = cachedGroups
        .map(
          (g) => `
        <tr class="hover:bg-slate-50/80 ${g.id === selectedGroupId ? 'bg-teal-50/60' : ''}" data-id="${escapeHtml(g.id)}">
          <td class="px-4 py-3">
            <div class="font-medium">${escapeHtml(g.name)}</div>
            <div class="text-xs text-slate-400 font-mono">${escapeHtml(g.id)}</div>
          </td>
          <td class="px-4 py-3">${g.contactCount}</td>
          <td class="px-4 py-3 whitespace-nowrap">
            <div class="action-menu">
              <button type="button" data-action-menu-toggle
                class="rounded-lg border border-slate-200 text-xs font-semibold px-2.5 py-1.5 hover:bg-slate-50">
                Actions ▾
              </button>
              <div class="action-menu-panel">
                <button type="button" class="action-menu-item" data-g-action="open">Open</button>
                <button type="button" class="action-menu-item" data-g-action="edit">Edit</button>
                <button type="button" class="action-menu-item danger" data-g-action="delete">Delete</button>
              </div>
            </div>
          </td>
        </tr>`
        )
        .join('');
    } catch (err) {
      console.error(err);
    }
  }

  async function openGroup(groupId) {
    selectedGroupId = groupId;
    $('group-excel-btn').disabled = false;
    $('clear-group-contacts-btn').disabled = false;
    $('manual-add-row').classList.remove('hidden');
    $('contact-search-wrap').classList.remove('hidden');
    $('group-import-feedback').textContent = '';
    try {
      const data = await api(`/api/admin/groups/${groupId}/contacts`);
      cachedGroupContacts = data.contacts || [];
      $('selected-group-label').textContent = `${data.group.name} · ${cachedGroupContacts.length} contacts`;
      renderContactsTable(cachedGroupContacts);
      loadGroups();
    } catch (err) {
      appAlert(err.message, 'Error');
    }
  }

  async function loadCampaignGroups() {
    try {
      const data = await api('/api/admin/groups');
      cachedGroups = data.groups || [];
      const select = $('camp-group');
      const current = select.value;
      select.innerHTML = '<option value="">Select a group…</option>';
      for (const g of cachedGroups) {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = `${g.name} (${g.contactCount})`;
        opt.dataset.count = String(g.contactCount);
        select.appendChild(opt);
      }
      if (current && cachedGroups.some((g) => g.id === current)) {
        select.value = current;
      }
      updateCampGroupCount();
    } catch (err) {
      console.error(err);
    }
  }

  function updateCampGroupCount() {
    const select = $('camp-group');
    const opt = select.selectedOptions[0];
    $('camp-group-count').textContent = opt?.dataset.count || '0';
  }

  async function loadMe() {
    const data = await api('/api/admin/me');
    if ($('company-name')) {
      $('company-name').textContent =
        mode === 'master' ? 'Master Workspace' : data.company.name;
    }
    companyUsers = data.users || {};
    companyApiToken = data.company.apiToken || '';
    if ($('company-api-token')) $('company-api-token').textContent = companyApiToken || '—';
    fillApkSetupCard();
    if ($('setting-job-batch-size') && data.company.jobBatchSize != null) {
      $('setting-job-batch-size').value = String(data.company.jobBatchSize);
    }
    return data;
  }

  function fillApkSetupCard() {
    const origin = window.location.origin || 'https://sms.awedaybet.com';
    const baseUrl = `${origin.replace(/\/$/, '')}/api/gateway`;
    if ($('apk-setup-base-url')) $('apk-setup-base-url').textContent = baseUrl;
    if ($('apk-setup-token')) $('apk-setup-token').textContent = companyApiToken || '—';
  }

  async function loadSettings() {
    const statusEl = $('settings-status');
    try {
      fillApkSetupCard();
      if (!companyApiToken) {
        try {
          await loadMe();
        } catch (_) {
          /* ignore */
        }
      } else {
        fillApkSetupCard();
      }
      const data = await api('/api/admin/settings');
      const s = data.settings || {};
      const input = $('setting-job-batch-size');
      if (input) {
        input.value = String(s.jobBatchSize ?? 10);
        input.min = String(s.jobBatchSizeMin ?? 1);
        input.max = String(s.jobBatchSizeMax ?? 50);
      }
      if (statusEl && !statusEl.dataset.saved) statusEl.textContent = '';
    } catch (err) {
      if (statusEl) statusEl.textContent = err.message || 'Failed to load settings';
    }
  }

  let detailCampaignId = '';
  let detailCampaignMeta = null;
  let detailMessagesCache = [];
  let cachedCampaigns = {};

  function renderDetailMessages() {
    const tbody = $('detail-messages-tbody');
    const q = ($('detail-search')?.value || '').trim().toLowerCase();
    const status = $('detail-status')?.value || '';
    let list = detailMessagesCache;
    if (status) list = list.filter((m) => m.status === status);
    if (q) {
      list = list.filter((m) => {
        const name = String(m.recipientName || '').toLowerCase();
        const phone = String(m.phoneNumber || '').toLowerCase();
        return name.includes(q) || phone.includes(q);
      });
    }
    $('detail-showing').textContent = String(list.length);
    if (!list.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="px-4 py-8 text-center text-slate-400">No recipients match this filter.</td></tr>';
      return;
    }
    tbody.innerHTML = list
      .map(
        (m) => `
      <tr class="hover:bg-slate-50/80">
        <td class="px-4 py-3 truncate max-w-[140px]">${escapeHtml(m.recipientName || '—')}</td>
        <td class="px-4 py-3 font-mono text-xs sm:text-sm">${escapeHtml(m.phoneNumber)}</td>
        <td class="px-4 py-3">${statusBadge(m.status)}</td>
        <td class="px-4 py-3">${m.simUsed >= 0 ? m.simUsed : '—'}</td>
        <td class="px-4 py-3 text-slate-500 whitespace-nowrap text-xs">${formatTime(m.updatedAt)}</td>
        <td class="px-4 py-3 text-xs text-red-600 max-w-[200px] truncate" title="${escapeHtml(m.failureReason || '')}">${escapeHtml(m.failureReason || '—')}</td>
      </tr>`
      )
      .join('');
  }

  function campaignStatusBadge(status) {
    const active = String(status || 'ACTIVE').toUpperCase() === 'ACTIVE';
    return active
      ? '<span class="status-pill bg-emerald-50 text-emerald-700"><span class="dot"></span>Active</span>'
      : '<span class="status-pill bg-slate-100 text-slate-600"><span class="dot"></span>Inactive</span>';
  }

  async function openCampaignDetail(campaign) {
    detailCampaignId = campaign.id;
    detailCampaignMeta = campaign;
    if ($('detail-campaign-title')) {
      $('detail-campaign-title').textContent = campaign.title || 'Campaign';
    }
    if ($('detail-campaign-id')) $('detail-campaign-id').textContent = campaign.id;
    if ($('detail-stat-total')) $('detail-stat-total').textContent = campaign.totalMessages ?? 0;
    if ($('detail-stat-queued')) $('detail-stat-queued').textContent = campaign.queued ?? 0;
    if ($('detail-stat-processing')) {
      $('detail-stat-processing').textContent = campaign.processing ?? 0;
    }
    if ($('detail-stat-sent')) $('detail-stat-sent').textContent = campaign.sent ?? 0;
    if ($('detail-stat-delivered')) {
      $('detail-stat-delivered').textContent = campaign.delivered ?? 0;
    }
    if ($('detail-stat-failed')) $('detail-stat-failed').textContent = campaign.failed ?? 0;
    if ($('detail-search')) $('detail-search').value = '';
    if ($('detail-status')) $('detail-status').value = '';
    if ($('detail-requeue-feedback')) {
      $('detail-requeue-feedback').textContent = '';
      $('detail-requeue-feedback').className = 'text-sm text-slate-500';
    }
    switchView('campaign-detail');
  }

  async function loadCampaignDetail() {
    if (!detailCampaignId) return;
    try {
      const qs = new URLSearchParams({
        limit: '5000',
        campaignId: detailCampaignId,
      });
      const data = await api(`/api/admin/messages?${qs}`);
      detailMessagesCache = data.messages || [];

      // Recompute live counts from messages
      const counts = { queued: 0, processing: 0, sent: 0, delivered: 0, failed: 0 };
      for (const m of detailMessagesCache) {
        if (m.status === 'QUEUED') counts.queued += 1;
        else if (m.status === 'PROCESSING') counts.processing += 1;
        else if (m.status === 'SENT') counts.sent += 1;
        else if (m.status === 'DELIVERED') counts.delivered += 1;
        else if (m.status === 'SEND_FAILED' || m.status === 'DELIVERY_FAILED') counts.failed += 1;
      }
      $('detail-stat-total').textContent = String(detailMessagesCache.length);
      $('detail-stat-queued').textContent = String(counts.queued);
      if ($('detail-stat-processing')) $('detail-stat-processing').textContent = String(counts.processing);
      $('detail-stat-sent').textContent = String(counts.sent);
      $('detail-stat-delivered').textContent = String(counts.delivered);
      $('detail-stat-failed').textContent = String(counts.failed);
      renderDetailMessages();
    } catch (err) {
      console.error(err);
      appAlert(err.message, 'Error');
    }
  }

  function fillOverviewStats(s) {
    if ($('stat-campaigns')) $('stat-campaigns').textContent = s.totalCampaigns ?? 0;
    if ($('stat-queued')) $('stat-queued').textContent = s.totalQueued ?? 0;
    if ($('stat-processing')) $('stat-processing').textContent = s.totalProcessing ?? 0;
    if ($('stat-sent')) $('stat-sent').textContent = s.totalSent ?? 0;
    if ($('stat-delivered')) $('stat-delivered').textContent = s.totalDelivered ?? 0;
    if ($('stat-failed')) $('stat-failed').textContent = s.totalFailed ?? 0;
  }

  async function loadOverview() {
    try {
      if ($('overview-subtitle')) {
        $('overview-subtitle').textContent =
          mode === 'master' ? 'SMS totals for Master Workspace.' : 'SMS totals for this company.';
      }
      const statsRes = await api('/api/admin/stats');
      fillOverviewStats(statsRes.stats || {});
    } catch (err) {
      console.error(err);
    }
  }

  async function loadAllOverview() {
    try {
      const data = await api('/api/master/overview');
      const s = data.totals || {};
      if ($('all-stat-companies')) $('all-stat-companies').textContent = s.totalCompanies ?? 0;
      if ($('all-stat-campaigns')) $('all-stat-campaigns').textContent = s.totalCampaigns ?? 0;
      if ($('all-stat-queued')) $('all-stat-queued').textContent = s.totalQueued ?? 0;
      if ($('all-stat-processing')) $('all-stat-processing').textContent = s.totalProcessing ?? 0;
      if ($('all-stat-sent')) $('all-stat-sent').textContent = s.totalSent ?? 0;
      if ($('all-stat-delivered')) $('all-stat-delivered').textContent = s.totalDelivered ?? 0;
      if ($('all-stat-failed')) $('all-stat-failed').textContent = s.totalFailed ?? 0;

      const tbody = $('all-overview-tbody');
      if (!tbody) return;
      const rows = data.companies || [];
      if (!rows.length) {
        tbody.innerHTML =
          '<tr><td colspan="10" class="px-5 py-8 text-center text-slate-400">No companies yet.</td></tr>';
        return;
      }
      tbody.innerHTML = rows
        .map((c) => {
          const badge = c.isMasterWorkspace
            ? '<span class="ml-2 inline-flex items-center rounded-md bg-teal-50 text-teal-800 text-[10px] font-semibold px-1.5 py-0.5">Master</span>'
            : '';
          return `
          <tr class="hover:bg-slate-50/80" data-id="${escapeHtml(c.id)}">
            <td class="px-4 py-3">
              <div class="font-medium text-ink-900">${escapeHtml(c.name)}${badge}</div>
              <div class="text-xs text-slate-400 font-mono">${escapeHtml(c.id)}</div>
            </td>
            <td class="px-4 py-3">${c.userCount ?? 0}</td>
            <td class="px-4 py-3">${c.deviceCount ?? 0}</td>
            <td class="px-4 py-3">${c.totalCampaigns ?? 0}</td>
            <td class="px-4 py-3 text-amber-600 font-medium">${c.totalQueued ?? 0}</td>
            <td class="px-4 py-3 text-sky-600 font-medium">${c.totalProcessing ?? 0}</td>
            <td class="px-4 py-3 text-teal-600 font-medium">${c.totalSent ?? 0}</td>
            <td class="px-4 py-3 text-emerald-600 font-medium">${c.totalDelivered ?? 0}</td>
            <td class="px-4 py-3 text-red-600 font-medium">${c.totalFailed ?? 0}</td>
            <td class="px-4 py-3 whitespace-nowrap">
              <button type="button" data-action="overview" class="text-xs font-medium text-accent hover:underline">Overview</button>
            </td>
          </tr>`;
        })
        .join('');
    } catch (err) {
      console.error(err);
    }
  }

  let viewingCompanyOverviewId = null;

  async function loadCompanyOverview(companyId) {
    if (!companyId) return;
    try {
      const data = await api(`/api/master/companies/${companyId}/overview`);
      const c = data.company || {};
      const s = data.stats || {};
      if ($('co-ov-name')) $('co-ov-name').textContent = c.name || 'Company';
      if ($('co-ov-id')) $('co-ov-id').textContent = c.id || '';
      if ($('co-ov-users')) $('co-ov-users').textContent = c.userCount ?? 0;
      if ($('co-ov-devices')) $('co-ov-devices').textContent = c.deviceCount ?? (data.devices || []).length;
      if ($('co-ov-campaigns')) $('co-ov-campaigns').textContent = s.totalCampaigns ?? 0;
      if ($('co-ov-queued')) $('co-ov-queued').textContent = s.totalQueued ?? 0;
      if ($('co-ov-processing')) $('co-ov-processing').textContent = s.totalProcessing ?? 0;
      if ($('co-ov-sent')) $('co-ov-sent').textContent = s.totalSent ?? 0;
      if ($('co-ov-delivered')) $('co-ov-delivered').textContent = s.totalDelivered ?? 0;
      if ($('co-ov-failed')) $('co-ov-failed').textContent = s.totalFailed ?? 0;
      if ($('co-ov-messages')) $('co-ov-messages').textContent = s.totalMessages ?? 0;
      if ($('page-title')) {
        $('page-title').textContent = c.name ? `${c.name} overview` : 'Company overview';
      }

      const tbody = $('co-ov-campaigns-tbody');
      const campaigns = data.campaigns || [];
      if (tbody) {
        if (!campaigns.length) {
          tbody.innerHTML =
            '<tr><td colspan="8" class="px-5 py-8 text-center text-slate-400">No campaigns for this company.</td></tr>';
        } else {
          tbody.innerHTML = campaigns
            .map((camp) => {
              const status = String(camp.status || 'ACTIVE').toUpperCase();
              return `
              <tr class="hover:bg-slate-50/80">
                <td class="px-4 py-3">
                  <div class="font-medium text-ink-900">${escapeHtml(camp.title)}</div>
                  <div class="text-xs text-slate-400 font-mono">${escapeHtml(camp.id)}</div>
                </td>
                <td class="px-4 py-3">${campaignStatusBadge(status)}</td>
                <td class="px-4 py-3">${camp.totalMessages ?? 0}</td>
                <td class="px-4 py-3 text-amber-600 font-medium">${camp.queued ?? 0}</td>
                <td class="px-4 py-3 text-sky-600 font-medium">${camp.processing ?? 0}</td>
                <td class="px-4 py-3 text-teal-600 font-medium">${camp.sent ?? 0}</td>
                <td class="px-4 py-3 text-emerald-600 font-medium">${camp.delivered ?? 0}</td>
                <td class="px-4 py-3 text-red-600 font-medium">${camp.failed ?? 0}</td>
              </tr>`;
            })
            .join('');
        }
      }
    } catch (err) {
      console.error(err);
      await appAlert(err.message, 'Error');
    }
  }

  async function openCompanyOverview(companyId) {
    viewingCompanyOverviewId = companyId;
    hideEditCompany();
    hideCreateCompany();
    switchView('company-overview');
  }

  function hideCompanyOverview() {
    viewingCompanyOverviewId = null;
    $('company-overview-modal')?.classList.add('hidden');
  }

  async function loadCampaigns() {
    try {
      const campsRes = await api('/api/admin/campaigns');
      const tbody = $('campaigns-tbody');
      if (!tbody) return;
      cachedCampaigns = {};
      for (const c of campsRes.campaigns) cachedCampaigns[c.id] = c;

      if (!cachedDevices.length) {
        try {
          const devicesRes = await api('/api/admin/devices');
          cachedDevices = devicesRes.devices || [];
        } catch (_) {
          cachedDevices = [];
        }
      }

      if (!campsRes.campaigns.length) {
        tbody.innerHTML =
          '<tr><td colspan="11" class="px-5 py-8 text-center text-slate-400">No campaigns yet for this company.</td></tr>';
        return;
      }
      tbody.innerHTML = campsRes.campaigns
        .map((c) => {
          const status = String(c.status || 'ACTIVE').toUpperCase();
          const isActive = status === 'ACTIVE';
          const deviceLabel = c.assignedDeviceName || c.assignedDeviceIdentifier || 'No device';
          return `
        <tr class="campaign-row hover:bg-teal-50/50 cursor-pointer" data-campaign-id="${escapeHtml(c.id)}" data-open-campaign="${escapeHtml(c.id)}" title="Open campaign detail">
          <td class="px-4 py-3">
            <div class="font-medium text-ink-900">${escapeHtml(c.title)}</div>
            <div class="text-xs text-slate-400 font-mono">${escapeHtml(c.id)}</div>
          </td>
          <td class="px-4 py-3">${campaignStatusBadge(status)}</td>
          <td class="px-4 py-3">
            <div class="text-sm font-medium truncate max-w-[140px]">${escapeHtml(deviceLabel)}</div>
            ${
              c.assignedDeviceIdentifier
                ? `<div class="text-[10px] text-slate-400 font-mono truncate max-w-[140px]">${escapeHtml(
                    c.assignedDeviceIdentifier
                  )}</div>`
                : '<div class="text-[10px] text-danger">Assign a device</div>'
            }
          </td>
          <td class="px-4 py-3">${c.totalMessages}</td>
          <td class="px-4 py-3 text-amber-600 font-medium">${c.queued ?? 0}</td>
          <td class="px-4 py-3 text-sky-600 font-medium">${c.processing ?? 0}</td>
          <td class="px-4 py-3 text-teal-600 font-medium">${c.sent ?? 0}</td>
          <td class="px-4 py-3 text-emerald-600 font-medium">${c.delivered ?? 0}</td>
          <td class="px-4 py-3 text-red-600 font-medium">${c.failed ?? 0}</td>
          <td class="px-4 py-3 text-slate-500 whitespace-nowrap">${formatTime(c.createdAt)}</td>
          <td class="px-4 py-3 whitespace-nowrap">
            <div class="action-menu">
              <button type="button" data-action-menu-toggle
                class="rounded-lg border border-slate-200 text-xs font-semibold px-2.5 py-1.5 hover:bg-slate-50">
                Actions ▾
              </button>
              <div class="action-menu-panel">
                <button type="button" class="action-menu-item" data-edit-campaign="${escapeHtml(c.id)}">Edit</button>
                ${
                  isActive
                    ? `<button type="button" class="action-menu-item" data-toggle-campaign="${escapeHtml(
                        c.id
                      )}" data-next-status="INACTIVE">Pause</button>`
                    : c.assignedDeviceIdentifier
                      ? `<button type="button" class="action-menu-item" data-toggle-campaign="${escapeHtml(
                          c.id
                        )}" data-next-status="ACTIVE">Activate</button>`
                      : `<button type="button" class="action-menu-item" disabled title="Assign a gateway device (Edit) before activating">Activate</button>`
                }
                <button type="button" class="action-menu-item danger" data-delete-campaign="${escapeHtml(
                  c.id
                )}">Delete</button>
              </div>
            </div>
          </td>
        </tr>`;
        })
        .join('');
    } catch (err) {
      console.error(err);
    }
  }

  async function loadMessages() {
    try {
      const status = $('filter-status').value;
      const campaignId = $('filter-campaign').value.trim();
      const qs = new URLSearchParams({ limit: '200' });
      if (status) qs.set('status', status);
      if (campaignId) qs.set('campaignId', campaignId);

      const data = await api(`/api/admin/messages?${qs}`);
      const tbody = $('messages-tbody');

      if (!data.messages.length) {
        tbody.innerHTML =
          '<tr><td colspan="7" class="px-4 py-8 text-center text-slate-400">No messages match this filter.</td></tr>';
        return;
      }

      tbody.innerHTML = data.messages
        .map(
          (m) => `
        <tr class="hover:bg-slate-50/80">
          <td class="px-4 py-3 truncate max-w-[120px]">${escapeHtml(m.recipientName || '—')}</td>
          <td class="px-4 py-3 font-mono text-xs sm:text-sm">${escapeHtml(m.phoneNumber)}</td>
          <td class="px-4 py-3">
            <div class="font-medium truncate max-w-[160px]">${escapeHtml(m.campaignTitle || '—')}</div>
            <div class="text-xs text-slate-400 font-mono truncate max-w-[160px]">${escapeHtml(m.campaignId)}</div>
          </td>
          <td class="px-4 py-3">${statusBadge(m.status)}</td>
          <td class="px-4 py-3">${m.simUsed >= 0 ? m.simUsed : '—'}</td>
          <td class="px-4 py-3 text-slate-500 whitespace-nowrap text-xs">${formatTime(m.updatedAt)}</td>
          <td class="px-4 py-3 text-xs text-red-600 max-w-[180px] truncate" title="${escapeHtml(m.failureReason || '')}">${escapeHtml(m.failureReason || '—')}</td>
        </tr>`
        )
        .join('');
    } catch (err) {
      console.error(err);
    }
  }

  async function loadDevices() {
    try {
      const data = await api('/api/admin/devices');
      cachedDevices = data.devices || [];
      const tbody = $('devices-tbody');
      if (!tbody) return;

      if (!data.devices.length) {
        tbody.innerHTML =
          '<tr><td colspan="5" class="px-5 py-8 text-center text-slate-400">No gateways for this company yet.</td></tr>';
        return;
      }

      tbody.innerHTML = data.devices
        .map((d) => {
          const online = isOnline(d.lastHeartbeat);
          return `
          <tr class="hover:bg-slate-50/80">
            <td class="px-5 py-3 font-medium">${escapeHtml(d.deviceName)}</td>
            <td class="px-5 py-3 font-mono text-xs">${escapeHtml(d.deviceIdentifier)}</td>
            <td class="px-5 py-3 text-slate-500">${escapeHtml(d.androidVersion || '—')} / ${escapeHtml(d.appVersion || '—')}</td>
            <td class="px-5 py-3 text-slate-500 whitespace-nowrap">${formatTime(d.lastHeartbeat)}</td>
            <td class="px-5 py-3">
              <span class="status-pill ${online ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}">
                <span class="dot ${online ? 'pulse-online' : ''}"></span>${online ? 'Online' : 'Offline'}
              </span>
            </td>
          </tr>`;
        })
        .join('');
    } catch (err) {
      console.error(err);
    }
  }

  function loadUsers() {
    if ($('company-api-token')) $('company-api-token').textContent = companyApiToken || '—';
    const tbody = $('users-tbody');
    const entries = Object.values(companyUsers || {});
    if (!entries.length) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="px-5 py-8 text-center text-slate-400">No users on this company.</td></tr>';
      return;
    }
    tbody.innerHTML = entries
      .map(
        (u) => `
      <tr class="hover:bg-slate-50/80">
        <td class="px-5 py-3 font-medium">${escapeHtml(u.name)}</td>
        <td class="px-5 py-3 font-mono text-sm">${escapeHtml(u.username || '—')}</td>
        <td class="px-5 py-3">${escapeHtml(u.email)}</td>
        <td class="px-5 py-3"><span class="status-pill bg-slate-100 text-slate-700">${escapeHtml(u.role)}</span></td>
        <td class="px-5 py-3 font-mono text-xs text-slate-500">${escapeHtml(u.id)}</td>
      </tr>`
      )
      .join('');
  }

  async function loadCompanies() {
    try {
      const data = await api('/api/master/companies');
      const tbody = $('companies-tbody');
      if (!data.companies.length) {
        tbody.innerHTML =
          '<tr><td colspan="6" class="px-5 py-8 text-center text-slate-400">No companies yet. Create one above.</td></tr>';
        return;
      }
      tbody.innerHTML = data.companies
        .map((c) => {
          const userNames = Object.values(c.users || {})
            .map((u) => `${u.username || u.name}`)
            .join(', ');
          return `
          <tr class="hover:bg-slate-50/80" data-id="${escapeHtml(c.id)}">
            <td class="px-5 py-3">
              <div class="font-medium">${escapeHtml(c.name)}</div>
              <div class="text-xs text-slate-400 font-mono">${escapeHtml(c.id)}</div>
            </td>
            <td class="px-5 py-3">${c.userCount || Object.keys(c.users || {}).length}<div class="text-xs text-slate-400 truncate max-w-[140px]">${escapeHtml(userNames)}</div></td>
            <td class="px-5 py-3">${c.campaignCount || 0}</td>
            <td class="px-5 py-3">${c.deviceCount || 0}</td>
            <td class="px-5 py-3"><code class="token-box text-slate-600">${escapeHtml(c.apiToken)}</code></td>
            <td class="px-5 py-3 whitespace-nowrap">
              <button type="button" data-action="overview" class="rounded-lg bg-accent hover:bg-accent-dark text-white text-xs font-semibold px-2.5 py-1.5 mr-1">Overview</button>
              <button type="button" data-action="edit" class="text-xs font-medium text-ink-800 hover:underline mr-2">Edit / login</button>
              <button type="button" data-action="regen" class="text-xs font-medium text-accent hover:underline mr-2">Regen token</button>
              <button type="button" data-action="delete" class="text-xs font-medium text-danger hover:underline">Delete</button>
            </td>
          </tr>`;
        })
        .join('');
    } catch (err) {
      console.error(err);
    }
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('login-username').value.trim();
    const password = $('login-password').value;
    if (!username || !password) {
      authError.textContent = 'Username and password are required';
      authError.classList.remove('hidden');
      return;
    }

    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });

      persistSession(data.token, data.mode, data.user);
      authError.classList.add('hidden');

      if (data.mode === 'master') {
        masterWorkspace = data.workspace || null;
        masterToken = data.token;
        workspaceToken = data.workspace?.apiToken || '';
        localStorage.setItem(MASTER_TOKEN_KEY, masterToken);
        if (workspaceToken) localStorage.setItem(WORKSPACE_TOKEN_KEY, workspaceToken);
        await unlockMaster();
      } else {
        companyApiToken = data.company?.apiToken || data.token;
        await loadMe();
        unlockCompany();
      }
    } catch (err) {
      authError.textContent = err.message || 'Invalid username or password';
      authError.classList.remove('hidden');
    }
  });

  $('logout-btn').addEventListener('click', lock);

  function closeAllActionMenus(except = null) {
    document.querySelectorAll('.action-menu.open').forEach((menu) => {
      if (menu === except) return;
      menu.classList.remove('open');
      const panel = menu.querySelector('.action-menu-panel');
      if (panel) {
        panel.style.top = '';
        panel.style.left = '';
        panel.style.right = '';
      }
    });
  }

  function positionActionMenu(menu, toggle) {
    const panel = menu.querySelector('.action-menu-panel');
    if (!panel) return;
    const rect = toggle.getBoundingClientRect();
    const menuWidth = 152;
    let left = rect.right - menuWidth;
    if (left < 8) left = 8;
    if (left + menuWidth > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - menuWidth - 8);
    }
    let top = rect.bottom + 4;
    panel.style.left = `${left}px`;
    panel.style.right = 'auto';
    panel.style.top = `${top}px`;
    // After shown, flip upward if it would go off-screen
    requestAnimationFrame(() => {
      const h = panel.offsetHeight || 120;
      if (top + h > window.innerHeight - 8 && rect.top - 4 - h > 8) {
        panel.style.top = `${rect.top - 4 - h}px`;
      }
    });
  }

  // Capture phase so row stopPropagation can't block the menu toggle
  document.addEventListener(
    'click',
    (e) => {
      const toggle = e.target.closest('[data-action-menu-toggle]');
      if (toggle) {
        e.preventDefault();
        e.stopPropagation();
        const menu = toggle.closest('.action-menu');
        if (!menu) return;
        const willOpen = !menu.classList.contains('open');
        closeAllActionMenus();
        if (willOpen) {
          menu.classList.add('open');
          positionActionMenu(menu, toggle);
        }
        return;
      }
      if (e.target.closest('.action-menu-item')) {
        // Close after the row/table handlers run on bubble.
        setTimeout(() => closeAllActionMenus(), 0);
        return;
      }
      if (!e.target.closest('.action-menu-panel')) {
        closeAllActionMenus();
      }
    },
    true
  );

  window.addEventListener('scroll', () => closeAllActionMenus(), true);
  window.addEventListener('resize', () => closeAllActionMenus());

  $('open-create-campaign')?.addEventListener('click', openCreateCampaignModal);
  $('close-create-campaign')?.addEventListener('click', closeCreateCampaignModal);
  $('cancel-create-campaign')?.addEventListener('click', closeCreateCampaignModal);
  $('create-campaign-backdrop')?.addEventListener('click', closeCreateCampaignModal);

  $('close-edit-campaign')?.addEventListener('click', closeEditCampaignModal);
  $('cancel-edit-campaign')?.addEventListener('click', closeEditCampaignModal);
  $('edit-campaign-backdrop')?.addEventListener('click', closeEditCampaignModal);

  $('close-edit-group')?.addEventListener('click', closeEditGroupModal);
  $('cancel-edit-group')?.addEventListener('click', closeEditGroupModal);
  $('edit-group-backdrop')?.addEventListener('click', closeEditGroupModal);

  $('edit-group-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const feedback = $('edit-group-feedback');
    const id = $('edit-group-id')?.value;
    const name = $('edit-group-name')?.value.trim();
    if (!id) return;
    if (!name) {
      if (feedback) {
        feedback.className = 'text-sm text-danger';
        feedback.textContent = 'Group name is required';
      }
      return;
    }
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      await api(`/api/admin/groups/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ name }),
      });
      closeEditGroupModal();
      await loadGroups();
      if (selectedGroupId === id) openGroup(id);
    } catch (err) {
      if (feedback) {
        feedback.className = 'text-sm text-danger';
        feedback.textContent = err.message || 'Save failed';
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  $('close-edit-contact')?.addEventListener('click', closeEditContactModal);
  $('cancel-edit-contact')?.addEventListener('click', closeEditContactModal);
  $('edit-contact-backdrop')?.addEventListener('click', closeEditContactModal);

  $('edit-contact-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const feedback = $('edit-contact-feedback');
    const id = $('edit-contact-id')?.value;
    const name = $('edit-contact-name')?.value.trim();
    const phoneNumber = $('edit-contact-phone')?.value.trim();
    if (!id) return;
    if (!phoneNumber) {
      if (feedback) {
        feedback.className = 'text-sm text-danger';
        feedback.textContent = 'Phone is required';
      }
      return;
    }
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      await api(`/api/admin/contacts/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ name, phoneNumber }),
      });
      closeEditContactModal();
      if (selectedGroupId) openGroup(selectedGroupId);
    } catch (err) {
      if (feedback) {
        feedback.className = 'text-sm text-danger';
        feedback.textContent = err.message || 'Save failed';
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  $('edit-campaign-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const feedback = $('edit-camp-feedback');
    const id = $('edit-camp-id')?.value;
    const title = $('edit-camp-title')?.value.trim();
    const messageBody = $('edit-camp-body')?.value.trim() || '';
    const assignedDeviceIdentifier = $('edit-camp-device')?.value || '';
    const groupId = $('edit-camp-group')?.disabled ? '' : $('edit-camp-group')?.value || '';
    if (!id) return;
    if (!title) {
      if (feedback) {
        feedback.className = 'text-sm text-danger';
        feedback.textContent = 'Campaign name is required';
      }
      return;
    }
    if (!messageBody) {
      if (feedback) {
        feedback.className = 'text-sm text-danger';
        feedback.textContent = 'Message is required';
      }
      return;
    }
    const deviceLabel = assignedDeviceIdentifier
      ? cachedDevices.find((d) => d.deviceIdentifier === assignedDeviceIdentifier)?.deviceName ||
        assignedDeviceIdentifier
      : null;
    const groupOpt = groupId
      ? $('edit-camp-group')?.selectedOptions?.[0]?.textContent || 'selected group'
      : null;
    let confirmMsg = `Save “${title}”?`;
    if (groupOpt) {
      confirmMsg += ` Replace all contacts with “${groupOpt}”.`;
    } else {
      confirmMsg += ' Keep current contacts.';
    }
    confirmMsg += deviceLabel
      ? ` Device: ${deviceLabel}.`
      : ' No gateway (Inactive).';
    confirmMsg += ' Queued jobs get the new message text.';
    const ok = await appConfirm(confirmMsg, 'Save campaign', { confirmLabel: 'Save' });
    if (!ok) return;
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const body = {
        title,
        messageBody,
        assignedDeviceIdentifier: assignedDeviceIdentifier || null,
      };
      if (groupId) body.groupId = groupId;
      await api(`/api/admin/campaigns/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      if (feedback) {
        feedback.className = 'text-sm text-ok';
        feedback.textContent = 'Saved';
      }
      closeEditCampaignModal();
      await loadCampaigns();
      if (detailCampaignId === id) loadCampaignDetail();
    } catch (err) {
      if (feedback) {
        feedback.className = 'text-sm text-danger';
        feedback.textContent = err.message || 'Save failed';
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  document.querySelectorAll('#app .nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  async function copyText(text, okMessage = 'Copied') {
    try {
      await navigator.clipboard.writeText(text);
      await appAlert(okMessage, 'Copied');
    } catch {
      await appAlert(text, 'Copy');
    }
  }

  $('copy-apk-setup')?.addEventListener('click', async () => {
    fillApkSetupCard();
    const baseUrl = $('apk-setup-base-url')?.textContent || '';
    const token = companyApiToken || $('apk-setup-token')?.textContent || '';
    const text = [
      'Android app settings',
      `Server Base URL: ${baseUrl}`,
      `API Token (Bearer): ${token}`,
      'Jobs Batch Size: 5–10 recommended (APK setting, max 50)',
      'Send delay: 2000 ms between SMS (APK setting)',
      '',
      'Steps:',
      '1. Open APK Config screen',
      '2. Set Server Base URL and API Token',
      '3. Set batch size 5–10 and send delay 2000 ms',
      '4. Test & Register',
      '5. Activate a campaign in the portal (defaults Inactive)',
    ].join('\n');
    await copyText(text, 'Full Android setup copied.');
  });

  document.querySelector('#view-settings')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy-apk]');
    if (!btn) return;
    fillApkSetupCard();
    const which = btn.getAttribute('data-copy-apk');
    if (which === 'base-url') {
      await copyText($('apk-setup-base-url')?.textContent || '', 'Server Base URL copied.');
    } else if (which === 'token') {
      await copyText(companyApiToken || $('apk-setup-token')?.textContent || '', 'API token copied.');
    }
  });

  $('regen-apk-token')?.addEventListener('click', async () => {
    const ok = await appConfirm(
      'Regenerate API token? The Android app must be updated with the new token. The old token will stop working immediately.',
      'Regenerate token',
      { danger: true, confirmLabel: 'Regenerate' }
    );
    if (!ok) return;
    try {
      const data = await api('/api/admin/regenerate-token', { method: 'POST' });
      const newToken = data.company?.apiToken || '';
      companyApiToken = newToken;
      if (mode === 'master') {
        workspaceToken = newToken;
        if (workspaceToken) localStorage.setItem(WORKSPACE_TOKEN_KEY, workspaceToken);
      }
      fillApkSetupCard();
      if ($('company-api-token')) $('company-api-token').textContent = newToken || '—';
      await appAlert(`New API token:\n${newToken}\n\nUpdate the APK Config screen with this token.`, 'Token regenerated');
    } catch (err) {
      await appAlert(err.message, 'Error');
    }
  });
  $('refresh-overview-page')?.addEventListener('click', loadOverview);
  $('refresh-all-overview')?.addEventListener('click', loadAllOverview);
  $('hide-company-overview')?.addEventListener('click', hideCompanyOverview);
  $('company-overview-backdrop')?.addEventListener('click', hideCompanyOverview);
  $('back-to-companies')?.addEventListener('click', () => {
    hideCompanyOverview();
    switchView('companies');
  });
  $('refresh-company-overview')?.addEventListener('click', () => {
    if (viewingCompanyOverviewId) loadCompanyOverview(viewingCompanyOverviewId);
  });
  $('all-overview-tbody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action="overview"]');
    if (!btn) return;
    const row = btn.closest('tr[data-id]');
    const id = row?.dataset.id;
    if (id) await openCompanyOverview(id);
  });
  $('refresh-overview')?.addEventListener('click', () => {
    loadCampaigns();
  });
  $('refresh-campaign-detail')?.addEventListener('click', loadCampaignDetail);
  $('back-to-campaigns')?.addEventListener('click', () => switchView('campaigns'));
  document.querySelectorAll('.jump-campaigns').forEach((btn) => {
    btn.addEventListener('click', () => switchView('campaigns'));
  });
  $('detail-search').addEventListener('input', renderDetailMessages);
  $('detail-status').addEventListener('change', renderDetailMessages);

  $('detail-requeue-btn')?.addEventListener('click', async () => {
    const feedback = $('detail-requeue-feedback');
    const fromStatuses = [...document.querySelectorAll('.detail-requeue-status:checked')].map(
      (el) => el.value
    );
    if (!detailCampaignId) {
      if (feedback) {
        feedback.className = 'text-sm text-danger';
        feedback.textContent = 'No campaign selected';
      }
      return;
    }
    if (!fromStatuses.length) {
      if (feedback) {
        feedback.className = 'text-sm text-danger';
        feedback.textContent = 'Select at least one status';
      }
      return;
    }
    const ok = await appConfirm(
      `Reset all messages with status [${fromStatuses.join(', ')}] back to QUEUED for this campaign?`,
      'Bulk requeue',
      { danger: true }
    );
    if (!ok) return;
    try {
      const data = await api('/api/admin/messages/requeue', {
        method: 'POST',
        body: JSON.stringify({
          campaignId: detailCampaignId,
          fromStatuses,
        }),
      });
      if (feedback) {
        feedback.className = 'text-sm text-ok';
        feedback.textContent = `Requeued ${data.updated} message(s)`;
      }
      await loadCampaignDetail();
      loadOverview();
    } catch (err) {
      if (feedback) {
        feedback.className = 'text-sm text-danger';
        feedback.textContent = err.message || 'Requeue failed';
      }
    }
  });

  $('monitor-requeue-btn')?.addEventListener('click', async () => {
    const feedback = $('monitor-requeue-feedback');
    const status = ($('filter-status')?.value || '').trim();
    const campaignIdFilter = ($('filter-campaign')?.value || '').trim();
    if (!status || status === 'QUEUED') {
      if (feedback) {
        feedback.className = 'text-sm text-danger';
        feedback.textContent = 'Pick a non-Queued status filter first';
      }
      return;
    }
    const ok = await appConfirm(
      `Reset all company messages with status ${status}${
        campaignIdFilter ? ` in campaign ${campaignIdFilter}` : ''
      } back to QUEUED?`,
      'Bulk requeue',
      { danger: true }
    );
    if (!ok) return;
    try {
      const body = { fromStatuses: [status] };
      if (campaignIdFilter) body.campaignId = campaignIdFilter;
      const data = await api('/api/admin/messages/requeue', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (feedback) {
        feedback.className = 'text-sm text-ok';
        feedback.textContent = `Requeued ${data.updated} message(s)`;
      }
      loadMessages();
      loadOverview();
    } catch (err) {
      if (feedback) {
        feedback.className = 'text-sm text-danger';
        feedback.textContent = err.message || 'Requeue failed';
      }
    }
  });

  $('campaigns-tbody')?.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-edit-campaign]');
    if (editBtn) {
      e.preventDefault();
      e.stopPropagation();
      const id = editBtn.getAttribute('data-edit-campaign');
      if (id) await openEditCampaign(id);
      return;
    }

    const toggleBtn = e.target.closest('[data-toggle-campaign]');
    if (toggleBtn) {
      e.preventDefault();
      e.stopPropagation();
      const id = toggleBtn.getAttribute('data-toggle-campaign');
      const next = toggleBtn.getAttribute('data-next-status');
      if (!id || !next) return;
      const campaign = cachedCampaigns[id];
      const title = campaign?.title || 'this campaign';
      const pausing = next === 'INACTIVE';
      if (!pausing && !String(campaign?.assignedDeviceIdentifier || '').trim()) {
        await appAlert(
          'Assign a gateway device before activating this campaign. Use Edit to set the device.',
          'Device required'
        );
        return;
      }
      const ok = await appConfirm(
        pausing
          ? `Pause “${title}”? The APK will stop receiving new jobs from this campaign. Processing jobs will return to Queued.`
          : `Activate “${title}”? The APK will start pulling queued jobs from this campaign.`,
        pausing ? 'Pause campaign' : 'Activate campaign',
        { confirmLabel: pausing ? 'Pause' : 'Activate' }
      );
      if (!ok) return;
      toggleBtn.disabled = true;
      try {
        await api(`/api/admin/campaigns/${encodeURIComponent(id)}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: next }),
        });
        await loadCampaigns();
        if (detailCampaignId === id) loadCampaignDetail();
        loadOverview();
      } catch (err) {
        appAlert(err.message, 'Error');
        toggleBtn.disabled = false;
      }
      return;
    }

    const deleteBtn = e.target.closest('[data-delete-campaign]');
    if (deleteBtn) {
      e.preventDefault();
      e.stopPropagation();
      const id = deleteBtn.getAttribute('data-delete-campaign');
      if (!id) return;
      const campaign = cachedCampaigns[id];
      const title = campaign?.title || 'this campaign';
      const total = campaign?.totalMessages ?? 0;
      const ok = await appConfirm(
        `Delete “${title}”? This removes the campaign and all ${total} message job(s). This cannot be undone.`,
        'Delete campaign',
        { danger: true, confirmLabel: 'Delete' }
      );
      if (!ok) return;
      deleteBtn.disabled = true;
      try {
        await api(`/api/admin/campaigns/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (detailCampaignId === id) {
          detailCampaignId = '';
          detailCampaignMeta = null;
          if (currentView === 'campaign-detail') switchView('campaigns');
        }
        await loadCampaigns();
        loadOverview();
      } catch (err) {
        appAlert(err.message, 'Error');
        deleteBtn.disabled = false;
      }
      return;
    }

    if (e.target.closest('.action-menu')) return;

    const row = e.target.closest('[data-open-campaign]');
    if (!row) return;
    const id = row.getAttribute('data-open-campaign');
    const campaign = cachedCampaigns[id];
    if (campaign) openCampaignDetail(campaign);
  });
  $('refresh-groups').addEventListener('click', loadGroups);
  $('show-create-group').addEventListener('click', showCreateGroupPanel);
  $('hide-create-group').addEventListener('click', hideCreateGroupPanel);

  document.querySelectorAll('.group-add-mode').forEach((btn) => {
    btn.addEventListener('click', () => setCreateGroupMode(btn.dataset.groupAddMode));
  });

  $('create-manual-contacts').addEventListener('input', () => {
    $('create-manual-count').textContent = String(
      parseRecipientLines($('create-manual-contacts').value).length
    );
  });

  $('create-group-excel-btn').addEventListener('click', () => $('create-group-excel').click());
  $('create-group-excel').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const status = $('create-excel-status');
    if (!file) return;
    if (typeof XLSX === 'undefined') {
      status.className = 'text-xs text-danger';
      status.textContent = 'Excel library failed to load. Refresh the page.';
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      const recipients = parseExcelRows(rows);
      pendingCreateContacts = recipients.map((r) => ({
        name: r.recipientName || '',
        phoneNumber: r.phoneNumber,
      }));
      if (!pendingCreateContacts.length) {
        status.className = 'text-xs text-danger';
        status.textContent = 'No valid phone numbers found in file.';
        return;
      }
      status.className = 'text-xs text-ok';
      status.textContent = `Ready: ${pendingCreateContacts.length} contacts from ${file.name}`;
    } catch (err) {
      status.className = 'text-xs text-danger';
      status.textContent = 'Failed to read file.';
    }
  });

  const bodyEl = $('camp-body');
  bodyEl.addEventListener('input', () => {
    $('body-count').textContent = String(bodyEl.value.length);
  });
  $('camp-group').addEventListener('change', updateCampGroupCount);

  $('create-group-btn').addEventListener('click', async () => {
    const feedback = $('group-create-feedback');
    feedback.textContent = '';
    const name = $('new-group-name').value.trim();
    if (!name) {
      feedback.className = 'text-sm text-danger';
      feedback.textContent = 'Group name is required';
      return;
    }
    const contacts = getContactsForCreate();
    if (createGroupMode !== 'skip' && contacts.length === 0) {
      feedback.className = 'text-sm text-danger';
      feedback.textContent =
        createGroupMode === 'excel'
          ? 'Choose an Excel/CSV file, or switch to Manual / Empty'
          : 'Add at least one contact, or choose Empty for now';
      return;
    }
    const splitRaw = $('split-size').value.trim();
    const splitSize = splitRaw === '' ? null : parseInt(splitRaw, 10);
    if (splitRaw !== '' && (!splitSize || splitSize < 1)) {
      feedback.className = 'text-sm text-danger';
      feedback.textContent = 'Split amount must be a positive number, or leave empty for full';
      return;
    }
    try {
      const data = await api('/api/admin/groups', {
        method: 'POST',
        body: JSON.stringify({ name, contacts, splitSize }),
      });
      const count = data.groups?.length || 1;
      const added = data.totalContacts || 0;
      feedback.className = 'text-sm text-ok';
      if (count > 1) {
        feedback.textContent = `Created ${count} groups (${name}_1…${name}_${count}) · ${added} contacts`;
      } else if (added) {
        feedback.textContent = `Created ${data.group.name} with ${added} contacts`;
      } else {
        feedback.textContent = `Created ${data.group.name}`;
      }
      hideCreateGroupPanel();
      $('split-size').value = '';
      await loadGroups();
      if (data.group?.id) openGroup(data.group.id);
    } catch (err) {
      feedback.className = 'text-sm text-danger';
      feedback.textContent = err.message;
    }
  });

  $('clear-group-contacts-btn').addEventListener('click', async () => {
    if (!selectedGroupId) return;
    const ok = await appConfirm(
      'Delete ALL contacts in this group? The group itself will stay.',
      'Delete contacts',
      { danger: true }
    );
    if (!ok) return;
    try {
      const result = await api(`/api/admin/groups/${selectedGroupId}/contacts`, {
        method: 'DELETE',
      });
      $('group-import-feedback').className = 'text-sm text-ok';
      $('group-import-feedback').textContent = `Deleted ${result.deleted} contacts`;
      openGroup(selectedGroupId);
    } catch (err) {
      $('group-import-feedback').className = 'text-sm text-danger';
      $('group-import-feedback').textContent = err.message;
    }
  });

  $('manual-add-btn').addEventListener('click', async () => {
    if (!selectedGroupId) return;
    const name = $('manual-name').value.trim();
    const phoneNumber = $('manual-phone').value.trim();
    const feedback = $('group-import-feedback');
    feedback.textContent = '';
    if (!phoneNumber) {
      feedback.className = 'text-sm text-danger';
      feedback.textContent = 'Phone is required';
      return;
    }
    try {
      const result = await api(`/api/admin/groups/${selectedGroupId}/import`, {
        method: 'POST',
        body: JSON.stringify({ contacts: [{ name, phoneNumber }] }),
      });
      if (result.added === 0) {
        feedback.className = 'text-sm text-danger';
        feedback.textContent = 'Contact not added (invalid or duplicate phone)';
        return;
      }
      $('manual-name').value = '';
      $('manual-phone').value = '';
      feedback.className = 'text-sm text-ok';
      feedback.textContent = 'Contact added';
      openGroup(selectedGroupId);
    } catch (err) {
      feedback.className = 'text-sm text-danger';
      feedback.textContent = err.message;
    }
  });

  $('groups-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-g-action]');
    if (!btn) return;
    const id = btn.closest('tr')?.dataset.id;
    if (!id) return;
    try {
      if (btn.dataset.gAction === 'open') {
        openGroup(id);
      }
      if (btn.dataset.gAction === 'edit') {
        openEditGroup(id);
      }
      if (btn.dataset.gAction === 'delete') {
        const ok = await appConfirm(
          'Delete this group AND all contacts inside it? This cannot be undone.',
          'Delete group',
          { danger: true }
        );
        if (!ok) return;
        await api(`/api/admin/groups/${id}`, { method: 'DELETE' });
        if (selectedGroupId === id) {
          selectedGroupId = '';
          cachedGroupContacts = [];
          $('group-excel-btn').disabled = true;
          $('clear-group-contacts-btn').disabled = true;
          $('manual-add-row').classList.add('hidden');
          $('contact-search-wrap').classList.add('hidden');
          $('contact-search').value = '';
          $('selected-group-label').textContent = 'Select a group to view / add contacts';
          $('contacts-tbody').innerHTML =
            '<tr><td colspan="3" class="px-4 py-8 text-center text-slate-400">No group selected</td></tr>';
        }
        loadGroups();
      }
    } catch (err) {
      appAlert(err.message, 'Error');
    }
  });

  $('contact-search').addEventListener('input', () => {
    renderContactsTable(cachedGroupContacts);
  });

  $('contacts-tbody').addEventListener('click', async (e) => {
    const editBtn = e.target.closest('button[data-c-action="edit"]');
    if (editBtn) {
      const contactId = editBtn.closest('tr')?.dataset.contactId;
      if (contactId) openEditContact(contactId);
      return;
    }
    const btn = e.target.closest('button[data-c-action="delete"]');
    if (!btn) return;
    const contactId = btn.closest('tr')?.dataset.contactId;
    if (!contactId) return;
    const ok = await appConfirm('Remove this contact from the group?', 'Remove contact', {
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/admin/contacts/${contactId}`, { method: 'DELETE' });
      if (selectedGroupId) openGroup(selectedGroupId);
    } catch (err) {
      appAlert(err.message, 'Error');
    }
  });

  $('group-excel-btn').addEventListener('click', () => {
    if (!selectedGroupId) return;
    $('group-excel-import').click();
  });

  $('group-excel-import').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const importFb = $('group-import-feedback');
    if (!file || !selectedGroupId) return;

    if (typeof XLSX === 'undefined') {
      importFb.className = 'text-danger';
      importFb.textContent = 'Excel library failed to load. Refresh the page.';
      return;
    }

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      const recipients = parseExcelRows(rows);
      if (!recipients.length) {
        importFb.className = 'text-danger';
        importFb.textContent = 'No valid phone numbers found.';
        return;
      }
      const contacts = recipients.map((r) => ({
        name: r.recipientName || '',
        phoneNumber: r.phoneNumber,
      }));
      const result = await api(`/api/admin/groups/${selectedGroupId}/import`, {
        method: 'POST',
        body: JSON.stringify({ contacts }),
      });
      importFb.className = 'text-ok';
      importFb.textContent = `Added ${result.added}` + (result.skipped ? `, skipped ${result.skipped}` : '');
      openGroup(selectedGroupId);
    } catch (err) {
      importFb.className = 'text-danger';
      importFb.textContent = err.message || 'Import failed';
    }
  });

  $('campaign-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const feedback = $('create-feedback');
    const btn = $('create-btn');
    feedback.textContent = '';
    const groupId = $('camp-group').value;
    if (!groupId) {
      feedback.className = 'text-sm text-danger';
      feedback.textContent = 'Select a contact group';
      return;
    }
    const title = $('camp-title').value.trim();
    const status = $('camp-status')?.value || 'INACTIVE';
    const assignedDeviceIdentifier = $('camp-device')?.value || '';
    if (!assignedDeviceIdentifier) {
      feedback.className = 'text-sm text-danger';
      feedback.textContent = 'Select a gateway device';
      return;
    }
    const count = $('camp-group-count')?.textContent || '?';
    const deviceLabel =
      cachedDevices.find((d) => d.deviceIdentifier === assignedDeviceIdentifier)?.deviceName ||
      assignedDeviceIdentifier;
    const okCreate = await appConfirm(
      status === 'ACTIVE'
        ? `Create “${title}” (${count} messages) as Active on ${deviceLabel}? Pulls can start immediately.`
        : `Create “${title}” (${count} messages) as Inactive on ${deviceLabel}? Activate later to allow pulls.`,
      'Create campaign',
      { confirmLabel: 'Create & Queue' }
    );
    if (!okCreate) return;
    btn.disabled = true;
    try {
      const data = await api('/api/admin/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          title,
          messageBody: bodyEl.value.trim(),
          groupId,
          status,
          assignedDeviceIdentifier,
        }),
      });
      feedback.className = 'text-sm text-ok';
      feedback.textContent = `Queued ${data.campaign.totalMessages} jobs · ${data.campaign.status || 'INACTIVE'}`;
      $('campaign-form').reset();
      if ($('camp-status')) $('camp-status').value = 'INACTIVE';
      if ($('camp-device')) $('camp-device').value = '';
      $('body-count').textContent = '0';
      $('camp-group-count').textContent = '0';
      closeCreateCampaignModal();
      switchView('campaigns');
      loadCampaigns();
    } catch (err) {
      feedback.className = 'text-sm text-danger';
      feedback.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $('settings-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const statusEl = $('settings-status');
    const input = $('setting-job-batch-size');
    const value = parseInt(input?.value, 10);
    if (!Number.isFinite(value) || value < 1 || value > 50) {
      if (statusEl) {
        statusEl.className = 'text-sm text-danger';
        statusEl.textContent = 'Enter a number between 1 and 50';
        delete statusEl.dataset.saved;
      }
      return;
    }
    try {
      const data = await api('/api/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify({ jobBatchSize: value }),
      });
      const saved = data.settings?.jobBatchSize ?? value;
      if (input) input.value = String(saved);
      if (statusEl) {
        statusEl.className = 'text-sm text-ok';
        statusEl.textContent = `Saved · ${saved} jobs per pull`;
        statusEl.dataset.saved = '1';
        setTimeout(() => {
          if (statusEl.dataset.saved === '1') {
            statusEl.textContent = '';
            delete statusEl.dataset.saved;
          }
        }, 4000);
      }
    } catch (err) {
      if (statusEl) {
        statusEl.className = 'text-sm text-danger';
        statusEl.textContent = err.message || 'Save failed';
        delete statusEl.dataset.saved;
      }
    }
  });

  $('apply-filters').addEventListener('click', loadMessages);
  $('refresh-monitor').addEventListener('click', loadMessages);
  $('refresh-gateways').addEventListener('click', loadDevices);
  $('refresh-companies').addEventListener('click', loadCompanies);
  $('show-create-company')?.addEventListener('click', showCreateCompany);
  $('hide-create-company')?.addEventListener('click', hideCreateCompany);
  $('cancel-create-company')?.addEventListener('click', hideCreateCompany);
  $('create-company-backdrop')?.addEventListener('click', hideCreateCompany);
  $('hide-edit-company').addEventListener('click', hideEditCompany);
  $('add-edit-user').addEventListener('click', () => {
    $('edit-users-list').insertAdjacentHTML('beforeend', userEditRow());
  });

  $('edit-users-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-user]');
    if (!btn) return;
    const row = btn.closest('.edit-user-row');
    const uid = row?.dataset.userId;
    const rows = $('edit-users-list').querySelectorAll('.edit-user-row');
    if (rows.length <= 1) {
      appAlert('Company must keep at least one user.', 'Cannot remove');
      return;
    }
    if (uid) editRemovedUserIds.push(uid);
    row.remove();
  });

  // Show / hide password toggles (create + edit)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-toggle-password]');
    if (!btn) return;
    const input = document.getElementById(btn.dataset.togglePassword);
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'Show' : 'Hide';
  });

  $('edit-company-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const feedback = $('edit-company-feedback');
    feedback.textContent = '';
    const id = $('edit-co-id').value;
    const users = [];
    let passwordError = '';

    $('edit-users-list').querySelectorAll('.edit-user-row').forEach((row) => {
      const get = (field) => row.querySelector(`[data-field="${field}"]`)?.value?.trim() || '';
      const password = row.querySelector('[data-field="password"]')?.value || '';
      const passwordConfirm = row.querySelector('[data-field="passwordConfirm"]')?.value || '';
      if (password || passwordConfirm) {
        if (password !== passwordConfirm) {
          passwordError = `Passwords do not match for user "${get('username') || get('name')}"`;
        }
      }
      const entry = {
        name: get('name'),
        email: get('email'),
        username: get('username'),
        role: get('role') || 'admin',
      };
      if (row.dataset.userId) entry.id = row.dataset.userId;
      if (password) entry.password = password;
      users.push(entry);
    });

    if (passwordError) {
      feedback.className = 'text-sm text-danger';
      feedback.textContent = passwordError;
      return;
    }

    try {
      await api(`/api/master/companies/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: $('edit-co-name').value.trim(),
          users,
          removeUserIds: editRemovedUserIds,
        }),
      });
      feedback.className = 'text-sm text-ok';
      feedback.textContent = 'Company & login credentials saved';
      editRemovedUserIds = [];
      loadCompanies();
      setTimeout(() => hideEditCompany(), 800);
    } catch (err) {
      feedback.className = 'text-sm text-danger';
      feedback.textContent = err.message;
    }
  });

  $('company-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const feedback = $('company-feedback');
    feedback.textContent = '';
    $('new-token-box').classList.add('hidden');

    const password = $('u-password').value;
    const confirm = $('u-password-confirm').value;
    if (password !== confirm) {
      feedback.className = 'text-sm text-danger';
      feedback.textContent = 'Password and confirm password do not match';
      return;
    }

    const users = [
      {
        name: $('u-name').value.trim(),
        email: $('u-email').value.trim(),
        username: $('u-username').value.trim(),
        password,
        role: 'admin',
      },
    ];

    const extra = $('extra-users').value.trim();
    if (extra) {
      for (const line of extra.split('\n')) {
        const parts = line.split(',').map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 4) {
          users.push({
            name: parts[0],
            email: parts[1],
            username: parts[2],
            password: parts[3],
            role: parts[4] || 'member',
          });
        }
      }
    }

    try {
      const data = await api('/api/master/companies', {
        method: 'POST',
        body: JSON.stringify({
          name: $('co-name').value.trim(),
          users,
        }),
      });
      feedback.className = 'text-sm text-ok';
      feedback.textContent = `Created ${data.company.name}`;
      $('new-token-value').textContent = data.company.apiToken;
      $('new-token-box').classList.remove('hidden');
      $('company-form').reset();
      loadCompanies();
      // Keep panel open briefly so the API token can be copied
    } catch (err) {
      feedback.className = 'text-sm text-danger';
      feedback.textContent = err.message;
    }
  });

  $('companies-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const row = btn.closest('tr[data-id]');
    const id = row?.dataset.id;
    if (!id) return;

    try {
      if (btn.dataset.action === 'overview') {
        await openCompanyOverview(id);
      }
      if (btn.dataset.action === 'edit') {
        await openEditCompany(id);
      }
      if (btn.dataset.action === 'regen') {
        const ok = await appConfirm(
          'Regenerate API token? Old Android apps must be updated with the new token.',
          'Regenerate token'
        );
        if (!ok) return;
        const data = await api(`/api/master/companies/${id}/regenerate-token`, { method: 'POST' });
        await appAlert(`New token:\n${data.company.apiToken}`, 'API token');
        loadCompanies();
      }
      if (btn.dataset.action === 'delete') {
        const ok = await appConfirm(
          'Delete this company and ALL its campaigns, jobs, devices, groups, and users? This cannot be undone.',
          'Delete company',
          { danger: true }
        );
        if (!ok) return;
        await api(`/api/master/companies/${id}`, { method: 'DELETE' });
        hideEditCompany();
        loadCompanies();
      }
    } catch (err) {
      appAlert(err.message, 'Error');
    }
  });

  // Boot — restore session if token still valid
  if (token) {
    if (mode === 'master') {
      masterToken = masterToken || token;
      api('/api/master/companies')
        .then(() => unlockMaster())
        .catch(() => lock());
    } else {
      loadMe()
        .then(() => unlockCompany())
        .catch(() => lock());
    }
  }
})();
