const axios = require('axios');

/**
 * The only file that knows PayU's wire format.
 *
 * PayU versions the Payment Links payload and the exact field names differ by
 * merchant onboarding, so every request/response shape is confined here — a
 * correction is a single-file change rather than a hunt through the routes.
 *
 * Credentials are per brand, read off the brand object built in config/brands.js
 * from PAYU_<LABEL>_CLIENT_ID / PAYU_<LABEL>_CLIENT_TOKEN.
 */

const OAUTH_URL   = process.env.PAYU_OAUTH_URL || 'https://accounts.payu.in/oauth/token';
const API_BASE    = process.env.PAYU_API_BASE  || 'https://apiv2.payu.in';
const OAUTH_SCOPE = 'create_payment_links';

const TIMEOUT_MS = 15000;

/**
 * Raised when a brand has no PayU credentials — callers turn this into a 400.
 *
 * The message names the exact variables. Labels like
 * "customer-ticket-dribble-ticket" derive 45-character env names, and a typo in
 * one of those otherwise surfaces as an unexplained "not configured".
 */
class PayuNotConfiguredError extends Error {
  constructor(brand) {
    const name = brand?.name || 'this brand';
    const hint = brand?.envKey
      ? ` — set PAYU_${brand.envKey}_CLIENT_ID and PAYU_${brand.envKey}_CLIENT_TOKEN`
      : '';
    super(`PayU is not configured for ${name}${hint}`);
    this.name = 'PayuNotConfiguredError';
    this.notConfigured = true;
  }
}

/** Raised when PayU answers but rejects the request. */
class PayuApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PayuApiError';
    this.status = status;
  }
}

function assertConfigured(brand) {
  if (!brand?.payuClientId || !brand?.payuClientSecret) {
    throw new PayuNotConfiguredError(brand);
  }
}

/** Pull the most useful line out of PayU's several error shapes. */
function describeError(err) {
  const data = err.response?.data;
  if (typeof data === 'string') return data.slice(0, 300);
  return (
    data?.message ||
    data?.error_description ||
    data?.error ||
    data?.result?.message ||
    err.message
  );
}

// ── Access tokens ────────────────────────────────────────────────────────────

// Per-brand token cache. Process-local by design: a second replica simply mints
// its own token, which PayU allows, and a restart costs one extra round trip.
const tokenCache = new Map(); // brandLabel -> { token, expiresAt }

const SKEW_MS = 60_000; // renew a minute early rather than race the expiry

async function getAccessToken(brand) {
  assertConfigured(brand);

  const cached = tokenCache.get(brand.label);
  if (cached && cached.expiresAt > Date.now() + SKEW_MS) return cached.token;

  const form = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     brand.payuClientId,
    client_secret: brand.payuClientSecret,
    scope:         OAUTH_SCOPE,
  });

  let data;
  try {
    ({ data } = await axios.post(OAUTH_URL, form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: TIMEOUT_MS,
    }));
  } catch (err) {
    throw new PayuApiError(`PayU auth failed: ${describeError(err)}`, err.response?.status);
  }

  const token = data?.access_token;
  if (!token) throw new PayuApiError('PayU auth returned no access_token');

  const ttlMs = (Number(data.expires_in) || 3600) * 1000;
  tokenCache.set(brand.label, { token, expiresAt: Date.now() + ttlMs });
  return token;
}

/** Drop a cached token — used once on 401 so an expired token self-heals. */
function invalidateToken(brand) {
  tokenCache.delete(brand?.label);
}

/**
 * Call PayU with a bearer token, retrying once on 401 with a fresh token.
 * PayU can revoke a token before its stated expiry, and the alternative is a
 * payment link that silently fails to create until the process restarts.
 */
async function authedRequest(brand, config) {
  const send = async () => {
    const token = await getAccessToken(brand);
    return axios({
      ...config,
      baseURL: API_BASE,
      timeout: TIMEOUT_MS,
      headers: { ...config.headers, Authorization: `Bearer ${token}` },
    });
  };

  try {
    return await send();
  } catch (err) {
    if (err.response?.status !== 401) throw err;
    invalidateToken(brand);
    return send();
  }
}

// ── Payment links ────────────────────────────────────────────────────────────

/**
 * Create a payment link.
 *
 * `reference` is echoed back in udf1. The action row does not exist yet at this
 * point (the link is minted first, so a PayU failure persists nothing), so this
 * carries the thread id — enough for a webhook to narrow down which ticket it
 * concerns, with the returned invoice id as the exact key.
 */
