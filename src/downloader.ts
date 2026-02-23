import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import mime from 'mime-types';
import {
  MAX_DOWNLOAD_BYTES,
  MAX_HLS_SEGMENTS,
  MAX_REDIRECTS,
  PROGRESS_UPDATE_STEP_BYTES,
  STORAGE_DIR
} from './config';
import { Item, updateItem } from './db';
import { InstagramUnsupportedError, resolveInstagramMedia } from './instagram';
import { resolveOkMedia, resolveRutubeMedia, resolveVkMedia, RutubeUnsupportedError } from './rutube';
import { errorMessage, fetchWithRedirects } from './security';
import { runYoutubeDownload } from './youtube';

class UnsupportedSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSourceError';
  }
}

interface DownloadResult {
  finalUrl: string;
  sizeBytes: number;
}

interface DirectDownloadOptions {
  sourceUrl: string;
  fileNamePrefix: string;
  fallbackExt: string;
}

interface StartOptions {
  youtubeFormatId?: string;
}

interface PlaylistReference {
  kind: 'segment' | 'map';
  lineIndex: number;
  originalLine: string;
  absoluteUrl: string;
}

interface PlaylistDownload {
  text: string;
  finalUrl: string;
}

interface HlsRequestOptions {
  headers?: Record<string, string>;
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return err.name === 'AbortError';
}

function toSafeExtensionFromUrl(urlString: string, fallback: string): string {
  try {
    const parsed = new URL(urlString);
    const ext = path.extname(parsed.pathname).toLowerCase();
    if (ext && /^\.[a-z0-9]{1,8}$/i.test(ext)) {
      return ext;
    }
  } catch {
    // Ignore extension parse failure and use fallback.
  }

  return fallback;
}

function toSafeExtensionFromContentType(contentType: string | null, fallback: string): string {
  if (!contentType) {
    return fallback;
  }

  const normalized = contentType.split(';')[0].trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (normalized.includes('application/vnd.apple.mpegurl') || normalized.includes('application/x-mpegurl')) {
    return '.m3u8';
  }

  const resolved = mime.extension(normalized);
  if (typeof resolved === 'string' && /^[a-z0-9]{1,8}$/i.test(resolved)) {
    return `.${resolved.toLowerCase()}`;
  }

  return fallback;
}

function parseYoutubeProgressBytes(line: string): number | null {
  const match = /\[download\]\s+\d+(?:\.\d+)?%\s+of\s+~?([0-9.]+)([KMGTP]?i?B)/i.exec(line);
  if (!match) {
    return null;
  }

  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  const unit = match[2].toUpperCase();
  const unitMultipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    KIB: 1024,
    MB: 1024 ** 2,
    MIB: 1024 ** 2,
    GB: 1024 ** 3,
    GIB: 1024 ** 3,
    TB: 1024 ** 4,
    TIB: 1024 ** 4,
    PB: 1024 ** 5,
    PIB: 1024 ** 5
  };

  const multiplier = unitMultipliers[unit];
  if (!multiplier) {
    return null;
  }

  return Math.round(value * multiplier);
}

async function resetItemStorage(itemId: string): Promise<string> {
  const itemDir = path.join(STORAGE_DIR, itemId);
  await fs.rm(itemDir, { recursive: true, force: true });
  await fs.mkdir(itemDir, { recursive: true });
  return itemDir;
}

async function cleanupItemStorage(itemId: string): Promise<void> {
  const itemDir = path.join(STORAGE_DIR, itemId);
  await fs.rm(itemDir, { recursive: true, force: true });
}

async function streamResponseToFile(
  response: Response,
  filePath: string,
  onChunk: (delta: number) => void
): Promise<number> {
  if (!response.body) {
    throw new Error('Тело ответа пустое.');
  }

  const readable = Readable.fromWeb(response.body as any);
  const writable = createWriteStream(filePath, { flags: 'w' });

  let total = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const delta = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        total += delta;
        onChunk(delta);
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    }
  });

  await pipeline(readable, counter, writable);
  return total;
}

function parseMasterVariants(playlistText: string, baseUrl: string): Array<{ bandwidth: number; absoluteUrl: string }> {
  const lines = playlistText.split(/\r?\n/);
  const variants: Array<{ bandwidth: number; absoluteUrl: string }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF')) {
      continue;
    }

    const match = /BANDWIDTH=(\d+)/i.exec(line);
    const bandwidth = match ? Number.parseInt(match[1], 10) : 0;

    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = lines[j].trim();
      if (!candidate) {
        continue;
      }

      if (candidate.startsWith('#')) {
        continue;
      }

      variants.push({
        bandwidth,
        absoluteUrl: new URL(candidate, baseUrl).toString()
      });
      break;
    }
  }

  return variants;
}

