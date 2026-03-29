const express = require('express');
const { getOrderDb } = require('../config/orderDb');

const router = express.Router();

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

router.get('/:orderId', async (req, res) => {
  const cleanId = req.params.orderId.replace(/^#/, '').trim();
  if (!cleanId) return res.status(400).json({ error: 'Order ID required' });

  try {
    const db = getOrderDb();

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

    if (!orders.length) return res.status(404).json({ error: 'Order not found', order_id: cleanId });

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