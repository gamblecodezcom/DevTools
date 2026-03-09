# GambleCodez // Web Lab

Private localhost website tester for Termux + Chrome Android.

## Features
- Proxy + iframe loader for any site
- Session/cookie persistence per domain
- Redirect scanner + chain viewer
- Network inspector with filtering
- Request replay tool
- Telegram Web + Discord Web quick targets
- Saved tests (daily claim URLs etc.)
- PWA installable from Chrome Android

## Start

```bash
cd /storage/emulated/0/DevTools
bash start.sh
```

Then open Chrome → `http://127.0.0.1:3000`

## Install as Chrome Web App

1. Open `http://127.0.0.1:3000` in Chrome
2. Tap the **⋮** menu → **Add to Home screen**
3. Tap **Add** — launches as standalone app

## Claude/CLI Testing API

```bash
# Run a request using stored cookies
curl -X POST http://127.0.0.1:3000/api/test/request \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://target.com/api/daily","method":"GET"}'

# List saved tests
curl http://127.0.0.1:3000/api/test/saved

# Check session status
curl http://127.0.0.1:3000/api/session-status
```
