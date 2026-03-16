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

  console.log('🔄 Running v3 migrations...');

  // Add fulltext index for global search on threads
  try {
    await conn.query(`
      ALTER TABLE threads 
      ADD FULLTEXT INDEX ft_threads (subject, customer_name, customer_email, ticket_id, order_number, issue_category)
    `);
    console.log('  ✅ fulltext index on threads added');
  } catch (err) {
    if (err.code === 'ER_DUP_KEYNAME') {
      console.log('  ⏭  fulltext index already exists');
    } else {
      console.log('  ⚠  fulltext index skipped:', err.message);
    }
  }

  // Add fulltext index on messages body for search
  try {
    await conn.query(`ALTER TABLE messages ADD FULLTEXT INDEX ft_messages (body)`);
    console.log('  ✅ fulltext index on messages added');
  } catch (err) {
    if (err.code === 'ER_DUP_KEYNAME') {
      console.log('  ⏭  fulltext index on messages already exists');
    } else {
      console.log('  ⚠  fulltext index on messages skipped:', err.message);
    }
  }

  console.log('✅ v3 migrations complete');
  await conn.end();
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});