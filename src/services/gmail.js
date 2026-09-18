const { google } = require('googleapis');
const db = require('../config/db');
const { parseShopifyEmail, buildChatBody } = require('./emailParser');

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

const crypto = require('crypto');

function getAuthUrl() {
  const client = createOAuthClient();
  const state = crypto.randomBytes(32).toString('hex');
  // Store state for verification in callback
  getAuthUrl._pendingState = state;
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    state,
    scope: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
  });
}

function getAndClearOAuthState() {
  const state = getAuthUrl._pendingState;
  getAuthUrl._pendingState = null;
  return state;
}

async function getStoredTokens() {
  const [rows] = await db.query('SELECT * FROM auth_tokens LIMIT 1');
  return rows[0] || null;
}

async function getAuthenticatedClient() {
  const tokens = await getStoredTokens();
  if (!tokens) throw new Error('Not authenticated — visit /auth/google to connect Gmail');

  const client = createOAuthClient();
  client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
  });

  // Auto-refresh if expired
  client.on('tokens', async (newTokens) => {
    await db.query(
      'UPDATE auth_tokens SET access_token=?, expiry_date=? WHERE email=?',
      [newTokens.access_token, newTokens.expiry_date, tokens.email]
    );
  });

  return client;
}

// Decode base64url Gmail message body
function decodeBody(data) {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

// Extract plain text or HTML from message payload
function extractBody(payload) {
  let text = '';
  let html = '';

  function walk(part) {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body?.data) {
      text = decodeBody(part.body.data);
    }
    if (part.mimeType === 'text/html' && part.body?.data) {
      html = decodeBody(part.body.data);
    }
    if (part.parts) part.parts.forEach(walk);
  }

  walk(payload);
  return { text, html };
}

