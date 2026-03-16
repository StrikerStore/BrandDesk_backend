require('dotenv').config();
const mysql = require('mysql2/promise');

async function reset() {
  // Safety guard — never run in production
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ Cannot run reset in production. This is a dev-only script.');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    database: process.env.DB_NAME || 'helpdesk',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  });

  console.log('🗑  Resetting all data...');

  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  await conn.query('TRUNCATE TABLE messages');
  await conn.query('TRUNCATE TABLE threads');
  await conn.query('TRUNCATE TABLE customers');
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');

  console.log('✅ messages   — cleared');
  console.log('✅ threads    — cleared');
  console.log('✅ customers  — cleared');
  console.log('');
  console.log('Templates and auth tokens are kept intact.');
  console.log('');
  console.log('Now restart the server and visit:');
  console.log('  http://localhost:3001/api/sync?full=true');
  console.log('to pull all emails fresh with the updated parser.');

  await conn.end();
}

reset().catch(err => {
  console.error('❌ Reset failed:', err.message);
  process.exit(1);
});