import { validateHttpUrl } from '../security';
import { detectDirectOrHlsSource } from './direct';
import { detectInstagramSource } from './instagram';
import { detectOkSource } from './ok';
import { detectBlockedPlatformSource } from './platform-block';
import { detectRutubeSource } from './rutube';
import { detectVkSource } from './vk';
import { detectYoutubeSource } from './youtube';
import { DetectResult } from './types';

export { type DetectResult, type DetectedKind } from './types';

export async function detectSourceByAdapters(rawUrl: string): Promise<DetectResult> {
  const parsed = validateHttpUrl(rawUrl);

  const fastMatches = [
    detectYoutubeSource(parsed),
    detectInstagramSource(parsed),
    detectRutubeSource(parsed),
    detectOkSource(parsed),
    detectVkSource(parsed),
    detectBlockedPlatformSource(parsed)
  ];

  for (const match of fastMatches) {
    if (match) {
      return match;
    }
  }

  return detectDirectOrHlsSource(parsed);
}
