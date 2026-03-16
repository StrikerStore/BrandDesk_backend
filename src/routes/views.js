const express = require('express');
const db = require('../config/db');
const router = express.Router();

// GET /api/views
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM saved_views ORDER BY sort_order ASC, created_at ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/views
router.post('/', async (req, res) => {
  try {
    const { name, filters } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    if (!filters) return res.status(400).json({ error: 'Filters required' });

    const [result] = await db.query(
      'INSERT INTO saved_views (name, filters) VALUES (?, ?)',
      [name.trim(), JSON.stringify(filters)]
    );
    const [rows] = await db.query('SELECT * FROM saved_views WHERE id = ?', [result.insertId]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/views/:id
router.delete('/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM saved_views WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;