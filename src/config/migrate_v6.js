require('dotenv').config();
const mysql = require('mysql2/promise');

async function migrate() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'helpdesk',
  });

  console.log('🔄 Running v6 migrations...');

  // Settings table — key/value store for app config
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key_name VARCHAR(100) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log('  ✅ settings table created');
  } catch (err) {
    console.log('  ⚠ settings:', err.message);
  }

  // Add auto_ack_sent flag to threads
  try {
    await conn.query(`ALTER TABLE threads ADD COLUMN auto_ack_sent TINYINT(1) DEFAULT 0`);
    console.log('  ✅ threads.auto_ack_sent added');
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') console.log('  ⏭  threads.auto_ack_sent exists');
    else throw err;
  }

  // Seed default settings
  const defaults = [
    ['auto_ack_enabled',       'false'],
    ['auto_ack_delay_minutes', '5'],
    ['auto_close_enabled',     'false'],
    ['auto_close_days',        '7'],
  ];
  for (const [key, value] of defaults) {
    await conn.query(
      `INSERT IGNORE INTO settings (key_name, value) VALUES (?, ?)`,
      [key, value]
    );
  }
  console.log('  ✅ default settings seeded');

  console.log('✅ v6 migrations complete');
  await conn.end();
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});