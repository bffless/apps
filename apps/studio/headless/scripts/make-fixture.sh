#!/usr/bin/env bash
# Tiny VP8+Vorbis (WebM) clip for mock-mode smoke runs. Firefox decodes VP8/Vorbis
# natively, so this needs no system codec libraries — only an ffmpeg binary able to
# encode them (the ffmpeg-static devDependency covers CI and most local machines).
#
# Resolves the ffmpeg binary in order:
#   1. $FFMPEG_BIN if set
#   2. `ffmpeg` on PATH
#   3. the ffmpeg-static package (node_modules of this workspace)
set -euo pipefail

out="${1:-/tmp/studio-fixture.webm}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

resolve_ffmpeg() {
  if [ -n "${FFMPEG_BIN:-}" ]; then
    echo "$FFMPEG_BIN"
    return 0
  fi
  if command -v ffmpeg >/dev/null 2>&1; then
    command -v ffmpeg
    return 0
  fi
  if bin="$(cd "$here" && node -e "process.stdout.write(require('ffmpeg-static'))" 2>/dev/null)" && [ -n "$bin" ]; then
    echo "$bin"
    return 0
  fi
  return 1
}

if ! ffmpeg_bin="$(resolve_ffmpeg)"; then
  echo "make-fixture.sh: no ffmpeg binary found (set FFMPEG_BIN, install ffmpeg, or ensure ffmpeg-static is installed in apps/studio/headless)" >&2
  exit 1
fi

"$ffmpeg_bin" -y -loglevel error -f lavfi -i "testsrc=duration=4:size=640x360:rate=30" -f lavfi -i "sine=frequency=440:duration=4" -shortest -c:v libvpx -pix_fmt yuv420p -c:a libvorbis "$out"
echo "$out"
