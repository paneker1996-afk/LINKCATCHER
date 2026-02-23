import { isVkHost, isVkVideoPath } from '../rutube';
import { DetectResult } from './types';

export function detectVkSource(parsedUrl: URL): DetectResult | null {
  if (!isVkHost(parsedUrl.hostname)) {
    return null;
  }

  if (!isVkVideoPath(parsedUrl.pathname)) {
    return {
      type: 'unsupported',
      finalUrl: parsedUrl.toString(),
      reason:
        'Для VK Video поддерживаются ссылки вида /video<owner>_<id> и /playlist/.../video<owner>_<id> на публичные видео.',
      adapter: 'vk'
    };
  }

  return {
    type: 'vk',
    finalUrl: parsedUrl.toString(),
    adapter: 'vk'
  };
}
