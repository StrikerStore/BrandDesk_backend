/**
 * Order-number normalisation.
 *
 * Customers type the same order every which way — "DS4334", "#DS4334",
 * "Order #DS4334", "ds 4334", "4334" — while the OMS only knows the canonical
 * "DS4334". This is the single place that cleanup happens; everything else
 * (lookup, search, manual correction) goes through here.
 *
 * Order data lives in a separate read-only database, so nothing can be fixed
 * on the storage side — only on the way we query it.
 */

// Leading noise words customers put in front of the actual id
const LEAD_NOISE = /^(?:order\s*(?:number|no\.?|id)?|ord\.?|#|:|-)\s*/i;

/**
 * @param {string} raw
 * @returns {{ cleaned: string, digits: string|null, prefix: string|null }}
 *   cleaned — uppercased id with noise stripped, '' if nothing usable
 *   digits  — the trailing digit run, guaranteed /^\d+$/ or null
 *   prefix  — leading letters, or null
 */
function normalizeOrderInput(raw) {
  const empty = { cleaned: '', digits: null, prefix: null };
  if (raw === null || raw === undefined) return empty;

  let s = String(raw).trim();
  if (!s) return empty;

  // Peel repeatedly: "Order #DS4334" and "order no: #4334" both need two passes
  let previous;
  do {
    previous = s;
    s = s.replace(LEAD_NOISE, '').trim();
  } while (s !== previous && s);

  // Drop anything that isn't part of an id. '_' survives because split
  // shipments are DS4334_1, DS4334_2 and must stay addressable.
  s = s.replace(/[^A-Za-z0-9_]/g, '').toUpperCase();
  if (!s) return empty;

  // Trailing digit run — the part that identifies the order regardless of
  // which prefix (if any) the customer remembered. Ignores any _N suffix.
  const base = s.split('_')[0];
  const m = base.match(/^([A-Z]*)(\d+)$/);

  return {
    cleaned: s,
    // Only expose digits when the base is a clean prefix+number. Anything
    // messier is not safe to pattern-match on.
    digits: m ? m[2] : null,
    prefix: m && m[1] ? m[1] : null,
  };
}

/**
 * Display form for the UI. Several places render `#{order_number}`, which
 * doubles up to "##DS4334" when the stored value already carries a hash.
 * Callers add their own '#'; this just guarantees there isn't one already.
 */
function displayOrderId(raw) {
  if (!raw) return '';
  const { cleaned } = normalizeOrderInput(raw);
  return cleaned || String(raw).trim();
}

/** Leading zeros are cosmetic — "04334" and "4334" are the same order. */
function sameDigits(a, b) {
  if (!a || !b) return false;
  return String(a).replace(/^0+/, '') === String(b).replace(/^0+/, '');
}

module.exports = { normalizeOrderInput, displayOrderId, sameDigits };
