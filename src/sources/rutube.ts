import { isRutubeHost, isRutubeVideoPath } from '../rutube';
import { DetectResult } from './types';

export function detectRutubeSource(parsedUrl: URL): DetectResult | null {
  if (!isRutubeHost(parsedUrl.hostname)) {
    return null;
  }

  if (!isRutubeVideoPath(parsedUrl.pathname)) {
    return {
      type: 'unsupported',
      finalUrl: parsedUrl.toString(),
      reason:
        'Для RuTube поддерживаются ссылки вида /video/<id>/ или /video/private/<id>/. Используйте прямую ссылку на видео-страницу.',
      adapter: 'rutube'
    };
  }

  return {
    type: 'rutube',
    finalUrl: parsedUrl.toString(),
    adapter: 'rutube'
  };
}
