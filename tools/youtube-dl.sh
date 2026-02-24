#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
YTDL_DIR="${ROOT_DIR}/vendor/youtube-dl"
COOKIES_FILE="/tmp/linkcatcher-ytdl-cookies.txt"
EXTRA_ARGS=()

if [ -n "${YTDL_COOKIES_FILE:-}" ] && [ -f "${YTDL_COOKIES_FILE}" ]; then
  EXTRA_ARGS+=(--cookies "${YTDL_COOKIES_FILE}")
elif [ -n "${YTDL_COOKIES_B64:-}" ]; then
  printf '%s' "${YTDL_COOKIES_B64}" | base64 -d > "${COOKIES_FILE}"
  chmod 600 "${COOKIES_FILE}"
  EXTRA_ARGS+=(--cookies "${COOKIES_FILE}")
fi

if [ -n "${YTDL_USER_AGENT:-}" ]; then
  EXTRA_ARGS+=(--user-agent "${YTDL_USER_AGENT}")
fi

if command -v yt-dlp >/dev/null 2>&1; then
  if [ -n "${YTDL_YOUTUBE_CLIENTS:-}" ]; then
    EXTRA_ARGS+=(--extractor-args "youtube:player_client=${YTDL_YOUTUBE_CLIENTS}")
  fi
  exec yt-dlp "${EXTRA_ARGS[@]}" "$@"
fi

if [ ! -d "${YTDL_DIR}" ]; then
  echo "youtube-dl vendor directory not found: ${YTDL_DIR}" >&2
  exit 1
fi

cd "${YTDL_DIR}"
exec python3 -m youtube_dl "${EXTRA_ARGS[@]}" "$@"
