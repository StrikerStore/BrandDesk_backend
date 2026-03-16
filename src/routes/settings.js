const express = require('express');
const { getAllSettings, setSetting } = require('../services/settings');
const { runAutoAck, runAutoClose } = require('../services/automation');

const router = express.Router();

// GET /api/settings
router.get('/', async (req, res) => {
  try {
    const settings = await getAllSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/settings — update one or many settings
router.patch('/', async (req, res) => {
  try {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
      await setSetting(key, value);
    }
    const settings = await getAllSettings();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/test-auto-ack — manually trigger auto-ack
router.post('/test-auto-ack', async (req, res) => {
  try {
    await runAutoAck();
    res.json({ success: true, message: 'Auto-ack run complete' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/test-auto-close — manually trigger auto-close
router.post('/test-auto-close', async (req, res) => {
  try {
    await runAutoClose();
    res.json({ success: true, message: 'Auto-close run complete' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;