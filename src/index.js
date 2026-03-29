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
const { syncThreads, watchMailbox, handlePushNotification, syncFromHistory, seedHistoryId } = require('./services/gmail');
const { runAutoAck, runAutoClose } = require('./services/automation');
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
app.get('/health',    (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── Gmail Push Webhook (public — Google Pub/Sub calls this) ──
app.post('/api/gmail/webhook', async (req, res) => {
  // Acknowledge immediately so Google doesn't retry
  res.status(200).send('ok');
  try {
    const message = req.body?.message;
    if (!message?.data) return;
    const result = await handlePushNotification(message);
    console.log(`📡 Webhook processed: ${result.total || 0} thread(s)`);
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

// ── Gmail OAuth ───────────────────────────────────────────────
// /auth/google requires admin (inside route)
// /auth/google/callback is public (Google redirect)
app.use('/auth', authRoutes);

// ── Protected API routes ──────────────────────────────────────
app.use('/api/threads',   requireAuth, threadRoutes);
app.use('/api/customers', requireAuth, customerRoutes);
app.use('/api/templates', requireAuth, templateRoutes);
app.use('/api/brands',    requireAuth, brandRoutes);
app.use('/api/analytics', requireAuth, analyticsRoutes);
app.use('/api/views',     requireAuth, viewsRoutes);
app.use('/api/settings',  requireAuth, settingsRoutes);
app.use('/api/orders',    requireAuth, ordersRoutes);
app.use('/api/ai',        requireAuth, aiRoutes);

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
    res.status(500).json({ error: err.message });
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

// ── Gmail Push Watch (if Pub/Sub is configured) ─────────────
if (process.env.GOOGLE_PUBSUB_TOPIC) {
  setTimeout(async () => {
    try { await watchMailbox(); }
    catch (err) { if (!err.message?.includes('Not authenticated')) console.error('Watch setup error:', err.message); }
  }, 5000);
  cron.schedule('0 0 * * *', async () => {
    try { await watchMailbox(); }
    catch (err) { console.error('Watch renewal error:', err.message); }
  });
}

// ── Seed history ID on startup (for fast history polling) ────
setTimeout(async () => {
  try { await seedHistoryId(); }
  catch (err) { if (!err.message?.includes('Not authenticated')) console.error('History seed error:', err.message); }
}, 5000);

// ── Cron jobs ─────────────────────────────────────────────────
// Fast history poll every 15 seconds — lightweight API call
let historyPollRunning = false;
setInterval(async () => {
  if (historyPollRunning) return;
  historyPollRunning = true;
  try { await syncFromHistory(); }
  catch (err) { if (!err.message?.includes('Not authenticated')) console.error('History sync error:', err.message); }
  finally { historyPollRunning = false; }
}, 15000);

// Full sync fallback every 5 min (catches anything history missed)
cron.schedule('*/5 * * * *', async () => {
  try { await syncThreads(false); }
  catch (err) { if (!err.message?.includes('Not authenticated')) console.error('Sync error:', err.message); }
});
cron.schedule('* * * * *', async () => {
  try { await runAutoAck(); }
  catch (err) { console.error('Auto-ack error:', err.message); }
});
cron.schedule('0 0 * * *', async () => {
  try { await runAutoClose(); }
  catch (err) { console.error('Auto-close error:', err.message); }
});

app.listen(PORT, () => {
  console.log(`🚀 BrandDesk backend running on port ${PORT}`);
  console.log(`🔒 Environment: ${isProd ? 'production' : 'development'}`);
  if (isProd) console.log(`🌐 Allowed origins: ${allowedOrigins.join(', ')}`);
});

// Test commit for deployment - ignore