#!/usr/bin/env node
'use strict';

const express = require('express');
const http = require('http');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const fetch = require('node-fetch');
const localtunnel = require('localtunnel');
const { CookieJar } = require('tough-cookie');
const fetchCookie = require('fetch-cookie');

const app = express();
const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SAVED_TESTS_FILE = path.join(DATA_DIR, 'saved-tests.json');
const REDIRECT_LOG_FILE = path.join(DATA_DIR, 'redirects.json');
const NETWORK_LOG_FILE = path.join(DATA_DIR, 'network.json');

// ─── ensure data dir ──────────────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '{}');
if (!fs.existsSync(SAVED_TESTS_FILE)) fs.writeFileSync(SAVED_TESTS_FILE, '[]');
if (!fs.existsSync(REDIRECT_LOG_FILE)) fs.writeFileSync(REDIRECT_LOG_FILE, '[]');
if (!fs.existsSync(NETWORK_LOG_FILE)) fs.writeFileSync(NETWORK_LOG_FILE, '[]');

// ─── session / cookie store ───────────────────────────────────────────────────
let cookieStore = {};
let networkLog = [];
let redirectLog = [];
let scannerActive = false;

function loadSessions() {
  try { cookieStore = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
  catch { cookieStore = {}; }
}
function saveSessions() {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(cookieStore, null, 2));
}
function loadNetworkLog() {
  try { networkLog = JSON.parse(fs.readFileSync(NETWORK_LOG_FILE, 'utf8')); }
  catch { networkLog = []; }
}
function saveNetworkLog() {
  fs.writeFileSync(NETWORK_LOG_FILE, JSON.stringify(networkLog.slice(-500), null, 2));
}
function loadRedirectLog() {
  try { redirectLog = JSON.parse(fs.readFileSync(REDIRECT_LOG_FILE, 'utf8')); }
  catch { redirectLog = []; }
}
function saveRedirectLog() {
  fs.writeFileSync(REDIRECT_LOG_FILE, JSON.stringify(redirectLog.slice(-200), null, 2));
}

loadSessions();
loadNetworkLog();
loadRedirectLog();

// ─── tunnel state ─────────────────────────────────────────────────────────────
let tunnel = null;
let tunnelUrl = null;

async function startTunnel() {
  try {
    if (tunnel) { tunnel.close(); tunnel = null; tunnelUrl = null; }
    tunnel = await localtunnel({ port: PORT, subdomain: 'gcz-weblab' });
    tunnelUrl = tunnel.url;
    console.log(`\n🌐 Tunnel: ${tunnelUrl}`);
    console.log(`   Register with @BotFather: /setdomain → ${tunnelUrl}\n`);
    tunnel.on('error', () => { tunnel = null; tunnelUrl = null; });
    tunnel.on('close', () => { tunnel = null; tunnelUrl = null; });
  } catch (err) {
    // subdomain taken — get random one
    try {
      tunnel = await localtunnel({ port: PORT });
      tunnelUrl = tunnel.url;
      console.log(`\n🌐 Tunnel: ${tunnelUrl}\n`);
      tunnel.on('error', () => { tunnel = null; tunnelUrl = null; });
      tunnel.on('close', () => { tunnel = null; tunnelUrl = null; });
    } catch (e) {
      console.log('⚠ Tunnel failed:', e.message);
    }
  }
}

// ─── cookie jar helpers ───────────────────────────────────────────────────────
function getCookieHeader(domain) {
  const cookies = cookieStore[domain];
  if (!cookies || !cookies.length) return '';
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}
function mergeCookies(domain, setCookieHeaders) {
  if (!setCookieHeaders) return;
  if (!cookieStore[domain]) cookieStore[domain] = [];
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const hdr of headers) {
    const [pair] = hdr.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 0) continue;
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    const existing = cookieStore[domain].findIndex(c => c.name === name);
    if (existing >= 0) cookieStore[domain][existing].value = value;
    else cookieStore[domain].push({ name, value, domain, saved: new Date().toISOString() });
  }
  saveSessions();
}

