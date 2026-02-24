import crypto from 'crypto';
import { spawn } from 'child_process';
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import express from 'express';
import rateLimit from 'express-rate-limit';
import mime from 'mime-types';
import { STORAGE_DIR } from './config';
import { createItem, deleteItemByOwner, getItemByOwner, listItemsByOwner, updateItem } from './db';
import { detectSource } from './detector';
import { Downloader } from './downloader';
import { UserInputError, errorMessage, isSafeItemId, safeJoin, validateHttpUrl } from './security';
import { getYoutubeFormats, isYoutubeUrl } from './youtube';

const app = express();
const downloader = new Downloader();
const hlsTranscodeJobs = new Map<string, Promise<void>>();
const SESSION_COOKIE_NAME = 'lc_uid';
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

interface RequestWithOwner extends express.Request {
  ownerId?: string;
}
const ffmpegStaticPath: string | null = (() => {
  try {
    const loaded = require('ffmpeg-static') as string | null;
    return typeof loaded === 'string' && loaded.trim() ? loaded : null;
  } catch {
    return null;
  }
})();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));
app.use('/public', express.static(path.join(__dirname, 'public')));

function parseCookieHeader(headerValue: string | undefined): Record<string, string> {
  if (!headerValue) {
    return {};
  }

  const parts = headerValue.split(';');
  const result: Record<string, string> = {};
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      continue;
    }
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }

  return result;
}

function isValidOwnerId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function appendSetCookie(res: express.Response, value: string): void {
  const current = res.getHeader('Set-Cookie');
  if (!current) {
    res.setHeader('Set-Cookie', value);
    return;
  }
  if (Array.isArray(current)) {
    res.setHeader('Set-Cookie', [...current, value]);
    return;
  }
  res.setHeader('Set-Cookie', [String(current), value]);
}