function parseMediaPlaylist(playlistText: string, mediaUrl: string): { lines: string[]; references: PlaylistReference[] } {
  const lines = playlistText.split(/\r?\n/);
  const references: PlaylistReference[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith('#EXT-X-KEY')) {
      throw new UnsupportedSourceError('Зашифрованные HLS-плейлисты (EXT-X-KEY) не поддерживаются.');
    }

    if (trimmed.startsWith('#EXT-X-MAP')) {
      const uriMatch = /URI="([^"]+)"/i.exec(rawLine);
      if (uriMatch?.[1]) {
        references.push({
          kind: 'map',
          lineIndex: index,
          originalLine: rawLine,
          absoluteUrl: new URL(uriMatch[1], mediaUrl).toString()
        });
      }
      continue;
    }

    if (trimmed.startsWith('#')) {
      continue;
    }

    references.push({
      kind: 'segment',
      lineIndex: index,
      originalLine: rawLine,
      absoluteUrl: new URL(trimmed, mediaUrl).toString()
    });
  }

  return { lines, references };
}

async function fetchPlaylistText(url: string, signal: AbortSignal, requestOptions?: HlsRequestOptions): Promise<PlaylistDownload> {
  const { response, finalUrl } = await fetchWithRedirects(
    url,
    {
      method: 'GET',
      signal,
      headers: requestOptions?.headers
    },
    MAX_REDIRECTS
  );

  if (response.status === 401 || response.status === 403) {
    throw new UnsupportedSourceError('Плейлист требует авторизацию и не может быть импортирован.');
  }

  if (!response.ok) {
    throw new Error(`Не удалось загрузить плейлист (${response.status}).`);
  }

  return {
    text: await response.text(),
    finalUrl: finalUrl.toString()
  };
}

async function downloadDirectFromUrl(
  item: Item,
  signal: AbortSignal,
  options: DirectDownloadOptions
): Promise<DownloadResult> {
  const itemDir = await resetItemStorage(item.id);

  const { response, finalUrl } = await fetchWithRedirects(
    options.sourceUrl,
    {
      method: 'GET',
      signal
    },
    MAX_REDIRECTS
  );

  if (response.status === 401 || response.status === 403) {
    throw new UnsupportedSourceError('URL источника требует авторизацию и не может быть импортирован.');
  }

  if (!response.ok) {
    throw new Error(`Не удалось скачать медиа (${response.status}).`);
  }

  const contentLength = Number.parseInt(response.headers.get('content-length') ?? '0', 10);
  if (contentLength > MAX_DOWNLOAD_BYTES) {
    throw new UnsupportedSourceError(`Файл превышает максимальный размер (${MAX_DOWNLOAD_BYTES} байт).`);
  }

  const extFromFinalUrl = toSafeExtensionFromUrl(finalUrl.toString(), '');
  const extFromSourceUrl = toSafeExtensionFromUrl(options.sourceUrl, '');
  const extFromContentType = toSafeExtensionFromContentType(response.headers.get('content-type'), options.fallbackExt);
  const ext = extFromFinalUrl || extFromSourceUrl || extFromContentType || options.fallbackExt;

  const fileName = `${options.fileNamePrefix}${ext}`;
  const filePath = path.join(itemDir, fileName);

  let downloaded = 0;
  let lastPersisted = 0;

  await streamResponseToFile(response, filePath, (delta) => {
    downloaded += delta;

    if (downloaded > MAX_DOWNLOAD_BYTES) {
      throw new UnsupportedSourceError(`Файл превышает максимальный размер (${MAX_DOWNLOAD_BYTES} байт).`);
    }

    if (downloaded - lastPersisted >= PROGRESS_UPDATE_STEP_BYTES) {
      updateItem(item.id, { sizeBytes: downloaded, status: 'downloading' });
      lastPersisted = downloaded;
    }
  });

  return {
    finalUrl: finalUrl.toString(),
    sizeBytes: downloaded
  };
}

async function downloadDirectFile(item: Item, signal: AbortSignal): Promise<DownloadResult> {
  return downloadDirectFromUrl(item, signal, {
    sourceUrl: item.finalUrl,
    fileNamePrefix: 'video',
    fallbackExt: '.bin'
  });
}

async function downloadInstagram(item: Item, signal: AbortSignal): Promise<DownloadResult> {
  const resolved = await resolveInstagramMedia(item.finalUrl, signal);
  updateItem(item.id, { title: resolved.title, finalUrl: resolved.canonicalUrl });

  const directResult = await downloadDirectFromUrl(item, signal, {
    sourceUrl: resolved.mediaUrl,
    fileNamePrefix: resolved.mediaKind === 'image' ? 'image' : 'video',
    fallbackExt: resolved.mediaKind === 'image' ? '.jpg' : '.mp4'
  });

  return {
    finalUrl: resolved.canonicalUrl,
    sizeBytes: directResult.sizeBytes
  };
}

