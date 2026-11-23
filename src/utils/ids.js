const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

function newId() {
  return uuidv4();
}

function campaignId() {
  return `camp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function companyId() {
  return `co_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
}

function gatewayId() {
  return `gw_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
}

function apiToken() {
  return `tok_${crypto.randomBytes(24).toString('hex')}`;
}

module.exports = { newId, campaignId, companyId, gatewayId, apiToken };
