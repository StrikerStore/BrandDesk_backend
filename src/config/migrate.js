require('dotenv').config();
const mysql = require('mysql2/promise');

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

  // Auth tokens table
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

  // Add history_id column if missing (existing installs)
  await conn.query(`
    ALTER TABLE auth_tokens ADD COLUMN IF NOT EXISTS history_id BIGINT NULL
  `).catch(() => {});

  // Customers table
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

  // Threads table
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_gmail_thread_id (gmail_thread_id),
      INDEX idx_status (status),
      INDEX idx_brand (brand),
      INDEX idx_customer_email (customer_email)
    )
  `);

  // Messages table
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

  // Templates table
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

  console.log('✅ Migrations complete');
  await conn.end();
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
