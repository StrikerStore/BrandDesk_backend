require('dotenv').config();
const mysql = require('mysql2/promise');

// Helper: add column if it doesn't exist
async function addColumn(conn, table, col, def) {
  const [rows] = await conn.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [col]);
  if (rows.length === 0) {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    console.log(`  ✅ ${table}.${col} added`);
  }
}

// Helper: add index if it doesn't exist
async function addIndex(conn, table, indexName, indexDef) {
  try {
    await conn.query(`ALTER TABLE ${table} ADD ${indexDef}`);
    console.log(`  ✅ ${indexName} added`);
  } catch (err) {
    if (err.code === 'ER_DUP_KEYNAME') return;
    throw err;
  }
}

async function migrate() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  });

  console.log('🔄 Running migrations...');

  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || 'helpdesk'}\``);
  await conn.query(`USE \`${process.env.DB_NAME || 'helpdesk'}\``);

  // ── Auth tokens ────────────────────────────────────────────
  await conn.query(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expiry_date BIGINT,
      history_id BIGINT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await addColumn(conn, 'auth_tokens', 'history_id', 'BIGINT NULL');

  // ── Customers ──────────────────────────────────────────────
  await conn.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      name VARCHAR(255),
      shopify_id VARCHAR(100),
      phone VARCHAR(50),
      location VARCHAR(255),
      total_orders INT DEFAULT 0,
      lifetime_value DECIMAL(10,2) DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_email (email)
    )
  `);
  await addColumn(conn, 'customers', 'phone', 'VARCHAR(50) NULL');

  // ── Threads ────────────────────────────────────────────────
  await conn.query(`
    CREATE TABLE IF NOT EXISTS threads (
      id INT AUTO_INCREMENT PRIMARY KEY,
      gmail_thread_id VARCHAR(255) NOT NULL UNIQUE,
      subject VARCHAR(500),
      brand VARCHAR(100),
      brand_email VARCHAR(255),
      status ENUM('open','in_progress','resolved') DEFAULT 'open',
      priority ENUM('urgent','normal','low') DEFAULT 'normal',
      customer_email VARCHAR(255),
      customer_name VARCHAR(255),
      is_unread TINYINT(1) DEFAULT 1,
      snoozed_until TIMESTAMP NULL,
      tags JSON,
      first_response_minutes INT NULL,
      ticket_id VARCHAR(100) NULL,
      order_number VARCHAR(100) NULL,
      issue_category VARCHAR(255) NULL,
      sub_issue VARCHAR(255) NULL,
      customer_phone VARCHAR(50) NULL,
      customer_country VARCHAR(10) NULL,
      is_shopify_form TINYINT(1) DEFAULT 0,
      status_changed_at TIMESTAMP NULL,
      resolved_by VARCHAR(255) NULL,
      resolution_note TEXT NULL,
      resolved_at TIMESTAMP NULL,
      auto_ack_sent TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_gmail_thread_id (gmail_thread_id),
      INDEX idx_status (status),
      INDEX idx_brand (brand),
      INDEX idx_customer_email (customer_email)
    )
  `);
  // v2 columns
  await addColumn(conn, 'threads', 'ticket_id',        'VARCHAR(100) NULL');
  await addColumn(conn, 'threads', 'order_number',     'VARCHAR(100) NULL');
  await addColumn(conn, 'threads', 'issue_category',   'VARCHAR(255) NULL');
  await addColumn(conn, 'threads', 'sub_issue',        'VARCHAR(255) NULL');
  await addColumn(conn, 'threads', 'customer_phone',   'VARCHAR(50) NULL');
  await addColumn(conn, 'threads', 'customer_country', 'VARCHAR(10) NULL');
  await addColumn(conn, 'threads', 'is_shopify_form',  'TINYINT(1) DEFAULT 0');
  // v4 columns
  await addColumn(conn, 'threads', 'status_changed_at', 'TIMESTAMP NULL');
  await addColumn(conn, 'threads', 'resolved_by',       'VARCHAR(255) NULL');
  await addColumn(conn, 'threads', 'resolution_note',   'TEXT NULL');
  await addColumn(conn, 'threads', 'resolved_at',       'TIMESTAMP NULL');
  // v6 column
  await addColumn(conn, 'threads', 'auto_ack_sent', 'TINYINT(1) DEFAULT 0');
  // v2 index
  await addIndex(conn, 'threads', 'idx_ticket_id', 'INDEX idx_ticket_id (ticket_id)');
  // v4 backfill
  await conn.query(`UPDATE threads SET status_changed_at = created_at WHERE status_changed_at IS NULL`);

  // ── Messages ───────────────────────────────────────────────
  await conn.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      thread_id INT NOT NULL,
      gmail_message_id VARCHAR(255) UNIQUE,
      direction ENUM('inbound','outbound') NOT NULL,
      from_email VARCHAR(255),
      from_name VARCHAR(255),
      body TEXT,
      body_html TEXT,
      is_note TINYINT(1) DEFAULT 0,
      sent_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
      INDEX idx_thread_id (thread_id),
      INDEX idx_gmail_message_id (gmail_message_id)
    )
  `);

  // ── Templates ──────────────────────────────────────────────
  await conn.query(`
    CREATE TABLE IF NOT EXISTS templates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      category VARCHAR(100),
      body TEXT NOT NULL,
      brand_filter VARCHAR(100) DEFAULT NULL,
      usage_count INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  // ── Saved Views (v5) ──────────────────────────────────────
  await conn.query(`
    CREATE TABLE IF NOT EXISTS saved_views (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      filters JSON NOT NULL,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── Settings (v6) ─────────────────────────────────────────
  await conn.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key_name VARCHAR(100) PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  const defaults = [
    ['auto_ack_enabled',       'false'],
    ['auto_ack_delay_minutes', '5'],
    ['auto_close_enabled',     'false'],
    ['auto_close_days',        '7'],
  ];
  for (const [key, value] of defaults) {
    await conn.query(`INSERT IGNORE INTO settings (key_name, value) VALUES (?, ?)`, [key, value]);
  }

  // ── Users (v7) ────────────────────────────────────────────
  await conn.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('admin', 'agent') DEFAULT 'agent',
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_email (email)
    )
  `);

  // ── Attachments (v8) ──────────────────────────────────────
  await conn.query(`
    CREATE TABLE IF NOT EXISTS attachments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      message_id INT NOT NULL,
      gmail_message_id VARCHAR(255) NOT NULL,
      attachment_id VARCHAR(500) NOT NULL,
      filename VARCHAR(500) NOT NULL,
      mime_type VARCHAR(100) NOT NULL,
      size INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_message_id (message_id),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    )
  `);

  // ── Fulltext indexes (v3) ─────────────────────────────────
  try {
    await conn.query(`ALTER TABLE threads ADD FULLTEXT INDEX ft_threads (subject, customer_name, customer_email, ticket_id, order_number, issue_category)`);
  } catch (err) {
    if (err.code !== 'ER_DUP_KEYNAME') console.log('  ⚠ fulltext threads:', err.message);
  }
  try {
    await conn.query(`ALTER TABLE messages ADD FULLTEXT INDEX ft_messages (body)`);
  } catch (err) {
    if (err.code !== 'ER_DUP_KEYNAME') console.log('  ⚠ fulltext messages:', err.message);
  }

  console.log('✅ All migrations complete');
  await conn.end();
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
