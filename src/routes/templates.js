const express = require('express');
const db = require('../config/db');

const router = express.Router();

// GET /api/templates — list all templates, optionally filtered by brand
router.get('/', async (req, res) => {
  try {
    const { brand, category } = req.query;

    let where = '1=1';
    const params = [];

    if (brand) {
      where += ' AND (brand_filter IS NULL OR brand_filter = ?)';
      params.push(brand);
    }
    if (category) {
      where += ' AND category = ?';
      params.push(category);
    }

    const [templates] = await db.query(
      `SELECT * FROM templates WHERE ${where} ORDER BY category, title`,
      params
    );

    // Group by category
    const grouped = templates.reduce((acc, t) => {
      const cat = t.category || 'General';
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(t);
      return acc;
    }, {});

    res.json({ templates, grouped });
  } catch (err) {
    res.status(500).json({ error: 'Template operation failed' });
  }
});

// POST /api/templates — create new template
router.post('/', async (req, res) => {
  try {
    const { title, category, body, brand_filter } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'Title and body are required' });

    const [result] = await db.query(
      'INSERT INTO templates (title, category, body, brand_filter) VALUES (?, ?, ?, ?)',
      [title, category || 'General', body, brand_filter || null]
    );

    const [rows] = await db.query('SELECT * FROM templates WHERE id=?', [result.insertId]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Template operation failed' });
  }
});

// PUT /api/templates/:id — update template
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, category, body, brand_filter } = req.body;

    await db.query(
      'UPDATE templates SET title=?, category=?, body=?, brand_filter=? WHERE id=?',
      [title, category || 'General', body, brand_filter || null, id]
    );

    const [rows] = await db.query('SELECT * FROM templates WHERE id=?', [id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Template operation failed' });
  }
});

// DELETE /api/templates/:id
router.delete('/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM templates WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Template operation failed' });
  }
});

// POST /api/templates/:id/use — increment usage count
router.post('/:id/use', async (req, res) => {
  try {
    await db.query('UPDATE templates SET usage_count = usage_count + 1 WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Template operation failed' });
  }
});

module.exports = router;