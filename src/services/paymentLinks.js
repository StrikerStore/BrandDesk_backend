const db = require('../config/db');
const payu = require('./payu');
const { getBrandByName } = require('../config/brands');
const { applySystemUpdate } = require('./actionProgress');

/**
 * Payment-link actions: minting a link, and keeping its paid state honest.
 *
 * The trust model is the important part. A PayU webhook is treated as an
 * untrusted nudge — it tells us *which* action to look at and nothing more.
 * Money state is only ever written from PayU's own status API, so a forged or
 * replayed webhook can at worst cost one redundant lookup.
 *
 * That also means the webhook and the cron sweep share one code path:
 * `reconcilePaymentLink` is the whole of it.
 */

// How far back the sweeper looks. A link nobody paid inside a fortnight is not
// going to be paid, and re-checking it forever is a slow leak of PayU calls.
const RECONCILE_WINDOW_DAYS = 14;

/** MySQL DATETIME from whatever shape PayU handed back. */
function toMysqlDateTime(value) {
  if (!value) return new Date().toISOString().slice(0, 19).replace('T', ' ');
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
  }
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Mint a PayU link for a thread.
 *
 * Called *before* the action row is inserted: if PayU refuses, nothing is
 * persisted and the agent gets a real error rather than an action claiming a
 * link it never got. The returned invoice id becomes `payment_link_id`, which is
 * how an inbound webhook finds its way back to the row.
 */
async function createForThread({ threadId, amount, reason }) {
  // `notConfigured` is the route's signal to answer 400 rather than 502 — these
  // are our own misconfiguration, not PayU rejecting anything.
  const localFault = (message) => Object.assign(new Error(message), { notConfigured: true });

  const [[thread]] = await db.query(
    'SELECT id, brand, customer_name, customer_email, customer_phone, ticket_id FROM threads WHERE id = ?',
    [threadId]
  );
  if (!thread) throw localFault('Thread not found');

  const brand = getBrandByName(thread.brand);
  if (!brand) throw localFault(`Unknown brand "${thread.brand}"`);

  const { paymentLink, invoiceId } = await payu.createPaymentLink({
    brand,
    amount,
    description: reason || `Payment for ticket ${thread.ticket_id || thread.id}`,
    customer: {
      name:  thread.customer_name,
      email: thread.customer_email,
      phone: thread.customer_phone,
    },
    reference: threadId,
  });

  return { payment_link: paymentLink, payment_link_id: invoiceId };
}

/**
 * Find the action a webhook payload is talking about.
 *
 * PayU's payload shape varies by integration, so this tries the identifiers it
 * might plausibly carry rather than insisting on one. Returning null is not a
 * failure mode worth worrying about — the cron sweep reconciles the same link
 * within two minutes regardless.
 */
async function findActionForWebhook(body = {}) {
  const invoiceId = body.invoiceNumber || body.invoice_number || body.invoiceId || body.id;
  if (invoiceId) {
    const [[byInvoice]] = await db.query(
      `SELECT id FROM thread_actions
        WHERE action_type = 'send_payment_link' AND payment_link_id = ?
        ORDER BY id DESC LIMIT 1`,
      [String(invoiceId)]
    );
    if (byInvoice) return byInvoice.id;
  }

  // udf1 carries the thread id — enough to narrow to that ticket's newest
  // unpaid link when the invoice id isn't in the payload.
  const threadId = Number(body.udf1);
  if (Number.isInteger(threadId) && threadId > 0) {
    const [[byThread]] = await db.query(
      `SELECT id FROM thread_actions
        WHERE action_type = 'send_payment_link' AND thread_id = ? AND payment_status != 'paid'
        ORDER BY id DESC LIMIT 1`,
      [threadId]
    );
    if (byThread) return byThread.id;
  }

  return null;
}

/**
 * Re-read one link's status from PayU and write it down if it moved.
 *
 * Safe to call concurrently: `applySystemUpdate` diffs inside a transaction, so
 * whichever call lands second sees the values already stored and no-ops.
 */
async function reconcilePaymentLink(actionId) {
  const [[action]] = await db.query(
    `SELECT ta.id, ta.payment_link_id, ta.payment_status, t.brand
       FROM thread_actions ta
       JOIN threads t ON t.id = ta.thread_id
      WHERE ta.id = ? AND ta.action_type = 'send_payment_link'`,
    [actionId]
  );
  // These are all normal, not errors — but when a payment is "stuck" the first
  // question is always which of them fired, so say so.
  if (!action) {
    console.warn(`[payu] reconcile ${actionId}: no such payment-link action`);
    return { skipped: 'not_found' };
  }
  if (action.payment_status === 'paid') return { skipped: 'already_paid' };
  if (!action.payment_link_id) {
    console.warn(`[payu] reconcile ${actionId}: row has no payment_link_id — cannot be confirmed`);
    return { skipped: 'no_link_id' };
  }

  const brand = getBrandByName(action.brand);
  if (!brand) {
    console.warn(`[payu] reconcile ${actionId}: unknown brand "${action.brand}" — check BRANDS`);
    return { skipped: 'unknown_brand' };
  }

  const status = await payu.getPaymentLinkStatus({
    brand,
    invoiceId: action.payment_link_id,
  });

  // Nothing has happened yet — don't churn the timeline with a no-op write.
  if (status.status === 'pending') return { status: 'pending' };

  const updates = { payment_status: status.rawStatus || status.status };

  if (status.status === 'paid') {
    updates.payment_received = 1;
    updates.payment_ref      = status.payuRef || null;
    updates.payment_paid_at  = toMysqlDateTime(status.paidAt);
  }

  // The state transition is the one line worth having when reconstructing what
  // happened to a payment after the fact.
  console.log(`[payu] reconcile ${actionId}: pending -> ${status.status}` +
              (status.payuRef ? ` (ref ${status.payuRef})` : ''));

  await applySystemUpdate({ actionId, updates });
  return { status: status.status };
}

/**
 * Safety net for missed or misconfigured webhooks. Because the reconciler is
 * authoritative, a webhook that never arrives costs a delay, not a stuck action.
 */
async function reconcilePendingPaymentLinks() {
  const [rows] = await db.query(
    `SELECT id FROM thread_actions
      WHERE action_type = 'send_payment_link'
        AND is_closed = 0
        AND payment_status = 'pending'
        AND payment_link_id IS NOT NULL
        AND created_at > DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [RECONCILE_WINDOW_DAYS]
  );

  // Silent when there is nothing pending — this runs every 2 minutes and an
  // idle heartbeat would bury the lines that matter.
  if (!rows.length) return { checked: 0, reconciled: 0 };

  let reconciled = 0;
  for (const row of rows) {
    try {
      const result = await reconcilePaymentLink(row.id);
      if (result.status && result.status !== 'pending') reconciled++;
    } catch (err) {
      // One brand's expired credentials must not stall every other brand's links.
      console.error(`[payu] reconcile ${row.id} failed:`, err.message);
    }
  }
  console.log(`[payu] sweep: ${rows.length} pending link(s), ${reconciled} resolved`);
  return { checked: rows.length, reconciled };
}

module.exports = {
  createForThread,
  findActionForWebhook,
  reconcilePaymentLink,
  reconcilePendingPaymentLinks,
};