function getHeader(headers, name) {
  const h = headers?.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

// Strip quoted reply text from email body
function stripQuoted(text) {
  const lines = text.split('\n');
  const cutoff = lines.findIndex(l =>
    l.startsWith('On ') && l.includes('wrote:') ||
    l.trim().startsWith('-----Original Message-----') ||
    l.trim().startsWith('From:') && lines.indexOf(l) > 5
  );
  return cutoff > 0 ? lines.slice(0, cutoff).join('\n').trim() : text.trim();
}

// How far back the incremental sync looks, in minutes. The window has to
// absorb clock skew between Gmail and us plus anything a failed run missed;
// Gmail volume here is tens of mails a day, so a wide window is cheap.
const SYNC_LOOKBACK_MINUTES = parseInt(process.env.SYNC_LOOKBACK_MINUTES || '60');

// Resume point for the incremental sync, as Unix epoch SECONDS.
//
// Anchored on the newest inbound mail we actually hold for the brand, not on
// threads.updated_at. updated_at carries every local write — opening a ticket
// clears is_unread, a status change, an order-id edit — so it tracked agent
// activity rather than mail, and dragged the `after:` window forward past mail
// that had not been fetched yet. A reply that landed in that gap fell outside
// the window on the next run and was never looked at again.
//
// Returned as epoch seconds straight from MySQL. The old expression wrapped
// the columns in GREATEST(..., 0), which collapsed the TIMESTAMPs to a string
// and defeated the driver's date parsing; `new Date('2026-09-18 15:05:00')`
// then parsed as LOCAL time, shifting the window by the server's UTC offset.
async function getLastSyncTime(brandName) {
  const [rows] = await db.query(
    `SELECT UNIX_TIMESTAMP(MAX(m.sent_at)) AS last_epoch
       FROM messages m
       JOIN threads t ON t.id = m.thread_id
      WHERE t.brand = ? AND m.direction = 'inbound'`,
    [brandName]
  );
  const epoch = Number(rows[0]?.last_epoch);
  // NULL (no inbound mail for this brand yet) → caller does a full sync
  return Number.isFinite(epoch) && epoch > 0 ? epoch : null;
}

// Page through threads.list for one query, up to `max` thread ids.
async function listThreadIds(gmail, q, max) {
  const ids = [];
  let pageToken = undefined;

  do {
    const listRes = await gmail.users.threads.list({
      userId: 'me',
      q,
      maxResults: Math.min(max - ids.length, 100),
      ...(pageToken ? { pageToken } : {}),
    });

    ids.push(...(listRes.data.threads || []).map(t => t.id));
    pageToken = listRes.data.nextPageToken;

  } while (pageToken && ids.length < max);

  return ids;
}

// Incremental sync — only fetch threads newer than what we already have
// Falls back to full sync if DB is empty for that brand
async function syncThreads(fullSync = false) {
  const { getBrands } = require('../config/brands');
  const auth = await getAuthenticatedClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const brands = getBrands();

  let newThreads = 0;
  let updatedThreads = 0;

  for (const brand of brands) {
    try {
      const lastSync = fullSync ? null : await getLastSyncTime(brand.name);
      const after = lastSync ? ` after:${lastSync - SYNC_LOOKBACK_MINUTES * 60}` : '';
      const maxToFetch = fullSync ? 500 : 100;

      // Query 1 — the brand label. This is what opens new tickets.
      //
      // The label is quoted: real labels contain spaces ("Customer ticket/
      // Dribble Ticket"), and unquoted those parse as separate search terms.
      const labelled = await listThreadIds(
        gmail, `label:${JSON.stringify(brand.label)}${after}`, maxToFetch
      );

      // Query 2 — mail addressed to the brand, regardless of label.
      //
      // Gmail applies the ticket label via a filter on the Shopify form
      // notification, so only the FIRST message of a thread carries it. A
      // customer's reply arrives straight from their own address and is
      // labelled INBOX/CATEGORY_PERSONAL and nothing else.
      //
      // `label:X after:T` needs ONE message to satisfy both halves, and no
      // message ever does: the labelled one is too old, the recent one is
      // unlabelled. So replies on existing tickets were invisible to this
      // sync — new tickets kept arriving while every reply was dropped.
      const addressed = await listThreadIds(
        gmail, `(to:${brand.email} OR cc:${brand.email})${after}`, maxToFetch
      );

      const labelledSet = new Set(labelled);
      const threadIds = [...labelled, ...addressed.filter(id => !labelledSet.has(id))];
      if (threadIds.length === 0) continue;

      console.log(`📥 ${brand.name}: ${labelled.length} labelled + ${threadIds.length - labelled.length} addressed`);

      for (const gmailThreadId of threadIds) {
        const [existing] = await db.query(
          'SELECT id, brand FROM threads WHERE gmail_thread_id = ?',
          [gmailThreadId]
        );
        const isNew = existing.length === 0;

        // Query 2 is deliberately broad, so it must not open tickets on its
        // own — anything reaching a brand address would become one. It only
        // tops up threads we already track. New tickets still come from the
        // label, which is what decides a mail is a ticket in the first place.
        if (isNew && !labelledSet.has(gmailThreadId)) continue;

        // A thread can match another brand's address (an agent looped one in).
        // Processing it under this brand would rewrite the wrong ticket.
        if (!isNew && existing[0].brand !== brand.name) continue;

        await processThread(gmail, gmailThreadId, brand);
        if (isNew) newThreads++;
        else updatedThreads++;
      }

    } catch (err) {
      console.error(`Error syncing brand ${brand.name}:`, err.message);
    }
  }

  const summary = `📬 Sync complete — ${newThreads} new, ${updatedThreads} updated`;
  console.log(summary);
  return { newThreads, updatedThreads, total: newThreads + updatedThreads };
}

async function processThread(gmail, gmailThreadId, brand) {
  const [existing] = await db.query(
    'SELECT id, status FROM threads WHERE gmail_thread_id = ?',
    [gmailThreadId]
  );

  const threadRes = await gmail.users.threads.get({
    userId: 'me',
    id: gmailThreadId,
    format: 'full',
  });

  const gmailThread = threadRes.data;
  const messages = gmailThread.messages || [];
  if (!messages.length) return;

  const firstMsg = messages[0];
  const headers = firstMsg.payload?.headers || [];
  const subject = getHeader(headers, 'Subject') || '(No subject)';
  const fromRaw = getHeader(headers, 'From');
  const replyTo = getHeader(headers, 'Reply-To');
  const sentAt = new Date(parseInt(firstMsg.internalDate));

  // Extract raw body of first message
  const { text: rawText, html: rawHtml } = extractBody(firstMsg.payload);
  const rawBody = rawText || rawHtml.replace(/<[^>]+>/g, '');

  // Try to parse as Shopify contact form
  const parsed = parseShopifyEmail(fromRaw, replyTo, rawBody);

  // Resolve customer info — prefer parsed data over raw From header
  let customerEmail, customerName, customerPhone, customerCountry;
  let orderNumber, issueCategory, subIssue, ticketId, isShopifyForm;

  if (parsed) {
    customerEmail   = parsed.customerEmail;
    customerName    = parsed.customerName;
    customerPhone   = parsed.customerPhone;
    customerCountry = parsed.customerCountry;
    orderNumber     = parsed.orderNumber;
    issueCategory   = parsed.issueCategory;
    subIssue        = parsed.subIssue;
    ticketId        = parsed.ticketId;
    isShopifyForm   = true;
  } else {
    // Non-Shopify email — use From header normally
    // But clean up Shopify sender names like "Store Name (Shopify)"
    const fromMatch = fromRaw.match(/^(.*?)\s*<(.+?)>$/) || [null, fromRaw, fromRaw];
    let rawName = fromMatch[1]?.trim().replace(/"/g, '') || '';
    // Strip "(Shopify)" suffix from store-generated sender names
    rawName = rawName.replace(/\s*\(Shopify\)\s*/i, '').trim();
    customerName  = rawName || null;
    customerEmail = fromMatch[2]?.trim() || fromRaw;
    isShopifyForm = false;
  }

  // Build a set of all email addresses that belong to "us" —
  // brand emails + admin Gmail + any other configured sender addresses.
  // This fixes direction detection when replying from admin Gmail directly.
  function isOurEmail(emailStr) {
    if (!emailStr) return false;
    const lower = emailStr.toLowerCase();
    const { getBrands } = require('../config/brands');
    const allBrands = getBrands();

    // Check all brand emails
    if (allBrands.some(b => lower.includes(b.email.toLowerCase()))) return true;

    // Check admin Gmail (the account we authenticated with)
    const adminEmail = process.env.ADMIN_EMAIL || '';
    if (adminEmail && lower.includes(adminEmail.toLowerCase())) return true;

    // Fallback: check GOOGLE_REDIRECT_URI domain or anything @plexzuu.com
    // Pull the domain from any brand email as a heuristic
    const brandDomains = [...new Set(allBrands.map(b => b.email.split('@')[1]).filter(Boolean))];
    if (brandDomains.some(domain => lower.includes(`@${domain}`))) return true;

    return false;
  }

  // Check if last message is from customer (unread)
  const lastMsg = messages[messages.length - 1];
  const lastFrom = getHeader(lastMsg.payload?.headers || [], 'From');
  const isUnread = !isOurEmail(lastFrom);

  let threadId;

  if (existing.length) {
    threadId = existing[0].id;
    await db.query(
      `UPDATE threads SET
        is_unread=?, updated_at=NOW(),
        ticket_id=COALESCE(ticket_id, ?),
        order_number=COALESCE(order_number, ?),
        issue_category=COALESCE(issue_category, ?),
        sub_issue=COALESCE(sub_issue, ?),
        customer_phone=COALESCE(customer_phone, ?),
        customer_country=COALESCE(customer_country, ?)
       WHERE id=?`,
      [isUnread ? 1 : 0, ticketId, orderNumber, issueCategory, subIssue,
       customerPhone, customerCountry, existing[0].id]
    );
    threadId = existing[0].id;

    // Auto-reopen: resolved ticket gets a customer reply → move back to in_progress
    if (isUnread && existing[0].status === 'resolved') {
      await db.query(
        "UPDATE threads SET status='in_progress', status_changed_at=NOW() WHERE id=?",
        [existing[0].id]
      );
      await db.query(
        `INSERT INTO messages (thread_id, direction, from_email, body, is_note, sent_at)
         VALUES (?, 'outbound', 'system', '🔄 Ticket reopened — customer replied after resolution.', 1, NOW())`,
        [existing[0].id]
      );
    }
  } else {
    const [result] = await db.query(
      `INSERT INTO threads 
        (gmail_thread_id, subject, brand, brand_email, customer_email, customer_name,
         is_unread, is_shopify_form, ticket_id, order_number, issue_category,
         sub_issue, customer_phone, customer_country, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gmailThreadId, subject, brand.name, brand.email, customerEmail, customerName,
       isUnread ? 1 : 0, isShopifyForm ? 1 : 0, ticketId || null, orderNumber || null,
       issueCategory || null, subIssue || null, customerPhone || null, customerCountry || null, sentAt]
    );
    threadId = result.insertId;

    // Upsert customer with phone
    await db.query(
      `INSERT INTO customers (email, name, phone) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name  = IF(name  IS NULL OR name='',  VALUES(name),  name),
         phone = IF(phone IS NULL OR phone='', VALUES(phone), phone)`,
      [customerEmail, customerName || '', customerPhone || null]
    );
  }

  // Sync messages — parse ONLY the first message (Shopify form)
  // All subsequent messages are plain replies — no form parsing needed
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isFirstMessage = i === 0;

    const [msgExisting] = await db.query(
      'SELECT id FROM messages WHERE gmail_message_id = ?',
      [msg.id]
    );
    if (msgExisting.length) continue;

    const msgHeaders = msg.payload?.headers || [];
    const from       = getHeader(msgHeaders, 'From');
    const direction  = msg.labelIds?.includes('SENT') ? 'outbound' : 'inbound';
    const { text, html } = extractBody(msg.payload);
    const rawMsgBody = text || html.replace(/<[^>]+>/g, '');
    const msgDate    = new Date(parseInt(msg.internalDate));

    let displayBody;

    if (isFirstMessage && direction === 'inbound') {
      // First message — try Shopify form parse for clean display
      const msgReplyTo = getHeader(msgHeaders, 'Reply-To');
      const msgParsed  = parseShopifyEmail(from, msgReplyTo, rawMsgBody);
      displayBody = msgParsed ? buildChatBody(msgParsed) : stripQuoted(rawMsgBody);
    } else {
      // All reply messages — just strip quoted text, no form parsing
      displayBody = stripQuoted(rawMsgBody);
    }

    await db.query(
      `INSERT IGNORE INTO messages (thread_id, gmail_message_id, direction, from_email, body, body_html, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [threadId, msg.id, direction, from, displayBody, html, msgDate]
    );
    // Store image attachments
    const [msgRow] = await db.query('SELECT id FROM messages WHERE gmail_message_id = ?', [msg.id]);
    if (msgRow.length) {
      const parts = msg.payload?.parts || [];
      for (const part of parts) {
        const isImage = part.mimeType?.startsWith('image/');
        const attachmentId = part.body?.attachmentId;
        const filename = part.filename;
        if (isImage && attachmentId && filename) {
          await db.query(
            `INSERT IGNORE INTO attachments (message_id, gmail_message_id, attachment_id, filename, mime_type, size)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [msgRow[0].id, msg.id, attachmentId, filename, part.mimeType, part.body?.size || 0]
          );
        }
      }
    }
  }
}

// userId attributes the message to an agent for analytics. Leave null for
// system sends (auto-ack, auto-resolve) — they must not be credited to anyone.
async function sendReply(gmailThreadId, body, brand, isNote = false, attachments = [], userId = null) {
  if (isNote) {
    // Internal notes are stored only, not sent
    const [thread] = await db.query('SELECT id FROM threads WHERE gmail_thread_id=?', [gmailThreadId]);
    if (!thread.length) throw new Error('Thread not found');
    await db.query(
      `INSERT INTO messages (thread_id, direction, from_email, body, is_note, user_id, sent_at)
       VALUES (?, 'outbound', ?, ?, 1, ?, NOW())`,
      [thread[0].id, brand.email, body, userId]
    );
    return { success: true, note: true };
  }

  const auth = await getAuthenticatedClient();
  const gmail = google.gmail({ version: 'v1', auth });

  // Get thread to find last message ID and customer email
  const [threadRows] = await db.query(
    'SELECT * FROM threads WHERE gmail_thread_id=?',
    [gmailThreadId]
  );
  if (!threadRows.length) throw new Error('Thread not found');
  const thread = threadRows[0];

  // Build email
  const to = thread.customer_email;
  const subject = thread.subject.startsWith('Re:') ? thread.subject : `Re: ${thread.subject}`;

  // Helper: split base64 into 76-char lines (MIME spec)
  const chunkBase64 = (b64) => b64.match(/.{1,76}/g).join('\r\n');

  let raw;
  if (attachments && attachments.length > 0) {
    const boundary = `----=_Part_${Date.now()}`;
    const bodyB64 = chunkBase64(Buffer.from(body).toString('base64'));
    const parts = [
      `From: ${brand.name} Support <${brand.email}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `In-Reply-To: ${gmailThreadId}`,
      `References: ${gmailThreadId}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      bodyB64,
    ];
    for (const file of attachments) {
      const fileB64 = chunkBase64(file.buffer.toString('base64'));
      parts.push(`--${boundary}`);
      parts.push(`Content-Type: ${file.mimetype}; name="${file.originalname}"`);
      parts.push('Content-Transfer-Encoding: base64');
      parts.push(`Content-Disposition: attachment; filename="${file.originalname}"`);
      parts.push('');
      parts.push(fileB64);
    }
    parts.push(`--${boundary}--`);
    raw = Buffer.from(parts.join('\r\n'))
      .toString('base64url');
  } else {
    const emailLines = [
      `From: ${brand.name} Support <${brand.email}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `In-Reply-To: ${gmailThreadId}`,
      `References: ${gmailThreadId}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      body,
    ];
    raw = Buffer.from(emailLines.join('\r\n'))
      .toString('base64url');
  }

  const sendRes = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId: gmailThreadId },
  });

  // Save to messages table
  const [threadRow] = await db.query('SELECT id, status FROM threads WHERE gmail_thread_id=?', [gmailThreadId]);
  if (threadRow.length) {
    await db.query(
      `INSERT INTO messages (thread_id, gmail_message_id, direction, from_email, body, user_id, sent_at)
       VALUES (?, ?, 'outbound', ?, ?, ?, NOW())`,
      [threadRow[0].id, sendRes.data.id, brand.email, body, userId]
    );

    // Auto-advance status: open → in_progress on first reply
    if (threadRow[0].status === 'open') {
      const [msgCount] = await db.query(
        "SELECT COUNT(*) as cnt FROM messages WHERE thread_id=? AND direction='outbound' AND is_note=0",
        [threadRow[0].id]
      );
      if (msgCount[0].cnt === 1) {
        await db.query("UPDATE threads SET status='in_progress' WHERE id=?", [threadRow[0].id]);

        // Record first response time
        const [firstMsg] = await db.query(
          'SELECT sent_at FROM messages WHERE thread_id=? AND direction="inbound" ORDER BY sent_at ASC LIMIT 1',
          [threadRow[0].id]
        );
        if (firstMsg.length) {
          const mins = Math.round((Date.now() - new Date(firstMsg[0].sent_at).getTime()) / 60000);
          await db.query('UPDATE threads SET first_response_minutes=? WHERE id=?', [mins, threadRow[0].id]);
        }
      }
    }
  }

  return { success: true, messageId: sendRes.data.id };
}

async function sendInitialEmail(customerEmail, subject, body, brand, ticketId) {
  console.log('[sendInitialEmail] START — to:', customerEmail, '| subject:', subject, '| ticketId:', ticketId);
  console.log('[sendInitialEmail] brand:', JSON.stringify({ name: brand?.name, email: brand?.email, label: brand?.label }));

  let auth;
  try {
    auth = await getAuthenticatedClient();
    console.log('[sendInitialEmail] Gmail auth OK');
  } catch (authErr) {
    console.error('[sendInitialEmail] AUTH FAILED:', authErr.message);
    throw authErr;
  }

  const gmail = google.gmail({ version: 'v1', auth });

  const htmlBody = [
    `<div style="font-family:sans-serif;color:#1a1a1a;line-height:1.6;">`,
    body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'),
    `</div>`,
    `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">`,
    `Ticket Reference: ${ticketId}`,
    `</div>`,
  ].join('');

  const chunkBase64 = (b64) => b64.match(/.{1,76}/g).join('\r\n');
  const bodyB64 = chunkBase64(Buffer.from(htmlBody).toString('base64'));

  const emailLines = [
    `From: ${brand.name} Support <${brand.email}>`,
    `To: ${customerEmail}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    bodyB64,
  ];
  const raw = Buffer.from(emailLines.join('\r\n')).toString('base64url');

  console.log('[sendInitialEmail] Calling Gmail API send...');
  let sendRes;
  try {
    sendRes = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });
    console.log('[sendInitialEmail] Gmail API response status:', sendRes.status);
    console.log('[sendInitialEmail] Gmail messageId:', sendRes.data?.id, '| threadId:', sendRes.data?.threadId);
  } catch (sendErr) {
    console.error('[sendInitialEmail] GMAIL SEND FAILED:', sendErr.message);
    console.error('[sendInitialEmail] Gmail error details:', JSON.stringify(sendErr.response?.data || sendErr.errors || {}));
    throw sendErr;
  }

  return {
    gmailThreadId: sendRes.data.threadId,
    gmailMessageId: sendRes.data.id,
  };
}

// ── Gmail Push Notifications (Pub/Sub) ───────────────────────

// Why this is tracked: the history watermark silently stopped advancing and
// stayed stuck for two weeks. The poll kept running, every failure went to
// console.error, and nothing downstream noticed — new tickets still arrived
// via the 5-minute label sync, so the tool looked healthy while every customer
// reply was being dropped. /health reads this so a stuck poll is visible.
const syncHealth = {
  lastHistorySyncAt: null,
  lastHistoryOkAt: null,
  lastHistoryError: null,
  consecutiveHistoryFailures: 0,
  lastWatermarkAdvanceAt: null,
  storedHistoryId: null,
};

function getSyncHealth() {
  const staleMs = syncHealth.lastWatermarkAdvanceAt
    ? Date.now() - syncHealth.lastWatermarkAdvanceAt
    : null;
  return {
    ...syncHealth,
    watermarkStaleMinutes: staleMs === null ? null : Math.round(staleMs / 60000),
    // The poll runs every 15s. Nothing advancing for 30 minutes means it is
    // wedged, not quiet — history.list returns the mailbox's current id on
    // every call, so the watermark moves even when no mail arrived.
    healthy: syncHealth.consecutiveHistoryFailures === 0 &&
             (staleMs === null || staleMs < 30 * 60 * 1000),
  };
}

async function getStoredHistoryId() {
  const [rows] = await db.query('SELECT history_id FROM auth_tokens LIMIT 1');
  return rows[0]?.history_id || null;
}

async function saveHistoryId(historyId) {
  const [res] = await db.query('UPDATE auth_tokens SET history_id = ?', [historyId]);
  // No row means there is no token record to hang the watermark on, so the
  // next poll re-reads the same stale id and the sync never moves forward.
  if (!res.affectedRows) throw new Error('saveHistoryId: no auth_tokens row to update');
  syncHealth.storedHistoryId = String(historyId);
  syncHealth.lastWatermarkAdvanceAt = Date.now();
}

/**
 * Re-anchor the watermark on the mailbox's current historyId. Used whenever
 * the stored one can no longer be resumed from.
 */
async function resetHistoryBaseline() {
  const auth = await getAuthenticatedClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  if (!profile.data.historyId) throw new Error('profile returned no historyId');
  await saveHistoryId(profile.data.historyId);
  console.log(`📡 History baseline reset to ${profile.data.historyId}`);
  return profile.data.historyId;
}

/**
 * Seed the history_id on startup so history polling has a baseline.
 * Calls Gmail profile to get the current historyId.
 */
async function seedHistoryId() {
  const stored = await getStoredHistoryId();
  if (stored) return; // already have a baseline

  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const historyId = profile.data.historyId;
    if (historyId) {
      await saveHistoryId(historyId);
      console.log(`📡 History baseline seeded: ${historyId}`);
    }
  } catch (err) {
    console.error('Failed to seed historyId:', err.message);
  }
}

/**
 * Register Gmail mailbox for push notifications via Google Pub/Sub.
 * Requires env: GOOGLE_PUBSUB_TOPIC (e.g. projects/my-project/topics/gmail-push)
 * Must be called on startup and renewed every ~24h (watch expires in 7 days).
 */
async function watchMailbox() {
  const topic = process.env.GOOGLE_PUBSUB_TOPIC;
  if (!topic) {
    console.log('⚠️  GOOGLE_PUBSUB_TOPIC not set — Gmail push disabled, using polling only');
    return null;
  }

  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });

    const res = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: topic,
        labelFilterAction: 'include',
        labelIds: ['INBOX'],
      },
    });

    const { historyId, expiration } = res.data;
    console.log(`📡 Gmail watch active — historyId: ${historyId}, expires: ${new Date(parseInt(expiration)).toISOString()}`);

    // Seed history_id if we don't have one yet
    const stored = await getStoredHistoryId();
    if (!stored) {
      await saveHistoryId(historyId);
    }

    return res.data;
  } catch (err) {
    console.error('Gmail watch failed:', err.message);
    return null;
  }
}

/**
 * Process a Gmail Pub/Sub push notification.
 * Google POSTs { message: { data: base64({emailAddress, historyId}) } }
 */
async function handlePushNotification(pubsubMessage) {
  const data = JSON.parse(Buffer.from(pubsubMessage.data, 'base64').toString());
  const { historyId: newHistoryId } = data;

  if (!newHistoryId) return { processed: 0 };

  return syncFromHistory(newHistoryId);
}

/**
 * Use Gmail history.list to fetch only threads that changed since our last sync.
 * Much faster than full thread listing — processes only affected threads.
 */
async function syncFromHistory(triggerHistoryId) {
  syncHealth.lastHistorySyncAt = Date.now();
  const startHistoryId = await getStoredHistoryId();
  syncHealth.storedHistoryId = startHistoryId === null ? null : String(startHistoryId);
  if (!startHistoryId) {
    // No history baseline — fall back to regular sync
    console.log('📥 No history baseline, falling back to full sync');
    return syncThreads(false);
  }

  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const { getBrands } = require('../config/brands');
    const brands = getBrands();

    // Fetch history since our last known point
    const changedThreadIds = new Set();
    let pageToken = undefined;
    let latestHistoryId = startHistoryId;

    do {
      const res = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: startHistoryId.toString(),
        historyTypes: ['messageAdded'],
        ...(pageToken ? { pageToken } : {}),
      });

      // Track the latest historyId from the response
      if (res.data.historyId) {
        latestHistoryId = res.data.historyId;
      }

      const histories = res.data.history || [];
      for (const h of histories) {
        const added = h.messagesAdded || [];
        for (const m of added) {
          if (m.message?.threadId) {
            changedThreadIds.add(m.message.threadId);
          }
        }
      }

      pageToken = res.data.nextPageToken;
    } while (pageToken);

    // The watermark is NOT advanced here — see the end of this function.
    // Advancing before the threads are processed meant a crash mid-loop
    // discarded those messages permanently: the next poll resumed past them,
    // and the label sync could not see an unlabelled reply either.
    const newHistoryId = triggerHistoryId || latestHistoryId;

    if (changedThreadIds.size === 0) {
      if (String(newHistoryId) !== String(startHistoryId)) await saveHistoryId(newHistoryId);
      syncHealth.lastHistoryOkAt = Date.now();
      syncHealth.consecutiveHistoryFailures = 0;
      syncHealth.lastHistoryError = null;
      return { newThreads: 0, updatedThreads: 0, total: 0 };
    }

    console.log(`📡 History sync: ${changedThreadIds.size} thread(s) changed`);

    // Build label-to-brand lookup
    const labelToBrand = {};
    for (const brand of brands) {
      // Resolve Gmail label ID from label name
      if (!labelToBrand._resolved) {
        try {
          const labelsRes = await gmail.users.labels.list({ userId: 'me' });
          const allLabels = labelsRes.data.labels || [];
          for (const b of brands) {
            const match = allLabels.find(l => l.name === b.label || l.name.endsWith('/' + b.label));
            if (match) labelToBrand[match.id] = b;
          }
          labelToBrand._resolved = true;
        } catch { labelToBrand._resolved = true; }
      }
    }

    let newThreads = 0;
    let updatedThreads = 0;
    let failed = 0;

    for (const threadId of changedThreadIds) {
      try {
        // Check if thread exists in DB
        const [existing] = await db.query('SELECT id, brand FROM threads WHERE gmail_thread_id = ?', [threadId]);

        let brand;
        if (existing.length) {
          // Known thread — look up brand from DB
          brand = brands.find(b => b.name === existing[0].brand);
        } else {
          // New thread — fetch from Gmail to check labels
          const threadRes = await gmail.users.threads.get({
            userId: 'me',
            id: threadId,
            format: 'minimal',
          });
          const labelIds = threadRes.data.messages?.[0]?.labelIds || [];
          // Match label to brand
          brand = labelIds.map(lid => labelToBrand[lid]).find(Boolean);
          // Fallback: check label names directly
          if (!brand) {
            brand = brands.find(b => labelIds.includes(b.label));
          }
        }

        if (!brand) continue; // Not a brand thread, skip

        const isNew = !existing.length;
        await processThread(gmail, threadId, brand);
        if (isNew) newThreads++;
        else updatedThreads++;
      } catch (err) {
        failed++;
        console.error(`Push sync error for thread ${threadId}:`, err.message);
      }
    }

    // Advanced only now, once the batch has been handled. A thread that threw
    // is still passed over rather than retried forever — one permanently bad
    // thread must not wedge the whole mailbox — but it is counted and logged
    // loudly, because a reply lost here has no other path into the tool.
    if (failed) console.error(`⚠ History sync: ${failed} thread(s) failed and were skipped`);
    if (String(newHistoryId) !== String(startHistoryId)) await saveHistoryId(newHistoryId);
    syncHealth.lastHistoryOkAt = Date.now();
    syncHealth.consecutiveHistoryFailures = 0;
    syncHealth.lastHistoryError = null;

    const summary = `📡 History sync complete — ${newThreads} new, ${updatedThreads} updated`;
    console.log(summary);
    return { newThreads, updatedThreads, total: newThreads + updatedThreads };

  } catch (err) {
    syncHealth.consecutiveHistoryFailures++;
    syncHealth.lastHistoryError = err.message;

    // Cover the gap first, whatever went wrong. Only then decide about the
    // watermark — re-anchoring skips to the mailbox's current position, so it
    // is safe only once the window it skips has been swept by syncThreads.
    console.error(`📥 History sync failed (${err.message}) — falling back to label/address sync`);
    const result = await syncThreads(false);

    // Detection is deliberately wider than the old `err.code === 404 ||
    // message.includes('notFound')`: a googleapis error reporting its status
    // another way slipped past that check and rethrew, so the baseline was
    // never re-anchored and every later poll failed identically. It is still
    // not unconditional — re-anchoring on a transient network blip would jump
    // the watermark past history we have not read. Repeated failures count as
    // expiry regardless, since that is what a permanently unusable id looks
    // like from here.
    const status = err.code ?? err.response?.status;
    const looksExpired = status === 404 || status === 400 ||
      /notFound|startHistoryId|Invalid/i.test(err.message || '');

    if (looksExpired || syncHealth.consecutiveHistoryFailures >= 5) {
      try {
        await resetHistoryBaseline();
        syncHealth.consecutiveHistoryFailures = 0;
      } catch (resetErr) {
        // Swallowing this is what let the watermark stay frozen. With the
        // reset failing AND silent, the poll was a no-op forever.
        console.error(`❌ Could not reset history baseline: ${resetErr.message}`);
      }
    }
    return result;
  }
}

module.exports = {
  getAuthUrl, getAndClearOAuthState, getAuthenticatedClient, syncThreads, sendReply, sendInitialEmail, createOAuthClient,
  watchMailbox, handlePushNotification, syncFromHistory, seedHistoryId,
  getSyncHealth, resetHistoryBaseline,
};