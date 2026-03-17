const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { generateToken, requireAuth, requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

// ── Rate limiting for login ──────────────────────────────────
const loginAttempts = new Map(); // ip → { count, resetAt }

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (entry && now < entry.resetAt) {
    if (entry.count >= 10) return false; // 10 attempts per 15 mins
    entry.count++;
  } else {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
  }
  return true;
}

// POST /api/users/login — public
router.post('/login', async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  if (!checkLoginRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }

  try {
    const { email, password } = req.body;
    if (!email?.trim() || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const [rows] = await db.query(
      'SELECT * FROM users WHERE email = ? AND is_active = 1',
      [email.toLowerCase().trim()]
    );

    // Same error message for missing user OR wrong password (prevents email enumeration)
    if (!rows.length) {
      await bcrypt.hash('dummy', 10); // timing attack prevention
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = generateToken(user);
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      // 'none' is required for cross-origin cookies (frontend on branddesk.in,
      // backend on railway.app). Must be paired with secure:true.
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    // Clear rate limit on success
    loginAttempts.delete(ip);

    res.json({
      user:  { id: user.id, name: user.name, email: user.email, role: user.role },
      token, // also return in body for cross-domain localStorage fallback
    });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' }); // don't expose internals
  }
});

// POST /api/users/logout — public (just clears cookie)
router.post('/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  });
  res.json({ success: true });
});

// GET /api/users/me — auth required
router.get('/me', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, name, email, role, created_at FROM users WHERE id = ? AND is_active = 1',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// PATCH /api/users/me — auth required
router.patch('/me', requireAuth, async (req, res) => {
  try {
    const { name, current_password, new_password } = req.body;
    const updates = [];
    const params = [];

    if (name?.trim()) {
      updates.push('name = ?');
      params.push(name.trim().slice(0, 100)); // max 100 chars
    }

    if (new_password) {
      if (!current_password) return res.status(400).json({ error: 'Current password required' });
      const [rows] = await db.query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
      const valid = await bcrypt.compare(current_password, rows[0].password_hash);
      if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });
      if (new_password.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
      updates.push('password_hash = ?');
      params.push(await bcrypt.hash(new_password, 12));
    }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.user.id);
    await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    const [rows] = await db.query('SELECT id, name, email, role FROM users WHERE id = ?', [req.user.id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// GET /api/users — admin only
router.get('/', requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, name, email, role, is_active, created_at FROM users ORDER BY role ASC, name ASC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// POST /api/users — admin only
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, email, password, role = 'agent' } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    if (!email?.trim() || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!['admin', 'agent'].includes(role)) return res.status(400).json({ error: 'Role must be admin or agent' });

    const hash = await bcrypt.hash(password, 12);
    const [result] = await db.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [name.trim().slice(0, 100), email.toLowerCase().trim(), hash, role]
    );
    const [rows] = await db.query(
      'SELECT id, name, email, role, is_active, created_at FROM users WHERE id = ?',
      [result.insertId]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already exists' });
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PATCH /api/users/:id — admin only
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const { name, role, is_active, password } = req.body;
    const updates = [];
    const params = [];

    if (name?.trim())            { updates.push('name = ?');      params.push(name.trim().slice(0, 100)); }
    if (role && ['admin','agent'].includes(role)) { updates.push('role = ?'); params.push(role); }
    if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }
    if (password && password.length >= 8) {
      updates.push('password_hash = ?');
      params.push(await bcrypt.hash(password, 12));
    }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(req.params.id);
    await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    const [rows] = await db.query(
      'SELECT id, name, email, role, is_active, created_at FROM users WHERE id = ?',
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// DELETE /api/users/:id — admin only, can't delete self
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.user.id) {
      return res.status(400).json({ error: 'Cannot deactivate your own account' });
    }
    await db.query('UPDATE users SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

module.exports = router;