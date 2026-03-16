require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');

async function seedAdmin() {
  // Read from env or use defaults for first-time setup
  const name     = process.env.ADMIN_NAME     || 'Admin';
  const email    = process.env.ADMIN_EMAIL    || 'admin@plexzuu.com';
  const password = process.env.ADMIN_PASSWORD || 'changeme123';

  console.log('🌱 Creating admin user...');
  console.log(`   Name:  ${name}`);
  console.log(`   Email: ${email}`);
  console.log(`   Role:  admin`);
  console.log('');

  const hash = await bcrypt.hash(password, 12);

  try {
    await db.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES (?, ?, ?, 'admin')
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         password_hash = VALUES(password_hash),
         role = 'admin',
         is_active = 1`,
      [name, email, hash]
    );
    console.log('✅ Admin user created successfully.');
    console.log('');
    console.log('Login credentials:');
    console.log(`  Email:    ${email}`);
    console.log(`  Password: ${password}`);
    console.log('');
    console.log('⚠  Change this password after first login via Settings → My account.');
  } catch (err) {
    console.error('❌ Failed to create admin:', err.message);
  }

  process.exit(0);
}

seedAdmin();