/**
 * Parses Shopify contact form emails into structured ticket data.
 *
 * Expected email body format:
 *   You received a new message from your online store's contact form.
 *   Country Code: IN
 *   Order Number: Test12
 *   Name: Keval
 *   Email: ravatkeval@gmail.com
 *   Phone: 8770420074
 *   Issue Category: Miscellaneous / Other
 *   Sub Issue: Other
 *   Body: Test
 *   Ticket: STKR-20260316-99457
 */

// Brand prefix map — used to identify ticket store from ticket ID
const TICKET_PREFIXES = {
  'STKR': 'Striker Store',
  'DRBL': 'Dribble Store',
  'HOOP': 'Hoop Store',
};

/**
 * Parse a field value from the email body.
 * Looks for "FieldName:\nValue" or "FieldName: Value" patterns.
 */
function extractField(body, fieldName) {
  // Match "FieldName:\nValue\n" or "FieldName: Value\n"
  const patterns = [
    new RegExp(`${fieldName}:\\s*\\n([^\\n]+)`, 'i'),
    new RegExp(`${fieldName}:\\s+([^\\n]+)`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match && match[1]?.trim()) {
      return match[1].trim();
    }
  }
  return null;
}

/**
 * Extract the Body field which may span multiple lines.
 * Everything between "Body:" and the next known field or end of string.
 */
function extractBody(emailBody) {
  const bodyMatch = emailBody.match(/Body:\s*\n?([\s\S]*?)(?:\nTicket:|\nOrder Number:|\nName:|\nEmail:|\nPhone:|$)/i);
  if (bodyMatch && bodyMatch[1]?.trim()) {
    return bodyMatch[1].trim();
  }
  // Fallback: everything after "Body:"
  const simpleMatch = emailBody.match(/Body:\s*(.+)/is);
  return simpleMatch?.[1]?.trim() || null;
}

/**
 * Check if this email is a Shopify contact form notification.
 */
function isShopifyContactForm(fromEmail, body) {
  const isFromShopify = fromEmail?.toLowerCase().includes('mailer@shopify.com') ||
                        fromEmail?.toLowerCase().includes('shopify.com');
  const hasFormPattern = body?.includes('received a new message from your online store');
  return isFromShopify || hasFormPattern;
}

/**
 * Main parser — takes raw email data and returns structured ticket info.
 *
 * @param {string} fromEmail - The From header value
 * @param {string} replyTo - The Reply-To header value
 * @param {string} rawBody - The plain text email body
 * @returns {object} parsed ticket data
 */
function parseShopifyEmail(fromEmail, replyTo, rawBody) {
  if (!rawBody) return null;
  if (!isShopifyContactForm(fromEmail, rawBody)) return null;

  // Extract Reply-To email (real customer email)
  let customerEmail = null;
  if (replyTo) {
    const replyMatch = replyTo.match(/<(.+?)>/) || replyTo.match(/([^\s<>]+@[^\s<>]+)/);
    customerEmail = replyMatch?.[1]?.trim() || replyTo.trim();
  }

  // Extract all fields
  const name          = extractField(rawBody, 'Name');
  const emailInBody   = extractField(rawBody, 'Email');
  const phone         = extractField(rawBody, 'Phone');
  const countryCode   = extractField(rawBody, 'Country Code');
  const orderNumber   = extractField(rawBody, 'Order Number');
  const issueCategory = extractField(rawBody, 'Issue Category');
  const subIssue      = extractField(rawBody, 'Sub Issue');
  const ticketId      = extractField(rawBody, 'Ticket');
  const messageBody   = extractBody(rawBody);

  // Use email from body as fallback for customer email
  const resolvedEmail = customerEmail || emailInBody || null;

  // Determine brand from ticket prefix
  let brandFromTicket = null;
  if (ticketId) {
    const prefix = ticketId.split('-')[0]?.toUpperCase();
    brandFromTicket = TICKET_PREFIXES[prefix] || null;
  }

  return {
    isShopifyForm: true,
    customerEmail: resolvedEmail,
    customerName: name,
    customerPhone: phone,
    customerCountry: countryCode,
    orderNumber,
    issueCategory,
    subIssue,
    messageBody,   // The actual message from customer — use this as chat bubble text
    ticketId,
    brandFromTicket,
  };
}

/**
 * Build a clean display body for the chat view.
 * Instead of showing the raw form dump, show just the customer's message
 * with key info as a structured header.
 */
function buildChatBody(parsed) {
  if (!parsed?.isShopifyForm) return null;

  const lines = [];

  if (parsed.ticketId)      lines.push(`🎫 Ticket: ${parsed.ticketId}`);
  if (parsed.orderNumber)   lines.push(`📦 Order: ${parsed.orderNumber}`);
  if (parsed.issueCategory) lines.push(`🏷 Issue: ${parsed.issueCategory}`);
  if (parsed.subIssue && parsed.subIssue !== parsed.issueCategory) {
    lines.push(`   └ ${parsed.subIssue}`);
  }
  if (parsed.customerPhone) lines.push(`📞 Phone: ${parsed.customerPhone}`);
  if (parsed.customerCountry) lines.push(`🌍 Country: ${parsed.customerCountry}`);

  lines.push('');
  lines.push(parsed.messageBody || '(No message body)');

  return lines.join('\n');
}

module.exports = { parseShopifyEmail, buildChatBody, isShopifyContactForm, TICKET_PREFIXES };