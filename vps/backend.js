'use strict';
// =============================================================================
// Runewager Endpoint — companion HTTP service on port 3001
//
// Responsibilities:
//   - Autofix AI webhook receiver (POST /autofix/webhook)
//   - GET /autofix/test  — signature self-test
//   - GET /health        — basic liveness
//   - GET /health/full   — detailed diagnostic snapshot
//   - Telegram admin broadcast helper (sendAdmin)
//   - Structured request/event logging to logs/backend.log
//   - Graceful SIGTERM/SIGINT shutdown
//   - Claude bridge — proxied via nginx at https://gamblecodez.com/claude
//       GET  /claude/status   — no auth, safe to poll
//       POST /claude/chat     — auth required (CLAUDE_BRIDGE_TOKEN)
//       POST /claude/clear    — auth required
//     Auth mode: Claude CLI subprocess (Pro device-code login) preferred,
//                falls back to ANTHROPIC_API_KEY if CLI unavailable.
//
// This service does NOT run Telegram polling (index.js owns that).
// =============================================================================

require('dotenv').config();

const express                    = require('express');
const crypto                     = require('crypto');
const fs                         = require('fs');
const https                      = require('https');
const os                         = require('os');
const path                       = require('path');
const { execFile, execFileSync } = require('child_process');
const { globalThrottle, stats: rlStats } = require('./rateLimiter');
const { getActivePromoFromDb, invalidateActivePromoCache, normalizePromoAudience } = require('./promo-message');

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT              = parseInt(process.env.ENDPOINT_PORT    ?? '3001', 10);
const AUTOFIX_SECRET    = process.env.AUTOFIX_SECRET            ?? '';
const TG_TOKEN          = process.env.TELEGRAM_BOT_TOKEN ?? process.env.BOT_TOKEN ?? '';
const ADMIN_CHAT_IDS    = (process.env.ADMIN_IDS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);

// Claude bridge config — add these to .env:
//   ANTHROPIC_API_KEY=sk-ant-...
//   CLAUDE_BRIDGE_TOKEN=your-secret-token   (Web Lab uses this)
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY  ?? '';
const CLAUDE_BRIDGE_TOKEN = process.env.CLAUDE_BRIDGE_TOKEN ?? '';

// ─── Structured Logging ──────────────────────────────────────────────────────

const LOG_DIR      = path.join(__dirname, 'logs');
const LOG_FILE     = path.join(LOG_DIR, 'backend.log');
const ERR_FILE     = path.join(LOG_DIR, 'backend-error.log');
const CLAUDE_HIST  = path.join(LOG_DIR, 'claude-history.json');

let _logStream = null;
let _errStream = null;

try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    _logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    _errStream = fs.createWriteStream(ERR_FILE, { flags: 'a' });
    _logStream.on('error', (e) => { _logStream = null; console.error(`[backend] log stream error: ${e.message}`); });
    _errStream.on('error', (e) => { _errStream = null; console.error(`[backend] err stream error: ${e.message}`); });
} catch (e) {
    console.error(`[backend] Cannot open log files in ${LOG_DIR}: ${e.message}`);
}

const logger = {
    _entry(level, eventType, msg, extra) {
        return { ts: new Date().toISOString(), level, eventType, msg, ...extra };
    },
    _write(streams, obj) {
        const line = JSON.stringify(obj) + '\n';
        const writable = streams.filter((s) => s && !s.destroyed && s.writable);
        if (writable.length > 0) {
            for (const s of writable) {
                try { s.write(line); } catch (e) { console.error(`[backend] stream write error: ${e.message}`); }
            }
        } else {
            console.log(line.trimEnd());
        }
    },
    info(eventType, msg, extra = {}) {
        this._write([_logStream], this._entry('info', eventType, msg, extra));
    },
    error(eventType, msg, extra = {}) {
        this._write([_logStream, _errStream], this._entry('error', eventType, msg, extra));
    },
    event(eventType, msg, extra = {}) {
        this._write([_logStream], this._entry('event', eventType, msg, extra));
    },
};

// ─── Telegram Admin Broadcast ─────────────────────────────────────────────────

