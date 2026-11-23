const bcrypt = require('bcryptjs');

const ROUNDS = 10;

function hashPassword(plain) {
  return bcrypt.hashSync(String(plain), ROUNDS);
}

function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  return bcrypt.compareSync(String(plain), String(hash));
}

module.exports = { hashPassword, verifyPassword };
