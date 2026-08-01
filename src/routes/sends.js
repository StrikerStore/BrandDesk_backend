const express = require('express');
const {
  cancelPendingSend,
  retryPendingSend,
  discardPendingSend,
} = require('../services/sendQueue');

const router = express.Router();

// POST /api/sends/:id/cancel — pull a queued email back before it reaches Gmail
router.post('/:id/cancel', async (req, res) => {
  try {
    const result = await cancelPendingSend(parseInt(req.params.id, 10), req.user);
    if (!result.cancelled) {
      // Either it already flushed, or it isn't this agent's to cancel. The
      // client refreshes on 409 rather than showing a generic error.
      return res.status(409).json({ error: 'Too late — this email has already been sent.' });
    }
    res.json(result);
  } catch (err) {
    console.error('Cancel send error:', err);
    res.status(500).json({ error: 'Failed to cancel send' });
  }
});

// POST /api/sends/:id/retry — re-queue a failed send with a fresh window
router.post('/:id/retry', async (req, res) => {
  try {
    const result = await retryPendingSend(parseInt(req.params.id, 10), req.user);
    if (!result.retried) return res.status(409).json({ error: 'This send can no longer be retried.' });
    res.json(result);
  } catch (err) {
    console.error('Retry send error:', err);
    res.status(500).json({ error: 'Failed to retry send' });
  }
});

// DELETE /api/sends/:id — drop a failed send so the bubble goes away
router.delete('/:id', async (req, res) => {
  try {
    const result = await discardPendingSend(parseInt(req.params.id, 10), req.user);
    if (!result.discarded) return res.status(409).json({ error: 'This send can no longer be discarded.' });
    res.json(result);
  } catch (err) {
    console.error('Discard send error:', err);
    res.status(500).json({ error: 'Failed to discard send' });
  }
});

module.exports = router;
