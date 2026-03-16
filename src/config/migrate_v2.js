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

  console.log('🔄 Running v2 migrations...');

  // Add parsed ticket fields to threads table
  const newThreadCols = [
    { col: 'ticket_id',       def: 'VARCHAR(100) NULL' },
    { col: 'order_number',    def: 'VARCHAR(100) NULL' },
    { col: 'issue_category',  def: 'VARCHAR(255) NULL' },
    { col: 'sub_issue',       def: 'VARCHAR(255) NULL' },
    { col: 'customer_phone',  def: 'VARCHAR(50) NULL' },
    { col: 'customer_country',def: 'VARCHAR(10) NULL' },
    { col: 'is_shopify_form', def: 'TINYINT(1) DEFAULT 0' },
  ];

  for (const { col, def } of newThreadCols) {
    try {
      await conn.query(`ALTER TABLE threads ADD COLUMN ${col} ${def}`);
      console.log(`  ✅ threads.${col} added`);
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log(`  ⏭  threads.${col} already exists`);
      } else {
        throw err;
      }
    }
  }

  // Add phone to customers table
  try {
    await conn.query('ALTER TABLE customers ADD COLUMN phone VARCHAR(50) NULL');
    console.log('  ✅ customers.phone added');
  } catch (err) {
    if (err.code === 'ER_DUP_FIELDNAME') {
      console.log('  ⏭  customers.phone already exists');
    } else {
      throw err;
    }
  }

  // Add index on ticket_id for fast lookup
  try {
    await conn.query('ALTER TABLE threads ADD INDEX idx_ticket_id (ticket_id)');
    console.log('  ✅ index on ticket_id added');
  } catch (err) {
    if (err.code === 'ER_DUP_KEYNAME') {
      console.log('  ⏭  index on ticket_id already exists');
    } else {
      throw err;
    }
  }

  console.log('✅ v2 migrations complete');
  await conn.end();
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});