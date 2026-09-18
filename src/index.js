require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');

const threadRoutes    = require('./routes/threads');
const customerRoutes  = require('./routes/customers');
const templateRoutes  = require('./routes/templates');
const brandRoutes     = require('./routes/brands');
const analyticsRoutes = require('./routes/analytics');
const viewsRoutes     = require('./routes/views');
const settingsRoutes  = require('./routes/settings');
const usersRoutes     = require('./routes/users');
const ordersRoutes    = require('./routes/orders');
const aiRoutes        = require('./routes/ai');
const authRoutes      = require('./routes/auth');
const sendsRoutes     = require('./routes/sends');
const { threadRouter: actionsRoutes, globalRouter: actionsGlobal } = require('./routes/actions');
const payuWebhookRoutes = require('./routes/payuWebhook');
const { syncThreads, syncFromHistory, seedHistoryId, getSyncHealth, resetHistoryBaseline } = require('./services/gmail');
const { runAutoAck, runAutoResolve } = require('./services/automation');
const { flushDueSends } = require('./services/sendQueue');
const { reconcilePendingPaymentLinks } = require('./services/paymentLinks');
const { getBrands } = require('./config/brands');
const { missingCredentials } = require('./services/payu');
const { requireAuth, requireAdmin } = require('./middleware/authMiddleware');

const app  = express();
const PORT = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === 'production';

// ── Security headers ──────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ── CORS ──────────────────────────────────────────────────────
// Always include production origins regardless of NODE_ENV
// so the app works even if NODE_ENV is not explicitly set on Railway.
const allowedOrigins = [
  'https://internal.branddesk.in',
  'https://www.branddesk.in',
  'https://branddesk.in',
  'https://branddesk-frontend-production.up.railway.app',
  process.env.FRONTEND_URL,   // any extra origin from Railway env
  // dev origins
  'http://localhost:5173',
  'http://localhost:3000',
].filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);   // allow server-to-server / curl
    if (allowedOrigins.includes(origin)) return cb(null, true);
    if (origin.endsWith('.railway.app')) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204,
};

// Handle preflight (OPTIONS) with the SAME credentials-aware config
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

app.use(express.json({ limit: '2mb' })); // tighter limit
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());

// ── Public routes ─────────────────────────────────────────────
app.use('/api/users', usersRoutes); // login/logout are public; admin routes protected inside
// Liveness. Always 200 while the process is serving — a platform healthcheck
// pointed here must not restart the container over a stalled mailbox.
app.get('/health',    (req, res) => res.json({
  status: 'ok', sync: getSyncHealth(), timestamp: new Date().toISOString(),
}));

// Is mail actually arriving? Point an uptime monitor at this, not /health.
// The two are not the same: the server stayed up and answered every request
// for two weeks while the Gmail history poll was wedged and every customer
// reply was being dropped. 503 here means the inbox cannot be trusted.
app.get('/health/sync', (req, res) => {
  const sync = getSyncHealth();
  res.status(sync.healthy ? 200 : 503).json({ ...sync, timestamp: new Date().toISOString() });
});

// ── Gmail OAuth ───────────────────────────────────────────────
// /auth/google requires admin (inside route)
// /auth/google/callback is public (Google redirect)
app.use('/auth', authRoutes);

// ── Inbound webhooks (public by necessity) ────────────────────
// Unauthenticated: PayU cannot present a JWT. The handler treats the payload as
// an untrusted hint and re-verifies everything against PayU's API, so there is
// nothing here for a forged POST to exploit. See routes/payuWebhook.js.
app.use('/webhooks', payuWebhookRoutes);

// ── Protected API routes ──────────────────────────────────────
app.use('/api/threads',   requireAuth, threadRoutes);
app.use('/api/threads/:threadId/actions', requireAuth, actionsRoutes);
app.use('/api/actions', requireAuth, actionsGlobal);
app.use('/api/customers', requireAuth, customerRoutes);
app.use('/api/templates', requireAuth, templateRoutes);
app.use('/api/brands',    requireAuth, brandRoutes);
app.use('/api/analytics', requireAuth, analyticsRoutes);
app.use('/api/views',     requireAuth, viewsRoutes);
app.use('/api/settings',  requireAuth, settingsRoutes);
app.use('/api/orders',    requireAuth, ordersRoutes);
app.use('/api/ai',        requireAuth, aiRoutes);
app.use('/api/sends',     requireAuth, sendsRoutes);

// Manual sync — uses fast history sync, full resync for admins
app.post('/api/sync', requireAuth, async (req, res) => {
  try {
    const fullSync = req.query.full === 'true';
    if (fullSync && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Full resync requires admin access' });
    }
    // Full sync uses thread listing; normal sync uses fast history API
    const result = fullSync ? await syncThreads(true) : await syncFromHistory();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Sync failed' });
  }
});