function sendAdmin(msg) {
    if (!TG_TOKEN || ADMIN_CHAT_IDS.length === 0) return Promise.resolve();

    const sendOne = (chatId) =>
        globalThrottle(() => new Promise((resolve) => {
            const body = JSON.stringify({ chat_id: chatId, text: String(msg) });
            const req = https.request({
                hostname: 'api.telegram.org',
                path:     `/bot${TG_TOKEN}/sendMessage`,
                method:   'POST',
                headers:  {
                    'Content-Type':   'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            }, () => resolve());
            req.setTimeout(10_000, () => { req.destroy(); resolve(); });
            req.on('error', () => resolve());
            req.write(body);
            req.end();
        }));

    return Promise.all(ADMIN_CHAT_IDS.map(sendOne)).then(() => {}).catch((err) => {
        console.error('[sendAdmin] broadcast error:', err && err.message);
    });
}

// ─── HMAC Signature Verification ─────────────────────────────────────────────

function verifySignature(rawBody, signature) {
    if (!AUTOFIX_SECRET) return false;
    const expected = crypto
        .createHmac('sha256', AUTOFIX_SECRET)
        .update(rawBody)
        .digest('hex');
    const sig = (signature ?? '').replace(/^sha256=/, '');
    if (sig.length !== expected.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
    } catch {
        return false;
    }
}

// ─── Claude Bridge — history + auth ──────────────────────────────────────────

let claudeHistory = [];
try { claudeHistory = JSON.parse(fs.readFileSync(CLAUDE_HIST, 'utf8')); } catch {}

function saveClaudeHistory() {
    try { fs.writeFileSync(CLAUDE_HIST, JSON.stringify(claudeHistory.slice(-100), null, 2)); } catch {}
}

function claudeAuth(req, res, next) {
    if (!CLAUDE_BRIDGE_TOKEN) {
        // no token configured — reject all requests for safety
        logger.error('claude.auth', 'CLAUDE_BRIDGE_TOKEN not set — rejecting request', { requestId: req.id });
        return res.status(503).json({ error: 'Claude bridge not configured on server' });
    }
    const token = req.headers['x-bridge-token'] || req.query.token;
    if (token !== CLAUDE_BRIDGE_TOKEN) {
        logger.error('claude.auth', 'Invalid bridge token', { requestId: req.id });
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();

// requestId middleware
app.use((req, _res, next) => {
    req.id = crypto.randomBytes(5).toString('hex');
    next();
});

// Raw body capture for HMAC on /autofix routes
app.use('/autofix', (req, res, next) => {
    express.raw({ type: '*/*', limit: '1mb' })(req, res, (err) => {
        if (err) return next(err);
        if (Buffer.isBuffer(req.body)) req.rawBody = req.body;
        next();
    });
});
app.use(express.json({ limit: '2mb' }));

// ─── GET /health ──────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
    logger.info('http.health', 'Health check', { requestId: req.id });
    res.json({
        ok:        true,
        service:   'runewager-endpoint',
        uptimeSec: Math.floor(process.uptime()),
    });
});

// ─── GET /health/full ─────────────────────────────────────────────────────────

app.get('/health/full', (req, res) => {
    const mem      = process.memoryUsage();
    const [load1]  = os.loadavg();
    logger.info('http.health.full', 'Full health check', { requestId: req.id });
    res.json({
        ok:                       true,
        service:                  'runewager-endpoint',
        uptimeSec:                Math.floor(process.uptime()),
        nodeVersion:              process.version,
        memoryMB: {
            rss:      +(mem.rss      / 1_048_576).toFixed(1),
            heapUsed: +(mem.heapUsed / 1_048_576).toFixed(1),
        },
        cpuLoad:                  +load1.toFixed(2),
        activeTelegramPolling:    false,
        autofixWebhookRegistered: Boolean(AUTOFIX_SECRET),
        adminChatIdsConfigured:   ADMIN_CHAT_IDS.length,
        rateLimiter:              rlStats(),
        claudeBridge: {
            publicUrl:    'https://bot.gamblecodez.com/claude',
            authMode:     CLI_AVAILABLE ? 'claude-cli-pro' : (ANTHROPIC_API_KEY ? 'api-key' : 'none'),
            cliAvailable: CLI_AVAILABLE,
            hasApiKey:    Boolean(ANTHROPIC_API_KEY),
            hasToken:     Boolean(CLAUDE_BRIDGE_TOKEN),
            history:      claudeHistory.length,
        },
    });
});

// ─── Promo routes ─────────────────────────────────────────────────────────────

app.get('/promo/active', (req, res) => {
    const audience = normalizePromoAudience(req.query.audience || 'new_user');
    const promo = getActivePromoFromDb(audience, { logger });
    logger.info('http.promo.active', 'Active promo lookup', { requestId: req.id, audience, promoId: promo && promo.promo_id });
    res.json({
        ok: true,
        audience,
        cacheKey: audience === 'existing_user' ? 'active_existing_user_promo' : 'active_new_user_promo',
        promo: promo ? {
            promo_id:        promo.promo_id,
            code:            promo.code,
            amount:          promo.amount,
            name:            promo.name,
            description:     promo.description,
            casino_base_url: promo.casino_base_url,
        } : null,
    });
});

app.post('/promo/cache/invalidate', (req, res) => {
    const audience = req.body && req.body.audience ? normalizePromoAudience(req.body.audience) : null;
    invalidateActivePromoCache(audience, { logger, reason: 'backend_route' });
    res.json({ ok: true, audience: audience || 'all' });
});

// ─── GET /autofix/test ────────────────────────────────────────────────────────

app.get('/autofix/test', (req, res) => {
    const timestamp = new Date().toISOString();
    const payload   = JSON.stringify({ event: 'test', ts: timestamp, requestId: req.id });
    const sig       = AUTOFIX_SECRET
        ? 'sha256=' + crypto.createHmac('sha256', AUTOFIX_SECRET).update(payload).digest('hex')
        : '';
    const signatureValid = AUTOFIX_SECRET ? verifySignature(Buffer.from(payload), sig) : false;

    logger.event('autofix.test', 'Signature self-test', { requestId: req.id, signatureValid });
    res.json({ ok: true, signatureValid, timestamp, requestId: req.id, secretConfigured: Boolean(AUTOFIX_SECRET) });
});

// ─── POST /autofix/webhook ────────────────────────────────────────────────────

app.post('/autofix/webhook', async (req, res) => {
    const requestId = req.id;
    try {
        const sig     = req.headers['x-autofix-signature'] ?? req.headers['x-hub-signature-256'] ?? '';
        const rawBody = req.rawBody;

        if (!rawBody || !Buffer.isBuffer(rawBody)) {
            logger.error('autofix.webhook', 'Missing rawBody — raw-body middleware did not run', { requestId });
            return res.status(400).json({ ok: false, error: 'Bad request: missing body', requestId });
        }

        if (!AUTOFIX_SECRET || !verifySignature(rawBody, sig)) {
            const reason = !AUTOFIX_SECRET ? 'AUTOFIX_SECRET not configured' : 'Signature mismatch';
            logger.error('autofix.webhook', `${reason} — request rejected`, { requestId });
            return res.status(401).json({ ok: false, error: 'Invalid signature', requestId });
        }

        let payload;
        try { payload = JSON.parse(rawBody.toString('utf8')); } catch { payload = {}; }

        const eventName = payload.event ?? payload.action ?? 'unknown';
        logger.event('autofix.webhook', 'Autofix event received', { requestId, event: eventName });

        await sendAdmin(`🤖 Autofix [${requestId}]: ${eventName}`);

        res.json({ ok: true, requestId, received: true });
    } catch (err) {
        const summary = err?.message ?? String(err);
        logger.error('autofix.webhook', 'Handler error', { requestId, error: summary });
        await sendAdmin(`⚠️ Autofix webhook error [${requestId}]: ${summary}`).catch(() => {});
        res.status(500).json({ ok: false, error: 'Internal server error', requestId });
    }
});

// ─── Claude Bridge ────────────────────────────────────────────────────────────
//
// Public URL (via nginx SSL proxy): https://bot.gamblecodez.com/claude
// Internal:                         http://127.0.0.1:3001/claude
//
// Auth mode priority:
//   1. Claude CLI subprocess  — uses Pro account from `claude auth login`
//   2. ANTHROPIC_API_KEY      — fallback if CLI not installed / not authed
//
// Required .env:
//   CLAUDE_BRIDGE_TOKEN=your-secret-token   ← Web Lab uses this header
//   ANTHROPIC_API_KEY=sk-ant-...            ← optional fallback only
//
// One-time VPS setup:
//   npm install -g @anthropic-ai/claude-code
//   claude auth login    ← follow device code flow, links your Pro account
// ─────────────────────────────────────────────────────────────────────────────

// Detect whether `claude` CLI is installed and authenticated
function claudeCliAvailable() {
    try {
        execFileSync('claude', ['--version'], { timeout: 5000, stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

const CLI_AVAILABLE = claudeCliAvailable();
logger.info('claude.init', `Claude CLI ${CLI_AVAILABLE ? 'available ✓' : 'not found — will use API key'}`, {});

// Run a prompt through `claude -p` (non-interactive print mode)
// Returns the reply string or throws on error
function runClaudeCli(prompt, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
        const proc = execFile(
            'claude',
            ['--print', '--output-format', 'text', '-'],
            { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) return reject(new Error(stderr?.trim() || err.message));
                resolve(stdout.trim());
            },
        );
        proc.stdin.write(prompt);
        proc.stdin.end();
    });
}

// Build context-aware system prompt prefix (prepended to message for CLI mode)
function buildSystemPrompt(context) {
    return `[GambleCodez Web Lab — Runewager bridge context]
You are assisting the developer (GambleCodez) via a secure bridge on gamblecodez.com.
Current context:
- Tunnel URL: ${context?.tunnelUrl || 'none'}
- Loaded site: ${context?.currentUrl || 'none'}
- Saved sessions: ${context?.sessions || 'none'}
To test endpoints with stored cookies: POST http://127.0.0.1:3000/api/test/request {"url":"...","method":"GET"}
Be concise and technical.

User message: `;
}

// GET /claude/status — polled by Web Lab every 20 s (no auth required)
app.get('/claude/status', (req, res) => {
    logger.info('claude.status', 'Status poll', { requestId: req.id });
    res.json({
        online:       Boolean(CLAUDE_BRIDGE_TOKEN) && (CLI_AVAILABLE || Boolean(ANTHROPIC_API_KEY)),
        authMode:     CLI_AVAILABLE ? 'claude-cli-pro' : (ANTHROPIC_API_KEY ? 'api-key' : 'none'),
        cliAvailable: CLI_AVAILABLE,
        hasApiKey:    Boolean(ANTHROPIC_API_KEY),
        hasToken:     Boolean(CLAUDE_BRIDGE_TOKEN),
        model:        'claude-sonnet-4-6',
        service:      'runewager-endpoint',
        publicUrl:    'https://bot.gamblecodez.com/claude',
        historyCount: claudeHistory.length,
        uptimeSec:    Math.floor(process.uptime()),
    });
});

// POST /claude/chat — main chat endpoint (auth required)
app.post('/claude/chat', claudeAuth, async (req, res) => {
    const requestId = req.id;
    const { message, context } = req.body || {};

    if (!message) return res.status(400).json({ error: 'message required' });

    const notReady = !CLI_AVAILABLE && !ANTHROPIC_API_KEY;
    if (notReady) {
        return res.status(503).json({
            error: 'Claude not configured. Either run `claude auth login` on VPS or set ANTHROPIC_API_KEY in .env',
        });
    }

    logger.event('claude.chat', 'Chat request', { requestId, authMode: CLI_AVAILABLE ? 'cli' : 'api', msgLen: message.length });

    let reply;

    // ── Mode 1: Claude CLI (Pro account via device code login) ────────────────
    if (CLI_AVAILABLE) {
        try {
            // Build history prefix + current message for CLI
            const historyText = claudeHistory.slice(-10)
                .map(h => `${h.role === 'user' ? 'Human' : 'Assistant'}: ${h.content}`)
                .join('\n');
            const fullPrompt = buildSystemPrompt(context)
                + (historyText ? `\n\nConversation so far:\n${historyText}\n\nHuman: ` : '')
                + message;
            reply = await runClaudeCli(fullPrompt);
        } catch (cliErr) {
            logger.error('claude.chat', 'CLI failed — falling back to API key', { requestId, error: cliErr.message });
            // fall through to API key below
            if (!ANTHROPIC_API_KEY) {
                return res.status(502).json({ error: 'Claude CLI failed: ' + cliErr.message });
            }
        }
    }

    // ── Mode 2: Anthropic API key (fallback) ──────────────────────────────────
    if (!reply && ANTHROPIC_API_KEY) {
        const systemPrompt = `You are Claude, embedded in the GambleCodez Web Lab via the Runewager endpoint (gamblecodez.com/claude).
You assist GambleCodez with Runewager Telegram bot testing, casino/sweepstakes site testing, Discord bots, OAuth flows, daily rewards, redirect chains.
Context — tunnel: ${context?.tunnelUrl || 'none'} | site: ${context?.currentUrl || 'none'} | sessions: ${context?.sessions || 'none'}
Test endpoints via Web Lab: POST http://127.0.0.1:3000/api/test/request {"url":"...","method":"GET"}
Be concise and technical.`;

        const messages = [
            ...claudeHistory.slice(-20).map(h => ({ role: h.role, content: h.content })),
            { role: 'user', content: message },
        ];

        try {
            const fetchFn = globalThis.fetch ?? await import('node-fetch').then(m => m.default);
            const r = await fetchFn('https://api.anthropic.com/v1/messages', {
                method:  'POST',
                headers: {
                    'x-api-key':         ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01',
                    'content-type':      'application/json',
                },
                body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2048, system: systemPrompt, messages }),
            });
            const data = await r.json();
            if (data.error) throw new Error(data.error.message);
            reply = data.content?.[0]?.text || 'No response';
        } catch (apiErr) {
            logger.error('claude.chat', 'API key fallback failed', { requestId, error: apiErr.message });
            return res.status(502).json({ error: apiErr.message });
        }
    }

    // ── Save and respond ──────────────────────────────────────────────────────
    claudeHistory.push({ role: 'user',      content: message, ts: new Date().toISOString() });
    claudeHistory.push({ role: 'assistant', content: reply,   ts: new Date().toISOString() });
    saveClaudeHistory();

    logger.info('claude.chat', 'Reply sent', { requestId, replyLen: reply.length, authMode: CLI_AVAILABLE ? 'cli' : 'api' });
    res.json({ reply, historyCount: claudeHistory.length, authMode: CLI_AVAILABLE ? 'claude-cli-pro' : 'api-key' });
});

// POST /claude/clear — wipe conversation history
app.post('/claude/clear', claudeAuth, (req, res) => {
    logger.event('claude.clear', 'History cleared', { requestId: req.id });
    claudeHistory = [];
    saveClaudeHistory();
    res.json({ ok: true, cleared: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, '127.0.0.1', () => {
    logger.info('server.start', 'runewager-endpoint listening', {
        port:          PORT,
        claudeBridge:  Boolean(CLAUDE_BRIDGE_TOKEN && ANTHROPIC_API_KEY),
    });
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
    logger.info('server.shutdown', `${signal} received — shutting down gracefully`);
    server.close(() => {
        logger.info('server.shutdown', 'HTTP server closed — exiting cleanly');
        process.exit(0);
    });
    setTimeout(() => {
        logger.error('server.shutdown', 'Graceful shutdown timeout — forcing exit');
        process.exit(1);
    }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', err => {
    logger.error('process.uncaughtException', err.message, { stack: err.stack });
    sendAdmin(`💀 runewager-endpoint crash: ${err.message}`).finally(() => process.exit(1));
});

process.on('unhandledRejection', reason => {
    logger.error('process.unhandledRejection', String(reason));
});
