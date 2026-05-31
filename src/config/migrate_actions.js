require('dotenv').config();
const db = require('./db');

async function migrate() {
  console.log('🔧 Running thread_actions migration...');

  await db.query(`
    CREATE TABLE IF NOT EXISTS thread_actions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      thread_id INT NOT NULL,
      action_type ENUM('exchange', 'return', 'alternate_product') NOT NULL,

      pickup_jersey VARCHAR(255),
      exchange_jersey VARCHAR(255),
      alternate_jersey VARCHAR(255),

      -- Exchange status
      exchange_order_id VARCHAR(100),
      exchange_pickup_done TINYINT(1) DEFAULT 0,
      exchange_packed TINYINT(1) DEFAULT 0,

      -- Return status
      return_created TINYINT(1) DEFAULT 0,
      return_received TINYINT(1) DEFAULT 0,
      refund_done TINYINT(1) DEFAULT 0,
      refund_id VARCHAR(100),
      refund_time VARCHAR(100),

      -- Alternate product status
      alt_order_created TINYINT(1) DEFAULT 0,
      original_order_cancelled TINYINT(1) DEFAULT 0,

      is_closed TINYINT(1) DEFAULT 0,
      closed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
    )
  `);

  console.log('✅ thread_actions table ready');
  process.exit(0);
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
