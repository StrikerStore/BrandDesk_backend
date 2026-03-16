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

function getAuthUrl() {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
  });
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

// Get the timestamp of the most recent thread we have per brand
async function getLastSyncTime(brandName) {
  const [rows] = await db.query(
    'SELECT MAX(created_at) as last FROM threads WHERE brand = ?',
    [brandName]
  );
  return rows[0]?.last || null;
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

      // Build Gmail query
      let query = `label:${brand.label}`;
      if (lastSync) {
        // Gmail uses Unix epoch seconds for after: filter
        // Subtract 5 min buffer to catch any emails that arrived during last sync
        const epochSeconds = Math.floor(new Date(lastSync).getTime() / 1000) - 300;
        query += ` after:${epochSeconds}`;
      }

      // Fetch threads — paginate to get up to 300 on full sync
      const allThreadIds = [];
      let pageToken = undefined;
      const maxToFetch = fullSync ? 500 : 20;

      do {
        const listRes = await gmail.users.threads.list({
          userId: 'me',
          q: query,
          maxResults: Math.min(maxToFetch - allThreadIds.length, 100),
          ...(pageToken ? { pageToken } : {}),
        });

        const batch = listRes.data.threads || [];
        allThreadIds.push(...batch);
        pageToken = listRes.data.nextPageToken;

      } while (pageToken && allThreadIds.length < maxToFetch);

      if (allThreadIds.length === 0) continue;

      console.log(`📥 ${brand.name}: fetching ${allThreadIds.length} threads...`);

      for (const t of allThreadIds) {
        const [existing] = await db.query(
          'SELECT id FROM threads WHERE gmail_thread_id = ?',
          [t.id]
        );
        const isNew = existing.length === 0;
        await processThread(gmail, t.id, brand);
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
    'SELECT id FROM threads WHERE gmail_thread_id = ?',
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
    const direction  = isOurEmail(from) ? 'outbound' : 'inbound';
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
  }
}

async function sendReply(gmailThreadId, body, brand, isNote = false) {
  if (isNote) {
    // Internal notes are stored only, not sent
    const [thread] = await db.query('SELECT id FROM threads WHERE gmail_thread_id=?', [gmailThreadId]);
    if (!thread.length) throw new Error('Thread not found');
    await db.query(
      `INSERT INTO messages (thread_id, direction, from_email, body, is_note, sent_at)
       VALUES (?, 'outbound', ?, ?, 1, NOW())`,
      [thread[0].id, brand.email, body]
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
  const emailLines = [
    `From: ${brand.name} Support <${brand.email}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `In-Reply-To: ${gmailThreadId}`,
    `References: ${gmailThreadId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ];
  const raw = Buffer.from(emailLines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const sendRes = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId: gmailThreadId },
  });

  // Save to messages table
  const [threadRow] = await db.query('SELECT id, status FROM threads WHERE gmail_thread_id=?', [gmailThreadId]);
  if (threadRow.length) {
    await db.query(
      `INSERT INTO messages (thread_id, gmail_message_id, direction, from_email, body, sent_at)
       VALUES (?, ?, 'outbound', ?, ?, NOW())`,
      [threadRow[0].id, sendRes.data.id, brand.email, body]
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

module.exports = { getAuthUrl, getAuthenticatedClient, syncThreads, sendReply, createOAuthClient };