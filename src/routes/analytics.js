const express = require('express');
const db = require('../config/db');
const router = express.Router();

// Parse ?days= into a safe integer. days=1 means "today only".
function parseDays(days, fallback = 30) {
  return Math.min(Math.max(parseInt(days) || fallback, 1), 365);
}

// GET /api/analytics/overview
// Snapshot counts (open/in-progress/urgent) reflect the current backlog;
// activity counts (new/resolved/avg response) are scoped to ?days=N.
router.get('/overview', async (req, res) => {
  try {
    const { brand, days } = req.query;
    const safeDays = parseDays(days);
    const bw = brand && brand !== 'all' ? `AND brand = ${db.escape(brand)}` : '';
    const range = `DATE_SUB(CURDATE(), INTERVAL ${safeDays - 1} DAY)`;

    // Current backlog snapshot
    const [[open]]     = await db.query(`SELECT COUNT(*) c FROM threads WHERE status='open' ${bw}`);
    const [[inProg]]   = await db.query(`SELECT COUNT(*) c FROM threads WHERE status='in_progress' ${bw}`);
    const [[urgent]]   = await db.query(`SELECT COUNT(*) c FROM threads WHERE priority='urgent' AND status!='resolved' ${bw}`);
    const [[unread]]   = await db.query(`SELECT COUNT(*) c FROM threads WHERE is_unread=1 ${bw}`);

    // Activity within the selected range
    const [[rangeNew]]      = await db.query(`SELECT COUNT(*) c FROM threads WHERE created_at >= ${range} ${bw}`);
    const [[rangeResolved]] = await db.query(`SELECT COUNT(*) c FROM threads WHERE status='resolved' AND resolved_at >= ${range} ${bw}`);
    const [[rangeAvgResp]]  = await db.query(`SELECT ROUND(AVG(first_response_minutes)) c FROM threads WHERE first_response_minutes IS NOT NULL AND created_at >= ${range} ${bw}`);

    // All-time (kept for backward compatibility)
    const [[resolved]] = await db.query(`SELECT COUNT(*) c FROM threads WHERE status='resolved' ${bw}`);
    const [[total]]    = await db.query(`SELECT COUNT(*) c FROM threads WHERE 1=1 ${bw}`);
    const [[todayRes]] = await db.query(`SELECT COUNT(*) c FROM threads WHERE status='resolved' AND DATE(resolved_at)=CURDATE() ${bw}`);
    const [[todayNew]] = await db.query(`SELECT COUNT(*) c FROM threads WHERE DATE(created_at)=CURDATE() ${bw}`);

    res.json({
      open:                open.c          || 0,
      in_progress:         inProg.c        || 0,
      urgent:              urgent.c        || 0,
      unread:              unread.c        || 0,
      range_days:          safeDays,
      range_new:           rangeNew.c      || 0,
      range_resolved:      rangeResolved.c || 0,
      range_avg_response_mins: rangeAvgResp.c || 0,
      resolved:            resolved.c || 0,
      total:               total.c    || 0,
      today_resolved:      todayRes.c || 0,
      today_new:           todayNew.c || 0,
      avg_response_mins:   rangeAvgResp.c || 0,
    });
  } catch (err) { res.status(500).json({ error: 'Analytics query failed' }); }
});

// GET /api/analytics/volume
router.get('/volume', async (req, res) => {
  try {
    const { days = 30, brand } = req.query;
    const safeDays = parseDays(days);
    const bw = brand && brand !== 'all' ? `AND brand = ${db.escape(brand)}` : '';
    const [rows] = await db.query(`
      SELECT DATE(created_at) as date, COUNT(*) as total,
        SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) as resolved
      FROM threads
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${bw}
      GROUP BY DATE(created_at) ORDER BY date ASC
    `, [safeDays - 1]);

    // Fill missing days with zeros — days=1 yields just today
    const map = {};
    rows.forEach(r => {
      const key = new Date(r.date).toISOString().split('T')[0];
      map[key] = r;
    });
    const result = [];
    for (let i = safeDays - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key  = d.toISOString().split('T')[0];
      const label = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
      result.push({ date: key, label, total: Number(map[key]?.total || 0), resolved: Number(map[key]?.resolved || 0) });
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: 'Analytics query failed' }); }
});