// Re-anchor the Gmail history watermark on the mailbox's current position.
// The recovery path does this on its own now; this is the manual lever for
// when the watermark is stuck but history.list is not failing, which is the
// state that went unnoticed for two weeks. Run a full sync afterwards — this
// skips forward, it does not backfill.
app.post('/api/sync/reset-history', requireAuth, requireAdmin, async (req, res) => {
  try {
    const historyId = await resetHistoryBaseline();
    res.json({ success: true, historyId });
  } catch (err) {
    console.error('History baseline reset failed:', err.message);
    res.status(500).json({ error: 'Reset failed' });
  }
});

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.message?.startsWith('CORS')) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: isProd ? 'Internal server error' : err.message });
});

// ── 404 handler ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Seed history ID on startup (for fast history polling) ────
setTimeout(async () => {
  try { await seedHistoryId(); }
  catch (err) { if (!err.message?.includes('Not authenticated')) console.error('History seed error:', err.message); }
}, 5000);

// ── Cron jobs ─────────────────────────────────────────────────
// Fast history poll every 15 seconds — lightweight API call
let historyPollRunning = false;
let lastStaleWarnAt = 0;
setInterval(async () => {
  if (historyPollRunning) return;
  historyPollRunning = true;
  try { await syncFromHistory(); }
  catch (err) { if (!err.message?.includes('Not authenticated')) console.error('History sync error:', err.message); }
  finally { historyPollRunning = false; }

  // Say it out loud when the watermark stops moving. A silent stall here looks
  // exactly like a quiet inbox: new tickets keep arriving on the 5-minute
  // sync, so nothing on screen suggests anything is wrong. That sync now also
  // catches replies, so a stall is degradation rather than data loss — but it
  // still means mail is minutes late instead of seconds, and it is the signal
  // that the fast path has broken.
  const health = getSyncHealth();
  if (!health.healthy && Date.now() - lastStaleWarnAt > 10 * 60 * 1000) {
    lastStaleWarnAt = Date.now();
    console.error(
      `❌ Gmail history sync unhealthy — watermark ${health.storedHistoryId} stale for ` +
      `${health.watermarkStaleMinutes}m, ${health.consecutiveHistoryFailures} consecutive failure(s)` +
      (health.lastHistoryError ? `: ${health.lastHistoryError}` : '') +
      ' — customer replies are NOT being captured.'
    );
  }
}, 15000);

// Flush due recall-window sends every 10s. Each queued send also has its own
// in-process timer; this sweeper is the safety net that picks up rows orphaned
// by a restart, and the only thing that flushes rows queued on another replica.
// 10s (not cron's 1-min granularity) keeps "Sending…" from visibly hanging.
let flushRunning = false;
setInterval(async () => {
  if (flushRunning) return;
  flushRunning = true;
  try { await flushDueSends(); }
  catch (err) { console.error('Send queue flush error:', err.message); }
  finally { flushRunning = false; }
}, 10000);

// Full sync fallback every 5 min (catches anything history missed)
cron.schedule('*/5 * * * *', async () => {
  try { await syncThreads(false); }
  catch (err) { if (!err.message?.includes('Not authenticated')) console.error('Sync error:', err.message); }
});
cron.schedule('* * * * *', async () => {
  try { await runAutoAck(); }
  catch (err) { console.error('Auto-ack error:', err.message); }
});
cron.schedule('0 1 * * *', async () => {
  try { await runAutoResolve(); }
  catch (err) { console.error('Auto-resolve error:', err.message); }
});

// Reconcile pending payment links against PayU. The webhook makes this mostly
// redundant — which is the point: a webhook that never arrives, or a PayU
// dashboard pointed at the wrong URL, costs a two-minute delay rather than an
// action stuck on "pending" forever.
let reconcileRunning = false;
cron.schedule('*/2 * * * *', async () => {
  if (reconcileRunning) return;
  reconcileRunning = true;
  try { await reconcilePendingPaymentLinks(); }
  catch (err) { console.error('Payment link reconcile error:', err.message); }
  finally { reconcileRunning = false; }
});

app.listen(PORT, () => {
  console.log(`🚀 BrandDesk backend running on port ${PORT}`);
  console.log(`🔒 Environment: ${isProd ? 'production' : 'development'}`);
  if (isProd) console.log(`🌐 Allowed origins: ${allowedOrigins.join(', ')}`);

  // PayU credentials are per-brand env vars whose names derive from the Gmail
  // label, so they run long and a typo is easy to make and hard to spot. Say at
  // boot which brands can take payments, rather than letting an agent discover
  // it when a customer is waiting.
  const brands = getBrands();
  const gaps = brands.map(b => ({ brand: b, missing: missingCredentials(b) }));
  const ready = gaps.filter(g => !g.missing.length);
  console.log(`💳 PayU configured for ${ready.length}/${brands.length} brand(s)`);
  for (const { brand, missing } of gaps.filter(g => g.missing.length)) {
    console.log(`   ⚠ ${brand.name}: set ${missing.map(m => `PAYU_${brand.envKey}_${m}`).join(', ')}`);
  }
});

// Test commit for deployment - ignore