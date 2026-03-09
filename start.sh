#!/bin/bash
###############################################
# GambleCodez // DevTools — VPS Start Script
###############################################

export PORT=3002
export SKIP_TUNNEL=1
export PUBLIC_BASE="https://bot.gamblecodez.com/dev"
export NODE_NO_WARNINGS=1   # suppress DEP0040 punycode (node-fetch / Node v22)

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║     GambleCodez // DevTools  v3.0                           ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Port:    3002                                               ║"
echo "║  Public:  https://bot.gamblecodez.com/dev                   ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

node server.js
