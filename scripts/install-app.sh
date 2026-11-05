#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm build
pnpm exec electron-builder --mac dir --arm64 -c.mac.notarize=false -c.mac.identity=-

DEST="$HOME/Applications/PRism.app"
mkdir -p "$HOME/Applications"
rm -rf "$DEST"
ditto dist/mac-arm64/PRism.app "$DEST"
echo "Installed $DEST"