async function downloadResolvedPlatformHls(
  item: Item,
  signal: AbortSignal,
  resolver: (
    url: string,
    signal?: AbortSignal
  ) => Promise<{ mediaUrl: string; title: string; requestHeaders?: Record<string, string> }>
): Promise<DownloadResult> {
  const resolved = await resolver(item.finalUrl, signal);
  updateItem(item.id, {
    title: resolved.title,
    finalUrl: resolved.mediaUrl
  });

  return downloadHls(
    {
      ...item,
      finalUrl: resolved.mediaUrl,
      title: resolved.title
    },
    signal,
    { headers: resolved.requestHeaders }
  );
}

async function downloadHls(item: Item, signal: AbortSignal, requestOptions?: HlsRequestOptions): Promise<DownloadResult> {
  const itemDir = await resetItemStorage(item.id);
  const segmentsDir = path.join(itemDir, 'segments');
  await fs.mkdir(segmentsDir, { recursive: true });

  const rootPlaylist = await fetchPlaylistText(item.finalUrl, signal, requestOptions);
  let mediaPlaylistText = rootPlaylist.text;
  let mediaPlaylistUrl = rootPlaylist.finalUrl;

  const variants = parseMasterVariants(rootPlaylist.text, rootPlaylist.finalUrl);
  if (variants.length > 0) {
    const selected = variants.sort((a, b) => b.bandwidth - a.bandwidth)[0];
    const variantPlaylist = await fetchPlaylistText(selected.absoluteUrl, signal, requestOptions);
    mediaPlaylistText = variantPlaylist.text;
    mediaPlaylistUrl = variantPlaylist.finalUrl;
  }

  const parsed = parseMediaPlaylist(mediaPlaylistText, mediaPlaylistUrl);
  const segmentsOnly = parsed.references.filter((ref) => ref.kind === 'segment');

  if (segmentsOnly.length === 0) {
    throw new UnsupportedSourceError('В плейлисте не найдено воспроизводимых HLS-сегментов.');
  }

  if (segmentsOnly.length > MAX_HLS_SEGMENTS) {
    throw new UnsupportedSourceError(`Количество HLS-сегментов превышает лимит (${MAX_HLS_SEGMENTS}).`);
  }

  const resourceMap = new Map<string, { localPath: string; kind: 'segment' | 'map' }>();
  let segmentCounter = 0;
  let mapCounter = 0;

  for (const ref of parsed.references) {
    if (resourceMap.has(ref.absoluteUrl)) {
      continue;
    }

    if (ref.kind === 'segment') {
      segmentCounter += 1;
      const ext = toSafeExtensionFromUrl(ref.absoluteUrl, '.ts');
      const fileName = `seg-${String(segmentCounter).padStart(5, '0')}${ext}`;
      resourceMap.set(ref.absoluteUrl, {
        localPath: `segments/${fileName}`,
        kind: 'segment'
      });
    } else {
      mapCounter += 1;
      const ext = toSafeExtensionFromUrl(ref.absoluteUrl, '.bin');
      const fileName = `map-${String(mapCounter).padStart(5, '0')}${ext}`;
      resourceMap.set(ref.absoluteUrl, {
        localPath: `segments/${fileName}`,
        kind: 'map'
      });
    }
  }

  let totalBytes = 0;
  let lastPersisted = 0;

  for (const [resourceUrl, local] of resourceMap.entries()) {
    const destination = path.join(itemDir, local.localPath);
    await fs.mkdir(path.dirname(destination), { recursive: true });

    const { response } = await fetchWithRedirects(
      resourceUrl,
      {
        method: 'GET',
        signal,
        headers: requestOptions?.headers
      },
      MAX_REDIRECTS
    );

    if (response.status === 401 || response.status === 403) {
      throw new UnsupportedSourceError('URL HLS-сегментов требуют авторизацию и не поддерживаются.');
    }

    if (!response.ok) {
      throw new Error(`Не удалось скачать HLS-сегмент (${response.status}).`);
    }

    const contentLength = Number.parseInt(response.headers.get('content-length') ?? '0', 10);
    if (contentLength > 0 && totalBytes + contentLength > MAX_DOWNLOAD_BYTES) {
      throw new UnsupportedSourceError(`Размер HLS-загрузки превышает максимум (${MAX_DOWNLOAD_BYTES} байт).`);
    }

    await streamResponseToFile(response, destination, (delta) => {
      totalBytes += delta;

      if (totalBytes > MAX_DOWNLOAD_BYTES) {
        throw new UnsupportedSourceError(`Размер HLS-загрузки превышает максимум (${MAX_DOWNLOAD_BYTES} байт).`);
      }

      if (totalBytes - lastPersisted >= PROGRESS_UPDATE_STEP_BYTES) {
        updateItem(item.id, { sizeBytes: totalBytes, status: 'downloading' });
        lastPersisted = totalBytes;
      }
    });
  }

  const rewrittenLines = [...parsed.lines];
  for (const reference of parsed.references) {
    const resource = resourceMap.get(reference.absoluteUrl);
    if (!resource) {
      continue;
    }

    if (reference.kind === 'segment') {
      rewrittenLines[reference.lineIndex] = resource.localPath;
      continue;
    }

    rewrittenLines[reference.lineIndex] = reference.originalLine.replace(
      /URI="([^"]+)"/i,
      `URI="${resource.localPath}"`
    );
  }

  await fs.writeFile(path.join(itemDir, 'index.m3u8'), rewrittenLines.join('\n'), 'utf8');

  return {
    finalUrl: mediaPlaylistUrl,
    sizeBytes: totalBytes
  };
}

