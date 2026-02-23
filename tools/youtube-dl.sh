#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
YTDL_DIR="${ROOT_DIR}/vendor/youtube-dl"

if [ ! -d "${YTDL_DIR}" ]; then
  echo "youtube-dl vendor directory not found: ${YTDL_DIR}" >&2
  exit 1
fi

cd "${YTDL_DIR}"
exec python3 -m youtube_dl "$@"
