const axios = require('axios');
const crypto = require('crypto');

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

// PayU's live hosts. Payment links are served by OneAPI — not the apiv2.payu.in
// host that some older integration notes mention, which does not resolve at all.
// Both are env-overridable so a sandbox or a future host move needs no deploy.
const OAUTH_URL = process.env.PAYU_OAUTH_URL || 'https://accounts.payu.in/oauth/token';
const API_BASE  = process.env.PAYU_API_BASE  || 'https://oneapi.payu.in';

/**
 * OAuth scopes, space-separated.
 *
 * `create_payment_links` alone mints a token that can create a link but is
 * rejected by the status endpoint with "Token is either invalid/expired" —
 * misleading wording for what is really a permissions failure, since the token
 * in question is seconds old. Reading a link back needs its own grant.
 *
 * PAYU_FALLBACK_SCOPE is the safety net: if the broader request is refused
 * outright, we drop back to creation-only so minting links keeps working while
 * only reconciliation degrades. Override PAYU_OAUTH_SCOPE if your account
 * names the read grant differently.
 */
const OAUTH_SCOPE    = process.env.PAYU_OAUTH_SCOPE || 'create_payment_links read_payment_links';
const FALLBACK_SCOPE = process.env.PAYU_FALLBACK_SCOPE || 'create_payment_links';

const TIMEOUT_MS = 15000;

/**
 * Raised when a brand has no PayU credentials — callers turn this into a 400.
 *
 * The message names the exact variables. Labels like
 * "customer-ticket-dribble-ticket" derive 45-character env names, and a typo in
 * one of those otherwise surfaces as an unexplained "not configured".
 */
class PayuNotConfiguredError extends Error {
  constructor(brand, missing = []) {
    const name = brand?.name || 'this brand';
    const hint = brand?.envKey && missing.length
      ? ` — set ${missing.map(m => `PAYU_${brand.envKey}_${m}`).join(' and ')}`
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

/** The env-var suffixes a brand is missing, in the order they're named. */
function missingCredentials(brand) {
  const missing = [];
  if (!brand?.payuClientId)     missing.push('CLIENT_ID');
  if (!brand?.payuClientSecret) missing.push('CLIENT_TOKEN');
  // Required, not optional: OneAPI rejects the call outright without it.
  if (!brand?.payuMerchantId)   missing.push('MERCHANT_ID');
  return missing;
}

function assertConfigured(brand) {
  const missing = missingCredentials(brand);
  if (missing.length) throw new PayuNotConfiguredError(brand, missing);
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

// ── Logging ──────────────────────────────────────────────────────────────────
//
// Every PayU call is money-adjacent and involves three separate credentials, so
// a bare "it failed" is not enough to act on. These logs name the brand, the
// endpoint and PayU's own error body.
//
// Nothing secret is ever printed. Credentials go through `mask`, which shows
// only the last four characters — enough to confirm the right value loaded,
// useless to anyone reading the logs. Bearer tokens are never logged at all.

const DEBUG = process.env.PAYU_DEBUG === 'true';

function mask(value) {
  if (!value) return '(unset)';
  const s = String(value);
  return s.length <= 4 ? '****' : `****${s.slice(-4)}`;
}

const tag = (brand) => `[payu:${brand?.label || '?'}]`;

const log      = (brand, msg) => console.log(`${tag(brand)} ${msg}`);
const logDebug = (brand, msg) => { if (DEBUG) console.log(`${tag(brand)} ${msg}`); };

/**
 * Log a failure with everything needed to diagnose it in one line-group.
 *
 * Marks the error as logged so an outer catch doesn't report the same failure
 * a second time in weaker terms — a token rejection surfacing again as
 * "create link FAILED — no response" reads like two problems, not one.
 */
function logFailure(brand, what, err) {
  if (err.logged) return;
  err.logged = true;
  const status = err.response?.status;
  const body   = err.response?.data;
  console.error(`${tag(brand)} ${what} FAILED` + (status ? ` — HTTP ${status}` : ` — ${err.code || 'no response'}`));
  if (body !== undefined) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    console.error(`${tag(brand)}   PayU said: ${String(text).slice(0, 1000)}`);
  } else {
    console.error(`${tag(brand)}   ${err.message}`);
  }
}

// ── Access tokens ────────────────────────────────────────────────────────────

// Per-brand token cache. Process-local by design: a second replica simply mints
// its own token, which PayU allows, and a restart costs one extra round trip.
const tokenCache = new Map(); // brandLabel -> { token, expiresAt }

const SKEW_MS = 60_000; // renew a minute early rather than race the expiry

// Which scope string actually worked for a brand, so a rejected broad request
// is not re-attempted on every token renewal.
const scopeInUse = new Map(); // brandLabel -> scope string

/** One raw token request. Throws on anything but a token. */
async function requestToken(brand, scope) {
  const form = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     brand.payuClientId,
    client_secret: brand.payuClientSecret,
    scope,
  });

