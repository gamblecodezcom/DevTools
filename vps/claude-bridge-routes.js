'use strict';
// =============================================================================
// claude-bridge-routes.js
// Drop-in Claude bridge for backend.js (runewager-endpoint.service, port 3001)
//
// Usage — add ONE line to backend.js:
//   app.use('/claude', require('./claude-bridge-routes'));
//
// Then routes are available at:
//   GET  https://gamble-codez.com:3001/claude/status
//   POST https://gamble-codez.com:3001/claude/chat
//   POST https://gamble-codez.com:3001/claude/clear
//
// In Web Lab: set VPS Bridge URL → https://gamble-codez.com:3001/claude
// =============================================================================

const { Router } = require('express');
const fs   = require('fs');
const path = require('path');
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

const router = Router();

const HISTORY_FILE = path.join(__dirname, 'logs', 'claude-history.json');
const BRIDGE_TOKEN = process.env.CLAUDE_BRIDGE_TOKEN || process.env.BOT_SECRET || 'gcz-bridge';
const API_KEY      = process.env.ANTHROPIC_API_KEY   || '';

// ── load/save history ─────────────────────────────────────────────────────────
let history = [];
try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch {}
function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-100), null, 2)); } catch {}
}

// ── auth ──────────────────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers['x-bridge-token'] || req.query.token;
  if (token !== BRIDGE_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── GET /claude/status (no auth — safe to poll) ───────────────────────────────
router.get('/status', (req, res) => {
  res.json({
    online:       true,
    hasKey:       !!API_KEY,
    model:        'claude-sonnet-4-6',
    service:      'runewager-endpoint',
    historyCount: history.length,
    uptime:       Math.floor(process.uptime()),
  });
});

// ── POST /claude/chat ─────────────────────────────────────────────────────────
router.post('/chat', auth, async (req, res) => {
  const { message, context } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });
  if (!API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not in .env' });

  const system = `You are Claude, embedded in the GambleCodez Web Lab via the Runewager endpoint service (port 3001) on gamble-codez.com.

You help the developer (GambleCodez) test:
- Runewager Telegram bot and its backend endpoints
- Casino/sweepstakes/Gold Coin websites
- Discord bots, OAuth flows, daily reward endpoints, redirect chains

Current context from Web Lab:
- Tunnel URL: ${context?.tunnelUrl || 'none'}
- Current site: ${context?.currentUrl || 'none'}
- Saved sessions: ${context?.sessions || 'none'}

To test endpoints using stored browser cookies, suggest:
  curl -X POST http://127.0.0.1:3000/api/test/request \\
    -H 'Content-Type: application/json' \\
    -d '{"url":"<endpoint>","method":"GET"}'

Be concise, technical, and direct. You have conversation memory.`;

  const messages = [
    ...history.slice(-20).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2048, system, messages }),
    });
    const data = await r.json();
    if (data.error) return res.status(502).json({ error: data.error.message });
    const reply = data.content?.[0]?.text || 'No response';
    history.push({ role: 'user',      content: message, ts: new Date().toISOString() });
    history.push({ role: 'assistant', content: reply,   ts: new Date().toISOString() });
    saveHistory();
    res.json({ reply, historyCount: history.length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── POST /claude/clear ────────────────────────────────────────────────────────
router.post('/clear', auth, (req, res) => {
  history = [];
  saveHistory();
  res.json({ cleared: true });
});

module.exports = router;
