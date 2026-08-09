const db = require('../config/db');
const { getSetting } = require('./settings');
const { sendReply, sendInitialEmail } = require('./gmail');
const { getBrandByName } = require('../config/brands');

/**
 * Send queue — the "recall" (undo send) window.
 *
 * Gmail has no unsend API, so a recall can only work by NOT calling Gmail yet.
 * A send is parked in `pending_sends` for `recall_window_seconds`, and only then
 * handed to the existing gmail.js send functions — untouched, so the messages
 * INSERT, the open→in_progress advance and first_response_minutes all behave
 * exactly as they always have.
 *
 * The DB row is the source of truth. The in-process timer is only an
 * optimization for punctuality; the sweeper in index.js recovers anything a
 * restart orphaned, and every state change is a conditional UPDATE so two
 * timers / two Railway replicas can never both send the same row.
 */

// Above this, blob INSERTs start bumping into MySQL's max_allowed_packet
// (typically 16-64MB). Such sends bypass the queue and go out immediately.
const MAX_QUEUEABLE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// A reply queued behind a still-pending manual ticket waits for the real Gmail
// thread id. Bounded so a permanently stuck ticket can't spin forever.
const MAX_THREAD_WAIT_ATTEMPTS = 6;

const timers = new Map(); // pendingSendId -> Timeout

const PENDING_STATUSES = ['queued', 'sending', 'failed'];

async function getRecallWindowSeconds() {
  const raw = parseInt(await getSetting('recall_window_seconds', '30'), 10);
  if (Number.isNaN(raw)) return 30;
  return Math.min(Math.max(raw, 0), 120);
}

function scheduleTimer(id, delayMs) {
  clearTimeout(timers.get(id));
  // The pad keeps the in-process timer from firing before scheduled_for, which
  // is only second-granular — otherwise flushOne would claim a row the sweeper
  // doesn't yet consider due.
  const t = setTimeout(() => {
    flushOne(id).catch(err => console.error(`[sendQueue] flush ${id} failed:`, err.message));
  }, Math.max(delayMs, 0) + 250);
  if (typeof t.unref === 'function') t.unref();
  timers.set(id, t);
}

async function markFailed(id, message) {
  await db.query('UPDATE pending_sends SET status=\'failed\', error=? WHERE id=?', [
    String(message).slice(0, 2000),
    id,
  ]);
  console.error(`[sendQueue] #${id} failed: ${message}`);
}

// ── Queueing ────────────────────────────────────────────────

async function queueReply({ threadId, gmailThreadId, body, brand, attachments = [], userId }) {
  const win = await getRecallWindowSeconds();
  const totalBytes = attachments.reduce((sum, f) => sum + (f.buffer?.length || 0), 0);

  // Kill switch (window = 0) and oversized attachments take the original path,
  // byte for byte.
  if (win === 0 || totalBytes > MAX_QUEUEABLE_ATTACHMENT_BYTES) {
    const result = await sendReply(gmailThreadId, body, brand, false, attachments, userId || null);
    return { pending: false, ...result };
  }

  const conn = await db.getConnection();
  let pendingSendId;
  try {
    await conn.beginTransaction();
    const [res] = await conn.query(
      `INSERT INTO pending_sends
         (kind, thread_id, brand_name, body, attachment_count, status, scheduled_for, created_by)
       VALUES ('reply', ?, ?, ?, ?, 'queued', DATE_ADD(NOW(), INTERVAL ? SECOND), ?)`,
      [threadId, brand.name, body, attachments.length, win, userId || null]
    );
    pendingSendId = res.insertId;

    for (const file of attachments) {
      await conn.query(
        `INSERT INTO pending_send_attachments (pending_send_id, filename, mime_type, size, content)
         VALUES (?, ?, ?, ?, ?)`,
        [pendingSendId, file.originalname, file.mimetype, file.buffer.length, file.buffer]
      );
    }
    await conn.commit();
  } catch (err) {
    // Rolling back matters: a committed parent with missing attachment rows
    // would later email the customer "see attached" with nothing attached.
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }

  const [rows] = await db.query('SELECT scheduled_for FROM pending_sends WHERE id=?', [pendingSendId]);
  scheduleTimer(pendingSendId, win * 1000);
  return { pending: true, pendingSendId, scheduledFor: rows[0]?.scheduled_for || null };
}

