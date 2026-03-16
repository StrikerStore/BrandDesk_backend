const express = require('express');
const db = require('../config/db');

const router = express.Router();

// GET /api/customers/:email — lookup from local DB
router.get('/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);

    const [rows] = await db.query('SELECT * FROM customers WHERE email=?', [email]);
    const customer = rows[0] || { email, name: null, phone: null };

    // Fetch past tickets with parsed info
    const [pastTickets] = await db.query(
      `SELECT id, subject, status, brand, ticket_id, order_number,
              issue_category, sub_issue, created_at
       FROM threads
       WHERE customer_email = ?
       ORDER BY created_at DESC LIMIT 10`,
      [email]
    );

    res.json({ found: !!rows.length, customer, pastTickets });
  } catch (err) {
    console.error('Customer lookup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/customers/:email/notes — save agent notes
router.patch('/:email/notes', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const { notes } = req.body;
    await updateCustomerNotes(email, notes);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/customers — create customer manually
router.post('/', async (req, res) => {
  try {
    const { email, name, phone, location, notes } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    await db.query(
      `INSERT INTO customers (email, name, phone, location, notes)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name=VALUES(name), phone=VALUES(phone), location=VALUES(location), notes=VALUES(notes)`,
      [email, name || '', phone || null, location || null, notes || null]
    );

    const [rows] = await db.query('SELECT * FROM customers WHERE email=?', [email]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;