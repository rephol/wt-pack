#!/bin/sh
# Build server.mjs into a Node single-executable (SEA) sidecar for Tauri.
set -eu
# store.mjs needs node:sqlite without a flag (node >= 22.13, same floor as ./setup); the SEA embeds this node.
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' || { echo "sidecar: node >= 22.13 required (have $(node -v))" >&2; exit 1; }
cd "$(dirname "$0")/.."
mkdir -p build src-tauri/binaries
OUT=src-tauri/binaries/wt-dashboard-server-aarch64-apple-darwin
# SEA needs one CommonJS file; import.meta.url becomes the executable's own URL.
npx esbuild ../server.mjs --bundle --platform=node --format=cjs --outfile=build/server.cjs \
  --define:import.meta.url=__imu --banner:js="const __imu=require('url').pathToFileURL(__filename).href;" --log-level=warning
cat > build/sea-config.json <<JSON
{ "main": "build/server.cjs", "output": "build/sea-prep.blob", "disableExperimentalSEAWarning": true }
JSON
node --experimental-sea-config build/sea-config.json
cp "$(command -v node)" "$OUT"
chmod u+w "$OUT"
codesign --remove-signature "$OUT"
npx postject "$OUT" NODE_SEA_BLOB build/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA
codesign --sign - "$OUT"
echo "sidecar: $OUT"
