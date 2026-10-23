#!/usr/bin/env bash
# Rebuild dist/memecoin-radar.zip: a standalone, Render-ready copy of radar/ (own render.yaml + CI at its root).
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
out="$tmp/memecoin-radar"
mkdir -p "$out"
git archive HEAD:radar | tar -x -C "$out"
mkdir -p "$out/.github/workflows"
cp radar/deploy/render.yaml "$out/render.yaml"
cp radar/deploy/ci.yml "$out/.github/workflows/ci.yml"
cp radar/deploy/README.standalone.md "$out/README.md"
rm -rf "$out/deploy"
mkdir -p dist
rm -f dist/memecoin-radar.zip
(cd "$tmp" && zip -qr -X "$OLDPWD/dist/memecoin-radar.zip" memecoin-radar)
rm -rf "$tmp"
echo "wrote dist/memecoin-radar.zip"
