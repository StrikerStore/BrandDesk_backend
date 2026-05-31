const express = require('express');
const db = require('../config/db');

// ── Per-thread router (mounted at /api/threads/:threadId/actions) ──────────
const router = express.Router({ mergeParams: true });

// GET /api/threads/:threadId/actions
router.get('/', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM thread_actions WHERE thread_id = ? ORDER BY created_at ASC',
      [req.params.threadId]
    );
    res.json({ actions: rows });
  } catch (err) {
    console.error('Fetch actions error:', err);
    res.status(500).json({ error: 'Failed to fetch actions' });
  }
});

// POST /api/threads/:threadId/actions
router.post('/', async (req, res) => {
  const { action_type, pickup_jersey, exchange_jersey, alternate_jersey } = req.body;

  if (!['exchange', 'return', 'alternate_product', 'refund'].includes(action_type)) {
    return res.status(400).json({ error: 'Invalid action_type' });
  }
  // pickup_jersey required for all types except pure refund
  if (action_type !== 'refund' && !pickup_jersey?.trim()) {
    return res.status(400).json({ error: 'pickup_jersey is required' });
  }
  if (action_type === 'exchange' && !exchange_jersey?.trim()) {
    return res.status(400).json({ error: 'exchange_jersey is required for exchange' });
  }
  if (action_type === 'alternate_product' && !alternate_jersey?.trim()) {
    return res.status(400).json({ error: 'alternate_jersey is required for alternate product' });
  }

  try {
    const [result] = await db.query(
      `INSERT INTO thread_actions
        (thread_id, action_type, pickup_jersey, exchange_jersey, alternate_jersey)
       VALUES (?, ?, ?, ?, ?)`,
      [
        req.params.threadId,
        action_type,
        pickup_jersey.trim(),
        exchange_jersey?.trim() || null,
        alternate_jersey?.trim() || null,
      ]
    );
    const [rows] = await db.query('SELECT * FROM thread_actions WHERE id = ?', [result.insertId]);
    res.status(201).json({ action: rows[0] });
  } catch (err) {
    console.error('Create action error:', err);
    res.status(500).json({ error: 'Failed to create action' });
  }
});

// PATCH /api/threads/:threadId/actions/:actionId
router.patch('/:actionId', async (req, res) => {
  const ALLOWED = [
    'exchange_order_id', 'exchange_pickup_done', 'exchange_packed',
    'return_created', 'return_received', 'refund_done', 'refund_id', 'refund_time',
    'alt_order_created', 'original_order_cancelled',
  ];
  const updates = {};
  for (const key of ALLOWED) {
    if (key in req.body) updates[key] = req.body[key];
  }
  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }
  try {
    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    await db.query(
      `UPDATE thread_actions SET ${setClauses} WHERE id = ? AND thread_id = ?`,
      [...Object.values(updates), req.params.actionId, req.params.threadId]
    );
    const [rows] = await db.query('SELECT * FROM thread_actions WHERE id = ?', [req.params.actionId]);
    if (!rows.length) return res.status(404).json({ error: 'Action not found' });
    res.json({ action: rows[0] });
  } catch (err) {
    console.error('Update action error:', err);
    res.status(500).json({ error: 'Failed to update action' });
  }
});

// POST /api/threads/:threadId/actions/:actionId/close
router.post('/:actionId/close', async (req, res) => {
  try {
    await db.query(
      'UPDATE thread_actions SET is_closed = 1, closed_at = NOW() WHERE id = ? AND thread_id = ?',
      [req.params.actionId, req.params.threadId]
    );
    const [rows] = await db.query('SELECT * FROM thread_actions WHERE id = ?', [req.params.actionId]);
    if (!rows.length) return res.status(404).json({ error: 'Action not found' });
    res.json({ action: rows[0] });
  } catch (err) {
    console.error('Close action error:', err);
    res.status(500).json({ error: 'Failed to close action' });
  }
});

// ── Global router (mounted at /api/actions) ───────────────────────────────
const globalRouter = express.Router();

// GET /api/actions  — all actions across all threads, joined with thread info
globalRouter.get('/', async (req, res) => {
  try {
    const { status, type } = req.query;

    let where = '1=1';
    const params = [];

    if (status === 'open')   { where += ' AND ta.is_closed = 0'; }
    if (status === 'closed') { where += ' AND ta.is_closed = 1'; }
    if (type && ['exchange', 'return', 'alternate_product', 'refund'].includes(type)) {
      where += ' AND ta.action_type = ?';
      params.push(type);
    }

    const [rows] = await db.query(
      `SELECT
         ta.*,
         t.customer_name,
         t.customer_email,
         t.ticket_id,
         t.order_number,
         t.brand,
         t.status  AS thread_status,
         t.subject AS thread_subject
       FROM thread_actions ta
       JOIN threads t ON t.id = ta.thread_id
       WHERE ${where}
       ORDER BY ta.is_closed ASC, ta.created_at DESC`,
      params
    );
    res.json({ actions: rows });
  } catch (err) {
    console.error('Fetch all actions error:', err);
    res.status(500).json({ error: 'Failed to fetch actions' });
  }
});

// PATCH /api/actions/:actionId  — update status fields (from consolidated view)
globalRouter.patch('/:actionId', async (req, res) => {
  const ALLOWED = [
    'exchange_order_id', 'exchange_pickup_done', 'exchange_packed',
    'return_created', 'return_received', 'refund_done', 'refund_id', 'refund_time',
    'alt_order_created', 'original_order_cancelled',
  ];
  const updates = {};
  for (const key of ALLOWED) {
    if (key in req.body) updates[key] = req.body[key];
  }
  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }
  try {
    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    await db.query(
      `UPDATE thread_actions SET ${setClauses} WHERE id = ?`,
      [...Object.values(updates), req.params.actionId]
    );
    const [rows] = await db.query(
      `SELECT ta.*, t.customer_name, t.customer_email, t.ticket_id, t.order_number,
              t.brand, t.status AS thread_status, t.subject AS thread_subject
       FROM thread_actions ta JOIN threads t ON t.id = ta.thread_id
       WHERE ta.id = ?`,
      [req.params.actionId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Action not found' });
    res.json({ action: rows[0] });
  } catch (err) {
    console.error('Update action error:', err);
    res.status(500).json({ error: 'Failed to update action' });
  }
});

// POST /api/actions/:actionId/close
globalRouter.post('/:actionId/close', async (req, res) => {
  try {
    await db.query(
      'UPDATE thread_actions SET is_closed = 1, closed_at = NOW() WHERE id = ?',
      [req.params.actionId]
    );
    const [rows] = await db.query(
      `SELECT ta.*, t.customer_name, t.customer_email, t.ticket_id, t.order_number,
              t.brand, t.status AS thread_status, t.subject AS thread_subject
       FROM thread_actions ta JOIN threads t ON t.id = ta.thread_id
       WHERE ta.id = ?`,
      [req.params.actionId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Action not found' });
    res.json({ action: rows[0] });
  } catch (err) {
    console.error('Close action error:', err);
    res.status(500).json({ error: 'Failed to close action' });
  }
});

module.exports = { threadRouter: router, globalRouter };
