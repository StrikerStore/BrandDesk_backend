const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const db = require('../config/db');
const { syncThreads, sendReply, sendInitialEmail } = require('../services/gmail');
const { getBrandByName } = require('../config/brands');
const { requireAdmin } = require('../middleware/authMiddleware');
const { TICKET_PREFIXES, buildChatBody } = require('../services/emailParser');
const { normalizeOrderInput } = require('../services/orderId');
const { buildAckBody, defaultAckBody } = require('../services/automation');
const {
  getRecallWindowSeconds,
  queueReply,
  queueInitialEmail,
  listPendingForThread,
  countActiveSends,
} = require('../services/sendQueue');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// GET /api/threads
router.get('/', async (req, res) => {
  try {
    const { brand, status, priority, tag, search, assignee, page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = '(t.snoozed_until IS NULL OR t.snoozed_until <= NOW())';
    const params = [];

    if (brand && brand !== 'all') { where += ' AND t.brand = ?'; params.push(brand); }
    if (status && status !== 'all') { where += ' AND t.status = ?'; params.push(status); }
    // `me` and `unassigned` are the two that matter day to day; a raw id is
    // accepted so a lead can look at one agent's queue.
    if (assignee === 'me')              { where += ' AND t.assignee_id = ?'; params.push(req.user?.id || 0); }
    else if (assignee === 'unassigned') { where += ' AND t.assignee_id IS NULL'; }
    else if (assignee)                  { where += ' AND t.assignee_id = ?'; params.push(parseInt(assignee) || 0); }
    if (priority) { where += ' AND t.priority = ?'; params.push(priority); }
    if (tag) { where += ' AND JSON_CONTAINS(t.tags, ?)'; params.push(JSON.stringify(tag)); }
    if (search) {
      const q = `%${search}%`;
      const clauses = [
        't.customer_name LIKE ?', 't.customer_email LIKE ?', 't.ticket_id LIKE ?',
        't.order_number LIKE ?', 't.subject LIKE ?', 't.tags LIKE ?',
        't.order_id_resolved LIKE ?',
      ];
      params.push(q, q, q, q, q, q, q);

      // Searching "#4334" should find a ticket stored as "DS4334" — match the
      // bare digits against both order columns as well
      const { digits } = normalizeOrderInput(search);
      if (digits) {
        clauses.push('t.order_number LIKE ?', 't.order_id_resolved LIKE ?');
        params.push(`%${digits}%`, `%${digits}%`);
      }

      where += ` AND (${clauses.join(' OR ')})`;
    }

    const [threads] = await db.query(
      `SELECT t.*,
        au.name  AS assignee_name,
        au.email AS assignee_email,
        (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) as message_count,
        (SELECT sent_at FROM messages m WHERE m.thread_id = t.id ORDER BY sent_at DESC LIMIT 1) as last_message_at
       FROM threads t
       LEFT JOIN users au ON au.id = t.assignee_id
       WHERE ${where}
       /* Urgent first in every tab, then newest activity, then id.
          Mirrored exactly by utils/threadSort.js on the client, which re-sorts
          after each merge — the list is stitched from page 1 (refreshed by the
          poll) plus appended pages, and each response is only ordered within
          itself, so without that the rows drifted apart over a session.

          'low' ranks with 'normal' on purpose: giving it its own band would
          sink low-priority tickets below every normal one regardless of age.

          The recency key is spelled out rather than reusing the SELECT alias,
          so ordering never depends on how the server resolves an alias used
          inside an expression. Ties break on id so paging cannot repeat or
          skip a row when two threads share a timestamp. */
       ORDER BY
         CASE WHEN t.priority = 'urgent' THEN 0 ELSE 1 END ASC,
         COALESCE(
           (SELECT MAX(m.sent_at) FROM messages m WHERE m.thread_id = t.id),
           t.created_at
         ) DESC,
         t.id DESC
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
    res.status(500).json({ error: 'Failed to fetch threads' });
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
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /api/threads/:id
router.get('/:id', async (req, res) => {
  try {
    const [threads] = await db.query(
      `SELECT t.*, au.name AS assignee_name, au.email AS assignee_email
         FROM threads t LEFT JOIN users au ON au.id = t.assignee_id
        WHERE t.id = ?`, [req.params.id]);
    if (!threads.length) return res.status(404).json({ error: 'Thread not found' });
    const [messages] = await db.query(
      // id tie-breaks rows written in the same second (e.g. a manual ticket's
      // details card and its acknowledgement)
      'SELECT * FROM messages WHERE thread_id = ? ORDER BY sent_at ASC, id ASC', [req.params.id]
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

    // Emails still inside their recall window have no `messages` row yet, so
    // the client gets them from here — that's what makes the Undo affordance
    // survive a refresh or a background poll.
    const pending = await listPendingForThread(req.params.id);

    await db.query('UPDATE threads SET is_unread = 0 WHERE id = ?', [req.params.id]);

    // The list endpoint attaches SLA but this one never did, so the thread
    // header had no way to show whether the ticket it's displaying is overdue.
    const { getSLAStatus } = require('../services/sla');
    const t = threads[0];
    const sla = t.status === 'resolved' ? null : getSLAStatus(t.created_at, t.status);
    const thread = {
      ...t,
      sla_status: sla?.status || null,
      sla_label:  sla?.label  || null,
      sla_pct:    sla?.pct    || 0,
    };

    // Action progress is merged into the timeline client-side, the same way
    // pending sends already are.
    const { listThreadEvents } = require('../services/actionProgress');
    const events = await listThreadEvents(req.params.id);

    res.json({ thread, messages: messagesWithAttachments, pending, events });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch thread' });
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
    // Only allow safe mime types; default to octet-stream for anything unexpected
    const safeMimeTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'];
    const mimeType = safeMimeTypes.includes(rows[0].mime_type) ? rows[0].mime_type : 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', 'inline; filename="attachment"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(buffer);
  } catch (err) {
    console.error('Attachment fetch error:', err.message);
    res.status(500).json({ error: 'Failed to load image' });
  }
});

// PATCH /api/threads/:id — general updates (status, priority, tags)
const VALID_STATUSES   = ['open', 'in_progress', 'resolved'];
const VALID_PRIORITIES = ['normal', 'urgent'];

router.patch('/:id', async (req, res) => {
  try {
    const { status, priority, tags, snoozed_until, order_id_resolved, assignee_id } = req.body;
    const updates = [];
    const params  = [];

    // null clears the assignment; any other value must be a real active user.
    if (assignee_id !== undefined) {
      if (assignee_id === null) {
        updates.push('assignee_id = NULL');
      } else {
        const [u] = await db.query('SELECT id FROM users WHERE id = ? AND is_active = 1', [assignee_id]);
        if (!u.length) return res.status(400).json({ error: 'Unknown or inactive user' });
        updates.push('assignee_id = ?');
        params.push(assignee_id);
      }
    }

    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status value' });
      updates.push('status = ?', 'status_changed_at = NOW()');
      params.push(status);
    }
    if (priority !== undefined) {
      if (!VALID_PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority value' });
      updates.push('priority = ?'); params.push(priority);
    }
    if (tags          !== undefined) { updates.push('tags = ?');          params.push(JSON.stringify(tags)); }
    if (snoozed_until !== undefined) { updates.push('snoozed_until = ?'); params.push(snoozed_until || null); }
    // The canonical order id, either auto-resolved or corrected by an agent.
    // `order_number` is deliberately not editable — it stays as the customer
    // typed it, and this column carries what it actually maps to.
    if (order_id_resolved !== undefined) {
      const { cleaned } = normalizeOrderInput(order_id_resolved);
      updates.push('order_id_resolved = ?');
      params.push(cleaned ? cleaned.slice(0, 100) : null);
    }

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    await db.query(`UPDATE threads SET ${updates.join(', ')} WHERE id = ?`, params);
    const [updated] = await db.query(
      `SELECT t.*, au.name AS assignee_name, au.email AS assignee_email
         FROM threads t LEFT JOIN users au ON au.id = t.assignee_id
        WHERE t.id = ?`, [req.params.id]);
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update thread' });
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
        resolved_by_user_id = ?,
        resolution_note = ?,
        resolved_at = NOW()
       WHERE id = ?`,
      // resolved_by stays the free-text name shown in the thread; the id is
      // what analytics groups on
      [resolved_by.trim(), req.user?.id || null, resolution_note.trim(), req.params.id]
    );

    // Add a system message to the thread timeline
    await db.query(
      `INSERT INTO messages (thread_id, direction, from_email, body, is_note, sent_at)
       VALUES (?, 'outbound', 'system', ?, 1, NOW())`,
      [req.params.id, `✅ Resolved by ${resolved_by.trim()}\n\n${resolution_note.trim()}`]
    );

    const [updated] = await db.query(
      `SELECT t.*, au.name AS assignee_name, au.email AS assignee_email
         FROM threads t LEFT JOIN users au ON au.id = t.assignee_id
        WHERE t.id = ?`, [req.params.id]);
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve thread' });
  }
});

// POST /api/threads/manual — agent raises a ticket on behalf of a customer
router.post('/manual', async (req, res) => {
  try {
    const {
      customer_email, customer_name, customer_phone, brand, subject,
      issue_category, sub_issue, order_number, description, priority,
    } = req.body;

    // Mirrors the required fields on the customer-facing Shopify form
    if (!order_number?.trim())   return res.status(400).json({ error: 'Order number is required' });
    if (!customer_name?.trim())  return res.status(400).json({ error: 'Customer name is required' });
    if (!customer_email?.trim() || !customer_email.includes('@')) {
      return res.status(400).json({ error: 'Valid customer email is required' });
    }
    if (!customer_phone?.trim()) return res.status(400).json({ error: 'Contact number is required' });
    if (!brand?.trim())          return res.status(400).json({ error: 'Brand is required' });
    if (!issue_category?.trim()) return res.status(400).json({ error: 'Issue category is required' });
    if (!sub_issue?.trim())      return res.status(400).json({ error: 'Sub issue is required' });
    if (!subject?.trim())        return res.status(400).json({ error: 'Subject is required' });
    if (!description?.trim())    return res.status(400).json({ error: 'Description is required' });

    const brandObj = getBrandByName(brand);
    console.log('[manual-ticket] brandObj:', JSON.stringify(brandObj));
    if (!brandObj) return res.status(400).json({ error: 'Invalid brand' });

    const safePriority = ['normal', 'urgent'].includes(priority) ? priority : 'normal';
    const safeEmail    = customer_email.trim().toLowerCase();

    // Generate ticket ID: PREFIX-YYYYMMDD-XXXXX
    // Look up prefix from TICKET_PREFIXES map (keyed by prefix, valued by brand name)
    const prefixEntry = Object.entries(TICKET_PREFIXES).find(([, name]) => name === brand);
    const prefix = prefixEntry
      ? prefixEntry[0]
      : brand.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase();
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randNum = Math.floor(10000 + Math.random() * 90000);
    const ticketId = `${prefix}-${dateStr}-${randNum}`;

    const safeSubject = subject.trim().slice(0, 500);
    const safeName    = customer_name.trim().slice(0, 255);
    const safePhone   = customer_phone.trim().slice(0, 50);
    const safeOrder   = order_number.trim().slice(0, 100);

    // The description is what the CUSTOMER reported, so it becomes an inbound
    // structured card (left side of the thread) — identical in shape to a
    // Shopify-form ticket, which is what buildChatBody already produces.
    const detailsBody = buildChatBody({
      isShopifyForm: true,
      ticketId,
      orderNumber:   safeOrder,
      issueCategory: issue_category.trim(),
      subIssue:      sub_issue.trim(),
      customerPhone: safePhone,
      messageBody:   description.trim(),
    });

    // What actually gets emailed is an acknowledgement, not the description
    const safeBody = (await buildAckBody({
      customerName: safeName,
      brandName:    brandObj.name,
      orderNumber:  safeOrder,
      ticketId,
    })) || defaultAckBody({ customerName: safeName, brandName: brandObj.name, ticketId });

    const win = await getRecallWindowSeconds();

    console.log('[manual-ticket] ticketId:', ticketId, '| to:', safeEmail, '| subject:', safeSubject, '| window:', win);

    const insertThread = (gmailThreadId) => db.query(
      `INSERT INTO threads
         (gmail_thread_id, subject, brand, brand_email, status, priority,
          customer_email, customer_name, customer_phone, issue_category, sub_issue, order_number,
          ticket_id, is_manual, auto_ack_sent, is_unread)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0)`,
      [
        gmailThreadId,
        safeSubject,
        brand,
        brandObj.email,
        safePriority,
        safeEmail,
        safeName,
        safePhone,
        issue_category.trim().slice(0, 255),
        sub_issue.trim().slice(0, 255),
        safeOrder,
        ticketId,
      ]
    );

    // The customer's reported details — always the first message in the thread
    const insertDetails = (threadId) => db.query(
      `INSERT INTO messages (thread_id, direction, from_email, from_name, body, is_note, sent_at)
       VALUES (?, 'inbound', ?, ?, ?, 0, NOW())`,
      [threadId, safeEmail, safeName, detailsBody]
    );

    // Recall disabled — original behaviour, send first and store the real IDs.
    if (win === 0) {
      console.log('[manual-ticket] Calling sendInitialEmail...');
      const { gmailThreadId, gmailMessageId } = await sendInitialEmail(
        safeEmail, safeSubject, safeBody, brandObj, ticketId
      );
      console.log('[manual-ticket] sendInitialEmail OK — gmailThreadId:', gmailThreadId, '| gmailMessageId:', gmailMessageId);

      const [result] = await insertThread(gmailThreadId);
      // Details first so it sorts ahead of the acknowledgement (same NOW(),
      // tie-broken by id — see the ORDER BY in GET /:id)
      await insertDetails(result.insertId);
      await db.query(
        `INSERT INTO messages (thread_id, gmail_message_id, direction, from_email, from_name, body, is_note, sent_at)
         VALUES (?, ?, 'outbound', ?, ?, ?, 0, NOW())`,
        [result.insertId, gmailMessageId, brandObj.email, `${brandObj.name} Support`, safeBody]
      );
      const [rows] = await db.query('SELECT * FROM threads WHERE id = ?', [result.insertId]);
      return res.json(rows[0]);
    }

    // Recall window: the real Gmail thread ID doesn't exist until the send
    // flushes, so the ticket gets a placeholder and shows in the inbox right
    // away. sendQueue swaps in the real ID on flush, or deletes this row on undo.
    const placeholderId = `pending_${crypto.randomBytes(12).toString('hex')}`;
    const [result] = await insertThread(placeholderId);
    const threadId = result.insertId;

    // Shows immediately, even while the acknowledgement sits in the recall window
    await insertDetails(threadId);

    const queued = await queueInitialEmail({
      threadId,
      toEmail: safeEmail,
      subject: safeSubject,
      body: safeBody,
      brand: brandObj,
      ticketId,
      userId: req.user?.id,
    });

    const [rows] = await db.query('SELECT * FROM threads WHERE id = ?', [threadId]);
    res.json({ ...rows[0], pending_send_id: queued.pendingSendId, scheduled_for: queued.scheduledFor });
  } catch (err) {
    console.error('Manual ticket creation error:', err);
    res.status(500).json({ error: err.message || 'Failed to create ticket' });
  }
});

// POST /api/threads/:gmailId/reply
router.post('/:gmailId/reply', upload.array('attachments', 10), async (req, res) => {
  try {
    const { body, brandName } = req.body;
    // isNote may arrive as string "true"/"false" from FormData, or boolean from JSON
    const isNote = req.body.isNote === true || req.body.isNote === 'true';
    if (!body?.trim()) return res.status(400).json({ error: 'Reply body is required' });

    // Manual tickets don't have a real Gmail thread — store the message locally only
    if (req.params.gmailId.startsWith('manual_')) {
      const [threadRows] = await db.query(
        'SELECT id FROM threads WHERE gmail_thread_id = ?', [req.params.gmailId]
      );
      if (!threadRows.length) return res.status(404).json({ error: 'Thread not found' });
      const threadId = threadRows[0].id;
      const brand = getBrandByName(brandName);
      const fromEmail = brand?.email || brandName || 'agent';
      await db.query(
        `INSERT INTO messages (thread_id, direction, from_email, body, is_note, sent_at)
         VALUES (?, 'outbound', ?, ?, ?, NOW())`,
        [threadId, fromEmail, body.trim(), isNote ? 1 : 0]
      );
      if (!isNote) {
        await db.query(
          "UPDATE threads SET status = 'in_progress', status_changed_at = NOW() WHERE id = ? AND status = 'open'",
          [threadId]
        );
      }
      return res.json({ success: true, isManual: true });
    }

    // The parent ticket is still inside its own recall window, so there's no
    // Gmail thread to reply into yet.
    if (req.params.gmailId.startsWith('pending_')) {
      return res.status(409).json({ error: 'This ticket is still sending. Undo it or wait a moment.' });
    }

    const brand = getBrandByName(brandName);
    if (!brand) return res.status(400).json({ error: 'Invalid brand' });
    const attachments = req.files || [];

    // Internal notes are never emailed, so there is nothing to recall.
    if (isNote) {
      const result = await sendReply(req.params.gmailId, body, brand, true, attachments, req.user?.id || null);
      return res.json(result);
    }

    const [threadRows] = await db.query(
      'SELECT id FROM threads WHERE gmail_thread_id = ?', [req.params.gmailId]
    );
    if (!threadRows.length) return res.status(404).json({ error: 'Thread not found' });

    const result = await queueReply({
      threadId: threadRows[0].id,
      gmailThreadId: req.params.gmailId,
      body,
      brand,
      attachments,
      userId: req.user?.id,
    });
    res.json(result);
  } catch (err) {
    console.error('Reply error:', err);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// POST /api/threads/resync — admin only, full wipe and re-parse
router.post('/resync', requireAdmin, async (req, res) => {
  try {
    // pending_sends cascades off threads, so resyncing mid-window would
    // silently destroy emails nobody knows are queued.
    const active = await countActiveSends();
    if (active > 0) {
      return res.status(409).json({
        error: `${active} email(s) are waiting to send. Try again in a moment.`,
      });
    }
    await db.query('DELETE FROM messages');
    await db.query('DELETE FROM threads');
    const result = await syncThreads(true);
    res.json({ success: true, ...result, message: 'All threads re-parsed from scratch' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;