// GET /api/analytics/by-brand — scoped to tickets created within ?days=N
router.get('/by-brand', async (req, res) => {
  try {
    const safeDays = parseDays(req.query.days);
    const [rows] = await db.query(`
      SELECT brand, COUNT(*) as total,
        SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN priority='urgent' AND status!='resolved' THEN 1 ELSE 0 END) as urgent,
        ROUND(AVG(first_response_minutes)) as avg_response_mins
      FROM threads
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY brand ORDER BY total DESC
    `, [safeDays - 1]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Analytics query failed' }); }
});

// GET /api/analytics/by-issue — scoped to tickets created within ?days=N
router.get('/by-issue', async (req, res) => {
  try {
    const { brand } = req.query;
    const safeDays = parseDays(req.query.days);
    const bw = brand && brand !== 'all' ? `AND brand = ${db.escape(brand)}` : '';
    const [rows] = await db.query(`
      SELECT issue_category as issue, COUNT(*) as total,
        SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) as resolved
      FROM threads
      WHERE issue_category IS NOT NULL AND issue_category != ''
        AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${bw}
      GROUP BY issue_category ORDER BY total DESC LIMIT 10
    `, [safeDays - 1]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Analytics query failed' }); }
});

// GET /api/analytics/response-time
router.get('/response-time', async (req, res) => {
  try {
    const { days = 30, brand } = req.query;
    const safeDays = parseDays(days);
    const bw = brand && brand !== 'all' ? `AND brand = ${db.escape(brand)}` : '';
    const [rows] = await db.query(`
      SELECT DATE(created_at) as date,
        ROUND(AVG(first_response_minutes)) as avg_mins,
        COUNT(*) as count
      FROM threads
      WHERE first_response_minutes IS NOT NULL
        AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${bw}
      GROUP BY DATE(created_at) ORDER BY date ASC
    `, [safeDays - 1]);
    res.json(rows.map(r => ({ ...r, avg_mins: Number(r.avg_mins || 0) })));
  } catch (err) { res.status(500).json({ error: 'Analytics query failed' }); }
});

// GET /api/analytics/resolved-by — leaderboard scoped to resolutions within ?days=N
router.get('/resolved-by', async (req, res) => {
  try {
    const safeDays = parseDays(req.query.days);
    const [rows] = await db.query(`
      SELECT resolved_by, COUNT(*) as total,
        ROUND(AVG(first_response_minutes)) as avg_response_mins
      FROM threads
      WHERE resolved_by IS NOT NULL AND resolved_by != '' AND status = 'resolved'
        AND resolved_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY resolved_by ORDER BY total DESC
    `, [safeDays - 1]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Analytics query failed' }); }
});

// GET /api/analytics/sla  — business-hours SLA stats
router.get('/sla', async (req, res) => {
  try {
    const { getSLAStatus } = require('../services/sla');

    // Get all open threads
    const [openThreads] = await db.query(
      `SELECT id, subject, brand, customer_name, customer_email,
              ticket_id, priority, created_at, status
       FROM threads WHERE status != 'resolved'`
    );

    let on_track = 0, at_risk = 0, breach = 0;
    const breachingThreads = [];

    for (const t of openThreads) {
      const sla = getSLAStatus(t.created_at, t.status);
      if (!sla) continue;

      if (sla.status === 'breached') {
        breach++;
        breachingThreads.push({
          ...t,
          sla_deadline: sla.deadline,
          elapsed_mins: sla.elapsed_mins,
          pct: sla.pct,
          sla_label: sla.label,
        });
      } else if (sla.status === 'at_risk') {
        at_risk++;
      } else {
        on_track++;
      }
    }

    // Sort by most overdue
    breachingThreads.sort((a, b) => b.elapsed_mins - a.elapsed_mins);

    res.json({
      sla_target_minutes: 240,
      sla_description: 'Business hours: Mon–Sat 10 AM–8 PM IST. Outside hours → next business day 12 PM.',
      breach,
      at_risk,
      on_track,
      breaching_threads: breachingThreads.slice(0, 10),
    });
  } catch (err) { res.status(500).json({ error: 'Analytics query failed' }); }
});

// GET /api/analytics/templates — most used templates
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
  } catch (err) { res.status(500).json({ error: 'Analytics query failed' }); }
});

module.exports = router;