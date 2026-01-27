#!/bin/bash
set -e

CLAWDBOT_DIR="$HOME/git/clawdbot"
BRANCH="feat/anthropic-vertex-ai"

echo "=== Updating Clawdbot ==="
cd "$CLAWDBOT_DIR"

echo "→ Fetching latest..."
git fetch origin

echo "→ Checking out $BRANCH..."
git checkout "$BRANCH"
git pull origin "$BRANCH"

echo "→ Installing dependencies..."
pnpm install

echo "→ Installing UI dependencies..."
pnpm ui:install

echo "→ Building..."
pnpm build

echo "→ Building UI..."
pnpm ui:build

echo "→ Restarting service..."
systemctl --user daemon-reload
systemctl --user restart clawdbot-gateway

echo "→ Waiting for startup..."
sleep 3

echo "→ Status:"
systemctl --user status clawdbot-gateway --no-pager | head -15

npm -g install . -U

echo ""
echo "✅ Clawdbot updated and restarted!"
