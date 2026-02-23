import { isOkHost, isOkVideoPath } from '../rutube';
import { DetectResult } from './types';

export function detectOkSource(parsedUrl: URL): DetectResult | null {
  if (!isOkHost(parsedUrl.hostname)) {
    return null;
  }

  if (!isOkVideoPath(parsedUrl.pathname)) {
    return {
      type: 'unsupported',
      finalUrl: parsedUrl.toString(),
      reason:
        'Для OK поддерживаются ссылки вида /video/<id> или /videoembed/<id> на публичные страницы.',
      adapter: 'ok'
    };
  }

  return {
    type: 'ok',
    finalUrl: parsedUrl.toString(),
    adapter: 'ok'
  };
}
