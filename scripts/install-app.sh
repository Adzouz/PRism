#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm build
pnpm exec electron-builder --mac dir --arm64 -c.mac.notarize=false -c.mac.identity=-

DIR="${PRISM_INSTALL_DIR:-/Applications}"
[[ -w "$DIR" ]] || DIR="$HOME/Applications"
mkdir -p "$DIR"
DEST="$DIR/PRism.app"
rm -rf "$DEST"
ditto dist/mac-arm64/PRism.app "$DEST"
touch "$DEST"
echo "Installed $DEST"
