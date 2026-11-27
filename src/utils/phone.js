/**
 * Ethiopian mobile numbers:
 * - Ethio Telecom: 09XXXXXXXX (+2519XXXXXXXX)
 * - Safaricom Ethiopia: 07XXXXXXXX (+2517XXXXXXXX)
 *
 * Stored/normalized form: 10-digit national (09… or 07…).
 */

function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '');
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, phone: string } | { ok: false, error: string }}
 */
function normalizeEthiopianMobile(raw) {
  let s = String(raw ?? '')
    .trim()
    .replace(/[\s\-().]/g, '');
  if (!s) {
    return { ok: false, error: 'Phone number is required' };
  }

  // Excel scientific notation
  if (/e\+/i.test(s)) {
    const n = Number(String(raw).trim());
    if (Number.isFinite(n)) s = n.toFixed(0);
  }

  // Keep leading + only as marker then strip to digits
  s = s.replace(/^\+/, '');
  let d = digitsOnly(s);

  // 2519XXXXXXXX / 2517XXXXXXXX → 09… / 07…
  if (d.startsWith('251') && d.length === 12 && /^251[79]\d{8}$/.test(d)) {
    d = `0${d.slice(3)}`;
  }

  // 9XXXXXXXX / 7XXXXXXXX (missing leading 0)
  if (d.length === 9 && /^[79]\d{8}$/.test(d)) {
    d = `0${d}`;
  }

  // Already national 10-digit
  if (d.length === 10 && /^0[79]\d{8}$/.test(d)) {
    return { ok: true, phone: d };
  }

  return {
    ok: false,
    error:
      'Invalid Ethiopian mobile. Use Ethio 09XXXXXXXX or Safaricom 07XXXXXXXX (or +251…)',
  };
}

function isEthiopianMobile(raw) {
  return normalizeEthiopianMobile(raw).ok;
}

module.exports = {
  normalizeEthiopianMobile,
  isEthiopianMobile,
  digitsOnly,
};
