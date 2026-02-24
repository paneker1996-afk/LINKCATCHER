import crypto from 'crypto';
import { spawn } from 'child_process';
import { createReadStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import express from 'express';
import rateLimit from 'express-rate-limit';
import mime from 'mime-types';
import {
  BASE_URL,
  BOT_TOKEN,
  DOWNLOAD_LINK_TTL_SECONDS,
  SESSION_SECRET,
  SESSION_TTL_SECONDS,
  STORAGE_DIR,
  TELEGRAM_AUTH_MAX_AGE_SECONDS,
  TELEGRAM_ENABLED,
  WEBAPP_URL
} from './config';
import {
  createItem,
  createTelegramSession,
  deleteItem,
  getItem,
  getTelegramSessionUser,
  listItems,
  purgeExpiredTelegramSessions,
  updateItem,
  upsertTelegramUser
} from './db';
import { detectSource } from './detector';
import { Downloader } from './downloader';
import { UserInputError, errorMessage, isSafeItemId, safeJoin, validateHttpUrl } from './security';
import { getYoutubeFormats, isYoutubeUrl } from './youtube';

const app = express();
const downloader = new Downloader();
const hlsTranscodeJobs = new Map<string, Promise<void>>();
const SESSION_COOKIE_NAME = 'lc_session';
const baseUrlProtocol = (() => {
  if (!BASE_URL) {
    return null;
  }

  try {
    return new URL(BASE_URL).protocol;
  } catch {
    return null;
  }
})();

if (TELEGRAM_ENABLED && !BOT_TOKEN) {
  throw new Error('BOT_TOKEN is required when TELEGRAM_ENABLED=true');
}

if (TELEGRAM_ENABLED && !SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required when TELEGRAM_ENABLED=true');
}

if (TELEGRAM_ENABLED && (!WEBAPP_URL || !/^https:\/\//i.test(WEBAPP_URL))) {
  throw new Error('WEBAPP_URL must be a valid https:// URL when TELEGRAM_ENABLED=true');
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

const inboxLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => req.ip || 'unknown',
  message: {
    error: 'Слишком много запросов. Повторите через минуту.'
  }
});

interface TelegramInitDataUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_bot?: boolean;
  is_premium?: boolean;
  allows_write_to_pm?: boolean;
  photo_url?: string;
}

interface TelegramAuthPayload {
  authDate: number;
  user: TelegramInitDataUser;
}

function parseCookies(headerValue: string | undefined): Record<string, string> {
  if (!headerValue) {
    return {};
  }

  const cookies: Record<string, string> = {};
  for (const pair of headerValue.split(';')) {
    const [rawName, ...rest] = pair.split('=');
    if (!rawName || rest.length === 0) {
      continue;
    }

    const name = rawName.trim();
    if (!name) {
      continue;
    }

    const value = rest.join('=').trim();
    if (!value) {
      continue;
    }

    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }

  return cookies;
}

function signSessionId(sessionId: string): string {
  if (!SESSION_SECRET) {
    return '';
  }
  return crypto.createHmac('sha256', SESSION_SECRET).update(sessionId).digest('base64url');
}

function buildSignedSessionToken(sessionId: string): string {
  return `${sessionId}.${signSessionId(sessionId)}`;
}

function parseSignedSessionToken(token: string | undefined): string | null {
  if (!token || !SESSION_SECRET) {
    return null;
  }

  const separatorIndex = token.lastIndexOf('.');
  if (separatorIndex < 1 || separatorIndex === token.length - 1) {
    return null;
  }

  const sessionId = token.slice(0, separatorIndex);
  const providedSignature = token.slice(separatorIndex + 1);
  const expectedSignature = signSessionId(sessionId);

  const providedBuffer = Buffer.from(providedSignature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null;
  }

  return sessionId;
}