async function findDownloadedYoutubeFile(itemDir: string): Promise<string | null> {
  const entries = await fs.readdir(itemDir, { withFileTypes: true });
  const file = entries.find((entry) => entry.isFile() && entry.name.startsWith('video.'));
  return file?.name ?? null;
}

async function downloadYoutube(item: Item, signal: AbortSignal, formatId?: string): Promise<DownloadResult> {
  const itemDir = await resetItemStorage(item.id);
  const outputTemplate = path.join(itemDir, 'video.%(ext)s');

  let lastProgressPersist = 0;

  await runYoutubeDownload({
    url: item.finalUrl,
    outputTemplate,
    formatId,
    signal,
    onLine: (line) => {
      const totalBytes = parseYoutubeProgressBytes(line);
      if (!totalBytes) {
        return;
      }

      if (totalBytes - lastProgressPersist >= PROGRESS_UPDATE_STEP_BYTES) {
        updateItem(item.id, { sizeBytes: totalBytes, status: 'downloading' });
        lastProgressPersist = totalBytes;
      }
    }
  });

  const fileName = await findDownloadedYoutubeFile(itemDir);
  if (!fileName) {
    throw new Error('youtube-dl завершил работу, но файл не найден.');
  }

  const stat = await fs.stat(path.join(itemDir, fileName));
  if (stat.size > MAX_DOWNLOAD_BYTES) {
    throw new UnsupportedSourceError(`Файл превышает максимальный размер (${MAX_DOWNLOAD_BYTES} байт).`);
  }

  return {
    finalUrl: item.finalUrl,
    sizeBytes: stat.size
  };
}

export class Downloader {
  private readonly jobs = new Map<string, AbortController>();
  private readonly jobOptions = new Map<string, StartOptions>();

  start(item: Item, options: StartOptions = {}): void {
    if (this.jobs.has(item.id)) {
      return;
    }

    const controller = new AbortController();
    this.jobs.set(item.id, controller);
    this.jobOptions.set(item.id, options);

    void this.run(item, controller)
      .catch(() => {
        // Error handling is performed inside run.
      })
      .finally(() => {
        this.jobs.delete(item.id);
        this.jobOptions.delete(item.id);
      });
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.abort();
      this.jobs.delete(id);
    }
  }

  private async run(item: Item, controller: AbortController): Promise<void> {
    updateItem(item.id, { status: 'downloading', reason: null });

    try {
      let result: DownloadResult;
      const options = this.jobOptions.get(item.id);
      if (item.type === 'file') {
        result = await downloadDirectFile(item, controller.signal);
      } else if (item.type === 'hls') {
        result = await downloadHls(item, controller.signal);
      } else if (item.type === 'youtube') {
        result = await downloadYoutube(item, controller.signal, options?.youtubeFormatId);
      } else if (item.type === 'instagram') {
        result = await downloadInstagram(item, controller.signal);
      } else if (item.type === 'rutube') {
        result = await downloadResolvedPlatformHls(item, controller.signal, resolveRutubeMedia);
      } else if (item.type === 'ok') {
        result = await downloadResolvedPlatformHls(item, controller.signal, resolveOkMedia);
      } else if (item.type === 'vk') {
        result = await downloadResolvedPlatformHls(item, controller.signal, resolveVkMedia);
      } else {
        throw new UnsupportedSourceError('Неподдерживаемый тип элемента.');
      }

      updateItem(item.id, {
        finalUrl: result.finalUrl,
        sizeBytes: result.sizeBytes,
        status: 'ready',
        reason: null
      });
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      await cleanupItemStorage(item.id);

      if (
        error instanceof UnsupportedSourceError ||
        error instanceof InstagramUnsupportedError ||
        error instanceof RutubeUnsupportedError
      ) {
        updateItem(item.id, {
          type: 'unsupported',
          status: 'unsupported',
          reason: error.message
        });
        return;
      }

      updateItem(item.id, {
        status: 'error',
        reason: errorMessage(error)
      });
    }
  }
}
