#!/data/data/com.termux/files/usr/bin/bash
###############################################
# GambleCodez // Web Lab — Start Script
###############################################

export PREFIX="/data/data/com.termux/files/usr"
export TMPDIR="$HOME/.claude-tmp"
export PATH="$PREFIX/bin:$HOME/bin:$PATH"

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

# Ensure tmp dir
mkdir -p "$HOME/.claude-tmp"

# Install deps if needed
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install --no-bin-links
fi

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║     GambleCodez // Web Lab  v1.0             ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Starting on http://127.0.0.1:3000           ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# Keep screen on (Termux:API — optional, won't fail if not installed)
termux-wake-lock 2>/dev/null || true

node server.js
