#!/usr/bin/env bash
# Codex Custom Studio Launcher
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "=========================================================="
echo "⚡️ Codex Custom Studio - Custom Model & Tool Runner"
echo "=========================================================="

if [ ! -d "node_modules" ]; then
  echo "📦 Installing npm dependencies..."
  npm install
fi

MODE="${1:-desktop}"

if [ "$MODE" = "web" ]; then
  echo "🌐 Starting in Web Mode on http://localhost:3737..."
  npm run server &
  SERVER_PID=$!
  sleep 1.5
  open "http://localhost:3737"
  wait $SERVER_PID
else
  echo "🖥️ Starting Native macOS Electron Desktop App..."
  npm start
fi