  const { data } = await axios.post(OAUTH_URL, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: TIMEOUT_MS,
  });

  const token = data?.access_token;
  if (!token) {
    console.error(`${tag(brand)} token: response had no access_token — keys: ${Object.keys(data || {}).join(', ') || '(empty)'}`);
    throw new PayuApiError('PayU auth returned no access_token');
  }
  return { token, ttlSec: Number(data.expires_in) || 3600, grantedScope: data.scope };
}

async function getAccessToken(brand) {
  assertConfigured(brand);

  const cached = tokenCache.get(brand.label);
  if (cached && cached.expiresAt > Date.now() + SKEW_MS) {
    logDebug(brand, 'token: cache hit');
    return cached.token;
  }

  const wanted = scopeInUse.get(brand.label) || OAUTH_SCOPE;
  log(brand, `token: requesting from ${OAUTH_URL} (client_id ${mask(brand.payuClientId)}, secret ${mask(brand.payuClientSecret)}, scope "${wanted}")`);

  let result;
  try {
    result = await requestToken(brand, wanted);
  } catch (err) {
    // Only a rejected *scope* is worth retrying narrower. Bad credentials fail
    // identically at any scope, so retrying would just double the noise.
    const retryable = wanted !== FALLBACK_SCOPE && err.response?.status;
    if (!retryable) {
      logFailure(brand, 'token request', err);
      throw Object.assign(
        new PayuApiError(`PayU auth failed: ${describeError(err)}`, err.response?.status),
        { logged: true }
      );
    }
    console.warn(`${tag(brand)} token: scope "${wanted}" refused (HTTP ${err.response.status}) — falling back to "${FALLBACK_SCOPE}"`);
    console.warn(`${tag(brand)}   link creation will work; status reconciliation will keep failing until the read scope is right`);
    try {
      result = await requestToken(brand, FALLBACK_SCOPE);
      scopeInUse.set(brand.label, FALLBACK_SCOPE);
    } catch (err2) {
      logFailure(brand, 'token request (fallback scope)', err2);
      throw Object.assign(
        new PayuApiError(`PayU auth failed: ${describeError(err2)}`, err2.response?.status),
        { logged: true }
      );
    }
  }

  // PayU echoes the scopes it actually granted, which may be narrower than the
  // ones asked for — the difference is exactly what a later 401 will be about.
  const granted = result.grantedScope ? ` granted="${result.grantedScope}"` : '';
  log(brand, `token: acquired, valid ${result.ttlSec}s${granted}`);
  tokenCache.set(brand.label, { token: result.token, expiresAt: Date.now() + result.ttlSec * 1000 });
  return result.token;
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
      headers: {
        ...config.headers,
        Authorization: `Bearer ${token}`,
        // The OAuth token says who is calling; merchantId says which account to
        // act on. OneAPI needs both — omitting this one fails with
        // "Merchant SDK unavailable for merchantId: null".
        merchantId: brand.payuMerchantId,
      },
    });
  };

  try {
    return await send();
  } catch (err) {
    if (err.response?.status !== 401) throw err;
    log(brand, '401 on an authenticated call — refreshing token and retrying once');
    invalidateToken(brand);
    try {
      return await send();
    } catch (err2) {
      // A brand-new token rejected as "invalid/expired" is not about expiry.
      // Say so, because the wording PayU returns sends you hunting the wrong bug.
      if (err2.response?.status === 401) {
        console.error(`${tag(brand)} still 401 with a token seconds old — this is a PERMISSIONS problem, not expiry.`);
        console.error(`${tag(brand)}   current scope: "${scopeInUse.get(brand.label) || OAUTH_SCOPE}"`);
        console.error(`${tag(brand)}   if link creation works but this call doesn't, the scope is missing the read grant.`);
        console.error(`${tag(brand)}   check the scope name in your PayU dashboard and set PAYU_OAUTH_SCOPE to match.`);
      }
      throw err2;
    }
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

  log(brand, `create link: POST ${API_BASE}/payment-links amount=${payload.subAmount} merchantId=${mask(brand.payuMerchantId)}`);
  logDebug(brand, `create link: payload ${JSON.stringify(payload)}`);

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
    logFailure(brand, 'create link', err);
    throw new PayuApiError(`PayU link creation failed: ${describeError(err)}`, err.response?.status);
  }

  const result = data?.result || data;
  const paymentLink  = result?.paymentLink;
  const invoiceNumber = result?.invoiceNumber;

  // A 200 with an unexpected body is the hardest case to debug blind, so name
  // the keys PayU actually sent rather than just reporting what was absent.
  if (!paymentLink || !invoiceNumber) {
    console.error(`${tag(brand)} create link: unexpected 200 body — keys: ${Object.keys(result || {}).join(', ') || '(empty)'}`);
    console.error(`${tag(brand)}   body: ${JSON.stringify(data).slice(0, 1000)}`);
  }
  if (!paymentLink) throw new PayuApiError('PayU did not return a payment link');
  // Without the invoice number there is nothing to reconcile against later, so
  // this is a hard failure rather than a link that can never be confirmed paid.
  if (!invoiceNumber) throw new PayuApiError('PayU did not return an invoiceNumber');

  log(brand, `create link: ok invoiceNumber=${invoiceNumber}`);
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
    logDebug(brand, `status: GET /payment-links/${invoiceId}`);
    ({ data } = await authedRequest(brand, {
      method: 'get',
      url: `/payment-links/${encodeURIComponent(invoiceId)}`,
    }));
  } catch (err) {
    if (err.notConfigured) throw err;
    if (err.response?.status !== 404) {
      logFailure(brand, `status lookup (invoice ${invoiceId})`, err);
      throw new PayuApiError(`PayU status lookup failed: ${describeError(err)}`, err.response?.status);
    }
    // Logged at info level, not debug: if this branch is the one that works,
    // the path form above is dead code you can delete.
    log(brand, `status: path form 404'd, retrying as ?invoiceNumber=${invoiceId}`);
    try {
      ({ data } = await authedRequest(brand, {
        method: 'get',
        url: '/payment-links',
        params: { invoiceNumber: invoiceId },
      }));
    } catch (err2) {
      logFailure(brand, `status lookup fallback (invoice ${invoiceId})`, err2);
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
  logDebug(brand, `status: invoice ${invoiceId} raw="${result?.status}" -> ${status}`);

  return {
    status,
    rawStatus: String(paidTxn?.status || result?.status || '').slice(0, 30) || status,
    payuRef:   paidTxn?.mihpayid || paidTxn?.payuId || result?.mihpayid || null,
    paidAt:    paidTxn?.addedOn || paidTxn?.paidAt || result?.paidAt || null,
  };
}

// ── Webhook verification ─────────────────────────────────────────────────────

/**
 * Check the SHA-512 signature PayU puts on its callbacks.
 *
 * This is what makes a webhook trustworthy enough to act on directly. Without
 * it the payload is just an unauthenticated POST claiming money changed hands,
 * and anyone who guessed a thread id and an amount could mark an order paid.
 *
 * The formula is PayU's "reverse hash" — the request hash sequence, mirrored,
 * salted at the front:
 *
 *   sha512(salt|status|||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
 *
 * with five empty fields between `status` and `udf5`, mirroring the unused
 * udf6–udf10 slots in the forward hash.
 */
function verifyWebhookHash(brand, body = {}) {
  if (!brand?.payuSalt) return { ok: false, reason: 'no_salt' };

  const received = String(body.hash || '').toLowerCase();
  if (!received) return { ok: false, reason: 'no_hash' };

  const f = (k) => String(body[k] ?? '');
  const parts = [
    brand.payuSalt, f('status'), '', '', '', '', '',
    f('udf5'), f('udf4'), f('udf3'), f('udf2'), f('udf1'),
    f('email'), f('firstname'), f('productinfo'), f('amount'), f('txnid'), f('key'),
  ];
  // PayU prepends additionalCharges to the sequence when the payment carried any.
  if (body.additionalCharges) parts.unshift(String(body.additionalCharges));

  const expected = crypto.createHash('sha512').update(parts.join('|')).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? { ok: true } : { ok: false, reason: 'mismatch', expected };
}

/** Read the payment result out of a callback body. */
function parseWebhookPayment(body = {}) {
  return {
    status:    normaliseStatus(body.status),
    rawStatus: String(body.status || '').slice(0, 30),
    payuRef:   body.mihpayid || null,
    paidAt:    body.addedon || null,
    amount:    body.amount != null ? Number(body.amount) : null,
    merchantKey: body.key || null,
  };
}

module.exports = {
  createPaymentLink,
  getPaymentLinkStatus,
  verifyWebhookHash,
  parseWebhookPayment,
  missingCredentials,
  normaliseStatus,
  PayuNotConfiguredError,
  PayuApiError,
};