function ensureOwnerId(req: express.Request, res: express.Response): string {
  const cookies = parseCookieHeader(req.headers.cookie);
  const existing = cookies[SESSION_COOKIE_NAME];
  if (existing && isValidOwnerId(existing)) {
    return existing;
  }

  const ownerId = crypto.randomUUID();
  const isSecure = req.secure || req.get('x-forwarded-proto')?.toLowerCase().includes('https');
  const cookieParts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(ownerId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${ONE_YEAR_SECONDS}`
  ];
  if (isSecure) {
    cookieParts.push('Secure');
  }
  appendSetCookie(res, cookieParts.join('; '));

  return ownerId;
}

function getOwnerId(req: express.Request): string {
  const ownerId = (req as RequestWithOwner).ownerId;
  if (!ownerId) {
    throw new Error('Owner ID не инициализирован');
  }
  return ownerId;
}

app.use((req, res, next) => {
  (req as RequestWithOwner).ownerId = ensureOwnerId(req, res);
  next();
});

const inboxLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Слишком много запросов. Повторите через минуту.'
  }
});

function isSafeFormatId(value: string): boolean {
  return /^[a-zA-Z0-9._-]{1,40}$/.test(value);
}

function deriveTitle(url: URL): string {
  const lastPart = url.pathname.split('/').filter(Boolean).pop();
  if (!lastPart) {
    return url.hostname;
  }

  try {
    return decodeURIComponent(lastPart).slice(0, 180);
  } catch {
    return lastPart.slice(0, 180);
  }
}

async function findDirectMediaFileName(id: string): Promise<string | null> {
  const itemDir = path.join(STORAGE_DIR, id);

  try {
    const entries = await fs.readdir(itemDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    if (!files.length) {
      return null;
    }

    const prioritized = [...files].sort((a, b) => {
      const score = (name: string): number => {
        if (name.startsWith('video.')) return 0;
        if (name.startsWith('image.')) return 1;
        return 2;
      };
      return score(a) - score(b);
    });

    return prioritized[0] ?? null;
  } catch {
    return null;
  }
}

function detectLocalMediaKind(fileName: string): 'video' | 'image' {
  const detected = mime.lookup(fileName);
  if (detected && detected.startsWith('image/')) {
    return 'image';
  }
  return 'video';
}

function sanitizeAttachmentBaseName(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return 'video';
  }

  return cleaned.slice(0, 120);
}

function buildDownloadFileName(itemTitle: string, sourceFileName: string): string {
  const baseName = sanitizeAttachmentBaseName(itemTitle);
  const ext = path.extname(sourceFileName).toLowerCase();
  if (/^\.[a-z0-9]{1,10}$/.test(ext)) {
    return `${baseName}${ext}`;
  }

  const detectedType = mime.lookup(sourceFileName);
  if (detectedType) {
    const detectedExt = mime.extension(detectedType);
    if (detectedExt) {
      return `${baseName}.${detectedExt}`;
    }
  }

  return `${baseName}.bin`;
}

function buildDownloadFileNameWithPreferredExt(itemTitle: string, sourceFileName: string, preferredExt?: string | null): string {
  const baseName = sanitizeAttachmentBaseName(itemTitle);
  const preferred = typeof preferredExt === 'string' ? preferredExt.trim().toLowerCase() : '';
  if (/^\.[a-z0-9]{1,10}$/.test(preferred)) {
    return `${baseName}${preferred}`;
  }

  return buildDownloadFileName(itemTitle, sourceFileName);
}

function resolvePreferredDownloadExtension(item: { type: string; finalUrl: string }, sourceFileName: string): string | null {
  const sourceExt = path.extname(sourceFileName).toLowerCase();
  if (sourceExt && sourceExt !== '.bin') {
    return null;
  }

  try {
    const urlExt = path.extname(new URL(item.finalUrl).pathname).toLowerCase();
    if (/^\.[a-z0-9]{1,10}$/.test(urlExt) && urlExt !== '.m3u8') {
      return urlExt;
    }
  } catch {
    // Ignore invalid finalUrl and use type fallback.
  }

  if (['file', 'youtube', 'instagram', 'hls', 'rutube', 'ok'].includes(item.type)) {
    return '.mp4';
  }

  return null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function transcodeLocalHlsToMp4(itemId: string, itemDir: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ffmpegBinary = ffmpegStaticPath ?? 'ffmpeg';
    const inputName = 'index.m3u8';
    const outputName = 'video.mp4';
    const ffmpeg = spawn(
      ffmpegBinary,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputName, '-c', 'copy', '-movflags', '+faststart', outputName],
      {
        cwd: itemDir,
        stdio: ['ignore', 'ignore', 'pipe']
      }
    );

    let stderr = '';
    ffmpeg.stderr.setEncoding('utf8');
    ffmpeg.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    ffmpeg.on('error', () => {
      reject(
        new Error(
          'Не удалось запустить ffmpeg для сборки MP4. Установите ffmpeg или переустановите зависимости проекта.'
        )
      );
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const details = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-3)
        .join(' ');
      reject(new Error(details || `ffmpeg завершился с кодом ${String(code)}.`));
    });
  }).finally(() => {
    hlsTranscodeJobs.delete(itemId);
  });
}

async function ensureHlsDownloadFile(itemId: string): Promise<string> {
  const itemDir = path.join(STORAGE_DIR, itemId);
  const outputName = 'video.mp4';
  const outputPath = path.join(itemDir, outputName);
  if (await fileExists(outputPath)) {
    return outputName;
  }

  const playlistPath = path.join(itemDir, 'index.m3u8');
  if (!(await fileExists(playlistPath))) {
    throw new Error('Локальный HLS-плейлист не найден. Откройте элемент через "Смотреть" и повторите скачивание.');
  }

  let running = hlsTranscodeJobs.get(itemId);
  if (!running) {
    running = transcodeLocalHlsToMp4(itemId, itemDir);
    hlsTranscodeJobs.set(itemId, running);
  }

  await running;
  if (!(await fileExists(outputPath))) {
    throw new Error('Не удалось сформировать MP4-файл из HLS-плейлиста.');
  }

  return outputName;
}

function buildContentDisposition(fileName: string): string {
  const safeAscii = fileName
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName);
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encoded}`;
}

app.get('/', (_req, res) => {
  res.render('home');
});

app.get('/library', (req, res) => {
  const ownerId = getOwnerId(req);
  const items = listItemsByOwner(ownerId);
  res.render('library', { items });
});

app.get('/play/:id', async (req, res) => {
  const { id } = req.params;
  if (!isSafeItemId(id)) {
    res.status(400).send('Некорректный идентификатор элемента.');
    return;
  }

  const ownerId = getOwnerId(req);
  const item = getItemByOwner(id, ownerId);
  if (!item) {
    res.status(404).send('Элемент не найден.');
    return;
  }

  if (item.status !== 'ready') {
    res.render('player', {
      item,
      mediaUrl: null,
      mediaKind: null,
      error: 'Элемент еще не готов. Дождитесь завершения загрузки.'
    });
    return;
  }

  let mediaUrl: string | null = null;
  let mediaKind: 'video' | 'image' | 'hls' | null = null;

  if (item.type === 'file' || item.type === 'youtube' || item.type === 'instagram') {
    const fileName = await findDirectMediaFileName(item.id);
    if (!fileName) {
      res.render('player', {
        item,
        mediaUrl: null,
        mediaKind: null,
        error: 'Медиафайл отсутствует в локальном хранилище.'
      });
      return;
    }

    mediaUrl = `/media/${item.id}/${encodeURIComponent(fileName)}`;
    mediaKind = detectLocalMediaKind(fileName);
  }

  if (item.type === 'hls' || item.type === 'rutube' || item.type === 'ok' || item.type === 'vk') {
    mediaUrl = `/media/${item.id}/index.m3u8`;
    mediaKind = 'hls';
  }

  if (!mediaUrl) {
    res.render('player', {
      item,
      mediaUrl: null,
      mediaKind: null,
      error: 'Неподдерживаемый медиаэлемент.'
    });
    return;
  }

  res.render('player', {
    item,
    mediaUrl,
    mediaKind,
    error: null
  });
});

app.post('/api/inbox', inboxLimiter, async (req, res) => {
  const ownerId = getOwnerId(req);
  const sourceUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  const formatId =
    typeof req.body?.formatId === 'string' && req.body.formatId.trim().length > 0 ? req.body.formatId.trim() : undefined;

  if (formatId && !isSafeFormatId(formatId)) {
    res.status(400).json({ error: 'Некорректный идентификатор формата.' });
    return;
  }

  if (!sourceUrl) {
    res.status(400).json({ error: 'Тело запроса должно содержать поле { url }.' });
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = validateHttpUrl(sourceUrl);
  } catch (error) {
    const status = error instanceof UserInputError ? error.statusCode : 400;
    res.status(status).json({ error: errorMessage(error) });
    return;
  }

  const id = crypto.randomUUID();
  createItem({
    id,
    ownerId,
    sourceUrl,
    finalUrl: parsedUrl.toString(),
    type: 'unsupported',
    status: 'queued',
    title: deriveTitle(parsedUrl),
    reason: null,
    sizeBytes: 0
  });

  try {
    const detected = await detectSource(sourceUrl);
    let resolvedTitle: string | undefined;

    if (detected.type === 'youtube') {
      try {
        const youtubeInfo = await getYoutubeFormats(sourceUrl);
        if (youtubeInfo.title) {
          resolvedTitle = youtubeInfo.title.slice(0, 180);
        }
      } catch {
        // If metadata lookup fails, keep derived URL title.
      }
    }

    if (detected.type === 'unsupported') {
      updateItem(id, {
        finalUrl: detected.finalUrl,
        type: 'unsupported',
        status: 'unsupported',
        reason: detected.reason ?? 'Неподдерживаемый URL источника.'
      });

      res.json({
        id,
        status: 'unsupported',
        reason: detected.reason ?? 'Неподдерживаемый URL источника.'
      });
      return;
    }

    updateItem(id, {
      finalUrl: detected.finalUrl,
      type: detected.type,
      status: 'queued',
      reason: null,
      title: resolvedTitle
    });

    const queuedItem = getItemByOwner(id, ownerId);
    if (queuedItem) {
      downloader.start(queuedItem, {
        youtubeFormatId: queuedItem.type === 'youtube' ? formatId : undefined
      });
    }

    res.json({ id, status: 'queued' });
  } catch (error) {
    const message = errorMessage(error);
    const unsupported = error instanceof UserInputError;

    updateItem(id, {
      type: 'unsupported',
      status: unsupported ? 'unsupported' : 'error',
      reason: message
    });

    res.json({
      id,
      status: unsupported ? 'unsupported' : 'error',
      reason: message
    });
  }
});

app.post('/api/youtube/formats', inboxLimiter, async (req, res) => {
  const sourceUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!sourceUrl) {
    res.status(400).json({ error: 'Тело запроса должно содержать поле { url }.' });
    return;
  }

  if (!isYoutubeUrl(sourceUrl)) {
    res.status(400).json({ error: 'Поддерживаются только ссылки YouTube.' });
    return;
  }

  try {
    const formats = await getYoutubeFormats(sourceUrl);
    res.json(formats);
  } catch (error) {
    const status = error instanceof UserInputError ? error.statusCode : 500;
    res.status(status).json({ error: errorMessage(error) });
  }
});

