import { DetectResult } from './types';

interface BlockedPlatform {
  suffix: string;
  title: string;
}

const BLOCKED_PLATFORMS: BlockedPlatform[] = [
  { suffix: 'tiktok.com', title: 'TikTok' },
  { suffix: 'facebook.com', title: 'Facebook' },
  { suffix: 'x.com', title: 'X/Twitter' },
  { suffix: 'twitter.com', title: 'X/Twitter' },
  { suffix: 'vimeo.com', title: 'Vimeo' }
];

function findBlockedPlatform(hostname: string): BlockedPlatform | null {
  const lower = hostname.toLowerCase();
  return (
    BLOCKED_PLATFORMS.find((platform) => lower === platform.suffix || lower.endsWith(`.${platform.suffix}`)) ?? null
  );
}

export function detectBlockedPlatformSource(parsedUrl: URL): DetectResult | null {
  const blocked = findBlockedPlatform(parsedUrl.hostname);
  if (!blocked) {
    return null;
  }

  return {
    type: 'unsupported',
    finalUrl: parsedUrl.toString(),
    reason: `${blocked.title} не поддерживается в этом сервисе. Используйте прямую ссылку на файл .mp4/.webm/.mov/.m4v или открытый .m3u8 без DRM.`,
    adapter: 'platform-block'
  };
}