function createDownloadToken(itemId: string): string {
  if (!SESSION_SECRET) {
    throw new UserInputError('SESSION_SECRET is missing for download token signing.', 500);
  }

  const expiresAt = Math.floor(Date.now() / 1000) + DOWNLOAD_LINK_TTL_SECONDS;
  const payload = `${itemId}:${String(expiresAt)}`;
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${String(expiresAt)}.${signature}`;
}

function verifyDownloadToken(itemId: string, token: string): boolean {
  if (!SESSION_SECRET || !token) {
    return false;
  }

  const separatorIndex = token.indexOf('.');
  if (separatorIndex <= 0 || separatorIndex >= token.length - 1) {
    return false;
  }

  const expiresAtRaw = token.slice(0, separatorIndex);
  const providedSignature = token.slice(separatorIndex + 1);
  if (!/^\d+$/.test(expiresAtRaw)) {
    return false;
  }

  const expiresAt = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(`${itemId}:${String(expiresAt)}`)
    .digest('base64url');

  const providedBuffer = Buffer.from(providedSignature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function extractDownloadItemIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/download\/([a-zA-Z0-9-]{1,100})$/);
  return match ? match[1] : null;
}

function shouldUseSecureCookie(req: express.Request): boolean {
  if (baseUrlProtocol === 'https:') {
    return true;
  }

  if (req.secure) {
    return true;
  }

  const forwardedProto = req.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string') {
    return forwardedProto.split(',').some((value) => value.trim().toLowerCase() === 'https');
  }

  if (Array.isArray(forwardedProto)) {
    return forwardedProto.some((value) => value.trim().toLowerCase() === 'https');
  }

  return false;
}

function buildSessionCookie(req: express.Request, signedToken: string): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(signedToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(SESSION_TTL_SECONDS)}`
  ];

  if (shouldUseSecureCookie(req)) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}

function clearSessionCookie(req: express.Request): string {
  const attributes = [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (shouldUseSecureCookie(req)) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

function toTelegramUser(value: unknown): TelegramInitDataUser | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'number' || !Number.isFinite(candidate.id)) {
    return null;
  }

  if (typeof candidate.first_name !== 'string' || candidate.first_name.trim().length === 0) {
    return null;
  }

  return {
    id: candidate.id,
    first_name: candidate.first_name,
    last_name: typeof candidate.last_name === 'string' ? candidate.last_name : undefined,
    username: typeof candidate.username === 'string' ? candidate.username : undefined,
    language_code: typeof candidate.language_code === 'string' ? candidate.language_code : undefined,
    is_bot: Boolean(candidate.is_bot),
    is_premium: Boolean(candidate.is_premium),
    allows_write_to_pm: Boolean(candidate.allows_write_to_pm),
    photo_url: typeof candidate.photo_url === 'string' ? candidate.photo_url : undefined
  };
}