app.get('/api/items', (_req, res) => {
  const ownerId = getOwnerId(_req);
  res.json(listItemsByOwner(ownerId));
});

app.get('/api/items/:id', (req, res) => {
  const { id } = req.params;
  if (!isSafeItemId(id)) {
    res.status(400).json({ error: 'Некорректный идентификатор элемента.' });
    return;
  }

  const ownerId = getOwnerId(req);
  const item = getItemByOwner(id, ownerId);
  if (!item) {
    res.status(404).json({ error: 'Элемент не найден.' });
    return;
  }

  res.json(item);
});

app.delete('/api/items/:id', async (req, res) => {
  const { id } = req.params;
  if (!isSafeItemId(id)) {
    res.status(400).json({ error: 'Некорректный идентификатор элемента.' });
    return;
  }

  const ownerId = getOwnerId(req);
  const existing = getItemByOwner(id, ownerId);
  if (!existing) {
    res.status(404).json({ error: 'Элемент не найден.' });
    return;
  }

  downloader.cancel(id);
  await fs.rm(path.join(STORAGE_DIR, id), { recursive: true, force: true });
  deleteItemByOwner(id, ownerId);

  res.status(204).send();
});

app.get('/download/:id', async (req, res) => {
  const { id } = req.params;
  if (!isSafeItemId(id)) {
    res.status(400).send('Некорректный идентификатор элемента.');
    return;
  }

  const ownerId = getOwnerId(req);
  const item = getItemByOwner(id, ownerId);
  if (!item) {
    res.status(404).send('Элемент не найден.');
    return;
  }

  if (item.status !== 'ready') {
    res.status(409).send('Элемент еще не готов к скачиванию.');
    return;
  }

  if (!['file', 'youtube', 'instagram', 'hls', 'rutube', 'ok', 'vk'].includes(item.type)) {
    res.status(400).send('Скачивание для этого типа источника не поддерживается.');
    return;
  }

  let storedFileName: string | null = null;
  if (['file', 'youtube', 'instagram'].includes(item.type)) {
    storedFileName = await findDirectMediaFileName(id);
  } else if (['hls', 'rutube', 'ok', 'vk'].includes(item.type)) {
    try {
      storedFileName = await ensureHlsDownloadFile(id);
    } catch (error) {
      res.status(400).send(errorMessage(error));
      return;
    }
  }

  if (!storedFileName) {
    res.status(404).send('Файл для скачивания не найден.');
    return;
  }

  const baseDir = path.join(STORAGE_DIR, id);
  let filePath: string;
  try {
    filePath = safeJoin(baseDir, storedFileName);
  } catch {
    res.status(400).send('Некорректный путь к файлу.');
    return;
  }

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    res.status(404).send('Файл для скачивания не найден.');
    return;
  }

  if (!stat.isFile()) {
    res.status(404).send('Файл для скачивания не найден.');
    return;
  }

  const preferredExt = resolvePreferredDownloadExtension(item, storedFileName);
  const downloadFileName = buildDownloadFileNameWithPreferredExt(item.title || 'video', storedFileName, preferredExt);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', buildContentDisposition(downloadFileName));
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Transfer-Encoding', 'binary');
  res.setHeader('Cache-Control', 'no-store');

  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.status(500).send('Ошибка чтения файла.');
      return;
    }
    res.destroy();
  });
  stream.pipe(res);
});

