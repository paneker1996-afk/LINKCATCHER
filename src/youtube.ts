import { spawn } from 'child_process';
import { ROOT_DIR } from './config';
import { UserInputError, validateHttpUrl } from './security';

const YOUTUBE_SUFFIXES = ['youtube.com', 'youtu.be'];

export interface YoutubeFormat {
  formatId: string;
  ext: string;
  label: string;
  sizeBytes: number | null;
  kind: 'video' | 'audio' | 'other';
}

export interface YoutubeFormatsResult {
  title: string;
  formats: YoutubeFormat[];
}

interface YoutubeDlJson {
  title?: unknown;
  formats?: unknown;
}

interface YoutubeDlFormat {
  format_id?: unknown;
  ext?: unknown;
  format?: unknown;
  format_note?: unknown;
  resolution?: unknown;
  width?: unknown;
  height?: unknown;
  filesize?: unknown;
  filesize_approx?: unknown;
  vcodec?: unknown;
  acodec?: unknown;
  protocol?: unknown;
}

export interface YoutubeDownloadOptions {
  url: string;
  outputTemplate: string;
  formatId?: string;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function toSizeBytes(format: YoutubeDlFormat): number | null {
  if (isPositiveNumber(format.filesize)) {
    return format.filesize;
  }
  if (isPositiveNumber(format.filesize_approx)) {
    return format.filesize_approx;
  }
  return null;
}

function formatBytes(bytes: number | null): string {
  if (!bytes || bytes <= 0) {
    return 'размер неизвестен';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  const fixed = index === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${fixed} ${units[index]}`;
}

export function isYoutubeHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return YOUTUBE_SUFFIXES.some((suffix) => lower === suffix || lower.endsWith(`.${suffix}`));
}

export function isYoutubeUrl(rawUrl: string): boolean {
  try {
    const parsed = validateHttpUrl(rawUrl);
    return isYoutubeHost(parsed.hostname);
  } catch {
    return false;
  }
}

function classifyFormat(format: YoutubeDlFormat): 'video' | 'audio' | 'other' {
  const vcodec = typeof format.vcodec === 'string' ? format.vcodec : '';
  const acodec = typeof format.acodec === 'string' ? format.acodec : '';

  const hasVideo = vcodec.length > 0 && vcodec !== 'none';
  const hasAudio = acodec.length > 0 && acodec !== 'none';

  if (!hasVideo && hasAudio) {
    return 'audio';
  }

  if (hasVideo) {
    return 'video';
  }

  return 'other';
}

function buildFormatLabel(format: YoutubeDlFormat, sizeBytes: number | null): string {
  const ext = typeof format.ext === 'string' ? format.ext : 'bin';
  const resolution =
    typeof format.resolution === 'string'
      ? format.resolution
      : isPositiveNumber(format.width) && isPositiveNumber(format.height)
        ? `${format.width}x${format.height}`
        : null;
  const note = typeof format.format_note === 'string' ? format.format_note : '';
  const base = typeof format.format === 'string' ? format.format : '';
  const acodec = typeof format.acodec === 'string' ? format.acodec : '';
  const vcodec = typeof format.vcodec === 'string' ? format.vcodec : '';
  const hasAudio = acodec.length > 0 && acodec !== 'none';
  const hasVideo = vcodec.length > 0 && vcodec !== 'none';

  const parts = [ext.toUpperCase()];
  if (resolution && resolution !== 'audio only') {
    parts.push(resolution);
  }
  if (note) {
    parts.push(note);
  }
  if (!note && base) {
    parts.push(base);
  }
  if (hasVideo && !hasAudio) {
    parts.push('без аудио');
  }
  parts.push(formatBytes(sizeBytes));

  return parts.join(' • ');
}

function sortFormats(formats: YoutubeFormat[]): YoutubeFormat[] {
  return [...formats].sort((a, b) => {
    if (a.kind !== b.kind) {
      if (a.kind === 'video') return -1;
      if (b.kind === 'video') return 1;
      if (a.kind === 'audio') return -1;
      if (b.kind === 'audio') return 1;
    }

    const aSize = a.sizeBytes ?? 0;
    const bSize = b.sizeBytes ?? 0;
    return bSize - aSize;
  });
}

function collectLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isFragmentRetryError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('fragment retries') ||
    lower.includes('unable to download video data') ||
    lower.includes('giving up after') ||
    lower.includes('http error 403')
  );
}

function runYoutubeDl(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['tools/youtube-dl.sh', ...args], {
      cwd: ROOT_DIR
    });

    let stdout = '';
    let stderr = '';
    let closed = false;

    const closeWithError = (error: Error): void => {
      if (closed) {
        return;
      }
      closed = true;
      reject(error);
    };

    if (signal) {
      if (signal.aborted) {
        child.kill('SIGTERM');
      } else {
        signal.addEventListener(
          'abort',
          () => {
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 1500).unref();
          },
          { once: true }
        );
      }
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', closeWithError);
    child.on('close', (code) => {
      if (closed) {
        return;
      }
      closed = true;
      resolve({ stdout, stderr, code });
    });
  });
}

function createAbortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

export async function getYoutubeFormats(rawUrl: string): Promise<YoutubeFormatsResult> {
  const parsed = validateHttpUrl(rawUrl);
  if (!isYoutubeHost(parsed.hostname)) {
    throw new UserInputError('Для вариантов поддерживаются только ссылки YouTube.');
  }

  const result = await runYoutubeDl(['-J', '--no-playlist', '--no-warnings', parsed.toString()]);
  if (result.code !== 0) {
    const details = collectLines(result.stderr).slice(-2).join(' ');
    throw new Error(details || 'Не удалось получить список форматов YouTube.');
  }

  let parsedJson: YoutubeDlJson;
  try {
    parsedJson = JSON.parse(result.stdout) as YoutubeDlJson;
  } catch {
    throw new Error('youtube-dl вернул некорректный JSON форматов.');
  }

  const rawFormats = Array.isArray(parsedJson.formats) ? (parsedJson.formats as YoutubeDlFormat[]) : [];
  const formats: YoutubeFormat[] = [];

  for (const format of rawFormats) {
    const formatId = typeof format.format_id === 'string' ? format.format_id : '';
    const ext = typeof format.ext === 'string' ? format.ext : '';
    if (!formatId || !ext) {
      continue;
    }

    if (!['mp4', 'webm', 'm4a'].includes(ext)) {
      continue;
    }

    const acodec = typeof format.acodec === 'string' ? format.acodec : '';
    const vcodec = typeof format.vcodec === 'string' ? format.vcodec : '';
    const protocol = typeof format.protocol === 'string' ? format.protocol.toLowerCase() : '';
    const hasVideo = vcodec.length > 0 && vcodec !== 'none';
    const hasAudio = acodec.length > 0 && acodec !== 'none';

    if (hasVideo && !hasAudio) {
      continue;
    }

    if (protocol.startsWith('m3u8') || protocol.includes('dash')) {
      continue;
    }

    const sizeBytes = toSizeBytes(format);
    formats.push({
      formatId,
      ext,
      label: buildFormatLabel(format, sizeBytes),
      sizeBytes,
      kind: classifyFormat(format)
    });
  }

  const uniqueById = new Map<string, YoutubeFormat>();
  for (const format of formats) {
    if (!uniqueById.has(format.formatId)) {
      uniqueById.set(format.formatId, format);
    }
  }

  const title = typeof parsedJson.title === 'string' ? parsedJson.title : parsed.hostname;
  return {
    title,
    formats: sortFormats([...uniqueById.values()])
  };
}

export async function runYoutubeDownload(options: YoutubeDownloadOptions): Promise<void> {
  async function runAttempt(formatExpression: string): Promise<void> {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--newline',
      '--retries',
      '15',
      '--fragment-retries',
      '30',
      '-o',
      options.outputTemplate,
      '-f',
      formatExpression,
      options.url
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn('bash', ['tools/youtube-dl.sh', ...args], {
        cwd: ROOT_DIR
      });

      let stderr = '';
      let done = false;

      const finishError = (error: Error): void => {
        if (done) return;
        done = true;
        reject(error);
      };

      if (options.signal) {
        if (options.signal.aborted) {
          child.kill('SIGTERM');
        } else {
          options.signal.addEventListener(
            'abort',
            () => {
              child.kill('SIGTERM');
              setTimeout(() => child.kill('SIGKILL'), 1500).unref();
            },
            { once: true }
          );
        }
      }

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      child.stdout.on('data', (chunk: string) => {
        const lines = collectLines(chunk);
        for (const line of lines) {
          options.onLine?.(line);
        }
      });

      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        const lines = collectLines(chunk);
        for (const line of lines) {
          options.onLine?.(line);
        }
      });

      child.on('error', finishError);
      child.on('close', (code) => {
        if (done) {
          return;
        }
        done = true;
        if (options.signal?.aborted) {
          reject(createAbortError());
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }

        const details = collectLines(stderr).slice(-5).join(' ');
        reject(new Error(details || `youtube-dl завершился с кодом ${String(code)}.`));
      });
    });
  }

  const requested = options.formatId?.trim() || 'best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]/18/best';
  const fallback = '18/best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]/best';

  try {
    await runAttempt(requested);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    if (error.name === 'AbortError') {
      throw error;
    }

    const shouldRetryWithFallback = requested !== fallback && isFragmentRetryError(error.message);
    if (!shouldRetryWithFallback) {
      throw error;
    }

    options.onLine?.('Переключаюсь на резервный формат из-за ошибки фрагментов…');
    try {
      await runAttempt(fallback);
    } catch (fallbackError) {
      const details = fallbackError instanceof Error ? fallbackError.message : 'Неизвестная ошибка.';
      throw new Error(`Не удалось скачать видео даже с резервным форматом. ${details}`);
    }
  }
}
