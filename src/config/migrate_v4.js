
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

  console.log('🔄 Running v4 migrations...');

  const cols = [
    { col: 'status_changed_at',  def: 'TIMESTAMP NULL' },
    { col: 'resolved_by',        def: 'VARCHAR(255) NULL' },
    { col: 'resolution_note',    def: 'TEXT NULL' },
    { col: 'resolved_at',        def: 'TIMESTAMP NULL' },
  ];

  for (const { col, def } of cols) {
    try {
      await conn.query(`ALTER TABLE threads ADD COLUMN ${col} ${def}`);
      console.log(`  ✅ threads.${col} added`);
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log(`  ⏭  threads.${col} already exists`);
      } else throw err;
    }
  }

  // Set status_changed_at = created_at for existing threads
  await conn.query(`UPDATE threads SET status_changed_at = created_at WHERE status_changed_at IS NULL`);
  console.log('  ✅ backfilled status_changed_at');

  console.log('✅ v4 migrations complete');
  await conn.end();
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});