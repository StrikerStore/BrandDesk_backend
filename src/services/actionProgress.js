const db = require('../config/db');

/**
 * Everything that writes to a fulfilment action goes through here.
 *
 * Five endpoints touch thread_actions (create, two PATCHes, two closes) and
 * the two PATCHes previously duplicated the allowed-field list verbatim.
 * Bolting event-writing and status-advance onto each of them separately would
 * have guaranteed drift, so the behaviour lives in one place and the routes
 * are thin.
 */

// Boolean checklist columns — these drive the progress fraction in the UI.
const CHECK_FIELDS = [
  'exchange_pickup_done', 'exchange_packed',
  'return_created', 'return_received', 'refund_done',
  'alt_order_created', 'original_order_cancelled',
  'size_change_done', 'address_change_done',
  'payment_link_sent',
];

// Free-text columns.
const TEXT_FIELDS = [
  'pickup_jersey', 'exchange_jersey', 'alternate_jersey',
  'current_jersey', 'new_jersey', 'new_address',
  'exchange_order_id', 'refund_id', 'refund_time',
];

const ACTION_FIELDS = [...TEXT_FIELDS, ...CHECK_FIELDS];

// Money columns. Deliberately NOT in ACTION_FIELDS: `pickUpdates` drops
// anything unlisted, so no client PATCH can repoint a payment link at another
// merchant or tick "payment received" by hand. Only the PayU reconciler
// (services/paymentLinks.js) writes these, and only from PayU's own API.
const SYSTEM_CHECK_FIELDS = ['payment_received'];
const SYSTEM_TEXT_FIELDS  = ['payment_status', 'payment_ref', 'payment_paid_at'];
const SYSTEM_FIELDS = [...SYSTEM_TEXT_FIELDS, ...SYSTEM_CHECK_FIELDS];

// Which columns get a check/uncheck event rather than a field event.
const BOOLEAN_FIELDS = [...CHECK_FIELDS, ...SYSTEM_CHECK_FIELDS];

const VALID_TYPES = [
  'exchange', 'return', 'alternate_product', 'refund', 'change_size', 'change_address',
  'send_payment_link',
];

/** Pull only the columns a client is allowed to set. */
function pickUpdates(body) {
  const out = {};
  for (const key of ACTION_FIELDS) {
    if (key in body) out[key] = body[key];
  }
  return out;
}

const norm = (v) => (v === null || v === undefined || v === '' ? null : String(v));

/**
 * Any action activity means someone is working the ticket right now.
 *
 * Mirrors the rule already applied on reply (routes/threads.js), except that
 * one only fires from `open`. Progress on a resolved ticket reopens it: the
 * resolution no longer describes reality, so it is cleared rather than left
 * to count towards Insights' resolved totals for the period.
 *
 * Returns { status, reopened } so callers can update their UI without a
 * second round trip.
 */
async function advanceThreadStatus(conn, threadId, { actionId, userId } = {}) {
  const [[thread]] = await conn.query('SELECT status FROM threads WHERE id = ?', [threadId]);
  if (!thread) return null;
  if (thread.status === 'in_progress') return { status: 'in_progress', reopened: false };

  const reopened = thread.status === 'resolved';

  if (reopened) {
    await conn.query(
      `UPDATE threads
          SET status = 'in_progress', status_changed_at = NOW(),
              resolved_at = NULL, resolved_by = NULL,
              resolved_by_user_id = NULL, resolution_note = NULL
        WHERE id = ?`,
      [threadId]
    );
    // Reopening is the one status change worth calling out in the timeline —
    // the ticket left the resolved queue and the resolution record was
    // discarded. Written after the progress events so it reads as the
    // consequence of them.
    if (actionId) {
      await insertEvents(conn, [{
        action_id: actionId, thread_id: threadId,
        event_type: 'reopened', user_id: userId,
      }]);
    }
  } else {
    await conn.query(
      `UPDATE threads SET status = 'in_progress', status_changed_at = NOW() WHERE id = ?`,
      [threadId]
    );
  }

  return { status: 'in_progress', reopened };
}

async function insertEvents(conn, rows) {
  if (!rows.length) return;
  await conn.query(
    `INSERT INTO action_events
       (action_id, thread_id, event_type, field, old_value, new_value, user_id)
     VALUES ?`,
    [rows.map(r => [r.action_id, r.thread_id, r.event_type, r.field ?? null,
                    r.old_value ?? null, r.new_value ?? null, r.user_id ?? null])]
  );
}

/** Run `fn` inside a transaction — an action write, its events and the
 *  thread's status change must not half-apply. */
