const express = require('express');
const db = require('../config/db');
const { requireAdmin } = require('../middleware/authMiddleware');
const {
  parseFilters,
  getOverview, getVolume, getResponseTime,
  getByBrand, getByIssue, getActionStats,
  getAgentStats, getResolvedByName, getSlaBacklog,
  getHourlyActivity,
} = require('../services/analyticsQueries');
const { buildWorkbook, workbookFilename } = require('../services/analyticsExport');

const router = express.Router();

// Every handler shares this shape. The previous version swallowed the error
// entirely, which made a broken query indistinguishable from an empty range.
const handle = (name, fn) => async (req, res) => {
  try {
    const filters = parseFilters(req.query, req.user);
    res.json(await fn(filters, req));
  } catch (err) {
    console.error(`Analytics ${name} failed:`, err);
    res.status(500).json({ error: 'Analytics query failed' });
  }
};

// Snapshot counts (open/in-progress/urgent/backlog aging) reflect the current
// backlog; everything else is scoped to the selected range, with the equivalent
// preceding window returned alongside for comparison.
router.get('/overview',      handle('overview',      getOverview));
router.get('/volume',        handle('volume',        getVolume));
router.get('/by-brand',      handle('by-brand',      getByBrand));
router.get('/by-issue',      handle('by-issue',      getByIssue));
router.get('/response-time', handle('response-time', getResponseTime));
router.get('/sla',           handle('sla',           getSlaBacklog));
router.get('/actions',       handle('actions',       getActionStats));

// Admins see every agent; an agent sees only their own row. The scoping is
// applied in parseFilters from req.user, never from the query string.
router.get('/agents',        handle('agents',        getAgentStats));

// Leaderboard on the typed `resolved_by` name — covers all history, unlike
// /agents which only sees activity recorded since attribution shipped.
router.get('/resolved-by',   handle('resolved-by',   getResolvedByName));

// Hour-of-day activity, bucketed in IST. Admin only — the other /agents routes
// self-scope to the caller, but this one is a staff-hours view and there's no
// useful version of it for an agent looking at a colleague.
router.get('/hourly',        requireAdmin, handle('hourly', getHourlyActivity));

// Most-used reply templates
router.get('/templates', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT id, title, category, usage_count
      FROM templates
      WHERE usage_count > 0
      ORDER BY usage_count DESC
      LIMIT 10
    `);
    res.json(rows);
  } catch (err) {
    console.error('Analytics templates failed:', err);
    res.status(500).json({ error: 'Analytics query failed' });
  }
});

// GET /api/analytics/export — multi-sheet .xlsx, admin only
router.get('/export', requireAdmin, async (req, res) => {
  try {
    const filters = parseFilters(req.query, req.user);
    const workbook = await buildWorkbook(filters);
    const filename = workbookFilename(filters);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // The browser can only read the filename back off a cross-origin response
    // if the header is explicitly exposed
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Analytics export failed:', err);
    // Headers may already be sent once the stream has started
    if (!res.headersSent) res.status(500).json({ error: 'Export failed' });
    else res.end();
  }
});

module.exports = router;
