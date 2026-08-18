/**
 * Shared analytics queries.
 *
 * Both the /api/analytics routes and the Excel exporter call these, so a
 * downloaded workbook can never disagree with what the dashboard shows.
 */
const db = require('../config/db');
const { getSLAStatus, businessMinutesElapsed } = require('./sla');

const MAX_RANGE_DAYS = 365;
const SLA_BH_MINUTES = 4 * 60;   // must match sla.js
// businessMinutesElapsed walks forward a minute at a time, so cap how many
// threads we run it over for the historical compliance figure.
const SLA_SAMPLE_CAP = 2000;

const toDateStr = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * Shift a stored timestamp into IST.
 *
 * Everything is stored UTC — db.js pins the pool to +00:00 and the MySQL
 * session runs on UTC too — but the team works Mon–Sat 10 AM–8 PM IST, so an
 * hour-of-day bucket only means anything once shifted. The numeric-offset form
 * of CONVERT_TZ needs no mysql timezone tables loaded, unlike a named zone such
 * as 'Asia/Kolkata'.
 */
const IST = (col) => `CONVERT_TZ(${col}, '+00:00', '+05:30')`;

const daysBetween = (from, to) =>
  Math.round((new Date(to) - new Date(from)) / 86400000) + 1;

/**
 * Normalise the query string into a filter object.
 *
 * Accepts either ?days=N (N=1 means today only) or explicit ?from=&to=.
 * `user` is the authenticated req.user — a non-admin is always pinned to their
 * own id regardless of what the client asked for.
 */
function parseFilters(query = {}, user = null) {
  let from, to;

  if (query.from && query.to && !Number.isNaN(Date.parse(query.from)) && !Number.isNaN(Date.parse(query.to))) {
    from = new Date(query.from);
    to   = new Date(query.to);
    if (from > to) [from, to] = [to, from];
    if (daysBetween(from, to) > MAX_RANGE_DAYS) {
      from = new Date(to);
      from.setDate(from.getDate() - (MAX_RANGE_DAYS - 1));
    }
  } else {
    const days = Math.min(Math.max(parseInt(query.days) || 30, 1), MAX_RANGE_DAYS);
    to = new Date();
    from = new Date();
    from.setDate(from.getDate() - (days - 1));
  }

  const days = daysBetween(from, to);

  // Immediately preceding window of equal length — powers the delta chips
  const prevTo = new Date(from);
  prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(prevTo);
  prevFrom.setDate(prevFrom.getDate() - (days - 1));

  const brand = query.brand && query.brand !== 'all' ? String(query.brand) : null;

  const isAdmin = user?.role === 'admin';
  let agentId = null;
  if (isAdmin) {
    if (query.agent && query.agent !== 'all') agentId = parseInt(query.agent) || null;
  } else if (user?.id) {
    agentId = user.id;   // agents only ever see themselves
  }

  return {
    from: toDateStr(from), to: toDateStr(to),
    prevFrom: toDateStr(prevFrom), prevTo: toDateStr(prevTo),
    days, brand, agentId, isAdmin,
  };
}

/**
 * WHERE fragment for the `threads` table.
 *
 * dateCol picks which column the range applies to — created_at for "new in
 * range", resolved_at for "resolved in range".
 */
function threadWhere(f, { alias = 't', dateCol = 'created_at', usePrev = false, skipDate = false } = {}) {
  const a = alias ? `${alias}.` : '';
  const sql = [];
  const params = [];

  if (!skipDate) {
    sql.push(`DATE(${a}${dateCol}) BETWEEN ? AND ?`);
    params.push(usePrev ? f.prevFrom : f.from, usePrev ? f.prevTo : f.to);
  }
  if (f.brand)   { sql.push(`${a}brand = ?`);               params.push(f.brand); }
  if (f.agentId) { sql.push(`${a}resolved_by_user_id = ?`); params.push(f.agentId); }

  return { sql: sql.length ? sql.join(' AND ') : '1=1', params };
}

