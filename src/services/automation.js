const db = require('../config/db');
const { getSetting } = require('./settings');
const { sendReply } = require('./gmail');
const { getBrands } = require('../config/brands');

/**
 * Auto-acknowledgement
 * Runs every minute via cron.
 * Finds new threads (no outbound messages yet) older than delay_minutes
 * and sends the "Acknowledgement" template as a reply.
 */
async function runAutoAck() {
  const enabled = await getSetting('auto_ack_enabled', 'false');
  if (enabled !== 'true') return;

  const delayMins = parseInt(await getSetting('auto_ack_delay_minutes', '5'));

  // Find threads that:
  // - are open
  // - have no outbound messages sent yet
  // - were created more than delay_minutes ago
  // - haven't had auto_ack_sent yet
  const [threads] = await db.query(
    `SELECT t.* FROM threads t
     WHERE t.status = 'open'
       AND t.auto_ack_sent = 0
       AND t.created_at <= DATE_SUB(NOW(), INTERVAL ? MINUTE)
       AND NOT EXISTS (
         SELECT 1 FROM messages m
         WHERE m.thread_id = t.id AND m.direction = 'outbound' AND m.is_note = 0
       )`,
    [delayMins]
  );

  if (!threads.length) return;

  // Get the acknowledgement template
  const [tplRows] = await db.query(
    `SELECT * FROM templates WHERE title LIKE '%Acknowledgement%' OR title LIKE '%acknowledgement%' LIMIT 1`
  );
  if (!tplRows.length) {
    console.log('⚠ Auto-ack: No acknowledgement template found');
    return;
  }

  const brands = getBrands();

  for (const thread of threads) {
    try {
      const brand = brands.find(b => b.name === thread.brand);
      if (!brand) continue;

      // Resolve template variables
      const firstName = thread.customer_name?.split(' ')[0] || 'there';
      const body = tplRows[0].body
        .replace(/\{\{customer_name\}\}/g, firstName)
        .replace(/\{\{brand\}\}/g, brand.name)
        .replace(/\{\{order_id\}\}/g,  thread.order_number || '[order ID]')
        .replace(/\{\{ticket_id\}\}/g, thread.ticket_id    || '[ticket ID]');

      await sendReply(thread.gmail_thread_id, body, brand, false);

      // Mark auto_ack_sent so we don't send again
      await db.query('UPDATE threads SET auto_ack_sent = 1 WHERE id = ?', [thread.id]);

      console.log(`✅ Auto-ack sent for thread #${thread.id} (${thread.brand})`);
    } catch (err) {
      console.error(`⚠ Auto-ack failed for thread #${thread.id}:`, err.message);
    }
  }
}


/**
 * Auto-resolve in-progress threads with no customer reply
 * Runs daily at 1 AM.
 * Finds in-progress threads where we sent a mail and the customer hasn't replied
 * in N days — resolves them automatically with a system comment.
 */
async function runAutoResolve() {
  const enabled = await getSetting('auto_resolve_enabled', 'false');
  if (enabled !== 'true') return;

  const days = parseInt(await getSetting('auto_resolve_days', '7'));

  // Find in_progress threads where:
  // - At least one real outbound message has been sent (not a note)
  // - No inbound message has arrived after the last outbound
  // - The last outbound was sent more than N days ago
  const [threads] = await db.query(
    `SELECT t.id, t.subject, t.brand FROM threads t
     WHERE t.status = 'in_progress'
       AND EXISTS (
         SELECT 1 FROM messages m
         WHERE m.thread_id = t.id AND m.direction = 'outbound' AND m.is_note = 0
       )
       AND (
         SELECT MAX(m.sent_at) FROM messages m
         WHERE m.thread_id = t.id AND m.direction = 'outbound' AND m.is_note = 0
       ) <= DATE_SUB(NOW(), INTERVAL ? DAY)
       AND NOT EXISTS (
         SELECT 1 FROM messages m2
         WHERE m2.thread_id = t.id
           AND m2.direction = 'inbound'
           AND m2.sent_at > (
             SELECT MAX(m3.sent_at) FROM messages m3
             WHERE m3.thread_id = t.id AND m3.direction = 'outbound' AND m3.is_note = 0
           )
       )`,
    [days]
  );

  if (!threads.length) return;

  const note = `Auto-resolved: No customer reply received within ${days} day${days !== 1 ? 's' : ''} of our last outbound message.`;

  for (const thread of threads) {
    try {
      await db.query(
        `UPDATE threads SET
          status = 'resolved',
          status_changed_at = NOW(),
          resolved_by = 'system',
          resolution_note = ?,
          resolved_at = NOW()
         WHERE id = ?`,
        [note, thread.id]
      );

      await db.query(
        `INSERT INTO messages (thread_id, direction, from_email, body, is_note, sent_at)
         VALUES (?, 'outbound', 'system', ?, 1, NOW())`,
        [thread.id, `🤖 ${note}`]
      );

      console.log(`✅ Auto-resolved thread #${thread.id} (${thread.brand})`);
    } catch (err) {
      console.error(`⚠ Auto-resolve failed for thread #${thread.id}:`, err.message);
    }
  }

  console.log(`🤖 Auto-resolve: resolved ${threads.length} in-progress thread(s)`);
}

module.exports = { runAutoAck, runAutoResolve };