async function inTransaction(fn) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Create an action, log it, and move the ticket to in progress. */
async function createAction(threadId, payload, userId) {
  return inTransaction(async (conn) => {
    const [result] = await conn.query(
      `INSERT INTO thread_actions
         (thread_id, action_type, pickup_jersey, exchange_jersey, alternate_jersey,
          current_jersey, new_jersey, new_address, created_by,
          payment_amount, payment_reason, payment_link, payment_link_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        threadId,
        payload.action_type,
        payload.pickup_jersey?.trim()    || null,
        payload.exchange_jersey?.trim()  || null,
        payload.alternate_jersey?.trim() || null,
        payload.current_jersey?.trim()   || null,
        payload.new_jersey?.trim()       || null,
        payload.new_address?.trim()      || null,
        userId || null,
        // Payment columns are server-supplied — the route hands them over only
        // after PayU has actually minted a link.
        payload.payment_amount  ?? null,
        payload.payment_reason?.trim() || null,
        payload.payment_link    || null,
        payload.payment_link_id || null,
      ]
    );

    await insertEvents(conn, [{
      action_id: result.insertId, thread_id: threadId,
      event_type: 'created', user_id: userId,
    }]);

    const thread = await advanceThreadStatus(conn, threadId, { actionId: result.insertId, userId });
    const [rows] = await conn.query('SELECT * FROM thread_actions WHERE id = ?', [result.insertId]);
    return { action: rows[0], thread };
  });
}

/**
 * Diff the incoming values against what is stored, write only the real
 * changes, and log one event per changed column. A no-op PATCH records
 * nothing and leaves the ticket's status alone.
 */
async function applyActionUpdate({ actionId, threadId, updates, userId }) {
  return inTransaction(async (conn) => {
    const where  = threadId ? 'id = ? AND thread_id = ?' : 'id = ?';
    const params = threadId ? [actionId, threadId] : [actionId];

    const [[current]] = await conn.query(`SELECT * FROM thread_actions WHERE ${where}`, params);
    if (!current) return { notFound: true };

    const changed = {};
    const events  = [];

    for (const [field, raw] of Object.entries(updates)) {
      if (BOOLEAN_FIELDS.includes(field)) {
        const next = raw ? 1 : 0;
        if (Number(current[field] ? 1 : 0) === next) continue;
        changed[field] = next;
        events.push({
          action_id: actionId, thread_id: current.thread_id,
          event_type: next ? 'check' : 'uncheck',
          field, old_value: String(current[field] ? 1 : 0), new_value: String(next),
          user_id: userId,
        });
      } else {
        const next = norm(typeof raw === 'string' ? raw.trim() : raw);
        if (norm(current[field]) === next) continue;
        changed[field] = next;
        events.push({
          action_id: actionId, thread_id: current.thread_id,
          event_type: 'field',
          field, old_value: norm(current[field]), new_value: next,
          user_id: userId,
        });
      }
    }

    if (!Object.keys(changed).length) {
      return { action: current, thread: null, unchanged: true };
    }

    await conn.query(
      `UPDATE thread_actions SET ${Object.keys(changed).map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...Object.values(changed), actionId]
    );
    await insertEvents(conn, events);

    const thread = await advanceThreadStatus(conn, current.thread_id, { actionId, userId });
    const [rows] = await conn.query('SELECT * FROM thread_actions WHERE id = ?', [actionId]);
    return { action: rows[0], thread };
  });
}

/**
 * Write server-owned columns (the PayU money fields) on an action.
 *
 * Routed through `applyActionUpdate` so a reconciliation gets the same
 * transactional diffing, `action_events` rows and status advance as an agent
 * edit. Two consequences worth relying on:
 *
 *   - It is idempotent. Re-running a reconciliation whose values already match
 *     writes nothing and logs nothing, so a duplicated webhook is harmless.
 *   - Events land with `user_id` NULL, which the timeline already renders as
 *     Unattributed — the honest attribution for something PayU told us.
 */
async function applySystemUpdate({ actionId, updates }) {
  const allowed = {};
  for (const key of SYSTEM_FIELDS) {
    if (key in updates) allowed[key] = updates[key];
  }
  if (!Object.keys(allowed).length) return { unchanged: true };
  return applyActionUpdate({ actionId, updates: allowed, userId: null });
}

/** Close an action. Already-closed actions are left untouched. */
async function closeAction({ actionId, threadId, userId }) {
  return inTransaction(async (conn) => {
    const where  = threadId ? 'id = ? AND thread_id = ?' : 'id = ?';
    const params = threadId ? [actionId, threadId] : [actionId];

    const [[current]] = await conn.query(`SELECT * FROM thread_actions WHERE ${where}`, params);
    if (!current) return { notFound: true };
    if (current.is_closed) return { action: current, thread: null, unchanged: true };

    await conn.query(
      'UPDATE thread_actions SET is_closed = 1, closed_at = NOW(), closed_by = ? WHERE id = ?',
      [userId || null, actionId]
    );
    await insertEvents(conn, [{
      action_id: actionId, thread_id: current.thread_id,
      event_type: 'closed', user_id: userId,
    }]);

    const thread = await advanceThreadStatus(conn, current.thread_id, { actionId, userId });
    const [rows] = await conn.query('SELECT * FROM thread_actions WHERE id = ?', [actionId]);
    return { action: rows[0], thread };
  });
}

/** Timeline events for one thread, oldest first, with names attached. */
async function listThreadEvents(threadId) {
  const [rows] = await db.query(
    `SELECT ae.id, ae.action_id, ae.event_type, ae.field,
            ae.old_value, ae.new_value, ae.user_id, ae.created_at,
            u.name  AS user_name,
            ta.action_type
       FROM action_events ae
       LEFT JOIN users u          ON u.id  = ae.user_id
       LEFT JOIN thread_actions ta ON ta.id = ae.action_id
      WHERE ae.thread_id = ?
      ORDER BY ae.created_at ASC, ae.id ASC`,
    [threadId]
  );
  return rows;
}

module.exports = {
  ACTION_FIELDS, CHECK_FIELDS, TEXT_FIELDS, VALID_TYPES, SYSTEM_FIELDS,
  pickUpdates, createAction, applyActionUpdate, applySystemUpdate, closeAction,
  listThreadEvents, advanceThreadStatus,
};