function validateTelegramInitData(initData: string): TelegramAuthPayload {
  if (!BOT_TOKEN) {
    throw new UserInputError('Telegram auth is not configured on server.', 500);
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
    throw new UserInputError('Некорректный hash Telegram initData.', 401);
  }

  const authDateRaw = params.get('auth_date');
  const authDate = Number.parseInt(authDateRaw ?? '', 10);
  if (!Number.isFinite(authDate) || authDate <= 0) {
    throw new UserInputError('Некорректный auth_date в initData.', 401);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (authDate > nowSec + 60) {
    throw new UserInputError('auth_date из будущего. Проверьте время устройства.', 401);
  }

  if (nowSec - authDate > TELEGRAM_AUTH_MAX_AGE_SECONDS) {
    throw new UserInputError('initData устарел. Откройте Mini App заново.', 401);
  }

  const dataCheckString = Array.from(params.entries())
    .filter(([key]) => key !== 'hash')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const receivedBuffer = Buffer.from(receivedHash.toLowerCase(), 'utf8');
  const expectedBuffer = Buffer.from(expectedHash, 'utf8');
  if (receivedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
    throw new UserInputError('Подпись initData не прошла проверку.', 401);
  }

  const rawUser = params.get('user');
  if (!rawUser) {
    throw new UserInputError('initData не содержит user.', 401);
  }

  let parsedUser: unknown;
  try {
    parsedUser = JSON.parse(rawUser);
  } catch {
    throw new UserInputError('Некорректный формат user в initData.', 401);
  }

  const user = toTelegramUser(parsedUser);
  if (!user) {
    throw new UserInputError('Некорректные данные Telegram user.', 401);
  }

  return {
    authDate,
    user
  };
}

function getTelegramSessionFromRequest(req: express.Request) {
  if (!TELEGRAM_ENABLED) {
    return null;
  }

  const cookies = parseCookies(req.headers.cookie);
  const signedToken = cookies[SESSION_COOKIE_NAME];
  const sessionId = parseSignedSessionToken(signedToken);
  if (!sessionId) {
    return null;
  }

  return getTelegramSessionUser(sessionId);
}

function renderWithTelegram(res: express.Response, view: string, payload: Record<string, unknown> = {}) {
  res.render(view, {
    ...payload,
    telegramEnabled: TELEGRAM_ENABLED
  });
}

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

app.post('/api/telegram/auth', (req, res) => {
  if (!TELEGRAM_ENABLED) {
    res.status(400).json({ error: 'Telegram mode is disabled.' });
    return;
  }

  const initData = typeof req.body?.initData === 'string' ? req.body.initData.trim() : '';
  if (!initData) {
    res.status(400).json({ error: 'Требуется поле initData.' });
    return;
  }

  let authPayload: TelegramAuthPayload;
  try {
    authPayload = validateTelegramInitData(initData);
  } catch (error) {
    const status = error instanceof UserInputError ? error.statusCode : 401;
    res.status(status).json({ error: errorMessage(error) });
    return;
  }

  try {
    purgeExpiredTelegramSessions();

    const telegramId = String(authPayload.user.id);
    upsertTelegramUser({
      id: telegramId,
      username: authPayload.user.username ?? null,
      firstName: authPayload.user.first_name,
      lastName: authPayload.user.last_name ?? null,
      languageCode: authPayload.user.language_code ?? null,
      isBot: authPayload.user.is_bot,
      isPremium: authPayload.user.is_premium,
      allowsWriteToPm: authPayload.user.allows_write_to_pm,
      photoUrl: authPayload.user.photo_url ?? null
    });

    const sessionId = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
    createTelegramSession(sessionId, telegramId, expiresAt);
    res.setHeader('Set-Cookie', buildSessionCookie(req, buildSignedSessionToken(sessionId)));

    res.json({
      ok: true,
      user: {
        id: authPayload.user.id,
        username: authPayload.user.username ?? null,
        firstName: authPayload.user.first_name
      }
    });
  } catch (error) {
    console.error('Telegram auth persistence error:', error);
    res.status(500).json({ error: 'Не удалось завершить авторизацию Telegram.' });
  }
});

app.get('/api/telegram/me', (req, res) => {
  if (!TELEGRAM_ENABLED) {
    res.json({ enabled: false, authenticated: false });
    return;
  }

  const user = getTelegramSessionFromRequest(req);
  if (!user) {
    res.status(401).json({ enabled: true, authenticated: false });
    return;
  }

  res.json({ enabled: true, authenticated: true, user });
});

app.get('/api/download-link/:id', (req, res) => {
  const { id } = req.params;
  if (!isSafeItemId(id)) {
    res.status(400).json({ error: 'Некорректный идентификатор элемента.' });
    return;
  }

  const item = getItem(id);
  if (!item) {
    res.status(404).json({ error: 'Элемент не найден.' });
    return;
  }

  if (item.status !== 'ready') {
    res.status(409).json({ error: 'Элемент еще не готов к скачиванию.' });
    return;
  }

  if (!['file', 'youtube', 'instagram', 'hls', 'rutube', 'ok', 'vk'].includes(item.type)) {
    res.status(400).json({ error: 'Скачивание для этого типа источника не поддерживается.' });
    return;
  }

  try {
    const token = createDownloadToken(id);
    res.json({
      url: `/download/${id}?dl_token=${encodeURIComponent(token)}`
    });
  } catch (error) {
    const status = error instanceof UserInputError ? error.statusCode : 500;
    res.status(status).json({ error: errorMessage(error) });
  }
});

app.use((req, res, next) => {
  if (!TELEGRAM_ENABLED) {
    return next();
  }

  if (req.path === '/health' || req.path === '/api/telegram/auth' || req.path === '/api/telegram/me') {
    return next();
  }

  if (req.path.startsWith('/public/')) {
    return next();
  }

  if (req.path.startsWith('/download/')) {
    const itemId = extractDownloadItemIdFromPath(req.path);
    const tokenValue = typeof req.query?.dl_token === 'string' ? req.query.dl_token.trim() : '';
    if (itemId && tokenValue && verifyDownloadToken(itemId, tokenValue)) {
      return next();
    }
  }

  const requiresSession =
    req.path.startsWith('/api/') ||
    req.path.startsWith('/download/') ||
    req.path.startsWith('/media/') ||
    req.path.startsWith('/play/');

  if (!requiresSession) {
    return next();
  }

  const sessionUser = getTelegramSessionFromRequest(req);
  if (!sessionUser) {
    res.setHeader('Set-Cookie', clearSessionCookie(req));
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Требуется авторизация через Telegram Mini App.' });
      return;
    }
    res.status(401).send('Требуется авторизация через Telegram Mini App.');
    return;
  }

  return next();
});

