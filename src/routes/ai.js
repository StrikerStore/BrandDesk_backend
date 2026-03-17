const express = require('express');
const { improveText } = require('../services/openrouter');

const router = express.Router();

// POST /api/ai/improve
// body: { text: string, mode: 'grammar' | 'professional' }
router.post('/improve', async (req, res) => {
  try {
    const { text, mode } = req.body;

    if (!text?.trim()) return res.status(400).json({ error: 'Text is required' });
    if (!['grammar', 'professional'].includes(mode)) {
      return res.status(400).json({ error: 'Mode must be grammar or professional' });
    }
    if (text.length > 3000) {
      return res.status(400).json({ error: 'Text too long — max 3000 characters' });
    }

    const improved = await improveText(text.trim(), mode);
    res.json({ original: text.trim(), improved, mode });
  } catch (err) {
    if (err.message === 'OPENROUTER_API_KEY not configured') {
      return res.status(503).json({ error: 'AI service not configured. Add OPENROUTER_API_KEY to your .env' });
    }
    console.error('AI improve error:', err.message);
    res.status(500).json({ error: 'AI service failed. Try again.' });
  }
});

module.exports = router;