app.get('/media/:id/*', async (req, res) => {
  const { id } = req.params;
  const requestPath = (req.params as Record<string, string>)[0] ?? '';

  if (!isSafeItemId(id)) {
    res.status(400).send('Некорректный идентификатор элемента.');
    return;
  }

  const ownerId = getOwnerId(req);
  const item = getItemByOwner(id, ownerId);
  if (!item || item.status !== 'ready') {
    res.status(404).send('Медиа не найдено.');
    return;
  }

  const baseDir = path.join(STORAGE_DIR, id);
  let filePath: string;
  try {
    filePath = safeJoin(baseDir, requestPath);
  } catch {
    res.status(400).send('Некорректный путь к медиа.');
    return;
  }

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    res.status(404).send('Медиафайл не найден.');
    return;
  }

  if (!stat.isFile()) {
    res.status(404).send('Медиафайл не найден.');
    return;
  }

  const detectedType = mime.lookup(filePath);
  if (detectedType) {
    res.type(detectedType);
  }

  res.sendFile(filePath);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const statusCode = err instanceof UserInputError ? err.statusCode : 500;
  res.status(statusCode).json({ error: errorMessage(err) });
});

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '0.0.0.0';

app.listen(port, host, () => {
  console.log(`LinkCatcher запущен на http://localhost:${port} (host: ${host})`);
});
