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
const authRoutes      = require('./routes/auth');
const { syncThreads } = require('./services/gmail');
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

// Manual sync — any authenticated user can trigger incremental, admin only for full resync
app.post('/api/sync', requireAuth, async (req, res) => {
  try {
    const fullSync = req.query.full === 'true';
    // Only admins can do full resync
    if (fullSync && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Full resync requires admin access' });
    }
    const result = await syncThreads(fullSync);
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

// ── Cron jobs ─────────────────────────────────────────────────
const pollMinutes = Math.max(1, Math.round(parseInt(process.env.POLL_INTERVAL || '60000') / 60000));
cron.schedule(`*/${pollMinutes} * * * *`, async () => {
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