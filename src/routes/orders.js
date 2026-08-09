const express = require('express');
const { getOrderDb } = require('../config/orderDb');
const { normalizeOrderInput, sameDigits } = require('../services/orderId');

const router = express.Router();

const CANDIDATE_COLS = `o.order_id, o.order_date, o.customer_name, o.account_code, l.current_shipment_status`;
const CANDIDATE_FROM = `FROM orders o LEFT JOIN labels l ON l.order_id = o.order_id`;

/**
 * Map whatever the customer typed onto a canonical order_id.
 *
 * Tried in order of confidence. Returns { orderId, matchedBy, candidates } —
 * orderId is null when nothing matched, and candidates carries near-misses for
 * the agent to pick from.
 */
async function resolveOrderId(db, raw, { email } = {}) {
  const { cleaned, digits, prefix } = normalizeOrderInput(raw);
  if (!cleaned) return { orderId: null, matchedBy: null, candidates: [] };

  // 1. Exact — covers every already-correct value at no extra cost
  const [exact] = await db.query('SELECT order_id FROM orders WHERE order_id = ? LIMIT 1', [cleaned]);
  if (exact.length) return { orderId: exact[0].order_id, matchedBy: 'exact', candidates: [] };

  // Without a clean digit run there is nothing safe to pattern-match on
  if (!digits || !/^\d+$/.test(digits)) return { orderId: null, matchedBy: null, candidates: [] };

  // 2. This customer's own orders — strongest signal available, and it needs
  //    no per-store prefix configuration (there isn't any in this codebase)
  if (email) {
    const [mine] = await db.query(
      `SELECT DISTINCT ${CANDIDATE_COLS}
       ${CANDIDATE_FROM}
       LEFT JOIN customer_info ci ON ci.order_id = o.order_id
       WHERE ci.email = ? AND o.order_id NOT LIKE '%\\_%'
       ORDER BY o.order_date DESC LIMIT 50`,
      [String(email).toLowerCase().trim()]
    );
    const hits = mine.filter(o => {
      const n = normalizeOrderInput(o.order_id);
      if (!sameDigits(n.digits, digits)) return false;
      return prefix ? n.prefix === prefix : true;
    });
    if (hits.length === 1) return { orderId: hits[0].order_id, matchedBy: 'customer', candidates: [] };
    if (hits.length > 1)   return { orderId: null, matchedBy: null, candidates: hits.slice(0, 10) };
  }

  // 3. Pattern across all orders. `digits` is proven numeric above, so it is
  //    safe to inline — nothing else ever reaches the REGEXP literal.
  //    Unindexed, hence the LIMIT.
  // Strip the customer's own leading zeros too, so "04334" still finds DS4334
  const pattern = `^[A-Za-z]*0*${digits.replace(/^0+/, '') || '0'}$`;
  const [matches] = await db.query(
    `SELECT DISTINCT ${CANDIDATE_COLS}
     ${CANDIDATE_FROM}
     WHERE o.order_id REGEXP ? AND o.order_id NOT LIKE '%\\_%'
     ORDER BY o.order_date DESC LIMIT 10`,
    [pattern]
  );
  const scoped = prefix ? matches.filter(o => normalizeOrderInput(o.order_id).prefix === prefix) : matches;

  if (scoped.length === 1) return { orderId: scoped[0].order_id, matchedBy: 'pattern', candidates: [] };
  // Ambiguous (e.g. DS4334 and HP4334 both exist) — let the agent choose
  // rather than guessing
  return { orderId: null, matchedBy: null, candidates: scoped.slice(0, 10) };
}

/**
 * GET /api/orders/:orderId
 * Fetches the order and all its split orders.
 * e.g. orderId = "256001" fetches 256001, 256001_1, 256001_2, etc.
 */
router.get('/customer/:email', async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  try {
    const db = getOrderDb();
    const [rows] = await db.query(
      `SELECT DISTINCT
         o.order_id,
         o.customer_name,
         o.order_date,
         o.order_total,
         o.payment_type,
         o.account_code,
         l.current_shipment_status,
         l.carrier_name,
         l.awb,
         l.tracking_url
       FROM orders o
       LEFT JOIN customer_info ci ON ci.order_id = o.order_id
       LEFT JOIN labels l ON l.order_id = o.order_id
       WHERE ci.email = ?
         AND o.order_id NOT LIKE '%\\_%'
       ORDER BY o.order_date DESC
       LIMIT 20`,
      [email.toLowerCase().trim()]
    );
    res.json(rows);
  } catch (err) {
    if (err.message?.includes('ORDER_DB_HOST')) return res.status(503).json({ error: 'Order database not configured' });
    res.status(500).json({ error: 'Failed to fetch customer orders' });
  }
});

