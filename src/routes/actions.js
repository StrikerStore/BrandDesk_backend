const express = require('express');
const db = require('../config/db');
const {
  VALID_TYPES, pickUpdates,
  createAction, applyActionUpdate, closeAction,
} = require('../services/actionProgress');
const { createForThread } = require('../services/paymentLinks');

// Every write below goes through services/actionProgress, which logs the
// change to action_events and moves the ticket to in progress. The allowed
// field list used to be duplicated verbatim in both PATCH handlers; it now
// lives in that service.

const THREAD_JOIN = `
  SELECT ta.*, t.customer_name, t.customer_email, t.ticket_id, t.order_number,
         t.brand, t.status AS thread_status, t.subject AS thread_subject
    FROM thread_actions ta JOIN threads t ON t.id = ta.thread_id
   WHERE ta.id = ?`;

function validateNewAction(body) {
  const { action_type, pickup_jersey, exchange_jersey, alternate_jersey,
          current_jersey, new_jersey, new_address, payment_amount } = body;

  if (!VALID_TYPES.includes(action_type)) return 'Invalid action_type';
  // pickup_jersey is required for the pickup-based types and for refund
  // (the jersey being refunded)
  if (['exchange', 'return', 'alternate_product', 'refund'].includes(action_type) && !pickup_jersey?.trim()) {
    return 'pickup_jersey is required';
  }
  if (action_type === 'send_payment_link') {
    const amount = Number(payment_amount);
    if (!Number.isFinite(amount) || amount <= 0) return 'A payment amount greater than 0 is required';
    // PayU rejects more than two decimals; catching it here gives a better
    // message than the gateway's.
    if (Math.round(amount * 100) / 100 !== amount) return 'Amount cannot have more than 2 decimal places';
  }
  if (action_type === 'exchange' && !exchange_jersey?.trim())          return 'exchange_jersey is required for exchange';
  if (action_type === 'alternate_product' && !alternate_jersey?.trim()) return 'alternate_jersey is required for alternate product';
  if (action_type === 'change_size' && !current_jersey?.trim())         return 'current_jersey is required for change size';
  if (action_type === 'change_size' && !new_jersey?.trim())             return 'new_jersey is required for change size';
  if (action_type === 'change_address' && !new_address?.trim())         return 'new_address is required for change address';
  return null;
}

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
  const invalid = validateNewAction(req.body);
  if (invalid) return res.status(400).json({ error: invalid });

  try {
    const payload = { ...req.body };

    // Mint the PayU link before anything is written. If PayU refuses, no action
    // row exists — an action claiming a link it never got would be worse than
    // no action at all.
    if (payload.action_type === 'send_payment_link') {
      const amount = Number(payload.payment_amount);
      try {
        const link = await createForThread({
          threadId: req.params.threadId,
          amount,
          reason: payload.payment_reason,
        });
        Object.assign(payload, link, { payment_amount: amount });
      } catch (err) {
        // Misconfiguration and gateway rejection are both the caller's problem
        // to see plainly, not a generic 500.
        console.error('Payment link creation error:', err.message);
        return res.status(err.notConfigured ? 400 : 502).json({ error: err.message });
      }
    }

    const { action, thread } = await createAction(req.params.threadId, payload, req.user?.id);
    res.status(201).json({ action, thread_status: thread?.status, reopened: !!thread?.reopened });
  } catch (err) {
    console.error('Create action error:', err);
    res.status(500).json({ error: 'Failed to create action' });
  }
});

// PATCH /api/threads/:threadId/actions/:actionId
router.patch('/:actionId', async (req, res) => {
  const updates = pickUpdates(req.body);
  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }
  try {
    const result = await applyActionUpdate({
      actionId: req.params.actionId,
      threadId: req.params.threadId,
      updates,
      userId: req.user?.id,
    });
    if (result.notFound) return res.status(404).json({ error: 'Action not found' });
    res.json({ action: result.action, thread_status: result.thread?.status, reopened: !!result.thread?.reopened });
  } catch (err) {
    console.error('Update action error:', err);
    res.status(500).json({ error: 'Failed to update action' });
  }
});

// POST /api/threads/:threadId/actions/:actionId/close
router.post('/:actionId/close', async (req, res) => {
  try {
    const result = await closeAction({
      actionId: req.params.actionId,
      threadId: req.params.threadId,
      userId: req.user?.id,
    });
    if (result.notFound) return res.status(404).json({ error: 'Action not found' });
    res.json({ action: result.action, thread_status: result.thread?.status, reopened: !!result.thread?.reopened });
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
    if (type && VALID_TYPES.includes(type)) {
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
  const updates = pickUpdates(req.body);
  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }
  try {
    const result = await applyActionUpdate({
      actionId: req.params.actionId,
      updates,
      userId: req.user?.id,
    });
    if (result.notFound) return res.status(404).json({ error: 'Action not found' });
    const [rows] = await db.query(THREAD_JOIN, [req.params.actionId]);
    res.json({ action: rows[0], thread_status: result.thread?.status, reopened: !!result.thread?.reopened });
  } catch (err) {
    console.error('Update action error:', err);
    res.status(500).json({ error: 'Failed to update action' });
  }
});

// POST /api/actions/:actionId/close
globalRouter.post('/:actionId/close', async (req, res) => {
  try {
    const result = await closeAction({ actionId: req.params.actionId, userId: req.user?.id });
    if (result.notFound) return res.status(404).json({ error: 'Action not found' });
    const [rows] = await db.query(THREAD_JOIN, [req.params.actionId]);
    res.json({ action: rows[0], thread_status: result.thread?.status, reopened: !!result.thread?.reopened });
  } catch (err) {
    console.error('Close action error:', err);
    res.status(500).json({ error: 'Failed to close action' });
  }
});

module.exports = { threadRouter: router, globalRouter };
