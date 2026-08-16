/**
 * PayU response parsing — run with:  node src/services/payu.test.js
 *
 * The bug this file exists to prevent: `result.status` on a payment link is the
 * link's LIFECYCLE, not the money. A one-payment link flips to "expired" the
 * instant it is used, so reading it alone reports a fully paid order as expired
 * and leaves the customer chased for money they already sent.
 *
 * The first fixture is a verbatim PayU response for a link that really was paid.
 */
const assert = require('node:assert/strict');
const { parseLinkStatus, verifyWebhookHash, normaliseStatus } = require('./payu');

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (err) { fail++; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

// Verbatim from PayU for invoice INV008178691652844800, which WAS paid.
const PAID_BUT_EXPIRED = {
  status: 0,
  message: null,
  result: {
    summary: { amountRequested: 10, totalRevenue: 10, totalViews: 1 },
    subAmount: 10, tax: 0, shippingCharge: 0,
    totalAmount: 10, dueAmount: 10, totalAmountCollected: 10,
    invoiceNumber: 'INV008178691652844800',
    paymentLink: 'https://u.payu.in/PAYUMN/1rs72oCiFVOz',
    description: 'Size Exchange',
    active: false,
    isPartialPaymentAllowed: false,
    status: 'expired',            // link lifecycle — the trap
    paymentStatus: 'Paid',        // the actual answer
    amountStatus: 'FULLY_PAID',   // corroborates
    expiryDate: '2026-08-17T03:13:54.000+05:30',
    udf: { udf1: '3918' },
    addedOn: '2026-08-17T03:12:08.000+05:30',
    maxPaymentsAllowed: 1,
    transactionId: null,
    paymentDetails: null,
    merchantId: 13521513,
    currency: 'INR',
  },
  errorCode: null,
};

console.log('\nparseLinkStatus — the expired-but-paid trap');
test('a paid one-payment link is paid, not expired', () => {
  const r = parseLinkStatus(PAID_BUT_EXPIRED);
  assert.equal(r.status, 'paid');
});
test('link lifecycle is kept separately, not conflated', () => {
  const r = parseLinkStatus(PAID_BUT_EXPIRED);
  assert.equal(r.linkStatus, 'expired');
});
test('the status shown to an agent reads "Paid", not "expired"', () => {
  assert.equal(parseLinkStatus(PAID_BUT_EXPIRED).rawStatus, 'Paid');
});

console.log('\nparseLinkStatus — genuinely unpaid links');
test('an expired link that was never paid stays expired', () => {
  const r = parseLinkStatus({ result: {
    status: 'expired', paymentStatus: 'Not Paid', amountStatus: 'NOT_PAID',
    totalAmount: 10, totalAmountCollected: 0,
  } });
  assert.equal(r.status, 'expired');
});
test('an active unpaid link is pending', () => {
  const r = parseLinkStatus({ result: {
    status: 'active', paymentStatus: 'Not Paid', totalAmount: 10, totalAmountCollected: 0,
  } });
  assert.equal(r.status, 'pending');
});
test('a partial payment is NOT treated as paid', () => {
  const r = parseLinkStatus({ result: {
    status: 'active', paymentStatus: 'Paid', amountStatus: 'PARTIALLY_PAID',
    totalAmount: 100, totalAmountCollected: 40,
  } });
  assert.notEqual(r.status, 'paid');
});

console.log('\nparseLinkStatus — other shapes');
test('collected >= total counts as paid when status words are absent', () => {
  const r = parseLinkStatus({ result: { status: 'expired', totalAmount: 10, totalAmountCollected: 10 } });
  assert.equal(r.status, 'paid');
});
test('a transactions array is still honoured if present', () => {
  const r = parseLinkStatus({ result: {
    status: 'expired', totalAmount: 10, totalAmountCollected: 0,
    transactions: [{ status: 'failed' }, { status: 'success', mihpayid: '3016' }],
  } });
  assert.equal(r.status, 'paid');
  assert.equal(r.payuRef, '3016');
});
test('the list form (query fallback) unwraps to the first entry', () => {
  const r = parseLinkStatus({ result: [PAID_BUT_EXPIRED.result] });
  assert.equal(r.status, 'paid');
});
test('an empty body parses to null rather than throwing', () => {
  assert.equal(parseLinkStatus({}), null);
  assert.equal(parseLinkStatus({ result: null }), null);
});
test('expiryDate is never used as the payment time', () => {
  // For a timed link this would be a future date; a payment dated in the
  // future is worse than one dated at reconciliation.
  assert.equal(parseLinkStatus(PAID_BUT_EXPIRED).paidAt, null);
});

console.log('\nnormaliseStatus');
test('maps PayU vocabulary to the four tracked states', () => {
  assert.equal(normaliseStatus('success'), 'paid');
  assert.equal(normaliseStatus('captured'), 'paid');
  assert.equal(normaliseStatus('failed'), 'failed');
  assert.equal(normaliseStatus('expired'), 'expired');
  assert.equal(normaliseStatus('anything else'), 'pending');
});

console.log('\nverifyWebhookHash');
const crypto = require('crypto');
const SALT = 'TestSalt123';
const hookBody = {
  status: 'success', udf1: '3918', udf2: '', udf3: '', udf4: '', udf5: '',
  email: 'ravatkeval@gmail.com', firstname: 'Keval', productinfo: 'Size Exchange',
  amount: '10.00', txnid: '70154917', key: '2mULqb', mihpayid: '30163040859',
};
hookBody.hash = crypto.createHash('sha512').update([
  SALT, hookBody.status, '', '', '', '', '',
  hookBody.udf5, hookBody.udf4, hookBody.udf3, hookBody.udf2, hookBody.udf1,
  hookBody.email, hookBody.firstname, hookBody.productinfo,
  hookBody.amount, hookBody.txnid, hookBody.key,
].join('|')).digest('hex');

test('accepts a correctly signed callback', () => {
  assert.equal(verifyWebhookHash({ payuSalt: SALT }, hookBody).ok, true);
});
test('rejects a tampered amount', () => {
  assert.equal(verifyWebhookHash({ payuSalt: SALT }, { ...hookBody, amount: '1.00' }).ok, false);
});
test('rejects the wrong salt', () => {
  assert.equal(verifyWebhookHash({ payuSalt: 'wrong' }, hookBody).ok, false);
});
test('reports no_salt rather than silently passing', () => {
  assert.equal(verifyWebhookHash({}, hookBody).reason, 'no_salt');
});
test('reports no_hash on an unsigned body', () => {
  assert.equal(verifyWebhookHash({ payuSalt: SALT }, { status: 'success' }).reason, 'no_hash');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