// GET /api/orders/:orderId?email=  — email is optional and only improves
// matching for bare numbers; existing callers that omit it still work.
router.get('/:orderId', async (req, res) => {
  const raw = String(req.params.orderId || '').trim();
  if (!raw) return res.status(400).json({ error: 'Order ID required' });

  try {
    const db = getOrderDb();

    const { orderId: cleanId, matchedBy, candidates } = await resolveOrderId(db, raw, { email: req.query.email });
    if (!cleanId) {
      return res.status(404).json({ error: 'Order not found', order_id: raw, candidates });
    }

    const [orders] = await db.query(
      `SELECT
        o.order_id, o.unique_id, o.customer_name, o.order_date,
        o.product_name, o.product_code, o.size, o.quantity,
        o.selling_price, o.order_total, o.payment_type,
        o.is_partial_paid, o.collectable_amount, o.account_code,
        ci.email, ci.billing_phone,
        ci.shipping_firstname, ci.shipping_lastname, ci.shipping_phone,
        ci.shipping_address, ci.shipping_address2,
        ci.shipping_city, ci.shipping_state, ci.shipping_country, ci.shipping_zipcode,
        l.awb, l.carrier_name, l.carrier_id, l.current_shipment_status,
        l.label_url, l.tracking_url, l.handover_at, l.is_handover, l.priority_carrier
       FROM orders o
       LEFT JOIN customer_info ci ON ci.order_id = o.order_id
       LEFT JOIN labels l ON l.order_id = o.order_id
       WHERE o.order_id = ? OR o.order_id LIKE ?
       ORDER BY
         CASE WHEN o.order_id = ? THEN 0 ELSE 1 END ASC,
         o.order_id ASC`,
      [cleanId, `${cleanId}_%`, cleanId]
    );

    // resolveOrderId already proved this id exists, so an empty result here
    // would mean the row vanished between the two queries
    if (!orders.length) return res.status(404).json({ error: 'Order not found', order_id: raw, candidates: [] });

    const base = orders.find(o => o.order_id === cleanId) || orders[0];

    const customer = {
      name:  base.customer_name,
      email: base.email,
      phone: base.billing_phone || base.shipping_phone,
      address: [base.shipping_address, base.shipping_address2, base.shipping_city, base.shipping_state, base.shipping_zipcode]
        .filter(Boolean).join(', '),
    };

    const mapOrder = (o) => ({
      order_id:     o.order_id,
      is_split:     o.order_id !== cleanId,
      unique_id:    o.unique_id,
      order_date:   o.order_date,
      product:      o.product_name,
      product_code: o.product_code,
      size:         o.size,
      quantity:     o.quantity,
      selling_price:o.selling_price,
      order_total:  o.order_total,
      payment_type: o.payment_type,
      collectable:  o.collectable_amount,
      account_code: o.account_code,
      tracking: o.awb ? {
        awb:          o.awb,
        carrier:      o.carrier_name || o.priority_carrier || o.carrier_id,
        status:       o.current_shipment_status,
        label_url:    o.label_url,
        tracking_url: o.tracking_url || null,
        handover_at:  o.handover_at,
        is_handed_over: !!o.is_handover,
      } : null,
    });

    res.json({
      order_id:    cleanId,
      // What the caller asked for, and how we got from one to the other — the
      // frontend persists resolved_id so later lookups hit the exact branch
      requested_id: raw,
      resolved_id:  cleanId,
      matched_by:   matchedBy,
      customer,
      orders:      orders.map(mapOrder),
      total_items: orders.length,
      has_splits:  orders.length > 1,
      split_count: orders.filter(o => o.order_id !== cleanId).length,
    });
  } catch (err) {
    if (err.message?.includes('ORDER_DB_HOST')) return res.status(503).json({ error: 'Order database not configured' });
    console.error('Order fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

module.exports = router;