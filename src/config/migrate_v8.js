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

  console.log('🔄 Running v8 migrations...');

  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS attachments (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        message_id      INT NOT NULL,
        gmail_message_id VARCHAR(255) NOT NULL,
        attachment_id   VARCHAR(500) NOT NULL,
        filename        VARCHAR(500) NOT NULL,
        mime_type       VARCHAR(100) NOT NULL,
        size            INT DEFAULT 0,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_message_id (message_id),
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      )
    `);
    console.log('  ✅ attachments table created');
  } catch (err) {
    if (err.code === 'ER_TABLE_EXISTS_ERROR') console.log('  ⏭  attachments table already exists');
    else throw err;
  }

  console.log('✅ v8 migrations complete');
  await conn.end();
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});