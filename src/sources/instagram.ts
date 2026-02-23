import { isInstagramHost } from '../instagram';
import { DetectResult } from './types';

const INSTAGRAM_MEDIA_PATH = /\/(p|reel)\/[a-zA-Z0-9_-]+/i;

export function detectInstagramSource(parsedUrl: URL): DetectResult | null {
  if (!isInstagramHost(parsedUrl.hostname)) {
    return null;
  }

  if (!INSTAGRAM_MEDIA_PATH.test(parsedUrl.pathname)) {
    return {
      type: 'unsupported',
      finalUrl: parsedUrl.toString(),
      reason:
        'Для Instagram поддерживаются только ссылки вида /p/<shortcode>/ и /reel/<shortcode>/ на публичные публикации.',
      adapter: 'instagram'
    };
  }

  return {
    type: 'instagram',
    finalUrl: parsedUrl.toString(),
    adapter: 'instagram'
  };
}
