# GambleCodez // DevTools v3.0

Private developer testing console at `https://bot.gamblecodez.com/dev`

---

## Architecture

```
nginx → /dev/ → http://127.0.0.1:3002/
```

- **server.js** — Express app, all routes, SSE streaming, audit logging
- **public/index.html** — Single-page UI (tabs: Sessions, Claude, Share Links, Network, etc.)
- **data/** — Runtime data (gitignored). See table below.
- **scripts/log-rotate.sh** — Hourly cron, trims all logs when >1000 lines
- **.env** — Secrets loaded at startup (gitignored). Never committed.

---

## Starting the Server

```bash
cd /var/www/html/DevTools
NODE_NO_WARNINGS=1 PORT=3002 SKIP_TUNNEL=1 PUBLIC_BASE="https://bot.gamblecodez.com/dev" \
  nohup node server.js >> data/weblab.log 2>> data/weblab-error.log &
```

Or use `start.sh` which sets all env vars.

**To restart:** kill the existing process and re-run:
```bash
kill $(ps aux | grep "node /var/www/html/DevTools/server.js" | grep -v grep | awk '{print $2}')
NODE_NO_WARNINGS=1 PORT=3002 SKIP_TUNNEL=1 PUBLIC_BASE="https://bot.gamblecodez.com/dev" \
  nohup node server.js >> data/weblab.log 2>> data/weblab-error.log &
```

---

## Authentication

- Admin token: `ADMIN_TOKEN=980432` (from `.env`, never stored in git)
- Login URL: `https://bot.gamblecodez.com/dev/auth?token=980432`
- Session cookie lasts 14 days
- Localhost IP is always admin (no cookie needed)
- If session expires: browser shows red "Session expired" banner with re-auth link

---

## Environment Variables (`.env`)

| Variable | Description |
|---|---|
| `PORT` | Server port (3002) |
| `SKIP_TUNNEL` | Set to `1` on VPS — no ngrok tunnel |
| `PUBLIC_BASE` | Public URL base (`https://bot.gamblecodez.com/dev`) |
| `ADMIN_TOKEN` | Admin login token (`980432`) |
| `TG_BOT_TOKEN` | Telegram bot token for login widget |
| `TG_BOT_USERNAME` | Telegram bot username (`RuneWager_bot`) |
| `BRIDGE_TOKEN` | Bridge auth token |
| `ANTHROPIC_API_KEY` | Optional API key fallback if Claude CLI unavailable |

---

## Data Files

All in `/var/www/html/DevTools/data/` — gitignored.

| File | Contents |
|---|---|
| `sessions.json` | Saved browser cookies by domain |
| `share-tokens.json` | Active auth-share link tokens |
| `admin-config.json` | Admin token + session secret |
| `claude-config.json` | Claude config (no secrets — stripped before write) |
| `chat-history.json` | Last 40 Claude chat messages |
| `network.json` | Last 200 network scan entries |
| `redirects.json` | Last 100 redirect chain entries |
| `tg-auth.json` | Telegram OAuth user data |
| `audit.log` | JSON audit log of all key actions |
| `claude.log` | Full Claude conversation log (user + assistant) |
| `weblab.log` | Server stdout log |
| `weblab-error.log` | Server stderr log |

---

## Audit Logs

### View audit log (last 200 events):
```bash
curl -s http://127.0.0.1:3002/api/audit | python3 -m json.tool | less
```

Or from the browser (authenticated):
```
https://bot.gamblecodez.com/dev/api/audit?n=200
```

### View Claude conversation log:
```bash
curl -s http://127.0.0.1:3002/api/claude-log?n=50 | python3 -m json.tool
```

### View raw logs:
```bash
tail -50 /var/www/html/DevTools/data/audit.log | python3 -c "import sys,json; [print(json.dumps(json.loads(l), indent=2)) for l in sys.stdin if l.strip()]"
tail -f /var/www/html/DevTools/data/weblab.log
tail -f /var/www/html/DevTools/data/weblab-error.log
```

### Audit event types:
| Action | Meaning |
|---|---|
| `auth.login` | Admin logged in (IP logged) |
| `auth.fail` | Bad token attempt (IP logged) |
| `session.save` | Cookies saved for domain |
| `session.clear` | Session cleared for domain |
| `share.create` | Share link created |
| `share.use` | Share link used (IP + target logged) |
| `share.use_denied` | Expired/invalid link attempted |
| `claude.activate/deactivate` | Claude turned on/off |
| `claude.chat_start` | New chat message sent |
| `claude.chat` | Response received (auth mode, lengths) |
| `claude.cli_error` | Claude CLI subprocess error |
| `claude.permission_request` | Tool permission requested |
| `claude.permission_response` | User approved/denied tool |
| `tg.login` | Telegram OAuth login |

---

## Claude CLI Integration

- **Binary:** `/root/.local/bin/claude` (v2.1.71, Pro subscription)
- **Account:** thetylo88@gmail.com (Pro)
- **Model:** `claude-sonnet-4-6` (or latest available)
- **Response time:** ~60 seconds (VPS + API latency — this is normal)
- **Dangerous mode UI toggle:** uses `--permission-mode bypassPermissions`
  - Note: `--dangerously-skip-permissions` is blocked when running as root
- **Session continuity:** `--resume <session_id>` — stored in `claude-config.json` as `cliSessionId`
- **Streaming:** `--output-format stream-json --verbose` → SSE events to browser
- **Plan mode:** `--permission-mode plan`

### Claude Chat API Flow:
1. `POST /api/claude/chat {message, dangerousMode, planMode}` → `{streamId}`
2. `GET /api/claude/stream/:streamId` → SSE: `init`, `text`, `tool_use`, `tool_result`, `permission`, `result`, `close`
3. `POST /api/claude/respond/:streamId {response: "y"/"n"}` → approve/deny tool

### CRITICAL — Spawning Claude subprocess:
Must delete ALL three env vars or Claude refuses with "nested session" error:
```javascript
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_SESSION;
delete env.CLAUDE_CODE_ENTRYPOINT;
```

### New Session vs Clear History:
- **Clear** (`/api/claude/clear`) — clears in-memory chat history only
- **New Session** (`/api/claude/new-session`) — clears `--resume` session ID (fresh context for Claude)

---

## Auth-Share Links

Create a time-limited URL that auto-injects a saved session (cookies) for a domain:

```bash
curl -s -X POST http://127.0.0.1:3002/api/share/create \
  -H 'Content-Type: application/json' \
  -d '{"domain":"web.telegram.org","targetUrl":"https://web.telegram.org/k/","label":"Telegram session","ttlMinutes":60}'
```

The returned link (`https://bot.gamblecodez.com/dev/<token>`) loads the site with cookies injected server-side — the client never sees the raw cookies.

---

## Session Cookie Saving

### Manual paste (from browser DevTools):
1. Open site in Chrome → F12 → Application → Cookies → copy all pairs
2. Open DevTools UI → Sessions → Telegram → Paste Cookies textarea → Save

### Via API:
```bash
curl -s -X POST http://127.0.0.1:3002/api/sessions/web.telegram.org \
  -H 'Content-Type: application/json' \
  -d '{"cookies":[{"name":"stel_ssid","value":"xxx"}]}'
```

---

## Log Rotation (cron)

Runs hourly at `:17` — only acts if >1000 lines (low-CPU VPS safe):
```
17 * * * * /var/www/html/DevTools/scripts/log-rotate.sh >> /var/www/html/DevTools/data/weblab.log 2>&1
```

Limits: `network.json` → 200 entries, `redirects.json` → 100, text logs → 1000 lines, `audit.log`/`claude.log` → 1000 lines each.

---

## Nginx Config (reference)

```nginx
location /dev/ {
    proxy_pass http://127.0.0.1:3002/;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;       # Required for SSE streaming
    proxy_read_timeout 300s;   # Claude takes ~60s to respond
}
```

**Note:** nginx strips `/dev/` before proxying. Node sees `/`, `/auth`, `/:token`. All redirects must use full `PUBLIC_BASE` URL or they land on port 3001 (Runewager).

---

## Telegram Bot Login Widget

- Bot: `@RuneWager_bot`
- Domain registered with BotFather: `bot.gamblecodez.com`
- Login page: `https://bot.gamblecodez.com/dev/tg-login`
- OAuth callback: `GET /tg-auth?id=...&hash=...`
- HMAC-SHA256 hash verified with bot token
- Data stored: `data/tg-auth.json`

---

## Key API Endpoints

| Endpoint | Auth | Description |
|---|---|---|
| `GET /auth?token=<t>` | Public | Admin login |
| `GET /tg-login` | Public | Telegram widget page |
| `GET /tg-auth` | Public | Telegram OAuth callback |
| `GET /:tokenId` | Public | Share link entry point |
| `GET /share-proxy?token=<t>&url=<u>` | Token | Proxy with injected cookies |
| `GET /api/sessions` | Admin | List saved sessions |
| `POST /api/sessions/:domain` | Admin | Save cookies for domain |
| `GET /api/session-status` | Admin | Telegram/Discord session check |
| `POST /api/share/create` | Admin | Create share link |
| `GET /api/share` | Admin | List share links |
| `POST /api/claude/chat` | Admin | Start Claude SSE stream |
| `GET /api/claude/stream/:id` | Admin | SSE Claude response stream |
| `POST /api/claude/respond/:id` | Admin | Approve/deny tool permission |
| `POST /api/claude/new-session` | Admin | Clear --resume session ID |
| `GET /api/claude/status` | Admin | Claude status |
| `DELETE /api/claude/clear` | Admin | Clear chat history |
| `GET /api/audit?n=200` | Admin | Audit log (newest first) |
| `GET /api/claude-log?n=100` | Admin | Claude conversation log |
| `DELETE /api/audit` | Admin | Clear both audit logs |
| `GET /api/network?filter=x` | Admin | Network scan log |
| `GET /api/redirects` | Admin | Redirect chain log |

---

## Git

Remote: `git@github.com:gamblecodezcom/DevTools.git`

Gitignored: `data/`, `.env`, `node_modules/`, `*.log`

Secrets are NEVER committed. All tokens loaded from `.env` at runtime.
If `.env` is lost: re-create from this README's env var table + Runewager `.env`.
