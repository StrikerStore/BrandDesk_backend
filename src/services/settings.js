const db = require('../config/db');

async function getSetting(key, defaultValue = null) {
  const [rows] = await db.query('SELECT value FROM settings WHERE key_name = ?', [key]);
  if (!rows.length) return defaultValue;
  return rows[0].value;
}

async function setSetting(key, value) {
  await db.query(
    `INSERT INTO settings (key_name, value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    [key, String(value)]
  );
}

async function getAllSettings() {
  const [rows] = await db.query('SELECT key_name, value FROM settings');
  return rows.reduce((acc, r) => ({ ...acc, [r.key_name]: r.value }), {});
}

module.exports = { getSetting, setSetting, getAllSettings };