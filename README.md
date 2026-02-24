# LinkCatcher

LinkCatcher is a small Node.js + TypeScript MVP web service for importing and storing supported video URLs locally.

## What it supports

- YouTube URLs (through vendored `youtube-dl`, best-effort)
- Instagram public post/reel URLs (`/p/<shortcode>/`, `/reel/<shortcode>/`) with direct media extraction (video/photo, best-effort)
- Direct downloadable media URLs:
  - URL extension: `.mp4`, `.webm`, `.mov`, `.m4v`
  - or HTTP `Content-Type` starts with `video/`
- Open (non-DRM) HLS playlists (`.m3u8`) where playlist and segments are publicly accessible over HTTP(S)

## What it does not support

- Third-party platform scraping/parsing beyond YouTube/Instagram flow (TikTok, Facebook, etc.)
- No DRM circumvention
- If HLS has `#EXT-X-KEY` encryption or segment access fails (401/403), it is marked unsupported

## Features

- URL detection flow:
  - Source adapters layer in `src/sources/` (youtube / instagram / platform-block / direct)
  - Detect YouTube host URLs and route to `youtube-dl`
  - Detect Instagram host URLs and resolve direct media URL (video/image) before download
  - Follow up to 5 redirects
  - Probe with `HEAD`
  - If `HEAD` fails, fallback to `GET` with `Range: bytes=0-1048575`
- Download jobs:
  - YouTube download through `vendor/youtube-dl` wrapper (optional format selection)
  - Direct file streaming download
  - HLS playlist parse + segment download + local playlist rewrite
- Local storage under `./storage/<id>/...`
- SQLite metadata database in `./data/linkcatcher.db`
- UI pages:
  - `/` Home (paste URL + live status polling)
  - `/library` Library list with Play/Delete
  - `/play/:id` Local playback (`<video>` / `hls.js`)
- Per-user library isolation (anonymous session cookie):
  - each browser/device gets its own `lc_uid`
  - item listing/read/delete/play/download are scoped to that owner only
- API endpoints:
  - `POST /api/inbox`
  - `POST /api/youtube/formats`
  - `GET /api/items`
  - `GET /api/items/:id`
  - `DELETE /api/items/:id`
  - `GET /media/:id/*`
- Security basics:
  - URL scheme validation (`http`/`https` only)
  - SSRF checks blocking localhost/private networks
  - Path traversal protections on media serving
  - Rate limiting on `POST /api/inbox` and `POST /api/youtube/formats`
  - Max size and segment limits (`MAX_DOWNLOAD_BYTES`, `MAX_HLS_SEGMENTS`)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Run in development mode:

```bash
npm run dev
```

3. Open:

- [http://localhost:3000](http://localhost:3000)

## Build and run production

```bash
npm run build
npm start
```

## Deploy (Railway / Render)

`Vercel` serverless is not suitable for this backend because the service depends on:
- local persistent filesystem (`./data`, `./storage`)
- long-running downloads
- child processes (`python3` for `youtube-dl`, `ffmpeg`)

This repo now includes a Docker-based deployment setup for Railway and Render.

### Railway

1. Push this repo to GitHub.
2. In Railway: `New Project` -> `Deploy from GitHub repo`.
3. Railway will use `Dockerfile` + `railway.json`.
4. Add a persistent volume and mount it, for example at `/app/persist`.
5. Set environment variables:
   - `DATA_DIR=/app/persist/data`
   - `STORAGE_DIR=/app/persist/storage`
   - `MAX_DOWNLOAD_BYTES=1073741824`
   - `MAX_HLS_SEGMENTS=5000`
6. Deploy and open `/health` to verify.

### Render

1. Push repo to GitHub.
2. In Render create a new `Blueprint` service from this repository.
3. Render will read `render.yaml` and create:
   - Docker web service
   - persistent disk mounted at `/app/persist`
4. Verify env vars from `render.yaml`:
   - `DATA_DIR=/app/persist/data`
   - `STORAGE_DIR=/app/persist/storage`
5. Deploy and open `/health`.

## Environment variables (optional)

- `PORT` (default: `3000`)
- `HOST` (default: `0.0.0.0`)
- `DATA_DIR` (default: `./data`)
- `STORAGE_DIR` (default: `./storage`)
- `DB_PATH` (default: `DATA_DIR/linkcatcher.db`)
- `MAX_DOWNLOAD_BYTES` (default: `1073741824` = 1GB)
- `MAX_HLS_SEGMENTS` (default: `5000`)
- `REQUEST_TIMEOUT_MS` (default: `30000`)
- `YTDL_COOKIES_FILE` (path to cookies.txt, optional)
- `YTDL_COOKIES_B64` (base64 of cookies.txt, optional)
- `YTDL_USER_AGENT` (custom user-agent for yt-dlp/youtube-dl, optional)
- `YTDL_YOUTUBE_CLIENTS` (yt-dlp extractor args `youtube:player_client=...`, optional, e.g. `android,web`)

### YouTube anti-bot note

If YouTube returns `Sign in to confirm you’re not a bot`, configure authenticated cookies:

1. Export YouTube cookies in `cookies.txt` format from your browser.
2. Convert to base64:

```bash
base64 -i cookies.txt | tr -d '\n'
```

3. Set Railway variable:
   - `YTDL_COOKIES_B64=<base64-output>`
4. Redeploy service.

## Notes

- Large HLS playlists can take time to download because segments are stored locally for offline playback.
- Deleting an item removes both DB metadata and corresponding local storage folder.
- Unsupported reasons are source-specific (e.g. wrong Instagram path, blocked platform, non-media content type).
- Anonymous per-device isolation uses cookies, so clearing browser cookies creates a new empty library.

## Vendored youtube-dl layout

- The imported `youtube-dl-master` source tree is now stored at:
  - `vendor/youtube-dl`
- Wrapper script for consistent invocation from this project:
  - `tools/youtube-dl.sh`
- Convenience scripts:
  - `npm run youtube-dl:version`
  - `npm run youtube-dl:help`
# LINKCATCHER
