const express = require('express');
const multer  = require('multer');
const db = require('../config/db');
const { syncThreads, sendReply } = require('../services/gmail');
const { getBrandByName } = require('../config/brands');
const { requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// GET /api/threads
router.get('/', async (req, res) => {
  try {
    const { brand, status, priority, tag, search, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = '(t.snoozed_until IS NULL OR t.snoozed_until <= NOW())';
    const params = [];

    if (brand && brand !== 'all') { where += ' AND t.brand = ?'; params.push(brand); }
    if (status && status !== 'all') { where += ' AND t.status = ?'; params.push(status); }
    if (priority) { where += ' AND t.priority = ?'; params.push(priority); }
    if (tag) { where += ' AND JSON_CONTAINS(t.tags, ?)'; params.push(JSON.stringify(tag)); }
    if (search) {
      where += ` AND (t.customer_name LIKE ? OR t.customer_email LIKE ? OR t.ticket_id LIKE ? OR t.order_number LIKE ? OR t.subject LIKE ?)`;
      const q = `%${search}%`;
      params.push(q, q, q, q, q);
    }

    const [threads] = await db.query(
      `SELECT t.*,
        (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) as message_count,
        (SELECT sent_at FROM messages m WHERE m.thread_id = t.id ORDER BY sent_at DESC LIMIT 1) as last_message_at
       FROM threads t
       WHERE ${where}
       ORDER BY
         CASE t.priority WHEN 'urgent' THEN 1 ELSE 2 END ASC,
         last_message_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    // Attach SLA status to each non-resolved thread
    const { getSLAStatus } = require('../services/sla');
    const threadsWithSLA = threads.map(t => {
      if (t.status === 'resolved') return t;
      const sla = getSLAStatus(t.created_at, t.status);
      return { ...t, sla_status: sla?.status || null, sla_label: sla?.label || null, sla_pct: sla?.pct || 0 };
    });

    const [countResult] = await db.query(
      `SELECT COUNT(*) as total FROM threads t WHERE ${where}`, params
    );

    res.json({ threads: threadsWithSLA, total: countResult[0].total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('Error fetching threads:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/threads/stats/overview
router.get('/stats/overview', async (req, res) => {
  try {
    const [byStatus] = await db.query("SELECT status, COUNT(*) as count FROM threads GROUP BY status");
    const [byBrand]  = await db.query("SELECT brand, COUNT(*) as count FROM threads GROUP BY brand");
    const [unread]   = await db.query("SELECT COUNT(*) as count FROM threads WHERE is_unread = 1");
    const [urgent]   = await db.query("SELECT COUNT(*) as count FROM threads WHERE priority = 'urgent' AND status != 'resolved'");
    res.json({
      byStatus: byStatus.reduce((acc, r) => ({ ...acc, [r.status]: r.count }), {}),
      byBrand, unread: unread[0].count, urgent: urgent[0].count,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/threads/:id
router.get('/:id', async (req, res) => {
  try {
    const [threads] = await db.query('SELECT * FROM threads WHERE id = ?', [req.params.id]);
    if (!threads.length) return res.status(404).json({ error: 'Thread not found' });
    const [messages] = await db.query(
      'SELECT * FROM messages WHERE thread_id = ? ORDER BY sent_at ASC', [req.params.id]
    );
    // Attach image attachments to each message
    const messageIds = messages.map(m => m.id);
    let attachments = [];
    if (messageIds.length) {
      [attachments] = await db.query(
        `SELECT * FROM attachments WHERE message_id IN (${messageIds.map(() => '?').join(',')})`,
        messageIds
      );
    }
    const attachMap = attachments.reduce((acc, a) => {
      if (!acc[a.message_id]) acc[a.message_id] = [];
      acc[a.message_id].push(a);
      return acc;
    }, {});
    const messagesWithAttachments = messages.map(m => ({
      ...m,
      attachments: attachMap[m.id] || [],
    }));

    await db.query('UPDATE threads SET is_unread = 0 WHERE id = ?', [req.params.id]);
    res.json({ thread: threads[0], messages: messagesWithAttachments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/threads/attachment/:attachmentId?gmailMessageId=xxx
// Proxies the image from Gmail API — keeps Gmail credentials server-side
router.get('/attachment/:attachmentId', async (req, res) => {
  try {
    const { attachmentId } = req.params;
    const { gmailMessageId } = req.query;
    if (!gmailMessageId) return res.status(400).json({ error: 'gmailMessageId required' });

    // Verify attachment exists in our DB (security check)
    const [rows] = await db.query(
      'SELECT * FROM attachments WHERE attachment_id = ? AND gmail_message_id = ?',
      [attachmentId, gmailMessageId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Attachment not found' });

    const { getAuthenticatedClient } = require('../services/gmail');
    const { google } = require('googleapis');
    const auth   = await getAuthenticatedClient();
    const gmail  = google.gmail({ version: 'v1', auth });

    const attRes = await gmail.users.messages.attachments.get({
      userId:     'me',
      messageId:  gmailMessageId,
      id:         attachmentId,
    });

    const imageData = attRes.data.data
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    const buffer = Buffer.from(imageData, 'base64');
    res.setHeader('Content-Type', rows[0].mime_type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(buffer);
  } catch (err) {
    console.error('Attachment fetch error:', err.message);
    res.status(500).json({ error: 'Failed to load image' });
  }
});

// PATCH /api/threads/:id — general updates (status, priority, tags)
router.patch('/:id', async (req, res) => {
  try {
    const { status, priority, tags, snoozed_until } = req.body;
    const updates = [];
    const params  = [];

    if (status !== undefined) {
      updates.push('status = ?', 'status_changed_at = NOW()');
      params.push(status);
    }
    if (priority      !== undefined) { updates.push('priority = ?');      params.push(priority); }
    if (tags          !== undefined) { updates.push('tags = ?');          params.push(JSON.stringify(tags)); }
    if (snoozed_until !== undefined) { updates.push('snoozed_until = ?'); params.push(snoozed_until || null); }

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    await db.query(`UPDATE threads SET ${updates.join(', ')} WHERE id = ?`, params);
    const [updated] = await db.query('SELECT * FROM threads WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/threads/:id/resolve — resolve with name + note (mandatory)
router.post('/:id/resolve', async (req, res) => {
  try {
    const { resolved_by, resolution_note } = req.body;
    if (!resolved_by?.trim()) return res.status(400).json({ error: 'Resolver name is required' });
    if (!resolution_note?.trim()) return res.status(400).json({ error: 'Resolution note is required' });

    await db.query(
      `UPDATE threads SET
        status = 'resolved',
        status_changed_at = NOW(),
        resolved_by = ?,
        resolution_note = ?,
        resolved_at = NOW()
       WHERE id = ?`,
      [resolved_by.trim(), resolution_note.trim(), req.params.id]
    );

    // Add a system message to the thread timeline
    await db.query(
      `INSERT INTO messages (thread_id, direction, from_email, body, is_note, sent_at)
       VALUES (?, 'outbound', 'system', ?, 1, NOW())`,
      [req.params.id, `✅ Resolved by ${resolved_by.trim()}\n\n${resolution_note.trim()}`]
    );

    const [updated] = await db.query('SELECT * FROM threads WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/threads/:gmailId/reply
router.post('/:gmailId/reply', upload.array('attachments', 10), async (req, res) => {
  try {
    const { body, brandName } = req.body;
    // isNote may arrive as string "true"/"false" from FormData, or boolean from JSON
    const isNote = req.body.isNote === true || req.body.isNote === 'true';
    if (!body?.trim()) return res.status(400).json({ error: 'Reply body is required' });
    const brand = getBrandByName(brandName);
    if (!brand) return res.status(400).json({ error: 'Invalid brand' });
    const attachments = req.files || [];
    const result = await sendReply(req.params.gmailId, body, brand, isNote, attachments);
    res.json(result);
  } catch (err) {
    console.error('Reply error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/threads/resync — admin only, full wipe and re-parse
router.post('/resync', requireAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM messages');
    await db.query('DELETE FROM threads');
    const result = await syncThreads(true);
    res.json({ success: true, ...result, message: 'All threads re-parsed from scratch' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;