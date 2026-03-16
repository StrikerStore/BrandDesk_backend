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
 * Auto-close stale resolved tickets
 * Runs daily at midnight.
 * Archives resolved threads with no new customer message in N days.
 */
async function runAutoClose() {
  const enabled = await getSetting('auto_close_enabled', 'false');
  if (enabled !== 'true') return;

  const days = parseInt(await getSetting('auto_close_days', '7'));

  // Find resolved threads where last customer message is older than N days
  const [threads] = await db.query(
    `SELECT t.id, t.subject, t.brand FROM threads t
     WHERE t.status = 'resolved'
       AND t.resolved_at IS NOT NULL
       AND t.resolved_at <= DATE_SUB(NOW(), INTERVAL ? DAY)
       AND NOT EXISTS (
         SELECT 1 FROM messages m
         WHERE m.thread_id = t.id
           AND m.direction = 'inbound'
           AND m.sent_at > t.resolved_at
       )`,
    [days]
  );

  if (!threads.length) return;

  for (const thread of threads) {
    await db.query(
      `UPDATE threads SET status = 'resolved' WHERE id = ?`,
      [thread.id]
    );
  }

  console.log(`🗄 Auto-close: archived ${threads.length} stale resolved threads`);
}

module.exports = { runAutoAck, runAutoClose };