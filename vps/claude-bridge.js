#!/usr/bin/env node
'use strict';
// GambleCodez Claude Bridge — runs on VPS, connects Web Lab to Claude API
// pm2 start claude-bridge.js --name claude-bridge

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.BRIDGE_PORT || 4000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AUTH_TOKEN = process.env.BRIDGE_TOKEN || 'gcz-bridge-token'; // change this
const HISTORY_FILE = path.join(__dirname, 'chat-history.json');

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

// load chat history
let chatHistory = [];
try { chatHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch {}
function saveHistory() {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(chatHistory.slice(-100), null, 2));
}

// ── auth middleware ───────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers['x-bridge-token'] || req.query.token;
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── status ────────────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({
    online: true,
    hasKey: !!API_KEY,
    model: 'claude-sonnet-4-6',
    historyCount: chatHistory.length,
    uptime: Math.floor(process.uptime()),
  });
});

// ── chat ──────────────────────────────────────────────────────────────────────
app.post('/chat', auth, async (req, res) => {
  const { message, context, history } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  if (!API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on VPS' });

  const systemPrompt = `You are Claude, connected to the GambleCodez Web Lab via a VPS bridge at gamble-codez.com.

You are helping a solo developer (GambleCodez) who builds:
- Casino/sweepstakes/Gold Coin style websites
- Discord bots and Telegram bots
- Testing daily reward flows, OAuth, redirect chains, session cookies

Current Web Lab context:
- Tunnel URL: ${context?.tunnelUrl || 'none'}
- Current site loaded: ${context?.currentUrl || 'none'}
- Saved sessions: ${context?.sessions || 'none'}

You can suggest exact API calls to http://127.0.0.1:3000/api/test/request to test endpoints using stored cookies.
Be concise, technical, and direct. You remember the conversation history within this session.`;

  // build messages with history
  const messages = [
    ...(history || chatHistory).slice(-20).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2048, system: systemPrompt, messages }),
    });
    const data = await response.json();
    if (data.error) return res.status(502).json({ error: data.error.message });
    const reply = data.content?.[0]?.text || 'No response';

    // save to history
    chatHistory.push({ role: 'user', content: message, ts: new Date().toISOString() });
    chatHistory.push({ role: 'assistant', content: reply, ts: new Date().toISOString() });
    saveHistory();

    res.json({ reply, historyCount: chatHistory.length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── clear history ─────────────────────────────────────────────────────────────
app.post('/clear', auth, (req, res) => {
  chatHistory = [];
  saveHistory();
  res.json({ cleared: true });
});

// ── toggle (disable/enable via Web Lab) ───────────────────────────────────────
app.post('/stop', auth, (req, res) => {
  res.json({ message: 'Stopping bridge...' });
  setTimeout(() => process.exit(0), 500); // pm2 will restart if watch is on
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🤖 GambleCodez Claude Bridge`);
  console.log(`   Port: ${PORT}`);
  console.log(`   API Key: ${API_KEY ? '✓ set' : '✗ NOT SET — set ANTHROPIC_API_KEY'}`);
  console.log(`   Auth token: ${AUTH_TOKEN}`);
  console.log(`   Public: https://gamble-codez.com:${PORT}/status\n`);
});