// ─── middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── PROXY route ─────────────────────────────────────────────────────────────
app.get('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'No URL provided' });

  let targetUrl;
  try {
    targetUrl = new URL(target.startsWith('http') ? target : 'https://' + target);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const domain = targetUrl.hostname;
  const cookieHeader = getCookieHeader(domain);
  const startTime = Date.now();
  const chain = [];

  const entry = {
    id: Date.now(),
    method: 'GET',
    url: target,
    domain,
    status: null,
    duration: null,
    timestamp: new Date().toISOString(),
  };

  try {
    let currentUrl = targetUrl.href;
    let response;
    let hops = 0;

    while (hops < 10) {
      chain.push(currentUrl);
      response = await fetch(currentUrl, {
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
        },
      });

      const setCookie = response.headers.raw()['set-cookie'];
      if (setCookie) mergeCookies(domain, setCookie);

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const loc = response.headers.get('location');
        if (!loc) break;
        currentUrl = loc.startsWith('http') ? loc : new URL(loc, currentUrl).href;
        hops++;
        continue;
      }
      break;
    }

    entry.status = response.status;
    entry.duration = Date.now() - startTime;
    entry.redirectChain = chain;
    entry.finalUrl = currentUrl;

    if (scannerActive) {
      networkLog.unshift(entry);
      saveNetworkLog();
      if (chain.length > 1) {
        redirectLog.unshift({ id: entry.id, timestamp: entry.timestamp, chain, finalUrl: currentUrl, domain });
        saveRedirectLog();
      }
    }

    const contentType = response.headers.get('content-type') || 'text/html';
    let body = await response.text();

    // rewrite links to go through proxy
    if (contentType.includes('text/html')) {
      body = body
        .replace(/(href|src|action)="(\/[^"]+)"/g, (_, attr, p) => `${attr}="/proxy?url=${encodeURIComponent(new URL(p, targetUrl.origin).href)}"`)
        .replace(/<head>/i, `<head><base href="${targetUrl.origin}/">`);
    }

    // strip headers that block embedding
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.set('Content-Type', contentType);
    res.set('X-Final-Url', currentUrl);
    res.set('X-Redirect-Count', String(chain.length - 1));
    res.send(body);
  } catch (err) {
    entry.status = 0;
    entry.error = err.message;
    entry.duration = Date.now() - startTime;
    if (scannerActive) { networkLog.unshift(entry); saveNetworkLog(); }
    res.status(502).json({ error: err.message, entry });
  }
});

// ─── API: tunnel ─────────────────────────────────────────────────────────────
app.get('/api/tunnel', (req, res) => res.json({ active: !!tunnel, url: tunnelUrl }));
app.post('/api/tunnel/start', async (req, res) => {
  await startTunnel();
  res.json({ active: !!tunnel, url: tunnelUrl });
});
app.post('/api/tunnel/stop', (req, res) => {
  if (tunnel) { tunnel.close(); tunnel = null; tunnelUrl = null; }
  res.json({ active: false, url: null });
});

// ─── API: scanner toggle ───────────────────────────────────────────────────────
app.post('/api/scanner', (req, res) => {
  scannerActive = req.body.active === true || req.body.active === 'true';
  res.json({ active: scannerActive });
});
app.get('/api/scanner', (req, res) => res.json({ active: scannerActive }));

// ─── API: network log ─────────────────────────────────────────────────────────
app.get('/api/network', (req, res) => {
  const filter = req.query.filter || '';
  const log = filter
    ? networkLog.filter(e => e.url.toLowerCase().includes(filter.toLowerCase()))
    : networkLog;
  res.json(log.slice(0, 200));
});
app.delete('/api/network', (req, res) => {
  networkLog = [];
  saveNetworkLog();
  res.json({ cleared: true });
});

// ─── API: redirect log ────────────────────────────────────────────────────────
app.get('/api/redirects', (req, res) => res.json(redirectLog.slice(0, 100)));
app.delete('/api/redirects', (req, res) => {
  redirectLog = [];
  saveRedirectLog();
  res.json({ cleared: true });
});