async function queueInitialEmail({ threadId, toEmail, subject, body, brand, ticketId, userId }) {
  const win = await getRecallWindowSeconds();
  const [res] = await db.query(
    `INSERT INTO pending_sends
       (kind, thread_id, brand_name, to_email, subject, ticket_id, body, status, scheduled_for, created_by)
     VALUES ('manual', ?, ?, ?, ?, ?, ?, 'queued', DATE_ADD(NOW(), INTERVAL ? SECOND), ?)`,
    [threadId, brand.name, toEmail, subject, ticketId, body, win, userId || null]
  );
  const [rows] = await db.query('SELECT scheduled_for FROM pending_sends WHERE id=?', [res.insertId]);
  scheduleTimer(res.insertId, win * 1000);
  return { pending: true, pendingSendId: res.insertId, scheduledFor: rows[0]?.scheduled_for || null };
}

// ── Flushing ────────────────────────────────────────────────

async function flushOne(id) {
  // The claim is the whole concurrency story: whoever flips queued→sending owns
  // the row. Losers (second timer, other replica, a cancel that just landed)
  // see affectedRows 0 and walk away.
  const [claim] = await db.query(
    "UPDATE pending_sends SET status='sending', claimed_at=NOW() WHERE id=? AND status='queued'",
    [id]
  );
  if (claim.affectedRows === 0) return;

  timers.delete(id);

  try {
    const [rows] = await db.query('SELECT * FROM pending_sends WHERE id=?', [id]);
    if (!rows.length) return;
    const row = rows[0];

    const [files] = await db.query(
      'SELECT filename, mime_type, size, content FROM pending_send_attachments WHERE pending_send_id=?',
      [id]
    );
    if (files.length !== row.attachment_count) {
      return markFailed(id, `Attachments missing (${files.length}/${row.attachment_count}) — not sent`);
    }

    const brand = getBrandByName(row.brand_name);
    if (!brand) return markFailed(id, `Unknown brand "${row.brand_name}"`);

    // Exactly the shape gmail.js expects from multer.
    const attachments = files.map(f => ({
      buffer: f.content,
      mimetype: f.mime_type,
      originalname: f.filename,
    }));

    if (row.kind === 'reply') {
      const [threadRows] = await db.query('SELECT gmail_thread_id FROM threads WHERE id=?', [row.thread_id]);
      if (!threadRows.length) return markFailed(id, 'Thread no longer exists');
      const gmailThreadId = threadRows[0].gmail_thread_id;

      // The thread this reply belongs to is itself still queued. Resolving the
      // id at flush time (rather than snapshotting it at queue time) is what
      // lets this self-heal once the manual ticket lands.
      if (gmailThreadId.startsWith('pending_')) {
        if (row.attempts >= MAX_THREAD_WAIT_ATTEMPTS) {
          return markFailed(id, 'Ticket email never sent — reply could not be delivered');
        }
        await db.query(
          `UPDATE pending_sends
             SET status='queued', claimed_at=NULL, attempts=attempts+1,
                 scheduled_for=DATE_ADD(NOW(), INTERVAL 5 SECOND)
           WHERE id=?`,
          [id]
        );
        scheduleTimer(id, 5000);
        return;
      }

      await sendReply(gmailThreadId, row.body, brand, false, attachments, row.created_by || null);
    } else {
      const { gmailThreadId, gmailMessageId } = await sendInitialEmail(
        row.to_email, row.subject, row.body, brand, row.ticket_id
      );

      // Swap the placeholder for the real Gmail thread id. threads.gmail_thread_id
      // is NOT NULL UNIQUE, so a sync that somehow got there first would collide.
      try {
        await db.query('UPDATE threads SET gmail_thread_id=? WHERE id=?', [gmailThreadId, row.thread_id]);
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') throw err;
        const [winner] = await db.query('SELECT id FROM threads WHERE gmail_thread_id=?', [gmailThreadId]);
        if (winner.length && winner[0].id !== row.thread_id) {
          await db.query('UPDATE messages SET thread_id=? WHERE thread_id=?', [winner[0].id, row.thread_id]);
          await db.query('UPDATE pending_sends SET thread_id=? WHERE thread_id=?', [winner[0].id, row.thread_id]);
          await db.query('DELETE FROM threads WHERE id=?', [row.thread_id]);
          row.thread_id = winner[0].id;
        }
      }

      // sendInitialEmail deliberately touches no DB, so this mirrors what
      // POST /api/threads/manual used to do inline.
      await db.query(
        `INSERT INTO messages (thread_id, gmail_message_id, direction, from_email, from_name, body, is_note, sent_at)
         VALUES (?, ?, 'outbound', ?, ?, ?, 0, NOW())`,
        [row.thread_id, gmailMessageId, brand.email, `${brand.name} Support`, row.body]
      );
    }

    await db.query("UPDATE pending_sends SET status='sent', sent_at=NOW(), error=NULL WHERE id=?", [id]);
    await db.query('DELETE FROM pending_send_attachments WHERE pending_send_id=?', [id]);
    console.log(`[sendQueue] #${id} (${row.kind}) sent`);
  } catch (err) {
    // Never auto-retry: a silent loop against a flaky Gmail could send N copies.
    // The agent gets a visible failed bubble with Retry instead.
    await markFailed(id, err.message).catch(() => {});
  }
}

