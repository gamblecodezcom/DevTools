#!/bin/bash
# Run this on your VPS to set up the Claude bridge as a permanent service
# Usage: bash setup-bridge.sh YOUR_ANTHROPIC_KEY YOUR_BRIDGE_TOKEN

ANTHROPIC_KEY="${1:-}"
BRIDGE_TOKEN="${2:-gcz-bridge-$(openssl rand -hex 6)}"
BRIDGE_PORT=4000
BRIDGE_DIR="$HOME/claude-bridge"

echo "=== GambleCodez Claude Bridge Setup ==="

# install deps
mkdir -p "$BRIDGE_DIR"
cp claude-bridge.js "$BRIDGE_DIR/"
cd "$BRIDGE_DIR"
npm init -y >/dev/null
npm install express cors node-fetch@2 >/dev/null

# pm2 ecosystem config
cat > ecosystem.config.js <<EOF
module.exports = {
  apps: [{
    name: 'claude-bridge',
    script: 'claude-bridge.js',
    env: {
      ANTHROPIC_API_KEY: '${ANTHROPIC_KEY}',
      BRIDGE_TOKEN: '${BRIDGE_TOKEN}',
      BRIDGE_PORT: ${BRIDGE_PORT},
    },
    restart_delay: 3000,
    max_restarts: 10,
  }]
};
EOF

# install pm2 if needed
command -v pm2 >/dev/null || npm install -g pm2

# start
pm2 start ecosystem.config.js
pm2 save
pm2 startup | tail -1 | bash 2>/dev/null || true

echo ""
echo "✓ Claude Bridge running on port ${BRIDGE_PORT}"
echo "✓ Token: ${BRIDGE_TOKEN}"
echo ""
echo "Add to Web Lab settings:"
echo "  VPS URL: https://gamble-codez.com:${BRIDGE_PORT}"
echo "  Token:   ${BRIDGE_TOKEN}"
echo ""
echo "Manage:"
echo "  pm2 status          — check running"
echo "  pm2 stop claude-bridge    — disable"
echo "  pm2 start claude-bridge   — enable"
echo "  pm2 logs claude-bridge    — view logs"