// ── Overview ────────────────────────────────────────────────────────────────

async function getOverview(f) {
  const created      = threadWhere(f, { dateCol: 'created_at' });
  const createdPrev  = threadWhere(f, { dateCol: 'created_at',  usePrev: true });
  const resolved     = threadWhere(f, { dateCol: 'resolved_at' });
  const resolvedPrev = threadWhere(f, { dateCol: 'resolved_at', usePrev: true });
  // Backlog is a live snapshot — the date range doesn't apply to it
  const backlog      = threadWhere(f, { skipDate: true });

  const one = async (sql, params) => {
    const [[row]] = await db.query(sql, params);
    return Number(row?.c || 0);
  };

  const [
    open, inProgress, urgent, unread,
    rangeNew, rangePrevNew,
    rangeResolved, rangePrevResolved,
    avgResp, prevAvgResp,
    avgResolution,
  ] = await Promise.all([
    one(`SELECT COUNT(*) c FROM threads t WHERE t.status='open' AND ${backlog.sql}`, backlog.params),
    one(`SELECT COUNT(*) c FROM threads t WHERE t.status='in_progress' AND ${backlog.sql}`, backlog.params),
    one(`SELECT COUNT(*) c FROM threads t WHERE t.priority='urgent' AND t.status!='resolved' AND ${backlog.sql}`, backlog.params),
    one(`SELECT COUNT(*) c FROM threads t WHERE t.is_unread=1 AND ${backlog.sql}`, backlog.params),

    one(`SELECT COUNT(*) c FROM threads t WHERE ${created.sql}`, created.params),
    one(`SELECT COUNT(*) c FROM threads t WHERE ${createdPrev.sql}`, createdPrev.params),

    one(`SELECT COUNT(*) c FROM threads t WHERE t.status='resolved' AND ${resolved.sql}`, resolved.params),
    one(`SELECT COUNT(*) c FROM threads t WHERE t.status='resolved' AND ${resolvedPrev.sql}`, resolvedPrev.params),

    one(`SELECT ROUND(AVG(t.first_response_minutes)) c FROM threads t
         WHERE t.first_response_minutes IS NOT NULL AND ${created.sql}`, created.params),
    one(`SELECT ROUND(AVG(t.first_response_minutes)) c FROM threads t
         WHERE t.first_response_minutes IS NOT NULL AND ${createdPrev.sql}`, createdPrev.params),

    // resolved_at is never cleared on reopen, so guard on the current status
    one(`SELECT ROUND(AVG(TIMESTAMPDIFF(MINUTE, t.created_at, t.resolved_at))) c FROM threads t
         WHERE t.status='resolved' AND t.resolved_at IS NOT NULL AND ${resolved.sql}`, resolved.params),
  ]);

  const [medianResolution, aging, sla] = await Promise.all([
    getMedianResolutionMins(f),
    getBacklogAging(f),
    getSlaCompliance(f),
  ]);

  return {
    range: { from: f.from, to: f.to, days: f.days, prev_from: f.prevFrom, prev_to: f.prevTo },
    open, in_progress: inProgress, urgent, unread,
    range_new: rangeNew,           prev_new: rangePrevNew,
    range_resolved: rangeResolved, prev_resolved: rangePrevResolved,
    range_avg_response_mins: avgResp, prev_avg_response_mins: prevAvgResp,
    avg_resolution_mins: avgResolution,
    median_resolution_mins: medianResolution,
    backlog_aging: aging,
    sla_compliance_pct: sla.pct,
    sla_measured: sla.measured,
    sla_within: sla.within,
  };
}

