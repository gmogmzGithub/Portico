const crypto = require('crypto');

function generateReferenceId() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dateStr = `${year}${month}${day}`;
  const suffix = crypto.randomBytes(2).toString('hex'); // 2 bytes = 4 hex chars
  return `PORTICO-${dateStr}-${suffix}`;
}

module.exports = { generateReferenceId };
