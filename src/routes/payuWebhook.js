const express = require('express');
const { findActionForWebhook, reconcilePaymentLink } = require('../services/paymentLinks');

/**
 * PayU payment-link callbacks. The first public inbound endpoint in this app —
 * everything else sits behind requireAuth.
 *
 * It is deliberately powerless. The body is never trusted: it is read only to
 * work out *which* action to look at, and the answer always comes from PayU's
 * own status API (services/paymentLinks.js). So there is no hash to verify —
 * which is just as well, since PayU's response hash needs the merchant salt,
 * a different credential from the OAuth client id/token this integration uses.
 *
 * Worst case for a forged or replayed POST is one redundant status lookup.
 */

const router = express.Router();

// PayU posts application/x-www-form-urlencoded, already parsed by the global
// urlencoded middleware in index.js. No raw body is needed — nothing is hashed.
//
// The trailing brand label is optional and purely for log readability: the
// brand that matters is resolved from the action's own thread inside
// reconcilePaymentLink. One URL therefore works for every brand, which avoids
// having to URL-encode Gmail labels that contain a space or a slash.
async function handlePayuCallback(req, res) {
  // Answer immediately and always. PayU retries on any non-2xx, and there is
  // nothing here worth retrying: the cron sweep is the real guarantee.
  res.json({ received: true });

  const from = req.params.brandLabel ? ` (${req.params.brandLabel})` : '';
  const body = req.body || {};

  // Identifiers only. The full body can carry customer email and phone, which
  // do not belong in application logs — and the identifiers are all that is
  // needed to work out why a callback did or didn't match.
  console.log(`[payu] webhook${from}: status=${body.status ?? '?'} ` +
              `invoice=${body.invoiceNumber ?? body.invoice_number ?? '?'} ` +
              `txnid=${body.txnid ?? '?'} mihpayid=${body.mihpayid ?? '?'} udf1=${body.udf1 ?? '?'}`);

  try {
    const actionId = await findActionForWebhook(body);
    if (!actionId) {
      // Not fatal — the 2-minute sweep reconciles the same link regardless.
      // Worth a warning because a persistent mismatch means the payload shape
      // differs from what findActionForWebhook expects.
      console.warn(`[payu] webhook${from}: no matching action; body keys: ${Object.keys(body).join(', ') || '(empty)'}`);
      return;
    }
    console.log(`[payu] webhook${from}: matched action ${actionId}`);
    await reconcilePaymentLink(actionId);
  } catch (err) {
    // The response has already gone out; the sweep will retry this link anyway.
    console.error(`[payu] webhook${from} error:`, err.message);
  }
}

router.post('/payu', handlePayuCallback);
router.post('/payu/:brandLabel', handlePayuCallback);

module.exports = router;