// MySQL 5.7 has no PERCENTILE_CONT, and the row counts here are small enough
// that pulling the column and picking the middle is simpler than a window trick.
async function getMedianResolutionMins(f) {
  const w = threadWhere(f, { dateCol: 'resolved_at' });
  const [rows] = await db.query(
    `SELECT TIMESTAMPDIFF(MINUTE, t.created_at, t.resolved_at) m FROM threads t
     WHERE t.status='resolved' AND t.resolved_at IS NOT NULL AND ${w.sql}
     ORDER BY m ASC`, w.params
  );
  if (!rows.length) return 0;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2
    ? Number(rows[mid].m)
    : Math.round((Number(rows[mid - 1].m) + Number(rows[mid].m)) / 2);
}

async function getBacklogAging(f) {
  const w = threadWhere(f, { skipDate: true });
  const [[row]] = await db.query(`
    SELECT
      SUM(CASE WHEN t.created_at >  DATE_SUB(NOW(), INTERVAL 1 DAY) THEN 1 ELSE 0 END) AS under_1d,
      SUM(CASE WHEN t.created_at <= DATE_SUB(NOW(), INTERVAL 1 DAY)
                AND t.created_at >  DATE_SUB(NOW(), INTERVAL 3 DAY) THEN 1 ELSE 0 END) AS d1_3,
      SUM(CASE WHEN t.created_at <= DATE_SUB(NOW(), INTERVAL 3 DAY)
                AND t.created_at >  DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS d3_7,
      SUM(CASE WHEN t.created_at <= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS over_7d
    FROM threads t WHERE t.status != 'resolved' AND ${w.sql}
  `, w.params);
  return {
    under_1d: Number(row?.under_1d || 0),
    d1_3:     Number(row?.d1_3     || 0),
    d3_7:     Number(row?.d3_7     || 0),
    over_7d:  Number(row?.over_7d  || 0),
  };
}

/**
 * Historical SLA compliance: of the tickets created in range that got a first
 * response, how many landed inside 4 business hours. Uses the same
 * business-hours helper as the live SLA banner so the two agree.
 */
async function getSlaCompliance(f) {
  const w = threadWhere(f, { dateCol: 'created_at' });
  const [rows] = await db.query(
    `SELECT t.created_at, t.first_response_minutes FROM threads t
     WHERE t.first_response_minutes IS NOT NULL AND ${w.sql}
     ORDER BY t.created_at DESC LIMIT ${SLA_SAMPLE_CAP}`, w.params
  );
  if (!rows.length) return { pct: null, measured: 0, within: 0 };

  let within = 0;
  for (const r of rows) {
    const responded = new Date(new Date(r.created_at).getTime() + r.first_response_minutes * 60000);
    if (businessMinutesElapsed(r.created_at, responded) <= SLA_BH_MINUTES) within++;
  }
  return { pct: Math.round((within / rows.length) * 100), measured: rows.length, within };
}

// ── Time series ─────────────────────────────────────────────────────────────