// ─── API: sessions / cookies ───────────────────────────────────────────────────
app.get('/api/sessions', (req, res) => {
  const summary = {};
  for (const [domain, cookies] of Object.entries(cookieStore)) {
    summary[domain] = { count: cookies.length, cookies };
  }
  res.json(summary);
});
app.post('/api/sessions/:domain', (req, res) => {
  const { domain } = req.params;
  const { cookies } = req.body;
  if (!Array.isArray(cookies)) return res.status(400).json({ error: 'cookies must be array' });
  cookieStore[domain] = cookies;
  saveSessions();
  res.json({ saved: true, domain, count: cookies.length });
});
app.delete('/api/sessions/:domain', (req, res) => {
  delete cookieStore[req.params.domain];
  saveSessions();
  res.json({ cleared: true });
});
app.delete('/api/sessions', (req, res) => {
  cookieStore = {};
  saveSessions();
  res.json({ cleared: true });
});

// ─── API: session status for quick targets ────────────────────────────────────
app.get('/api/session-status', (req, res) => {
  res.json({
    telegram: !!(cookieStore['web.telegram.org'] && cookieStore['web.telegram.org'].length),
    discord: !!(cookieStore['discord.com'] && cookieStore['discord.com'].length),
    domains: Object.keys(cookieStore).map(d => ({
      domain: d,
      count: cookieStore[d].length,
    })),
  });
});

// ─── API: saved tests ─────────────────────────────────────────────────────────
app.get('/api/test/saved', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(SAVED_TESTS_FILE, 'utf8'))); }
  catch { res.json([]); }
});
app.post('/api/test/saved', (req, res) => {
  const { name, url, method, headers, body } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  let tests = [];
  try { tests = JSON.parse(fs.readFileSync(SAVED_TESTS_FILE, 'utf8')); } catch {}
  const id = Date.now().toString();
  tests.push({ id, name, url, method: method || 'GET', headers: headers || {}, body: body || null, created: new Date().toISOString() });
  fs.writeFileSync(SAVED_TESTS_FILE, JSON.stringify(tests, null, 2));
  res.json({ saved: true, id });
});
app.delete('/api/test/saved/:id', (req, res) => {
  let tests = [];
  try { tests = JSON.parse(fs.readFileSync(SAVED_TESTS_FILE, 'utf8')); } catch {}
  tests = tests.filter(t => t.id !== req.params.id);
  fs.writeFileSync(SAVED_TESTS_FILE, JSON.stringify(tests, null, 2));
  res.json({ deleted: true });
});