app.get('/', (_req, res) => {
  renderWithTelegram(res, 'home');
});

app.get('/library', (_req, res) => {
  const items = listItems();
  renderWithTelegram(res, 'library', { items });
});

app.get('/play/:id', async (req, res) => {
  const { id } = req.params;
  if (!isSafeItemId(id)) {
    res.status(400).send('Некорректный идентификатор элемента.');
    return;
  }

  const item = getItem(id);
  if (!item) {
    res.status(404).send('Элемент не найден.');
    return;
  }

  if (item.status !== 'ready') {
    renderWithTelegram(res, 'player', {
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
      renderWithTelegram(res, 'player', {
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
    renderWithTelegram(res, 'player', {
      item,
      mediaUrl: null,
      mediaKind: null,
      error: 'Неподдерживаемый медиаэлемент.'
    });
    return;
  }

  renderWithTelegram(res, 'player', {
    item,
    mediaUrl,
    mediaKind,
    error: null
  });
});

app.post('/api/inbox', inboxLimiter, async (req, res) => {
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

    const queuedItem = getItem(id);
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
  res.json(listItems());
});

app.get('/api/items/:id', (req, res) => {
  const { id } = req.params;
  if (!isSafeItemId(id)) {
    res.status(400).json({ error: 'Некорректный идентификатор элемента.' });
    return;
  }

  const item = getItem(id);
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

  const existing = getItem(id);
  if (!existing) {
    res.status(404).json({ error: 'Элемент не найден.' });
    return;
  }

  downloader.cancel(id);
  await fs.rm(path.join(STORAGE_DIR, id), { recursive: true, force: true });
  deleteItem(id);

  res.status(204).send();
});

app.get('/download/:id', async (req, res) => {
  const { id } = req.params;
  if (!isSafeItemId(id)) {
    res.status(400).send('Некорректный идентификатор элемента.');
    return;
  }

  const item = getItem(id);
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
  const downloadMimeType = mime.lookup(downloadFileName) || mime.lookup(storedFileName) || 'application/octet-stream';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', buildContentDisposition(downloadFileName));
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Content-Type', String(downloadMimeType));
  res.setHeader('Accept-Ranges', 'bytes');
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

  const item = getItem(id);
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
