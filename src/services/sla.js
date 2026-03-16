/**
 * Business Hours SLA Calculator
 *
 * Business hours: Monday–Saturday, 10:00 AM – 8:00 PM IST (UTC+5:30)
 * Sunday: off
 *
 * Rules:
 * - Ticket arrives during business hours → SLA deadline = created_at + 4 business hours
 * - Ticket arrives outside business hours → SLA deadline = next business day 12:00 PM IST
 * - SLA time only counts during business hours (minutes ticking overnight don't count)
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // UTC+5:30

const BH_START = 10; // 10 AM IST
const BH_END   = 20; // 8 PM IST
const SLA_BH_MINUTES = 4 * 60; // 4 business hours = 240 mins

// Convert UTC Date to IST Date object
function toIST(utcDate) {
  return new Date(utcDate.getTime() + IST_OFFSET_MS);
}

// Get IST midnight (start of day) as UTC
function istMidnightUTC(istDate) {
  const d = new Date(istDate);
  d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() - IST_OFFSET_MS);
}

// Is a given IST date a business day (Mon–Sat)?
function isBusinessDay(istDate) {
  const day = istDate.getDay(); // 0=Sun, 6=Sat
  return day !== 0; // Sunday off
}

// Is a given UTC timestamp within business hours?
function isInBusinessHours(utcDate) {
  const ist = toIST(utcDate);
  const hour = ist.getHours() + ist.getMinutes() / 60;
  return isBusinessDay(ist) && hour >= BH_START && hour < BH_END;
}

// Add N business-hours minutes to a UTC timestamp
// Returns the UTC deadline
function addBusinessMinutes(utcStart, minutes) {
  let remaining = minutes;
  let current = new Date(utcStart);

  while (remaining > 0) {
    const ist = toIST(current);
    const dayOfWeek = ist.getDay();
    const hourIST = ist.getHours() + ist.getMinutes() / 60 + ist.getSeconds() / 3600;

    if (!isBusinessDay(ist) || hourIST >= BH_END) {
      // Skip to next business day 10 AM IST
      current = nextBusinessDayStart(current);
      continue;
    }

    if (hourIST < BH_START) {
      // Skip to today's 10 AM IST
      const ist = toIST(current);
      ist.setHours(BH_START, 0, 0, 0);
      current = new Date(ist.getTime() - IST_OFFSET_MS);
      continue;
    }

    // We're in business hours — how many minutes until end of day?
    const minsUntilEOD = (BH_END - hourIST) * 60;
    if (remaining <= minsUntilEOD) {
      current = new Date(current.getTime() + remaining * 60000);
      remaining = 0;
    } else {
      remaining -= minsUntilEOD;
      // Move to next business day
      current = nextBusinessDayStart(current);
    }
  }

  return current;
}

// Get the next business day's 10 AM IST as a UTC date
function nextBusinessDayStart(utcDate) {
  const ist = toIST(utcDate);
  ist.setDate(ist.getDate() + 1);
  ist.setHours(BH_START, 0, 0, 0);
  // Skip Sundays
  while (ist.getDay() === 0) {
    ist.setDate(ist.getDate() + 1);
  }
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

// Get next business day 12 PM IST as UTC
function nextBusinessDayNoon(utcDate) {
  const ist = toIST(utcDate);
  ist.setDate(ist.getDate() + 1);
  ist.setHours(12, 0, 0, 0);
  while (ist.getDay() === 0) {
    ist.setDate(ist.getDate() + 1);
  }
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

/**
 * Calculate the SLA deadline for a ticket.
 * @param {Date} createdAt - UTC timestamp when ticket was created
 * @returns {Date} - UTC deadline
 */
function calculateSLADeadline(createdAt) {
  const created = new Date(createdAt);

  if (isInBusinessHours(created)) {
    // During business hours → 4 business hours from now
    return addBusinessMinutes(created, SLA_BH_MINUTES);
  } else {
    // Outside business hours → next business day 12 PM IST
    return nextBusinessDayNoon(created);
  }
}

/**
 * Calculate how many business minutes have elapsed since ticket was created.
 * Used for "time elapsed" display.
 */
function businessMinutesElapsed(utcStart) {
  const start = new Date(utcStart);
  const now   = new Date();
  let elapsed = 0;
  let current = new Date(start);

  // Cap at 30 days to avoid infinite loops
  const cap = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);

  while (current < now && current < cap) {
    if (isInBusinessHours(current)) {
      const ist = toIST(current);
      const hourIST = ist.getHours() + ist.getMinutes() / 60;
      const minsUntilEOD = (BH_END - hourIST) * 60;
      const minsUntilNow = (now - current) / 60000;
      const chunk = Math.min(minsUntilEOD, minsUntilNow, 1);
      elapsed += chunk;
      current = new Date(current.getTime() + chunk * 60000);
    } else {
      // Jump to next business hours start
      current = nextBusinessDayStart(current);
    }
  }

  return Math.floor(elapsed);
}

/**
 * Get SLA status for a thread.
 * @param {Date} createdAt
 * @param {string} status - thread status
 * @returns {{ deadline, elapsed_mins, remaining_mins, pct, status: 'on_track'|'at_risk'|'breached', label }}
 */
function getSLAStatus(createdAt, threadStatus) {
  if (threadStatus === 'resolved') return null;

  const deadline = calculateSLADeadline(new Date(createdAt));
  const now = new Date();
  const totalMins = SLA_BH_MINUTES;
  const elapsed = businessMinutesElapsed(createdAt);
  const remaining = Math.max(0, (deadline - now) / 60000);
  const pct = Math.min(100, Math.round((elapsed / totalMins) * 100));

  let slaStatus;
  if (now > deadline)        slaStatus = 'breached';
  else if (pct >= 75)        slaStatus = 'at_risk';
  else                       slaStatus = 'on_track';

  // Human-readable remaining time
  let label;
  if (slaStatus === 'breached') {
    const overMins = Math.floor((now - deadline) / 60000);
    label = `Overdue by ${formatDuration(overMins)}`;
  } else {
    label = `${formatDuration(Math.floor(remaining))} left`;
  }

  return { deadline, elapsed_mins: elapsed, remaining_mins: Math.floor(remaining), pct, status: slaStatus, label };
}

function formatDuration(mins) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

module.exports = { calculateSLADeadline, getSLAStatus, isInBusinessHours, businessMinutesElapsed };