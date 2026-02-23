import { isYoutubeHost } from '../youtube';
import { DetectResult } from './types';

export function detectYoutubeSource(parsedUrl: URL): DetectResult | null {
  if (!isYoutubeHost(parsedUrl.hostname)) {
    return null;
  }

  return {
    type: 'youtube',
    finalUrl: parsedUrl.toString(),
    adapter: 'youtube'
  };
}
