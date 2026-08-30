#!/usr/bin/env bash
# 480p, mono AAC, faststart — small enough to commit, still a real screen recording with speech.
set -euo pipefail
in="$1"; out="${2:-$(dirname "$0")/onboarding-rules.mp4}"
ffmpeg -y -loglevel error -i "$in" -vf "scale=-2:480" -c:v libx264 -preset slow -crf 30 -pix_fmt yuv420p -c:a aac -ac 1 -b:a 64k -movflags +faststart "$out"
sha256sum "$out" | cut -d' ' -f1 > "${out%.mp4}.sha256"
ls -l "$out"; cat "${out%.mp4}.sha256"