async function createPaymentLink({ brand, amount, description, customer, reference }) {
  assertConfigured(brand);

  const payload = {
    subAmount:   Number(amount).toFixed(2),
    description: description || `Payment to ${brand.name}`,
    source:      'API',
    isPartialPaymentAllowed: false,
    // Customer details are optional to PayU but prefill its checkout page.
    ...(customer?.email || customer?.name || customer?.phone
      ? {
          customer: {
            ...(customer.name  ? { name:  customer.name }  : {}),
            ...(customer.email ? { email: customer.email } : {}),
            ...(customer.phone ? { phone: customer.phone } : {}),
          },
        }
      : {}),
    udf: { udf1: String(reference ?? '') },
  };

  let data;
  try {
    ({ data } = await authedRequest(brand, {
      method: 'post',
      url: '/payment-links',
      headers: { 'Content-Type': 'application/json' },
      data: payload,
    }));
  } catch (err) {
    if (err.notConfigured) throw err;
    throw new PayuApiError(`PayU link creation failed: ${describeError(err)}`, err.response?.status);
  }

  const result = data?.result || data;
  const paymentLink  = result?.paymentLink;
  const invoiceNumber = result?.invoiceNumber;

  if (!paymentLink) throw new PayuApiError('PayU did not return a payment link');
  // Without the invoice number there is nothing to reconcile against later, so
  // this is a hard failure rather than a link that can never be confirmed paid.
  if (!invoiceNumber) throw new PayuApiError('PayU did not return an invoiceNumber');

  return { paymentLink, invoiceId: String(invoiceNumber) };
}

// PayU spells the paid state several ways depending on endpoint and vintage.
const PAID_STATES     = new Set(['paid', 'success', 'captured', 'completed']);
const FAILED_STATES   = new Set(['failed', 'failure', 'cancelled', 'canceled']);
const EXPIRED_STATES  = new Set(['expired']);

/** Normalise PayU's status vocabulary to the four states the action tracks. */
function normaliseStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (PAID_STATES.has(s))    return 'paid';
  if (FAILED_STATES.has(s))  return 'failed';
  if (EXPIRED_STATES.has(s)) return 'expired';
  return 'pending';
}

/**
 * Authoritative status for one link. This — never a webhook body — is what the
 * reconciler writes to the database.
 */
async function getPaymentLinkStatus({ brand, invoiceId }) {
  assertConfigured(brand);
  if (!invoiceId) throw new PayuApiError('No PayU invoice id on this action');

  // PayU exposes the lookup as a path segment on some merchant configurations
  // and as a query filter on others. Try the path form, fall back to the query
  // form on a 404 — cheaper than getting it wrong and silently never
  // confirming a payment. If your account only ever answers one of these, drop
  // the other.
  let data;
  try {
    ({ data } = await authedRequest(brand, {
      method: 'get',
      url: `/payment-links/${encodeURIComponent(invoiceId)}`,
    }));
  } catch (err) {
    if (err.notConfigured) throw err;
    if (err.response?.status !== 404) {
      throw new PayuApiError(`PayU status lookup failed: ${describeError(err)}`, err.response?.status);
    }
    try {
      ({ data } = await authedRequest(brand, {
        method: 'get',
        url: '/payment-links',
        params: { invoiceNumber: invoiceId },
      }));
    } catch (err2) {
      throw new PayuApiError(`PayU status lookup failed: ${describeError(err2)}`, err2.response?.status);
    }
  }

  // The query-filter form answers with a list; the path form with one object.
  const payload = data?.result || data;
  const result = Array.isArray(payload) ? payload[0] : payload;
  if (!result) throw new PayuApiError(`PayU has no record of invoice ${invoiceId}`);

  // A link can carry several transaction attempts; the successful one wins.
  const txns = result?.transactions || result?.transaction || [];
  const paidTxn = (Array.isArray(txns) ? txns : [txns])
    .find(t => t && normaliseStatus(t.status) === 'paid');

  const status = paidTxn ? 'paid' : normaliseStatus(result?.status);

  return {
    status,
    rawStatus: String(paidTxn?.status || result?.status || '').slice(0, 30) || status,
    payuRef:   paidTxn?.mihpayid || paidTxn?.payuId || result?.mihpayid || null,
    paidAt:    paidTxn?.addedOn || paidTxn?.paidAt || result?.paidAt || null,
  };
}

module.exports = {
  createPaymentLink,
  getPaymentLinkStatus,
  normaliseStatus,
  PayuNotConfiguredError,
  PayuApiError,
};