// ─── API: run test request (Claude/CLI use this) ──────────────────────────────
app.all('/api/test/request', async (req, res) => {
  const { url, method = 'GET', headers = {}, body } = { ...req.query, ...req.body };
  if (!url) return res.status(400).json({ error: 'url required' });

  let targetUrl;
  try { targetUrl = new URL(url.startsWith('http') ? url : 'https://' + url); }
  catch { return res.status(400).json({ error: 'invalid url' }); }

  const domain = targetUrl.hostname;
  const cookieHeader = getCookieHeader(domain);
  const startTime = Date.now();

  try {
    const response = await fetch(targetUrl.href, {
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'application/json, text/html, */*',
        ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
        ...headers,
      },
      ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });

    const setCookie = response.headers.raw()['set-cookie'];
    if (setCookie) mergeCookies(domain, setCookie);

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    let parsed = null;
    if (contentType.includes('application/json')) {
      try { parsed = JSON.parse(text); } catch {}
    }

    const entry = {
      id: Date.now(),
      method,
      url: targetUrl.href,
      domain,
      status: response.status,
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
    networkLog.unshift(entry);
    saveNetworkLog();

    res.json({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: parsed || text.slice(0, 5000),
      duration: entry.duration,
      cookiesSaved: cookieStore[domain]?.length || 0,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── API: run saved test by id ────────────────────────────────────────────────
app.post('/api/test/run-saved', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  let tests = [];
  try { tests = JSON.parse(fs.readFileSync(SAVED_TESTS_FILE, 'utf8')); } catch {}
  const test = tests.find(t => t.id === id);
  if (!test) return res.status(404).json({ error: 'test not found' });

  req.body = { url: test.url, method: test.method, headers: test.headers, body: test.body };
  req.method = 'POST';
  app._router.handle({ ...req, url: '/api/test/request', method: 'POST', path: '/api/test/request' }, res, () => {});
});

// ─── API: iframe check ────────────────────────────────────────────────────────
app.get('/api/iframe-check', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'No URL' });
  try {
    let url = target.startsWith('http') ? target : 'https://' + target;
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    const xfo = response.headers.get('x-frame-options') || '';
    const csp = response.headers.get('content-security-policy') || '';
    const blocked = /DENY|SAMEORIGIN/i.test(xfo) || /frame-ancestors/i.test(csp);
    res.json({ blocked, xfo, csp, status: response.status });
  } catch (err) {
    res.json({ blocked: true, error: err.message });
  }
});

// ─── Claude config ────────────────────────────────────────────────────────────
const CLAUDE_CONFIG_FILE = path.join(DATA_DIR, 'claude-config.json');
function loadClaudeConfig() {
  try { return JSON.parse(fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}
function saveClaudeConfig(cfg) { fs.writeFileSync(CLAUDE_CONFIG_FILE, JSON.stringify(cfg, null, 2)); }

// ─── API: Claude status ────────────────────────────────────────────────────────
app.get('/api/claude/status', (req, res) => {
  const cfg = loadClaudeConfig();
  const hasKey = !!(cfg.apiKey || process.env.ANTHROPIC_API_KEY);
  res.json({ online: hasKey, hasKey, model: 'claude-sonnet-4-6' });
});

// ─── API: save Claude API key / VPS bridge config ────────────────────────────
app.post('/api/claude/set-key', (req, res) => {
  const { key } = req.body;
  if (!key || !key.startsWith('sk-')) return res.status(400).json({ error: 'Invalid key format' });
  const cfg = loadClaudeConfig();
  cfg.apiKey = key;
  saveClaudeConfig(cfg);
  res.json({ saved: true });
});
app.post('/api/claude/set-bridge', (req, res) => {
  const { vpsUrl, token } = req.body;
  if (!vpsUrl) return res.status(400).json({ error: 'vpsUrl required' });
  const cfg = loadClaudeConfig();
  cfg.vpsUrl = vpsUrl.replace(/\/$/, '');
  cfg.bridgeToken = token || '';
  saveClaudeConfig(cfg);
  res.json({ saved: true });
});
app.get('/api/claude/bridge-status', async (req, res) => {
  const cfg = loadClaudeConfig();
  if (!cfg.vpsUrl) return res.json({ connected: false, reason: 'No VPS bridge configured' });
  try {
    const r = await fetch(`${cfg.vpsUrl}/status`, { signal: AbortSignal.timeout(5000) });
    const data = await r.json();
    res.json({ connected: true, ...data });
  } catch (err) {
    res.json({ connected: false, reason: err.message });
  }
});
app.post('/api/claude/bridge-toggle', async (req, res) => {
  const cfg = loadClaudeConfig();
  if (!cfg.vpsUrl) return res.status(400).json({ error: 'No VPS bridge configured' });
  try {
    const r = await fetch(`${cfg.vpsUrl}/stop`, {
      method: 'POST',
      headers: { 'x-bridge-token': cfg.bridgeToken || '' },
    });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── API: Claude chat ─────────────────────────────────────────────────────────
app.post('/api/claude/chat', async (req, res) => {
  const { message, context } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const cfg = loadClaudeConfig();
  const apiKey = cfg.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(401).json({ error: 'No Anthropic API key set. Add it in the Chat panel.' });

  const sessionSummary = Object.keys(cookieStore).map(d => `${d} (${cookieStore[d].length} cookies)`).join(', ') || 'none';
  const systemPrompt = `You are Claude, embedded in the GambleCodez Web Lab — a private developer testing tool running on Android Termux at localhost:3000.

Current context:
- Tunnel URL: ${context?.tunnelUrl || 'none'}
- Current loaded site: ${context?.currentUrl || 'none'}
- Saved sessions: ${sessionSummary}
- You can call the local API at http://127.0.0.1:3000/api/test/request to make authenticated requests using stored cookies.

You help the developer test websites, Discord bots, Telegram bots, daily reward flows, redirect chains, and OAuth sessions. Be concise and technical. If asked to test an endpoint, provide the exact curl command or API call.`;

  // prefer VPS bridge if configured
  const vpsUrl = cfg.vpsUrl;
  const bridgeToken = cfg.bridgeToken;
  if (vpsUrl) {
    try {
      const r = await fetch(`${vpsUrl}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bridge-token': bridgeToken || '' },
        body: JSON.stringify({ message, context, history: [] }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await r.json();
      return res.json(data);
    } catch (err) {
      // fall through to local API key
    }
  }

  if (!apiKey) return res.status(401).json({ error: 'No API key or VPS bridge configured.' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: message }],
      }),
    });
    const data = await response.json();
    if (data.error) return res.status(502).json({ error: data.error.message });
    const reply = data.content?.[0]?.text || 'No response';
    res.json({ reply });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── PNG icon generator (pure Node, no deps) ─────────────────────────────────
function makePng(size) {
  // Creates a minimal valid PNG: solid dark square with gold "G" text simulation
  // Pure pixel approach — gold (#ffd700) text on dark (#0a0a0f) background
  const w = size, h = size;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0; // filter byte
    for (let x = 0; x < w; x++) {
      const i = y * (1 + w * 3) + 1 + x * 3;
      const cx = x / w, cy = y / h;
      // background gradient: dark blue-black
      let r = 10, g = 10, b = 15;
      // gold border ring
      const edge = 0.06;
      if (cx < edge || cx > 1-edge || cy < edge || cy > 1-edge) {
        r = 255; g = 215; b = 0;
      }
      // cyan accent bar at bottom third
      if (cy > 0.65 && cy < 0.68 && cx > 0.1 && cx < 0.9) {
        r = 0; g = 229; b = 255;
      }
      // "G" shape in gold — center region
      const gx = (cx - 0.5) * 2, gy = (cy - 0.45) * 2;
      const dist = Math.sqrt(gx*gx + gy*gy);
      if (dist < 0.7 && dist > 0.5 && !(gx > 0 && gy > -0.1 && gy < 0.3)) {
        r = 255; g = 215; b = 0;
      }
      if (gx > 0 && gx < 0.7 && gy > -0.05 && gy < 0.15) {
        r = 255; g = 215; b = 0;
      }
      raw[i] = r; raw[i+1] = g; raw[i+2] = b;
    }
  }
  const compressed = zlib.deflateSync(raw);
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const b of buf) { c = (c >>> 8) ^ CRC_TABLE[(c ^ b) & 0xFF]; }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();
  function chunk(type, data) {
    const typeBuf = Buffer.from(type);
    const lenBuf = Buffer.allocUnsafe(4); lenBuf.writeUInt32BE(data.length);
    const crcBuf = Buffer.allocUnsafe(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4);
  ihdr[8]=8; ihdr[9]=2; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;
  return Buffer.concat([sig, chunk('IHDR',ihdr), chunk('IDAT',compressed), chunk('IEND',Buffer.alloc(0))]);
}

// serve generated icons
app.get('/icons/icon-:size.png', (req, res) => {
  const size = parseInt(req.params.size) || 192;
  const safe = Math.min(Math.max(size, 16), 512);
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(makePng(safe));
});

// ─── start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║     GambleCodez // Web Lab  v2.0             ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Local:   http://127.0.0.1:${PORT}              ║`);
  console.log('╠══════════════════════════════════════════════╣');
  console.log('║  1. Open Chrome → http://127.0.0.1:3000      ║');
  console.log('║  2. Tap ⋮ → "Add to Home screen"             ║');
  console.log('║  Starting public tunnel...                   ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  startTunnel();
});
