#!/bin/bash
set -euo pipefail

# Only run in Claude Code remote sessions
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

echo '{"async": true, "asyncTimeout": 300000}'

cd "$CLAUDE_PROJECT_DIR/frontend"
echo "Installing frontend dependencies..."
npm install

echo "Running database migrations..."
cd "$CLAUDE_PROJECT_DIR"
node .claude/hooks/run-migrations.mjs

echo "Session setup complete."
