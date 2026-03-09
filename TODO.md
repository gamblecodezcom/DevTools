# DevTools TODO

## In Progress / Pending Tests

### Claude CLI Streaming
- [ ] **Verify stream-json works end-to-end** — Claude responds in ~60s on VPS. Need to confirm `--output-format stream-json --verbose` produces SSE events correctly in production (tested locally: CLI takes ~60s, stream-json format requires --verbose flag).
- [ ] **Test dangerous mode** — `--permission-mode bypassPermissions` replaces `--dangerously-skip-permissions` (blocked as root). Test that tool use (Bash, Read, Write) auto-approves.
- [ ] **Test plan mode** — `--permission-mode plan` toggle in UI.
- [ ] **Test permission request UI** — When dangerous mode is OFF, Claude should pause on tool use and show Approve/Deny buttons. Browser sends `POST /api/claude/respond/:id {response: "y"}`.
- [ ] **Test session continuity** — `--resume <session_id>` stored in `data/claude-config.json` as `cliSessionId`. Verify compaction works across messages.
- [ ] **Test "New Session" button** — Should clear `cliSessionId` and start fresh context.
- [ ] **Verify model flag** — `--model claude-sonnet-4-6` passed to all Claude invocations.

### UI Issues
- [ ] **Chat overflow on mobile** — Chat messages cut off on small screens. `max-height: 160px` may be too small. Consider making chat pane taller or scrollable.
- [ ] **Red error messages cut off** — CSS `max-height` issue on mobile. Needs larger chat area.
- [ ] **Chat input re-enable on stream close** — Verify input is re-enabled after Claude responds (SSE `close` event).

### Telegram
- [ ] **Cookie paste flow** — Test pasting cookies from Chrome DevTools → `web.telegram.org` session saved.
- [ ] **Verify Telegram Web loads** — `tgLoadViaProxy()` now loads direct in iframe (not server proxy). Test if Telegram Web renders correctly.

### Auth Share Links
- [ ] **Test share link end-to-end** — Create link for `web.telegram.org` → open in incognito → verify Telegram Web loads with session cookies injected.

---

## Known Issues / Workarounds

- **Claude takes ~60s** — This is normal. VPS network + API latency. Don't reduce timeout below 180s.
- **`--dangerously-skip-permissions` blocked as root** — Use `--permission-mode bypassPermissions` instead (implemented).
- **CLAUDECODE/CLAUDE_CODE_ENTRYPOINT must be deleted** before spawning Claude subprocess, or it fails with "nested session" error.
- **stream-json requires `--verbose`** — Without it: `Error: When using --print, --output-format=stream-json requires --verbose`.
- **Telegram Web proxy grey page** — Server-side HTML proxy breaks SPAs. Fixed: Telegram loads direct in iframe.
- **nginx strips /dev/** — All Express redirects must use full `PUBLIC_BASE` URL.

---

## Future Ideas

- [ ] Add `/api/audit` viewer tab in the UI (table view of audit log)
- [ ] Add Claude conversation history viewer tab in UI
- [ ] PWA push notifications for share link usage
- [ ] Auto-detect Telegram session expiry and notify
- [ ] Discord proxy session support
- [ ] Rate limiting on share-proxy endpoint

---

## How to Continue in a New Claude Session

1. Read `README.md` — full architecture, all endpoints, all data files
2. Check `data/audit.log` for recent activity: `curl -s http://127.0.0.1:3002/api/audit | python3 -m json.tool`
3. Check git log: `git log --oneline -10`
4. Server running? `ps aux | grep "node.*DevTools" | grep -v grep`
5. If not running, restart: see README "Starting the Server"
