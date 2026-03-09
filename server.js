#!/usr/bin/env node
'use strict';

const express      = require('express');
const session      = require('express-session');
const cors         = require('cors');
const bodyParser   = require('body-parser');
const crypto       = require('crypto');
const fs           = require('fs');
const path         = require('path');
const zlib         = require('zlib');
const fetch        = require('node-fetch');
const { execFile } = require('child_process');

const app  = express();
const PORT = parseInt(process.env.PORT || '3002', 10);
const BASE = process.env.PUBLIC_BASE || 'https://bot.gamblecodez.com/dev';

const DATA_DIR           = path.join(__dirname, 'data');
const SESSIONS_FILE      = path.join(DATA_DIR, 'sessions.json');
const SAVED_TESTS_FILE   = path.join(DATA_DIR, 'saved-tests.json');
const REDIRECT_LOG_FILE  = path.join(DATA_DIR, 'redirects.json');
const NETWORK_LOG_FILE   = path.join(DATA_DIR, 'network.json');
const SHARE_TOKENS_FILE  = path.join(DATA_DIR, 'share-tokens.json');
const ADMIN_CONFIG_FILE  = path.join(DATA_DIR, 'admin-config.json');
const CHAT_HISTORY_FILE  = path.join(DATA_DIR, 'chat-history.json');
const TG_AUTH_FILE       = path.join(DATA_DIR, 'tg-auth.json');

// ─── Claude CLI detection ─────────────────────────────────────────────────────
const CLAUDE_CANDIDATES = [
  process.env.CLAUDE_BIN,
  '/root/.local/bin/claude',
  '/usr/local/bin/claude',
  '/usr/bin/claude',
].filter(Boolean);

let CLI_BIN = '';
for (const bin of CLAUDE_CANDIDATES) {
  try { if (fs.existsSync(bin)) { CLI_BIN = bin; break; } } catch {}
}

// ─── Claude state ─────────────────────────────────────────────────────────────
let claudeActive    = true;
let chatHistory     = [];
const HISTORY_MAX   = 40;
const CONTEXT_MSGS  = 20;

try { chatHistory = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf8')); } catch { chatHistory = []; }
function saveChatHistory() {
  try { fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chatHistory.slice(-HISTORY_MAX), null, 2)); } catch {}
}

// ─── Telegram auth store ──────────────────────────────────────────────────────
let tgAuthData = null;
try { tgAuthData = JSON.parse(fs.readFileSync(TG_AUTH_FILE, 'utf8')); } catch {}
function saveTgAuth() { fs.writeFileSync(TG_AUTH_FILE, JSON.stringify(tgAuthData, null, 2)); }

// ─── ensure data dir ──────────────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
[SESSIONS_FILE, SAVED_TESTS_FILE, REDIRECT_LOG_FILE, NETWORK_LOG_FILE, SHARE_TOKENS_FILE]
  .forEach(f => { if (!fs.existsSync(f)) fs.writeFileSync(f, f.endsWith('sessions.json') || f.endsWith('tokens.json') ? '{}' : '[]'); });

// ─── admin config (tokens + session secret) ───────────────────────────────────
function loadAdminConfig() {
  try { return JSON.parse(fs.readFileSync(ADMIN_CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}
function saveAdminConfig(cfg) { fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(cfg, null, 2)); }

function ensureAdminConfig() {
  const cfg = loadAdminConfig();
  let changed = false;
  if (!cfg.adminToken)     { cfg.adminToken     = crypto.randomBytes(24).toString('hex'); changed = true; }
  if (!cfg.sessionSecret)  { cfg.sessionSecret  = crypto.randomBytes(32).toString('hex'); changed = true; }
  if (changed) saveAdminConfig(cfg);
  return cfg;
}
const adminCfg = ensureAdminConfig();

// ─── session / cookie store ───────────────────────────────────────────────────
let cookieStore  = {};
let shareTokens  = {};
let networkLog   = [];
let redirectLog  = [];
let scannerActive = false;

function loadSessions()     { try { cookieStore  = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { cookieStore  = {}; } }
function saveSessions()     { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(cookieStore, null, 2)); }
function loadShareTokens()  { try { shareTokens  = JSON.parse(fs.readFileSync(SHARE_TOKENS_FILE, 'utf8')); } catch { shareTokens  = {}; } }
function saveShareTokens()  { fs.writeFileSync(SHARE_TOKENS_FILE, JSON.stringify(shareTokens, null, 2)); }
function loadNetworkLog()   { try { networkLog   = JSON.parse(fs.readFileSync(NETWORK_LOG_FILE, 'utf8')); } catch { networkLog   = []; } }
function saveNetworkLog()   { fs.writeFileSync(NETWORK_LOG_FILE, JSON.stringify(networkLog.slice(-500), null, 2)); }
function loadRedirectLog()  { try { redirectLog  = JSON.parse(fs.readFileSync(REDIRECT_LOG_FILE, 'utf8')); } catch { redirectLog  = []; } }
function saveRedirectLog()  { fs.writeFileSync(REDIRECT_LOG_FILE, JSON.stringify(redirectLog.slice(-200), null, 2)); }

loadSessions(); loadShareTokens(); loadNetworkLog(); loadRedirectLog();

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
    const name  = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    const existing = cookieStore[domain].findIndex(c => c.name === name);
    if (existing >= 0) cookieStore[domain][existing].value = value;
    else cookieStore[domain].push({ name, value, domain, saved: new Date().toISOString() });
  }
  saveSessions();
}

