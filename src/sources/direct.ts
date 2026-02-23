import { MAX_REDIRECTS } from '../config';
import { UserInputError, fetchWithRedirects } from '../security';
import { DetectResult } from './types';

const DIRECT_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v']);

function normalizeContentType(contentType: string | null): string | null {
  if (!contentType) {
    return null;
  }
  return contentType.split(';')[0].trim().toLowerCase();
}

function extensionFromPath(pathname: string): string {
  const index = pathname.lastIndexOf('.');
  if (index < 0) {
    return '';
  }
  return pathname.slice(index).toLowerCase();
}

function isHeadFailure(response: Response): boolean {
  if (!response.ok) {
    return true;
  }

  if (response.status === 405 || response.status === 501) {
    return true;
  }

  return false;
}

function buildUnsupportedReason(extension: string, contentType: string | null): string {
  const details: string[] = [];

  if (extension) {
    details.push(`расширение URL: ${extension}`);
  }

  if (contentType) {
    details.push(`Content-Type: ${contentType}`);
  }

  const suffix = details.length > 0 ? ` Определено: ${details.join(', ')}.` : '';
  return `Источник не распознан как поддерживаемое медиа.${suffix} Используйте прямую ссылку .mp4/.webm/.mov/.m4v, video/* или открытый .m3u8-плейлист без DRM.`;
}

export async function detectDirectOrHlsSource(parsedUrl: URL): Promise<DetectResult> {
  let finalUrl = parsedUrl;
  let contentType: string | null = null;
  let fallbackToRangeGet = false;

  try {
    const headResult = await fetchWithRedirects(parsedUrl, { method: 'HEAD' }, MAX_REDIRECTS);
    finalUrl = headResult.finalUrl;
    contentType = normalizeContentType(headResult.response.headers.get('content-type'));
    fallbackToRangeGet = isHeadFailure(headResult.response);
  } catch (error) {
    if (error instanceof UserInputError) {
      throw error;
    }
    fallbackToRangeGet = true;
  }

  if (fallbackToRangeGet) {
    try {
      const rangeResult = await fetchWithRedirects(
        parsedUrl,
        {
          method: 'GET',
          headers: {
            Range: 'bytes=0-1048575'
          }
        },
        MAX_REDIRECTS
      );
      finalUrl = rangeResult.finalUrl;
      contentType = normalizeContentType(rangeResult.response.headers.get('content-type'));
      await rangeResult.response.body?.cancel();
    } catch (error) {
      if (error instanceof UserInputError) {
        throw error;
      }
      throw new Error('Не удалось проверить URL через HEAD/GET-пробу.');
    }
  }

  const lowerPath = finalUrl.pathname.toLowerCase();
  const extension = extensionFromPath(lowerPath);

  const isHlsByExtension = lowerPath.endsWith('.m3u8');
  const isHlsByContentType = Boolean(
    contentType &&
      (contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl'))
  );

  if (isHlsByExtension || isHlsByContentType) {
    return {
      type: 'hls',
      finalUrl: finalUrl.toString(),
      contentType,
      adapter: 'direct'
    };
  }

  const isVideoByExtension = DIRECT_EXTENSIONS.has(extension);
  const isVideoByContentType = Boolean(contentType?.startsWith('video/'));

  if (isVideoByExtension || isVideoByContentType) {
    return {
      type: 'file',
      finalUrl: finalUrl.toString(),
      contentType,
      adapter: 'direct'
    };
  }

  return {
    type: 'unsupported',
    finalUrl: finalUrl.toString(),
    contentType,
    reason: buildUnsupportedReason(extension, contentType),
    adapter: 'direct'
  };
}