// Both series are zero-filled over the same day span so their x-axes line up.
function zeroFill(f, rows, valueKeys) {
  const map = {};
  rows.forEach(r => { map[toDateStr(new Date(r.date))] = r; });

  const out = [];
  const cursor = new Date(f.from);
  const end = new Date(f.to);
  while (cursor <= end) {
    const key = toDateStr(cursor);
    const hit = map[key];
    const entry = {
      date: key,
      label: cursor.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
    };
    valueKeys.forEach(k => { entry[k] = Number(hit?.[k] || 0); });
    out.push(entry);
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

async function getVolume(f) {
  const w = threadWhere(f, { dateCol: 'created_at' });
  const [rows] = await db.query(`
    SELECT DATE(t.created_at) as date, COUNT(*) as total,
      SUM(CASE WHEN t.status='resolved' THEN 1 ELSE 0 END) as resolved
    FROM threads t WHERE ${w.sql}
    GROUP BY DATE(t.created_at) ORDER BY date ASC
  `, w.params);
  return zeroFill(f, rows, ['total', 'resolved']);
}

async function getResponseTime(f) {
  const w = threadWhere(f, { dateCol: 'created_at' });
  const [rows] = await db.query(`
    SELECT DATE(t.created_at) as date,
      ROUND(AVG(t.first_response_minutes)) as avg_mins,
      COUNT(*) as count
    FROM threads t
    WHERE t.first_response_minutes IS NOT NULL AND ${w.sql}
    GROUP BY DATE(t.created_at) ORDER BY date ASC
  `, w.params);
  return zeroFill(f, rows, ['avg_mins', 'count']);
}

// ── Breakdowns ──────────────────────────────────────────────────────────────

async function getByBrand(f) {
  // Ignore any brand filter here — this panel is the brand comparison
  const w = threadWhere({ ...f, brand: null }, { dateCol: 'created_at' });
  const [rows] = await db.query(`
    SELECT t.brand, COUNT(*) as total,
      SUM(CASE WHEN t.status='open' THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN t.status='in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN t.status='resolved' THEN 1 ELSE 0 END) as resolved,
      SUM(CASE WHEN t.priority='urgent' AND t.status!='resolved' THEN 1 ELSE 0 END) as urgent,
      ROUND(AVG(t.first_response_minutes)) as avg_response_mins
    FROM threads t WHERE ${w.sql}
    GROUP BY t.brand ORDER BY total DESC
  `, w.params);
  return rows.map(r => ({ ...r, avg_response_mins: Number(r.avg_response_mins || 0) }));
}

/** Categories with their sub-issues nested, so the UI can drill in. */
async function getByIssue(f) {
  const w = threadWhere(f, { dateCol: 'created_at' });
  const [rows] = await db.query(`
    SELECT t.issue_category as issue, COALESCE(NULLIF(t.sub_issue,''), '—') as sub_issue,
      COUNT(*) as total,
      SUM(CASE WHEN t.status='resolved' THEN 1 ELSE 0 END) as resolved
    FROM threads t
    WHERE t.issue_category IS NOT NULL AND t.issue_category != '' AND ${w.sql}
    GROUP BY t.issue_category, sub_issue
    ORDER BY total DESC
  `, w.params);

  const byCategory = new Map();
  for (const r of rows) {
    if (!byCategory.has(r.issue)) {
      byCategory.set(r.issue, { issue: r.issue, total: 0, resolved: 0, sub_issues: [] });
    }
    const cat = byCategory.get(r.issue);
    cat.total    += Number(r.total);
    cat.resolved += Number(r.resolved);
    cat.sub_issues.push({ sub_issue: r.sub_issue, total: Number(r.total), resolved: Number(r.resolved) });
  }
  return [...byCategory.values()].sort((a, b) => b.total - a.total);
}

/** Exchanges / returns / refunds — the operational workload, absent until now. */
async function getActionStats(f) {
  const sql = [`DATE(a.created_at) BETWEEN ? AND ?`];
  const params = [f.from, f.to];
  if (f.brand)   { sql.push('t.brand = ?');      params.push(f.brand); }
  if (f.agentId) { sql.push('(a.created_by = ? OR a.closed_by = ?)'); params.push(f.agentId, f.agentId); }

  const [rows] = await db.query(`
    SELECT a.action_type, COUNT(*) as total,
      SUM(CASE WHEN a.is_closed = 1 THEN 1 ELSE 0 END) as closed,
      SUM(CASE WHEN a.is_closed = 0 THEN 1 ELSE 0 END) as open,
      ROUND(AVG(CASE WHEN a.is_closed = 1 AND a.closed_at IS NOT NULL
                     THEN TIMESTAMPDIFF(HOUR, a.created_at, a.closed_at) END) / 24, 1) as avg_days_to_close
    FROM thread_actions a JOIN threads t ON t.id = a.thread_id
    WHERE ${sql.join(' AND ')}
    GROUP BY a.action_type ORDER BY total DESC
  `, params);

  return rows.map(r => ({
    action_type: r.action_type,
    total: Number(r.total), closed: Number(r.closed), open: Number(r.open),
    avg_days_to_close: r.avg_days_to_close === null ? null : Number(r.avg_days_to_close),
  }));
}

// ── Agents ──────────────────────────────────────────────────────────────────

/**
 * Per-agent activity. Each metric is a separate scoped aggregate rather than
 * one big JOIN — joining resolutions to replies to actions multiplies rows and
 * silently inflates every count.
 */
async function getAgentStats(f) {
  const brandJoin = f.brand ? 'AND t.brand = ?' : '';
  const brandParam = f.brand ? [f.brand] : [];

  const [users] = await db.query(
    `SELECT id, name, email, role FROM users WHERE is_active = 1 ${f.agentId ? 'AND id = ?' : ''} ORDER BY name ASC`,
    f.agentId ? [f.agentId] : []
  );

  const [resolved] = await db.query(`
    SELECT t.resolved_by_user_id AS uid, COUNT(*) AS total,
      ROUND(AVG(t.first_response_minutes)) AS avg_response_mins,
      ROUND(AVG(TIMESTAMPDIFF(MINUTE, t.created_at, t.resolved_at))) AS avg_resolution_mins
    FROM threads t
    WHERE t.status='resolved' AND DATE(t.resolved_at) BETWEEN ? AND ? ${brandJoin}
    GROUP BY t.resolved_by_user_id
  `, [f.from, f.to, ...brandParam]);

  const [replies] = await db.query(`
    SELECT m.user_id AS uid,
      SUM(CASE WHEN m.is_note = 0 THEN 1 ELSE 0 END) AS replies,
      SUM(CASE WHEN m.is_note = 1 THEN 1 ELSE 0 END) AS notes
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE m.direction='outbound' AND DATE(m.sent_at) BETWEEN ? AND ? ${brandJoin}
    GROUP BY m.user_id
  `, [f.from, f.to, ...brandParam]);

  const [actions] = await db.query(`
    SELECT a.closed_by AS uid, COUNT(*) AS actions_closed
    FROM thread_actions a JOIN threads t ON t.id = a.thread_id
    WHERE a.is_closed = 1 AND DATE(a.closed_at) BETWEEN ? AND ? ${brandJoin}
    GROUP BY a.closed_by
  `, [f.from, f.to, ...brandParam]);

  const idx = (rows) => Object.fromEntries(rows.map(r => [r.uid ?? 'null', r]));
  const R = idx(resolved), M = idx(replies), A = idx(actions);

  const build = (id, name, role) => ({
    user_id: id, name, role,
    resolved:            Number(R[id]?.total || 0),
    replies:             Number(M[id]?.replies || 0),
    notes:               Number(M[id]?.notes || 0),
    actions_closed:      Number(A[id]?.actions_closed || 0),
    avg_response_mins:   Number(R[id]?.avg_response_mins || 0),
    avg_resolution_mins: Number(R[id]?.avg_resolution_mins || 0),
  });

  const out = users.map(u => build(u.id, u.name, u.role));

  // Everything from before attribution shipped, plus system sends
  if (!f.agentId) {
    const un = build('null', 'Unattributed', null);
    if (un.resolved || un.replies || un.notes || un.actions_closed) out.push(un);
  }

  return out.sort((a, b) => (b.resolved - a.resolved) || (b.replies - a.replies));
}

/**
 * Resolution leaderboard grouped on the free-text `resolved_by` name.
 *
 * Complements getAgentStats rather than replacing it: this one covers the full
 * history (the name has always been recorded) but can only ever count
 * resolutions, since messages and thread_actions carry no name to group on.
 *
 * Grouped case/whitespace-insensitively so "keval" and " Keval" merge, and
 * `variants` surfaces when one person has been recorded under several
 * spellings instead of quietly hiding it.
 *
 * The agent filter is deliberately NOT applied — it selects a user id, and
 * matching that back to free text would produce a number that silently
 * disagrees with the Agent performance table.
 */
async function getResolvedByName(f) {
  const w = threadWhere({ ...f, agentId: null }, { dateCol: 'resolved_at' });
  const [rows] = await db.query(`
    SELECT MAX(TRIM(t.resolved_by)) AS name,
      COUNT(*) AS total,
      COUNT(DISTINCT TRIM(t.resolved_by)) AS variants,
      ROUND(AVG(t.first_response_minutes)) AS avg_response_mins,
      ROUND(AVG(TIMESTAMPDIFF(MINUTE, t.created_at, t.resolved_at))) AS avg_resolution_mins
    FROM threads t
    WHERE t.status='resolved' AND t.resolved_by IS NOT NULL AND TRIM(t.resolved_by) != ''
      AND ${w.sql}
    GROUP BY LOWER(TRIM(t.resolved_by))
    ORDER BY total DESC
  `, w.params);

  return rows.map(r => ({
    name: r.name,
    total: Number(r.total),
    variants: Number(r.variants),
    // 'system' is written by the auto-resolve cron, not a person
    is_system: String(r.name).toLowerCase() === 'system',
    avg_response_mins:   Number(r.avg_response_mins || 0),
    avg_resolution_mins: Number(r.avg_resolution_mins || 0),
  }));
}

// ── Hour-of-day activity ────────────────────────────────────────────────────

const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

/**
 * When in the day an agent is actually working, bucketed by hour in IST.
 *
 * The rest of this file answers "how much" over a period; this answers "when".
 * Counts resolutions, replies, internal notes and closed actions — resolutions
 * alone are far too sparse to tell you whether someone was at their desk at
 * 3 PM.
 *
 * Both the day and the hour are grouped in IST. Summing straight into 24
 * buckets would make "active hours" mean "hours of the day this agent was ever
 * active", which over a month approaches 24 and says nothing; grouping by day
 * as well lets the per-day figure be a real answer.
 */
async function getHourlyActivity(f) {
  const resolvedSql = [
    `t.status='resolved'`,
    `t.resolved_at IS NOT NULL`,
    `DATE(${IST('t.resolved_at')}) BETWEEN ? AND ?`,
  ];
  const resolvedParams = [f.from, f.to];
  if (f.brand)   { resolvedSql.push('t.brand = ?');               resolvedParams.push(f.brand); }
  if (f.agentId) { resolvedSql.push('t.resolved_by_user_id = ?'); resolvedParams.push(f.agentId); }

  // messages.user_id is NULL for inbound mail and system sends (auto-ack,
  // auto-resolve notes), so it doubles as the "a person did this" filter.
  const msgSql = [
    `m.direction='outbound'`,
    `m.user_id IS NOT NULL`,
    `DATE(${IST('m.sent_at')}) BETWEEN ? AND ?`,
  ];
  const msgParams = [f.from, f.to];
  if (f.brand)   { msgSql.push('t.brand = ?');   msgParams.push(f.brand); }
  if (f.agentId) { msgSql.push('m.user_id = ?'); msgParams.push(f.agentId); }

  const actSql = [
    `a.is_closed = 1`,
    `a.closed_at IS NOT NULL`,
    `DATE(${IST('a.closed_at')}) BETWEEN ? AND ?`,
  ];
  const actParams = [f.from, f.to];
  if (f.brand)   { actSql.push('t.brand = ?');     actParams.push(f.brand); }
  if (f.agentId) { actSql.push('a.closed_by = ?'); actParams.push(f.agentId); }

  // DATE_FORMAT rather than DATE so the day comes back as a string. A bare
  // DATE() arrives as a JS Date at UTC midnight, which reads back as the
  // previous day for anyone running the server west of Greenwich.
  const [[resolvedRows], [msgRows], [actionRows]] = await Promise.all([
    db.query(`
      SELECT DATE_FORMAT(${IST('t.resolved_at')}, '%Y-%m-%d') d,
             HOUR(${IST('t.resolved_at')}) h, COUNT(*) n
      FROM threads t WHERE ${resolvedSql.join(' AND ')}
      GROUP BY d, h
    `, resolvedParams),
    db.query(`
      SELECT DATE_FORMAT(${IST('m.sent_at')}, '%Y-%m-%d') d,
             HOUR(${IST('m.sent_at')}) h,
             SUM(m.is_note = 0) replies, SUM(m.is_note = 1) notes
      FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE ${msgSql.join(' AND ')}
      GROUP BY d, h
    `, msgParams),
    db.query(`
      SELECT DATE_FORMAT(${IST('a.closed_at')}, '%Y-%m-%d') d,
             HOUR(${IST('a.closed_at')}) h, COUNT(*) n
      FROM thread_actions a JOIN threads t ON t.id = a.thread_id
      WHERE ${actSql.join(' AND ')}
      GROUP BY d, h
    `, actParams),
  ]);

  const hours = HOUR_LABELS.map((label, hour) => ({
    hour, label, resolved: 0, replies: 0, notes: 0, actions_closed: 0, total: 0,
  }));

  const days = new Map();
  const dayFor = (date) => {
    if (!days.has(date)) {
      days.set(date, { date, active: new Set(), resolved: 0, replies: 0, notes: 0, actions_closed: 0 });
    }
    return days.get(date);
  };

  // An hour counts as worked if anything at all happened in it, notes included
  const fold = (rows, counts) => {
    for (const r of rows) {
      const h = Number(r.h);
      if (!Number.isInteger(h) || h < 0 || h > 23) continue;
      const bucket = hours[h];
      const day = dayFor(r.d);
      let any = 0;
      for (const [key, n] of Object.entries(counts(r))) {
        bucket[key] += n;
        day[key]    += n;
        any         += n;
      }
      bucket.total += any;
      if (any > 0) day.active.add(h);
    }
  };

  fold(resolvedRows, r => ({ resolved: Number(r.n) || 0 }));
  fold(msgRows,      r => ({ replies: Number(r.replies) || 0, notes: Number(r.notes) || 0 }));
  fold(actionRows,   r => ({ actions_closed: Number(r.n) || 0 }));

  const by_day = [...days.values()]
    .map(d => {
      const active = [...d.active].sort((a, b) => a - b);
      return {
        date: d.date,
        label: new Date(`${d.date}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
        active_hours: active.length,
        first_hour: active.length ? active[0] : null,
        last_hour:  active.length ? active[active.length - 1] : null,
        resolved: d.resolved, replies: d.replies,
        notes: d.notes, actions_closed: d.actions_closed,
      };
    })
    .filter(d => d.active_hours > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const sum = (k) => hours.reduce((n, h) => n + h[k], 0);
  const activeHours = hours.filter(h => h.total > 0);
  const daysActive = by_day.length;

  // Across a range this is the average over the days actually worked, not over
  // the calendar range — a week off shouldn't read as a shorter working day.
  const avgActive = daysActive
    ? Math.round((by_day.reduce((n, d) => n + d.active_hours, 0) / daysActive) * 10) / 10
    : 0;

  const peak = activeHours.reduce((best, h) => (!best || h.resolved > best.resolved ? h : best), null);

  return {
    range: { from: f.from, to: f.to, days: f.days },
    agent_id: f.agentId,
    hours,
    by_day,
    summary: {
      total_resolved: sum('resolved'),
      total_replies:  sum('replies'),
      total_notes:    sum('notes'),
      total_actions:  sum('actions_closed'),
      active_hours: avgActive,
      days_active:  daysActive,
      peak_hour:     peak?.resolved ? peak.hour     : null,
      peak_resolved: peak?.resolved ? peak.resolved : 0,
      first_hour: activeHours.length ? activeHours[0].hour : null,
      last_hour:  activeHours.length ? activeHours[activeHours.length - 1].hour : null,
    },
  };
}

// ── Live SLA backlog ────────────────────────────────────────────────────────

async function getSlaBacklog(f) {
  const w = threadWhere(f, { skipDate: true });
  const [openThreads] = await db.query(
    `SELECT t.id, t.subject, t.brand, t.customer_name, t.customer_email,
            t.ticket_id, t.priority, t.created_at, t.status
     FROM threads t WHERE t.status != 'resolved' AND ${w.sql}`, w.params
  );

  let on_track = 0, at_risk = 0, breach = 0;
  const breaching = [];

  for (const t of openThreads) {
    const sla = getSLAStatus(t.created_at, t.status);
    if (!sla) continue;
    if (sla.status === 'breached') {
      breach++;
      breaching.push({ ...t, sla_deadline: sla.deadline, elapsed_mins: sla.elapsed_mins, pct: sla.pct, sla_label: sla.label });
    } else if (sla.status === 'at_risk') at_risk++;
    else on_track++;
  }

  breaching.sort((a, b) => b.elapsed_mins - a.elapsed_mins);

  return {
    sla_target_minutes: SLA_BH_MINUTES,
    sla_description: 'Business hours: Mon–Sat 10 AM–8 PM IST. Outside hours → next business day 12 PM.',
    breach, at_risk, on_track,
    breaching_threads: breaching.slice(0, 10),
  };
}

// ── Row-level detail (export only) ──────────────────────────────────────────

async function getTicketRows(f) {
  const w = threadWhere(f, { dateCol: 'created_at' });
  const [rows] = await db.query(`
    SELECT t.ticket_id, t.brand, t.customer_name, t.customer_email,
           COALESCE(t.order_id_resolved, t.order_number) AS order_number,
           t.issue_category, t.sub_issue, t.priority, t.status,
           t.resolved_by, u.name AS resolved_by_user,
           t.created_at, t.resolved_at,
           t.first_response_minutes,
           CASE WHEN t.status='resolved' AND t.resolved_at IS NOT NULL
                THEN TIMESTAMPDIFF(MINUTE, t.created_at, t.resolved_at) END AS resolution_minutes
    FROM threads t LEFT JOIN users u ON u.id = t.resolved_by_user_id
    WHERE ${w.sql} ORDER BY t.created_at DESC
  `, w.params);
  return rows;
}

async function getActionRows(f) {
  const sql = [`DATE(a.created_at) BETWEEN ? AND ?`];
  const params = [f.from, f.to];
  if (f.brand)   { sql.push('t.brand = ?'); params.push(f.brand); }
  if (f.agentId) { sql.push('(a.created_by = ? OR a.closed_by = ?)'); params.push(f.agentId, f.agentId); }

  const [rows] = await db.query(`
    SELECT a.action_type, t.ticket_id, t.brand, t.customer_name,
           cu.name AS created_by_user, clu.name AS closed_by_user,
           a.is_closed, a.created_at, a.closed_at,
           ROUND(TIMESTAMPDIFF(HOUR, a.created_at, a.closed_at) / 24, 1) AS days_to_close
    FROM thread_actions a
      JOIN threads t ON t.id = a.thread_id
      LEFT JOIN users cu  ON cu.id  = a.created_by
      LEFT JOIN users clu ON clu.id = a.closed_by
    WHERE ${sql.join(' AND ')} ORDER BY a.created_at DESC
  `, params);
  return rows;
}

module.exports = {
  parseFilters,
  getOverview, getVolume, getResponseTime,
  getByBrand, getByIssue, getActionStats,
  getAgentStats, getResolvedByName, getSlaBacklog,
  getHourlyActivity,
  getTicketRows, getActionRows,
};
