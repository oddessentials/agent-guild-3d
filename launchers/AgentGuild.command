#!/bin/bash
# Double-click to open Agent Guild on macOS. Requires Node.js 22 or newer.
cd "$(dirname "$0")/.." || exit 1
# Finder starts this without the login shell's PATH (Homebrew, nvm, ...).
if ! command -v node >/dev/null 2>&1; then
  export PATH="$(${SHELL:-/bin/zsh} -l -c 'printf %s "$PATH"' 2>/dev/null):$PATH"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required. Install it from https://nodejs.org and try again."
  read -r -p "Press Return to close."
  exit 1
fi
if [ ! -d node_modules/node-pty ]; then
  echo "Installing Agent Guild dependencies. This happens once."
  npm install --omit=dev --no-fund --no-audit || { read -r -p "Dependency installation failed. Press Return to close."; exit 1; }
fi
node bin/agent-guild.mjs open
