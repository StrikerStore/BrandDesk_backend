/**
 * Multi-sheet .xlsx export for the analytics tab.
 *
 * Every figure comes from analyticsQueries, the same module the dashboard
 * endpoints use, so a downloaded workbook always agrees with the screen.
 */
const ExcelJS = require('exceljs');
const {
  getOverview, getByBrand, getByIssue, getActionStats,
  getAgentStats, getResolvedByName, getTicketRows, getActionRows,
} = require('./analyticsQueries');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
const TITLE_FONT  = { bold: true, size: 13 };
const DATE_FMT    = 'dd mmm yyyy hh:mm';

function styleHeader(sheet, rowNumber = 1) {
  const row = sheet.getRow(rowNumber);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = HEADER_FILL;
  row.alignment = { vertical: 'middle' };
  row.height = 20;
}

/** Freeze the header and size columns from their declared widths. */
function finishSheet(sheet, headerRow = 1) {
  styleHeader(sheet, headerRow);
  sheet.views = [{ state: 'frozen', ySplit: headerRow }];
}

const minsToHuman = (m) => {
  if (m === null || m === undefined || m === 0) return '—';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
};

const TYPE_LABELS = {
  exchange: 'Exchange', return: 'Return', alternate_product: 'Alternate Product',
  refund: 'Refund', change_size: 'Change Size', change_address: 'Change Address',
};

function workbookFilename(f) {
  const parts = ['BrandDesk', f.from, 'to', f.to];
  if (f.brand)   parts.push(f.brand.replace(/[^A-Za-z0-9]+/g, '-'));
  if (f.agentId) parts.push(`agent-${f.agentId}`);
  return `${parts.join('_')}.xlsx`;
}