async function flushDueSends() {
  // A process that died mid-flush leaves a row wedged in 'sending' forever.
  // Reclaiming after 2 minutes makes this at-least-once rather than never.
  await db.query(
    "UPDATE pending_sends SET status='queued', claimed_at=NULL " +
    "WHERE status='sending' AND claimed_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE)"
  );

  const [rows] = await db.query(
    "SELECT id FROM pending_sends WHERE status='queued' AND scheduled_for <= NOW() ORDER BY scheduled_for ASC LIMIT 50"
  );
  // Sequential — Gmail rate-limits, and ordering keeps a manual ticket ahead of
  // replies queued against it.
  for (const row of rows) await flushOne(row.id);
  return rows.length;
}

// ── Cancel / retry / discard ────────────────────────────────

/**
 * The conditional UPDATE is simultaneously the authorization check and the race
 * check. Reading first and then writing would open exactly the gap this whole
 * feature is about.
 */
async function cancelPendingSend(id, user) {
  const isAdmin = user?.role === 'admin';
  const [res] = await db.query(
    `UPDATE pending_sends SET status='cancelled'
     WHERE id=? AND status='queued' AND (? OR created_by <=> ?)`,
    [id, isAdmin ? 1 : 0, user?.id ?? null]
  );
  if (res.affectedRows === 0) return { cancelled: false };

  clearTimeout(timers.get(id));
  timers.delete(id);

  const [rows] = await db.query('SELECT kind, thread_id, body FROM pending_sends WHERE id=?', [id]);
  const row = rows[0];

  // Cancelling a manual ticket means the ticket never existed — the placeholder
  // thread row goes with it. The LIKE guard stops us deleting a real ticket if
  // the id had already been rewritten.
  if (row?.kind === 'manual') {
    await db.query("DELETE FROM threads WHERE id=? AND gmail_thread_id LIKE 'pending\\_%'", [row.thread_id]);
  }

  return { cancelled: true, kind: row?.kind, threadId: row?.thread_id, body: row?.body };
}

async function retryPendingSend(id, user) {
  const isAdmin = user?.role === 'admin';
  const win = await getRecallWindowSeconds();
  const [res] = await db.query(
    `UPDATE pending_sends
       SET status='queued', claimed_at=NULL, error=NULL, attempts=0,
           scheduled_for=DATE_ADD(NOW(), INTERVAL ? SECOND)
     WHERE id=? AND status='failed' AND (? OR created_by <=> ?)`,
    [win, id, isAdmin ? 1 : 0, user?.id ?? null]
  );
  if (res.affectedRows === 0) return { retried: false };
  scheduleTimer(id, win * 1000);
  return { retried: true };
}

async function discardPendingSend(id, user) {
  const isAdmin = user?.role === 'admin';
  const [res] = await db.query(
    "DELETE FROM pending_sends WHERE id=? AND status='failed' AND (? OR created_by <=> ?)",
    [id, isAdmin ? 1 : 0, user?.id ?? null]
  );
  return { discarded: res.affectedRows > 0 };
}

// ── Reads ───────────────────────────────────────────────────

async function listPendingForThread(threadId) {
  const [rows] = await db.query(
    `SELECT id, kind, status, body, attachment_count, scheduled_for, error, created_by, created_at
     FROM pending_sends
     WHERE thread_id=? AND status IN (?, ?, ?)
     ORDER BY created_at ASC`,
    [threadId, ...PENDING_STATUSES]
  );
  return rows;
}

async function countActiveSends() {
  const [rows] = await db.query(
    "SELECT COUNT(*) AS cnt FROM pending_sends WHERE status IN ('queued','sending')"
  );
  return rows[0].cnt;
}

async function threadHasActiveSend(threadId) {
  const [rows] = await db.query(
    "SELECT COUNT(*) AS cnt FROM pending_sends WHERE thread_id=? AND status IN ('queued','sending')",
    [threadId]
  );
  return rows[0].cnt > 0;
}

module.exports = {
  getRecallWindowSeconds,
  queueReply,
  queueInitialEmail,
  flushOne,
  flushDueSends,
  cancelPendingSend,
  retryPendingSend,
  discardPendingSend,
  listPendingForThread,
  countActiveSends,
  threadHasActiveSend,
  MAX_QUEUEABLE_ATTACHMENT_BYTES,
};
