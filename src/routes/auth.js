const express = require('express');
const { google } = require('googleapis');
const { getAuthUrl, createOAuthClient } = require('../services/gmail');
const { requireAdmin, requireAuth } = require('../middleware/authMiddleware');
const db = require('../config/db');

const router = express.Router();

// Step 1: Redirect to Google consent screen — admin only
router.get('/google', requireAdmin, (req, res) => {
  const url = getAuthUrl();
  res.redirect(url);
});

// Step 2: Google redirects back here with code
router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}?auth_error=${error}`);
  }

  try {
    const client = createOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Get user email
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email;

    // Store tokens
    await db.query(
      `INSERT INTO auth_tokens (email, access_token, refresh_token, expiry_date)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         access_token=VALUES(access_token),
         refresh_token=IF(VALUES(refresh_token) IS NOT NULL, VALUES(refresh_token), refresh_token),
         expiry_date=VALUES(expiry_date)`,
      [email, tokens.access_token, tokens.refresh_token, tokens.expiry_date]
    );

    // Session is optional — JWT cookies handle auth.
    // Use optional chaining in case express-session middleware is not configured.
    if (req.session) {
      req.session.userEmail = email;
      req.session.authenticated = true;
    }

    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}?auth=success`);
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}?auth_error=callback_failed`);
  }
});

// Check Gmail auth status — auth required
router.get('/status', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT email, created_at FROM auth_tokens LIMIT 1');
    if (rows.length) {
      res.json({ authenticated: true, email: rows[0].email });
    } else {
      res.json({ authenticated: false });
    }
  } catch {
    res.json({ authenticated: false });
  }
});

// Disconnect Gmail — admin only
router.post('/logout', requireAdmin, async (req, res) => {
  await db.query('DELETE FROM auth_tokens');
  req.session?.destroy?.();
  res.json({ success: true });
});

module.exports = router;