// ─── share token helpers ──────────────────────────────────────────────────────
function isTokenValid(t) {
  if (!t || !t.active) return false;
  if (t.expiresAt && new Date() > new Date(t.expiresAt)) return false;
  if (t.maxUses && t.useCount >= t.maxUses) return false;
  return true;
}
function consumeToken(tokenId) {
  const t = shareTokens[tokenId];
  if (!t) return false;
  t.useCount = (t.useCount || 0) + 1;
  t.lastUsed = new Date().toISOString();
  if (t.maxUses && t.useCount >= t.maxUses) t.active = false;
  saveShareTokens();
  return true;
}

// ─── admin helpers ────────────────────────────────────────────────────────────
function isLocalhost(req) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
function isAdmin(req) {
  return isLocalhost(req) || req.session?.admin === true;
}

// ─── middleware ───────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(cors({ origin: '*' }));
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));
app.use(session({
  secret: adminCfg.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  // Return a simple auth challenge page
  const cfg = loadAdminConfig();
  res.status(403).send(adminLoginPage(req.originalUrl));
}

function adminLoginPage(redirectTo) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GCZ DevTools — Auth Required</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0f;color:#e0e0f0;font-family:system-ui,sans-serif;
     display:flex;align-items:center;justify-content:center;height:100vh}
.box{background:#111118;border:1px solid #ffd700;border-radius:14px;
     padding:32px 28px;width:min(90vw,380px);text-align:center}
h1{color:#ffd700;font-size:18px;margin-bottom:8px}
p{color:#6060a0;font-size:12px;margin-bottom:20px}
input{width:100%;padding:10px;background:#1a1a26;border:1px solid #2a2a3a;
      border-radius:8px;color:#e0e0f0;font-size:14px;margin-bottom:12px;outline:none}
input:focus{border-color:#00e5ff}
button{width:100%;padding:11px;background:#ffd700;color:#000;border:none;
       border-radius:8px;font-size:14px;font-weight:700;cursor:pointer}
.err{color:#ff4466;font-size:12px;margin-top:8px;display:none}
</style>
</head>
<body>
<div class="box">
  <h1>GCZ DevTools</h1>
  <p>Admin authentication required</p>
  <form method="GET" action="/auth">
    <input type="hidden" name="redirect" value="${redirectTo}">
    <input type="password" name="token" placeholder="Admin token" autofocus>
    <button type="submit">Unlock</button>
  </form>
</div>
</body>
</html>`;
}

// ─── Admin auth route ─────────────────────────────────────────────────────────
app.get('/auth', (req, res) => {
  const cfg = loadAdminConfig();
  const { token, redirect: redir } = req.query;
  if (token === cfg.adminToken) {
    req.session.admin = true;
    return res.redirect(redir || '/');
  }
  res.status(403).send(adminLoginPage(redir || '/'));
});

// ─── Static files (public — must come before admin middleware) ────────────────
// Icons and PWA files are public (needed for Android install)
app.get('/icons/icon-:size.png', (req, res) => {
  const size = parseInt(req.params.size) || 192;
  const safe = Math.min(Math.max(size, 16), 512);
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(makePng(safe));
});
app.get('/manifest.json',    requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public/manifest.json')));
app.get('/sw.js',            requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public/sw.js')));

// ─── DevTools UI (admin only) ─────────────────────────────────────────────────
app.get('/', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// ─── PROXY route (admin only) ─────────────────────────────────────────────────
app.get('/proxy', requireAdmin, async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'No URL provided' });

  let targetUrl;
  try { targetUrl = new URL(target.startsWith('http') ? target : 'https://' + target); }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const domain      = targetUrl.hostname;
  const cookieHeader = getCookieHeader(domain);
  const startTime   = Date.now();
  const chain       = [];

  const entry = { id: Date.now(), method: 'GET', url: target, domain, status: null, duration: null, timestamp: new Date().toISOString() };

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

      if ([301,302,303,307,308].includes(response.status)) {
        const loc = response.headers.get('location');
        if (!loc) break;
        currentUrl = loc.startsWith('http') ? loc : new URL(loc, currentUrl).href;
        hops++;
        continue;
      }
      break;
    }

    entry.status       = response.status;
    entry.duration     = Date.now() - startTime;
    entry.redirectChain = chain;
    entry.finalUrl     = currentUrl;

    if (scannerActive) {
      networkLog.unshift(entry); saveNetworkLog();
      if (chain.length > 1) { redirectLog.unshift({ id: entry.id, timestamp: entry.timestamp, chain, finalUrl: currentUrl, domain }); saveRedirectLog(); }
    }

    const contentType = response.headers.get('content-type') || 'text/html';
    let body = await response.text();

    if (contentType.includes('text/html')) {
      body = body
        .replace(/(href|src|action)="(\/[^"]+)"/g, (_, attr, p) => `${attr}="/proxy?url=${encodeURIComponent(new URL(p, targetUrl.origin).href)}"`)
        .replace(/<head>/i, `<head><base href="${targetUrl.origin}/">`);
    }

    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.set('Content-Type', contentType);
    res.set('X-Final-Url', currentUrl);
    res.set('X-Redirect-Count', String(chain.length - 1));
    res.send(body);
  } catch (err) {
    entry.status = 0; entry.error = err.message; entry.duration = Date.now() - startTime;
    if (scannerActive) { networkLog.unshift(entry); saveNetworkLog(); }
    res.status(502).json({ error: err.message, entry });
  }
});

// ─── Share-link proxy (public — validated by token) ───────────────────────────
app.get('/share-proxy', async (req, res) => {
  const { token: tokenId, url: target } = req.query;
  if (!tokenId || !target) return res.status(400).send('Missing parameters');

  const t = shareTokens[tokenId];
  if (!isTokenValid(t)) return res.status(403).send('Link expired or invalid');

  let targetUrl;
  try { targetUrl = new URL(target.startsWith('http') ? target : 'https://' + target); }
  catch { return res.status(400).send('Invalid URL'); }

  const domain      = t.domain || targetUrl.hostname;
  const cookieHeader = getCookieHeader(domain);

  try {
    const response = await fetch(targetUrl.href, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
      },
    });

    const setCookie = response.headers.raw()['set-cookie'];
    if (setCookie) mergeCookies(domain, setCookie);

    const contentType = response.headers.get('content-type') || 'text/html';
    let body = await response.text();

    if (contentType.includes('text/html')) {
      const finalOrigin = new URL(response.url || targetUrl.href).origin;
      // Rewrite absolute paths through share-proxy
      body = body
        .replace(/(href|src|action)="(\/[^"]+)"/g, (_, attr, p) =>
          `${attr}="/share-proxy?token=${encodeURIComponent(tokenId)}&url=${encodeURIComponent(new URL(p, finalOrigin).href)}"`)
        .replace(/<head>/i, `<head><base href="${finalOrigin}/">`);
    }

    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.set('Content-Type', contentType);
    res.send(body);
  } catch (err) {
    res.status(502).send(`Error: ${err.message}`);
  }
});

// ─── API routes (admin only) ──────────────────────────────────────────────────
app.use('/api', requireAdmin);

// ─── API: scanner toggle ──────────────────────────────────────────────────────
app.post('/api/scanner', (req, res) => {
  scannerActive = req.body.active === true || req.body.active === 'true';
  res.json({ active: scannerActive });
});
app.get('/api/scanner', (req, res) => res.json({ active: scannerActive }));

// ─── API: network log ─────────────────────────────────────────────────────────
app.get('/api/network', (req, res) => {
  const filter = req.query.filter || '';
  const log = filter ? networkLog.filter(e => e.url.toLowerCase().includes(filter.toLowerCase())) : networkLog;
  res.json(log.slice(0, 200));
});
app.delete('/api/network', (req, res) => { networkLog = []; saveNetworkLog(); res.json({ cleared: true }); });

// ─── API: redirect log ────────────────────────────────────────────────────────
app.get('/api/redirects', (req, res) => res.json(redirectLog.slice(0, 100)));
app.delete('/api/redirects', (req, res) => { redirectLog = []; saveRedirectLog(); res.json({ cleared: true }); });

// ─── API: sessions / cookies ──────────────────────────────────────────────────
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
app.delete('/api/sessions/:domain', (req, res) => { delete cookieStore[req.params.domain]; saveSessions(); res.json({ cleared: true }); });
app.delete('/api/sessions', (req, res) => { cookieStore = {}; saveSessions(); res.json({ cleared: true }); });

// ─── API: session status ──────────────────────────────────────────────────────
app.get('/api/session-status', (req, res) => {
  res.json({
    telegram: !!(cookieStore['web.telegram.org'] && cookieStore['web.telegram.org'].length),
    discord:  !!(cookieStore['discord.com']       && cookieStore['discord.com'].length),
    domains:  Object.keys(cookieStore).map(d => ({ domain: d, count: cookieStore[d].length })),
  });
});

// ─── API: share links ─────────────────────────────────────────────────────────
app.get('/api/share', (req, res) => {
  const list = Object.entries(shareTokens).map(([id, t]) => ({
    id,
    label:     t.label,
    targetUrl: t.targetUrl,
    domain:    t.domain,
    active:    t.active && isTokenValid(t),
    createdAt: t.createdAt,
    expiresAt: t.expiresAt || null,
    maxUses:   t.maxUses   || null,
    useCount:  t.useCount  || 0,
    link:      `${BASE}/${id}`,
  }));
  res.json(list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post('/api/share/create', (req, res) => {
  const { domain, targetUrl, label, ttlMinutes, maxUses } = req.body;
  if (!domain || !targetUrl) return res.status(400).json({ error: 'domain and targetUrl required' });

  if (!cookieStore[domain] || !cookieStore[domain].length) {
    return res.status(400).json({ error: `No saved session for ${domain}` });
  }

  const id    = crypto.randomBytes(18).toString('hex');
  const token = {
    label:     label || domain,
    targetUrl,
    domain,
    active:    true,
    createdAt: new Date().toISOString(),
    expiresAt: ttlMinutes ? new Date(Date.now() + ttlMinutes * 60000).toISOString() : null,
    maxUses:   maxUses ? parseInt(maxUses) : null,
    useCount:  0,
  };
  shareTokens[id] = token;
  saveShareTokens();
  res.json({ id, link: `${BASE}/${id}`, token });
});

app.delete('/api/share/:id', (req, res) => {
  delete shareTokens[req.params.id];
  saveShareTokens();
  res.json({ deleted: true });
});

app.post('/api/share/:id/revoke', (req, res) => {
  if (!shareTokens[req.params.id]) return res.status(404).json({ error: 'not found' });
  shareTokens[req.params.id].active = false;
  saveShareTokens();
  res.json({ revoked: true });
});

// ─── API: saved tests ────────────────────────────────────────────────────────
app.get('/api/test/saved', (req, res) => { try { res.json(JSON.parse(fs.readFileSync(SAVED_TESTS_FILE, 'utf8'))); } catch { res.json([]); } });
app.post('/api/test/saved', (req, res) => {
  const { name, url, method, headers, body } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  let tests = [];
  try { tests = JSON.parse(fs.readFileSync(SAVED_TESTS_FILE, 'utf8')); } catch {}
  const id = Date.now().toString();
  tests.push({ id, name, url, method: method||'GET', headers: headers||{}, body: body||null, created: new Date().toISOString() });
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

// ─── API: run test request ───────────────────────────────────────────────────
app.all('/api/test/request', async (req, res) => {
  const { url, method = 'GET', headers = {}, body } = { ...req.query, ...req.body };
  if (!url) return res.status(400).json({ error: 'url required' });

  let targetUrl;
  try { targetUrl = new URL(url.startsWith('http') ? url : 'https://' + url); }
  catch { return res.status(400).json({ error: 'invalid url' }); }

  const domain      = targetUrl.hostname;
  const cookieHeader = getCookieHeader(domain);
  const startTime   = Date.now();

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
    const text        = await response.text();
    let parsed        = null;
    if (contentType.includes('application/json')) { try { parsed = JSON.parse(text); } catch {} }

    const entry = { id: Date.now(), method, url: targetUrl.href, domain, status: response.status, duration: Date.now() - startTime, timestamp: new Date().toISOString() };
    networkLog.unshift(entry); saveNetworkLog();

    res.json({ status: response.status, headers: Object.fromEntries(response.headers.entries()), body: parsed || text.slice(0, 5000), duration: entry.duration, cookiesSaved: cookieStore[domain]?.length || 0 });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── API: iframe check ───────────────────────────────────────────────────────
app.get('/api/iframe-check', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'No URL' });
  try {
    const url      = target.startsWith('http') ? target : 'https://' + target;
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    const xfo      = response.headers.get('x-frame-options') || '';
    const csp      = response.headers.get('content-security-policy') || '';
    const blocked  = /DENY|SAMEORIGIN/i.test(xfo) || /frame-ancestors/i.test(csp);
    res.json({ blocked, xfo, csp, status: response.status });
  } catch (err) {
    res.json({ blocked: true, error: err.message });
  }
});

// ─── Claude config (legacy API key storage) ───────────────────────────────────
const CLAUDE_CONFIG_FILE = path.join(DATA_DIR, 'claude-config.json');
function loadClaudeConfig()    { try { return JSON.parse(fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf8')); } catch { return {}; } }
function saveClaudeConfig(cfg) { fs.writeFileSync(CLAUDE_CONFIG_FILE, JSON.stringify(cfg, null, 2)); }

// ─── Claude CLI call ──────────────────────────────────────────────────────────
function callViaCLI(prompt) {
  return new Promise((resolve, reject) => {
    // Remove CLAUDECODE env var to allow nested claude calls
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SESSION;

    const child = execFile(
      CLI_BIN,
      ['--print', '--no-markdown', '-p', prompt],
      { timeout: 90_000, maxBuffer: 8 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout.trim());
      }
    );
    child.on('error', reject);
  });
}

async function callViaApiKey(systemPrompt, messages) {
  const cfg    = loadClaudeConfig();
  const apiKey = cfg.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('No API key configured');
  const r    = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2048, system: systemPrompt, messages }),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.[0]?.text || 'No response';
}

// ─── API: Claude status ────────────────────────────────────────────────────────
app.get('/api/claude/status', (req, res) => {
  const cfg    = loadClaudeConfig();
  const hasKey = !!(cfg.apiKey || process.env.ANTHROPIC_API_KEY);
  res.json({
    online:       claudeActive && (!!CLI_BIN || hasKey),
    active:       claudeActive,
    cliAvailable: !!CLI_BIN,
    cliBin:       CLI_BIN || null,
    hasKey,
    model:        'claude-sonnet-4-6',
    authMode:     CLI_BIN ? 'claude-cli-pro' : (hasKey ? 'api-key' : 'none'),
    historyCount: chatHistory.length,
  });
});

// ─── API: Claude activate / deactivate ────────────────────────────────────────
app.post('/api/claude/activate', (req, res) => {
  claudeActive = true;
  res.json({ active: true, online: !!CLI_BIN || !!(loadClaudeConfig().apiKey || process.env.ANTHROPIC_API_KEY) });
});
app.post('/api/claude/deactivate', (req, res) => {
  claudeActive = false;
  res.json({ active: false });
});

// ─── API: save API key / bridge config (kept for compatibility) ────────────────
app.post('/api/claude/set-key', (req, res) => {
  const { key } = req.body;
  if (!key || !key.startsWith('sk-')) return res.status(400).json({ error: 'Invalid key format' });
  const cfg = loadClaudeConfig(); cfg.apiKey = key; saveClaudeConfig(cfg);
  res.json({ saved: true });
});
app.post('/api/claude/set-bridge', (req, res) => {
  const { vpsUrl, token } = req.body;
  if (!vpsUrl) return res.status(400).json({ error: 'vpsUrl required' });
  const cfg = loadClaudeConfig(); cfg.vpsUrl = vpsUrl.replace(/\/$/, ''); cfg.bridgeToken = token || ''; saveClaudeConfig(cfg);
  res.json({ saved: true });
});
app.get('/api/claude/bridge-status', (req, res) => {
  res.json({ connected: !!CLI_BIN, source: CLI_BIN ? 'claude-cli-pro' : 'none', model: 'claude-sonnet-4-6' });
});

// ─── API: Claude chat ─────────────────────────────────────────────────────────
app.post('/api/claude/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  if (!claudeActive) return res.status(503).json({ error: 'Claude is deactivated. Enable it in the Chat panel.' });

  const sessionSummary = Object.keys(cookieStore).map(d => `${d} (${cookieStore[d].length} cookies)`).join(', ') || 'none';
  const tgUser = tgAuthData ? `${tgAuthData.first_name} (@${tgAuthData.username || tgAuthData.id})` : 'not logged in';

  const systemPrompt = `You are Claude, embedded in the GambleCodez DevTools — a private developer testing console at ${BASE}.

You are running on the VPS as Claude Code Pro (claude-cli) with full tool access.

Current context:
- Saved browser sessions: ${sessionSummary}
- Telegram user: ${tgUser}
- DevTools API (localhost): http://127.0.0.1:${PORT}

Available API calls you can instruct or execute:
- Test HTTP endpoint (with cookies): POST /api/test/request {url, method, headers, body}
- Create share link: POST /api/share/create {domain, targetUrl, label, ttlMinutes, maxUses}
- List sessions: GET /api/sessions
- Check session status: GET /api/session-status

To test a bot endpoint with the user's session:
  curl -s -X POST http://127.0.0.1:${PORT}/api/test/request \\
    -H 'Content-Type: application/json' \\
    -d '{"url":"https://example.com/api/test","method":"GET"}'

You help the developer test websites, Discord bots, Telegram bots, OAuth flows, redirect chains, daily reward flows.
Be concise, technical, and direct. You maintain conversation memory.`;

  const apiMessages = [
    ...chatHistory.slice(-CONTEXT_MSGS).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message.trim() },
  ];

  let reply   = '';
  let authUsed = '';

  try {
    if (CLI_BIN) {
      const historyBlock = chatHistory.slice(-CONTEXT_MSGS)
        .map(h => `${h.role === 'user' ? 'Human' : 'Assistant'}: ${h.content}`)
        .join('\n\n');
      const cliPrompt = `${systemPrompt}\n\n${historyBlock ? historyBlock + '\n\n' : ''}Human: ${message.trim()}\n\nAssistant:`;
      reply    = await callViaCLI(cliPrompt);
      authUsed = 'claude-cli-pro';
    } else {
      reply    = await callViaApiKey(systemPrompt, apiMessages);
      authUsed = 'api-key';
    }
  } catch (cliErr) {
    // CLI failed — try API key fallback
    const cfg    = loadClaudeConfig();
    const hasKey = !!(cfg.apiKey || process.env.ANTHROPIC_API_KEY);
    if (hasKey) {
      try {
        reply    = await callViaApiKey(systemPrompt, apiMessages);
        authUsed = 'api-key-fallback';
      } catch (apiErr) {
        return res.status(502).json({ error: apiErr.message });
      }
    } else {
      return res.status(502).json({ error: `Claude CLI failed: ${cliErr.message}. Configure API key as fallback.` });
    }
  }

  const ts = new Date().toISOString();
  chatHistory.push({ role: 'user',      content: message.trim(), ts });
  chatHistory.push({ role: 'assistant', content: reply,          ts });
  saveChatHistory();

  res.json({ reply, authMode: authUsed, historyCount: chatHistory.length });
});

// ─── API: clear chat history ──────────────────────────────────────────────────
app.post('/api/claude/clear', (req, res) => {
  const count = chatHistory.length;
  chatHistory = [];
  saveChatHistory();
  res.json({ ok: true, cleared: count });
});

// ─── Telegram Login Widget + Auth ─────────────────────────────────────────────
// Public page (no admin required) — user opens this to authenticate via Telegram
app.get('/tg-login', (req, res) => {
  const botUsername = req.query.bot || (loadClaudeConfig().tgBotUsername || '');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram Login — GCZ DevTools</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0f;color:#e0e0f0;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:20px}
.box{background:#111118;border:1px solid #ffd700;border-radius:14px;padding:28px;width:min(90vw,380px);text-align:center}
h1{color:#ffd700;font-size:18px;margin-bottom:8px}
p{color:#6060a0;font-size:12px;margin-bottom:20px;line-height:1.5}
.status{padding:10px;border-radius:8px;font-size:13px;margin-top:12px}
.status.ok{background:#003322;color:#00ff88;border:1px solid #00ff88}
.status.err{background:#2a0a0a;color:#ff4466;border:1px solid #ff4466}
form{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}
input{background:#1a1a26;border:1px solid #2a2a3a;border-radius:8px;color:#e0e0f0;padding:8px 12px;font-size:13px;outline:none}
input:focus{border-color:#00e5ff}
button{padding:10px;background:#ffd700;color:#000;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px}
</style>
</head>
<body>
<div class="box">
  <h1>✈ Telegram Login</h1>
  <p>Log in with your Telegram account so DevTools can test your bots authenticated as you.</p>
  ${botUsername ? `
  <div id="tg-widget-wrap">
    <script async src="https://telegram.org/js/telegram-widget.js?22"
      data-telegram-login="${botUsername}"
      data-size="large"
      data-auth-url="${BASE}/tg-auth"
      data-request-access="write">
    </script>
  </div>` : `
  <form onsubmit="saveBotUsername(event)">
    <p style="color:#ffaa00;font-size:11px;margin-bottom:8px">Enter your bot's username to show the login widget:<br>(Register domain <code style="color:#00e5ff">${BASE.replace(/https?:\/\/[^/]+/, 'bot.gamblecodez.com')}</code> with @BotFather /setdomain first)</p>
    <input id="bot-input" placeholder="your_bot_username (without @)" autofocus>
    <button type="submit">Show Login Widget</button>
  </form>
  <script>
  function saveBotUsername(e) {
    e.preventDefault();
    const bot = document.getElementById('bot-input').value.trim().replace('@','');
    if (bot) window.location = '/tg-login?bot=' + encodeURIComponent(bot);
  }
  </script>`}
  <div id="auth-status"></div>
</div>
<script>
// Check if already authenticated
fetch('/api/tg-auth').then(r=>r.json()).then(d=>{
  if(d && d.id) {
    document.getElementById('auth-status').innerHTML =
      '<div class="status ok">✓ Authenticated as ' + (d.first_name||'') + ' ' + (d.last_name||'') + ' (@' + (d.username||d.id) + ')</div>';
  }
}).catch(()=>{});
</script>
</body>
</html>`);
});

// Telegram auth callback (receives GET redirect from widget or POST)
app.get('/tg-auth', (req, res) => {
  const { hash, auth_date, id, first_name, last_name, username, photo_url } = req.query;
  if (!hash || !auth_date || !id) return res.status(400).send('Invalid auth data');

  // Verify hash (requires bot token — stored in config)
  const cfg = loadClaudeConfig();
  const botToken = cfg.tgBotToken || process.env.TG_BOT_TOKEN;

  if (botToken) {
    const dataCheckArr = Object.entries({ auth_date, first_name, id, last_name, photo_url, username })
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`);
    const dataCheckStr = dataCheckArr.join('\n');
    const secretKey = crypto.createHash('sha256').update(botToken).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckStr).digest('hex');
    if (expectedHash !== hash) return res.status(403).send('Invalid hash — authentication failed');
    if (Date.now() / 1000 - parseInt(auth_date) > 86400) return res.status(403).send('Auth date expired');
  }

  tgAuthData = { id, first_name, last_name, username, photo_url, auth_date, hash, savedAt: new Date().toISOString() };
  saveTgAuth();

  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram Auth</title>
<style>body{background:#0a0a0f;color:#e0e0f0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center}
h1{color:#00ff88;font-size:20px;margin-bottom:8px}p{color:#6060a0;font-size:13px}</style>
</head><body><div>
<h1>✓ Authenticated as ${first_name}!</h1>
<p>Your Telegram session is saved in DevTools.<br>Claude can now test your bots as you.<br>You can close this tab.</p>
</div></body></html>`);
});

app.get('/api/tg-auth', (req, res) => res.json(tgAuthData || null));
app.delete('/api/tg-auth', (req, res) => { tgAuthData = null; try { fs.unlinkSync(TG_AUTH_FILE); } catch {} res.json({ cleared: true }); });

// ─── API: set Telegram bot token (for auth widget) ────────────────────────────
app.post('/api/claude/set-tg-bot', (req, res) => {
  const { botUsername, botToken } = req.body;
  const cfg = loadClaudeConfig();
  if (botUsername) cfg.tgBotUsername = botUsername.replace('@', '');
  if (botToken)    cfg.tgBotToken    = botToken;
  saveClaudeConfig(cfg);
  res.json({ saved: true });
});

// ─── API: admin info ─────────────────────────────────────────────────────────
app.get('/api/admin/info', (req, res) => {
  const cfg = loadAdminConfig();
  res.json({ loginUrl: `${BASE}/auth?token=${cfg.adminToken}` });
});

// ─── API: admin token reset ───────────────────────────────────────────────────
app.post('/api/admin/reset-token', (req, res) => {
  const cfg = loadAdminConfig();
  cfg.adminToken = crypto.randomBytes(24).toString('hex');
  saveAdminConfig(cfg);
  // Update in-memory ref
  adminCfg.adminToken = cfg.adminToken;
  res.json({ adminToken: cfg.adminToken, loginUrl: `${BASE}/auth?token=${cfg.adminToken}` });
});

// ─── Share link view (public) — catch-all before static ──────────────────────
app.get('/:tokenId', (req, res, next) => {
  const { tokenId } = req.params;
  // Let known paths fall through
  if (['proxy', 'auth', 'share-proxy', 'icons', 'manifest.json', 'sw.js', 'favicon.ico'].includes(tokenId)) return next();

  const t = shareTokens[tokenId];
  if (!isTokenValid(t)) {
    return res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link Expired</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0a0a0f;color:#e0e0f0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center}
h1{color:#ffd700;font-size:22px;margin-bottom:10px}p{color:#6060a0;font-size:14px}</style>
</head><body><div><h1>Link Expired</h1><p>This share link is no longer valid.</p></div></body></html>`);
  }

  // One-use: mark used after serving (but don't block on expiry yet — let them see it)
  consumeToken(tokenId);

  const targetUrl    = t.targetUrl;
  const proxyUrl     = `/share-proxy?token=${encodeURIComponent(tokenId)}&url=${encodeURIComponent(targetUrl)}`;
  const expiryNote   = t.expiresAt ? `Expires: ${new Date(t.expiresAt).toLocaleString()}` : (t.maxUses ? `Uses: ${t.useCount}/${t.maxUses}` : 'No expiry');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.label || t.domain} — GCZ DevView</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:#0a0a0f;color:#e0e0f0;font-family:system-ui,sans-serif;display:flex;flex-direction:column}
#topbar{display:flex;align-items:center;gap:10px;padding:8px 12px;background:#111118;border-bottom:2px solid #ffd700;flex-shrink:0}
#brand{font-size:12px;font-weight:700;color:#ffd700;letter-spacing:1px}
#site-label{flex:1;font-size:12px;color:#00e5ff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#expiry{font-size:10px;color:#6060a0}
#view{flex:1;display:flex;flex-direction:column}
#view-frame{flex:1;border:none;width:100%;height:100%}
#loading{display:flex;align-items:center;justify-content:center;flex:1;color:#6060a0;font-size:13px}
</style>
</head>
<body>
<div id="topbar">
  <span id="brand">GCZ</span>
  <span id="site-label">${t.label || t.domain}</span>
  <span id="expiry">${expiryNote}</span>
</div>
<div id="view">
  <div id="loading">Loading authenticated view...</div>
  <iframe id="view-frame" style="display:none" src="${proxyUrl}"
    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation allow-pointer-lock allow-downloads allow-modals allow-storage-access-by-user-activation"
    allow="camera; microphone; geolocation; clipboard-read; clipboard-write; fullscreen; display-capture; payment; accelerometer; gyroscope; magnetometer; autoplay"
    allowfullscreen></iframe>
</div>
<script>
const fr = document.getElementById('view-frame');
const ld = document.getElementById('loading');
fr.onload = () => { ld.style.display='none'; fr.style.display='block'; };
fr.onerror = () => { ld.textContent = 'Failed to load site.'; };
</script>
</body>
</html>`);
});

// ─── PNG icon generator ───────────────────────────────────────────────────────
function makePng(size) {
  const w = size, h = size;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (1 + w * 3) + 1 + x * 3;
      const cx = x / w, cy = y / h;
      let r = 10, g = 10, b = 15;
      const edge = 0.06;
      if (cx < edge || cx > 1-edge || cy < edge || cy > 1-edge) { r = 255; g = 215; b = 0; }
      if (cy > 0.65 && cy < 0.68 && cx > 0.1 && cx < 0.9) { r = 0; g = 229; b = 255; }
      const gx = (cx - 0.5) * 2, gy = (cy - 0.45) * 2;
      const dist = Math.sqrt(gx*gx + gy*gy);
      if (dist < 0.7 && dist > 0.5 && !(gx > 0 && gy > -0.1 && gy < 0.3)) { r = 255; g = 215; b = 0; }
      if (gx > 0 && gx < 0.7 && gy > -0.05 && gy < 0.15) { r = 255; g = 215; b = 0; }
      raw[i] = r; raw[i+1] = g; raw[i+2] = b;
    }
  }
  const compressed = zlib.deflateSync(raw);
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c; }
    return t;
  })();
  function crc32(buf) { let c = 0xFFFFFFFF; for (const b of buf) { c = (c >>> 8) ^ CRC_TABLE[(c ^ b) & 0xFF]; } return (c ^ 0xFFFFFFFF) >>> 0; }
  function chunk(type, data) {
    const typeBuf = Buffer.from(type), lenBuf = Buffer.allocUnsafe(4), crcBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32BE(data.length); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4); ihdr[8]=8; ihdr[9]=2; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0;
  return Buffer.concat([sig, chunk('IHDR',ihdr), chunk('IDAT',compressed), chunk('IEND',Buffer.alloc(0))]);
}

// ─── start ────────────────────────────────────────────────────────────────────
const cfg = loadAdminConfig();
app.listen(PORT, '127.0.0.1', () => {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║     GambleCodez // DevTools  v3.0                           ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Local:    http://127.0.0.1:${PORT}                              ║`);
  console.log(`║  Public:   ${BASE}/                        ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  ADMIN LOGIN URL (keep private):                             ║');
  console.log(`║  ${BASE}/auth?token=${cfg.adminToken}  ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  Open the login URL in Chrome Android once to unlock.        ║');
  console.log('║  Then add to home screen as PWA.                             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
});