async function buildWorkbook(f) {
  const [overview, byBrand, byIssue, actionStats, agents, resolvedByName, tickets, actionRows] = await Promise.all([
    getOverview(f), getByBrand(f), getByIssue(f), getActionStats(f),
    getAgentStats(f), getResolvedByName(f), getTicketRows(f), getActionRows(f),
  ]);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'BrandDesk';
  wb.created = new Date();

  // ── Summary ───────────────────────────────────────────────────────────────
  const s = wb.addWorksheet('Summary');
  s.columns = [{ width: 32 }, { width: 20 }, { width: 20 }, { width: 16 }, { width: 16 }, { width: 18 }];

  s.addRow(['BrandDesk analytics']).font = TITLE_FONT;
  s.addRow([]);
  s.addRow(['Filters applied']).font = { bold: true };
  s.addRow(['Date range', `${f.from} to ${f.to}`, `${f.days} day(s)`]);
  s.addRow(['Brand', f.brand || 'All brands']);
  s.addRow(['Agent', f.agentId ? (agents.find(a => a.user_id === f.agentId)?.name || `#${f.agentId}`) : 'All agents']);
  s.addRow(['Generated', new Date()]).getCell(2).numFmt = DATE_FMT;
  s.addRow([]);

  s.addRow(['Metric', 'This period', 'Previous period', 'Change']).font = { bold: true };
  const delta = (cur, prev) => (!prev ? '—' : `${cur >= prev ? '+' : ''}${Math.round(((cur - prev) / prev) * 100)}%`);
  s.addRow(['New tickets',        overview.range_new,      overview.prev_new,      delta(overview.range_new, overview.prev_new)]);
  s.addRow(['Resolved tickets',   overview.range_resolved, overview.prev_resolved, delta(overview.range_resolved, overview.prev_resolved)]);
  s.addRow(['Avg first response', minsToHuman(overview.range_avg_response_mins), minsToHuman(overview.prev_avg_response_mins),
            delta(overview.range_avg_response_mins, overview.prev_avg_response_mins)]);
  s.addRow(['Avg resolution time',    minsToHuman(overview.avg_resolution_mins)]);
  s.addRow(['Median resolution time', minsToHuman(overview.median_resolution_mins)]);
  s.addRow(['SLA compliance', overview.sla_compliance_pct === null ? '—' : `${overview.sla_compliance_pct}%`,
            `${overview.sla_within}/${overview.sla_measured} within 4 business hours`]);
  s.addRow([]);

  s.addRow(['Current backlog']).font = { bold: true };
  s.addRow(['Open', overview.open]);
  s.addRow(['In progress', overview.in_progress]);
  s.addRow(['Urgent', overview.urgent]);
  s.addRow(['Unread', overview.unread]);
  s.addRow(['Aging: under 1 day', overview.backlog_aging.under_1d]);
  s.addRow(['Aging: 1-3 days',    overview.backlog_aging.d1_3]);
  s.addRow(['Aging: 3-7 days',    overview.backlog_aging.d3_7]);
  s.addRow(['Aging: over 7 days', overview.backlog_aging.over_7d]);
  s.addRow([]);

  s.addRow(['By brand']).font = { bold: true };
  let r = s.addRow(['Brand', 'Total', 'Open', 'In progress', 'Resolved', 'Avg first response']);
  styleHeader(s, r.number);
  byBrand.forEach(b => s.addRow([b.brand, Number(b.total), Number(b.open), Number(b.in_progress), Number(b.resolved), minsToHuman(b.avg_response_mins)]));
  s.addRow([]);

  s.addRow(['By issue category']).font = { bold: true };
  r = s.addRow(['Category', 'Sub issue', 'Total', 'Resolved']);
  styleHeader(s, r.number);
  byIssue.forEach(cat => {
    s.addRow([cat.issue, '(all)', cat.total, cat.resolved]).font = { bold: true };
    cat.sub_issues.forEach(si => s.addRow(['', si.sub_issue, si.total, si.resolved]));
  });
  s.addRow([]);

  s.addRow(['By action type']).font = { bold: true };
  r = s.addRow(['Action', 'Total', 'Open', 'Closed', 'Avg days to close']);
  styleHeader(s, r.number);
  actionStats.forEach(a => s.addRow([
    TYPE_LABELS[a.action_type] || a.action_type, a.total, a.open, a.closed,
    a.avg_days_to_close === null ? '—' : a.avg_days_to_close,
  ]));

  s.views = [{ state: 'frozen', ySplit: 1 }];

  // ── Tickets ───────────────────────────────────────────────────────────────
  const t = wb.addWorksheet('Tickets');
  t.columns = [
    { header: 'Ticket ID',        key: 'ticket_id',    width: 24 },
    { header: 'Brand',            key: 'brand',        width: 16 },
    { header: 'Customer',         key: 'customer',     width: 24 },
    { header: 'Email',            key: 'email',        width: 28 },
    { header: 'Order',            key: 'order',        width: 14 },
    { header: 'Issue category',   key: 'category',     width: 30 },
    { header: 'Sub issue',        key: 'sub_issue',    width: 32 },
    { header: 'Priority',         key: 'priority',     width: 10 },
    { header: 'Status',           key: 'status',       width: 13 },
    { header: 'Resolved by',      key: 'resolved_by',  width: 18 },
    { header: 'Created',          key: 'created_at',   width: 20, style: { numFmt: DATE_FMT } },
    { header: 'Resolved',         key: 'resolved_at',  width: 20, style: { numFmt: DATE_FMT } },
    { header: 'First response (mins)', key: 'frt',     width: 20 },
    { header: 'Resolution (mins)',     key: 'rt',      width: 18 },
  ];
  tickets.forEach(row => t.addRow({
    ticket_id: row.ticket_id, brand: row.brand,
    customer: row.customer_name, email: row.customer_email, order: row.order_number,
    category: row.issue_category, sub_issue: row.sub_issue,
    priority: row.priority, status: row.status,
    // Prefer the joined user name; fall back to the free-text field for rows
    // predating attribution
    resolved_by: row.resolved_by_user || row.resolved_by || '',
    created_at: row.created_at ? new Date(row.created_at) : null,
    resolved_at: row.resolved_at ? new Date(row.resolved_at) : null,
    frt: row.first_response_minutes === null ? null : Number(row.first_response_minutes),
    rt:  row.resolution_minutes    === null ? null : Number(row.resolution_minutes),
  }));
  finishSheet(t);

  // ── Agents ────────────────────────────────────────────────────────────────
  const a = wb.addWorksheet('Agents');
  a.columns = [
    { header: 'Agent',                    key: 'name',     width: 24 },
    { header: 'Role',                     key: 'role',     width: 12 },
    { header: 'Tickets resolved',         key: 'resolved', width: 18 },
    { header: 'Replies sent',             key: 'replies',  width: 14 },
    { header: 'Notes added',              key: 'notes',    width: 14 },
    { header: 'Actions closed',           key: 'actions',  width: 16 },
    { header: 'Avg first response (mins)', key: 'frt',     width: 24 },
    { header: 'Avg resolution (mins)',     key: 'rt',      width: 22 },
  ];
  agents.forEach(row => a.addRow({
    name: row.name, role: row.role || '',
    resolved: row.resolved, replies: row.replies, notes: row.notes,
    actions: row.actions_closed,
    frt: row.avg_response_mins || null,
    rt:  row.avg_resolution_mins || null,
  }));
  finishSheet(a);

  // ── Resolved by (name) ────────────────────────────────────────────────────
  // Grouped on the typed name, so this covers the full history
  const rb = wb.addWorksheet('Resolved by');
  rb.columns = [
    { header: 'Resolved by (name entered)', key: 'name',     width: 28 },
    { header: 'Tickets resolved',           key: 'total',    width: 18 },
    { header: 'Name variants merged',       key: 'variants', width: 22 },
    { header: 'Avg first response (mins)',  key: 'frt',      width: 24 },
    { header: 'Avg resolution (mins)',      key: 'rt',       width: 22 },
  ];
  resolvedByName.forEach(row => rb.addRow({
    name: row.is_system ? 'system (auto-resolved)' : row.name,
    total: row.total,
    variants: row.variants > 1 ? row.variants : '',
    frt: row.avg_response_mins || null,
    rt:  row.avg_resolution_mins || null,
  }));
  finishSheet(rb);

  // ── Actions ───────────────────────────────────────────────────────────────
  const ac = wb.addWorksheet('Actions');
  ac.columns = [
    { header: 'Action type',   key: 'type',       width: 20 },
    { header: 'Ticket ID',     key: 'ticket_id',  width: 24 },
    { header: 'Brand',         key: 'brand',      width: 16 },
    { header: 'Customer',      key: 'customer',   width: 24 },
    { header: 'Opened by',     key: 'created_by', width: 18 },
    { header: 'Closed by',     key: 'closed_by',  width: 18 },
    { header: 'Status',        key: 'status',     width: 12 },
    { header: 'Opened',        key: 'created_at', width: 20, style: { numFmt: DATE_FMT } },
    { header: 'Closed',        key: 'closed_at',  width: 20, style: { numFmt: DATE_FMT } },
    { header: 'Days to close', key: 'days',       width: 14 },
  ];
  actionRows.forEach(row => ac.addRow({
    type: TYPE_LABELS[row.action_type] || row.action_type,
    ticket_id: row.ticket_id, brand: row.brand, customer: row.customer_name,
    created_by: row.created_by_user || '', closed_by: row.closed_by_user || '',
    status: row.is_closed ? 'Closed' : 'Open',
    created_at: row.created_at ? new Date(row.created_at) : null,
    closed_at:  row.closed_at  ? new Date(row.closed_at)  : null,
    days: row.days_to_close === null ? null : Number(row.days_to_close),
  }));
  finishSheet(ac);

  return wb;
}

module.exports = { buildWorkbook, workbookFilename };
