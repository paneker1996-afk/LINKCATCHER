import querystring from 'querystring';
import { fetchWithRedirects, validateHttpUrl } from './security';
import { MAX_REDIRECTS } from './config';

const INSTAGRAM_SUFFIXES = ['instagram.com', 'instagr.am'];
const SHORTCODE_REGEX = /\/(p|reel)\/([a-zA-Z0-9_-]+)\/?/i;
const SHORTCODE_MIN_LENGTH = 5;
const SHORTCODE_STANDARD_LENGTH = 11;

type GraphMedia = {
  is_video?: unknown;
  video_url?: unknown;
  display_url?: unknown;
  title?: unknown;
};

type GraphPayload = {
  data?: {
    xdt_shortcode_media?: GraphMedia;
  };
  graphql?: {
    shortcode_media?: GraphMedia;
  };
};

function isLikelyInstagramMediaUrl(urlString: string, kind: 'video' | 'image'): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return false;
  }

  if (host === 'static.cdninstagram.com') {
    return false;
  }

  const isInstagramCdnHost = host.includes('cdninstagram.com') || host.includes('fbcdn.net') || host.includes('fna.fbcdn.net');
  const isScontentHost = host.includes('scontent');

  if (kind === 'video') {
    return isInstagramCdnHost && isScontentHost && (path.includes('.mp4') || path.includes('.m3u8'));
  }

  const isImageExtension = ['.jpg', '.jpeg', '.png', '.webp'].some((ext) => path.includes(ext));
  const looksLikeStaticAsset = path.includes('/rsrc.php') || path.includes('/icons/') || path.includes('/apple-touch-icon');
  const looksLikeAvatar = path.includes('t51.2885-19/');

  return isImageExtension && isInstagramCdnHost && isScontentHost && !looksLikeStaticAsset && !looksLikeAvatar;
}

function normalizeUrlValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function decodeEmbeddedJsonString(value: string): string {
  return value
    .replaceAll('\\u0026', '&')
    .replaceAll('\\u003d', '=')
    .replaceAll('\\/', '/')
    .replaceAll('\\"', '"');
}

function extractMediaUrlFromHtml(html: string): { mediaUrl: string; kind: 'video' | 'image' } | null {
  const normalized = decodeEmbeddedJsonString(html);

  const ogVideoMatch = normalized.match(/<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i);
  if (ogVideoMatch?.[1]) {
    const candidate = normalizeUrlValue(ogVideoMatch[1]);
    if (candidate && isLikelyInstagramMediaUrl(candidate, 'video')) {
      return { mediaUrl: candidate, kind: 'video' };
    }
  }

  const twitterVideoMatch = normalized.match(
    /<meta[^>]+name=["']twitter:player:stream["'][^>]+content=["']([^"']+)["']/i
  );
  if (twitterVideoMatch?.[1]) {
    const candidate = normalizeUrlValue(twitterVideoMatch[1]);
    if (candidate && isLikelyInstagramMediaUrl(candidate, 'video')) {
      return { mediaUrl: candidate, kind: 'video' };
    }
  }

  const videoMatch = normalized.match(/"video_url":"([^"]+)"/i);
  if (videoMatch?.[1]) {
    const candidate = normalizeUrlValue(videoMatch[1]);
    if (candidate && isLikelyInstagramMediaUrl(candidate, 'video')) {
      return { mediaUrl: candidate, kind: 'video' };
    }
  }

  const mp4Match = normalized.match(/https:\/\/[^"'\s\\]+\.mp4[^"'\s]*/i);
  if (mp4Match?.[0]) {
    const candidate = normalizeUrlValue(mp4Match[0]);
    if (candidate && isLikelyInstagramMediaUrl(candidate, 'video')) {
      return { mediaUrl: candidate, kind: 'video' };
    }
  }

  const displayMatch = normalized.match(/"display_url":"([^"]+)"/i);
  if (displayMatch?.[1]) {
    const candidate = normalizeUrlValue(displayMatch[1]);
    if (candidate && isLikelyInstagramMediaUrl(candidate, 'image')) {
      return { mediaUrl: candidate, kind: 'image' };
    }
  }

  const ogImageMatch = normalized.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (ogImageMatch?.[1]) {
    const candidate = normalizeUrlValue(ogImageMatch[1]);
    if (candidate && isLikelyInstagramMediaUrl(candidate, 'image')) {
      return { mediaUrl: candidate, kind: 'image' };
    }
  }

  const imageMatch = normalized.match(/https:\/\/[^"'\s\\]+\.(?:jpg|jpeg|webp|png)[^"'\s]*/i);
  if (imageMatch?.[0]) {
    const candidate = normalizeUrlValue(imageMatch[0]);
    if (candidate && isLikelyInstagramMediaUrl(candidate, 'image')) {
      return { mediaUrl: candidate, kind: 'image' };
    }
  }

  return null;
}

function getMediaFromGraphPayload(payload: GraphPayload): { mediaUrl: string; kind: 'video' | 'image' } | null {
  const media = payload.data?.xdt_shortcode_media ?? payload.graphql?.shortcode_media;
  if (!media) {
    return null;
  }

  const isVideo = media.is_video === true;
  if (isVideo) {
    const videoUrl = normalizeUrlValue(media.video_url);
    if (videoUrl) {
      return { mediaUrl: videoUrl, kind: 'video' };
    }
  }

  const displayUrl = normalizeUrlValue(media.display_url);
  if (displayUrl) {
    return { mediaUrl: displayUrl, kind: 'image' };
  }

  return null;
}

function getTitleFromGraphPayload(payload: GraphPayload, fallback: string): string {
  const media = payload.data?.xdt_shortcode_media ?? payload.graphql?.shortcode_media;
  const title = typeof media?.title === 'string' ? media.title.trim() : '';
  if (title) {
    return title.slice(0, 180);
  }

  return fallback;
}

interface ShortcodeCandidate {
  kind: 'p' | 'reel';
  shortcode: string;
}

function normalizeShortcode(raw: string): string | null {
  const candidate = raw.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(candidate)) {
    return null;
  }

  if (candidate.length < SHORTCODE_MIN_LENGTH) {
    return null;
  }

  return candidate;
}

function getShortcodeCandidatesFromUrl(urlString: string): ShortcodeCandidate[] {
  const match = SHORTCODE_REGEX.exec(urlString);
  if (!match?.[1] || !match[2]) {
    return [];
  }

  const kind = match[1].toLowerCase() === 'reel' ? 'reel' : 'p';
  const raw = match[2];
  const variants =
    raw.length > SHORTCODE_STANDARD_LENGTH ? [raw.slice(0, SHORTCODE_STANDARD_LENGTH), raw] : [raw];

  const unique = new Set<string>();
  const result: ShortcodeCandidate[] = [];
  for (const variant of variants) {
    const normalized = normalizeShortcode(variant);
    if (!normalized || unique.has(normalized)) {
      continue;
    }

    unique.add(normalized);
    result.push({ kind, shortcode: normalized });
  }

  return result;
}

function generateRequestBody(shortcode: string): string {
  // These fields are adapted from the existing instagram project in the repo.
  return querystring.stringify({
    av: '0',
    __d: 'www',
    __user: '0',
    __a: '1',
    __req: 'b',
    __hs: '20183.HYP:instagram_web_pkg.2.1...0',
    dpr: '3',
    __ccg: 'GOOD',
    __rev: '1021613311',
    __s: 'hm5eih:ztapmw:x0losd',
    __hsi: '7489787314313612244',
    __dyn:
      '7xeUjG1mxu1syUbFp41twpUnwgU7SbzEdF8aUco2qwJw5ux609vCwjE1EE2Cw8G11wBz81s8hwGxu786a3a1YwBgao6C0Mo2swtUd8-U2zxe2GewGw9a361qw8Xxm16wa-0oa2-azo7u3C2u2J0bS1LwTwKG1pg2fwxyo6O1FwlA3a3zhA6bwIxe6V8aUuwm8jwhU3cyVrDyo',
    __csr:
      'goMJ6MT9Z48KVkIBBvRfqKOkinBtG-FfLaRgG-lZ9Qji9XGexh7VozjHRKq5J6KVqjQdGl2pAFmvK5GWGXyk8h9GA-m6V5yF4UWagnJzazAbZ5osXuFkVeGCHG8GF4l5yp9oOezpo88PAlZ1Pxa5bxGQ7o9VrFbg-8wwxp1G2acxacGVQ00jyoE0ijonyXwfwEnwWwkA2m0dLw3tE1I80hCg8UeU4Ohox0clAhAtsM0iCA9wap4DwhS1fxW0fLhpRB51m13xC3e0h2t2H801HQw1bu02j-',
    __comet_req: '7',
    lsd: 'AVrqPT0gJDo',
    jazoest: '2946',
    __spin_r: '1021613311',
    __spin_b: 'trunk',
    __spin_t: '1743852001',
    __crn: 'comet.igweb.PolarisPostRoute',
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: 'PolarisPostActionLoadPostQueryQuery',
    variables: JSON.stringify({
      shortcode,
      fetch_tagged_user_count: null,
      hoisted_comment_id: null,
      hoisted_reply_id: null
    }),
    server_timestamps: true,
    doc_id: '8845758582119845'
  });
}

async function fetchGraphPayload(shortcode: string, signal?: AbortSignal): Promise<{ payload: GraphPayload; status: number }> {
  const body = generateRequestBody(shortcode);
  const requestUrl = 'https://www.instagram.com/graphql/query';

  const { response } = await fetchWithRedirects(
    requestUrl,
    {
      method: 'POST',
      signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 11; SAMSUNG SM-G973U) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/14.2 Chrome/87.0.4280.141 Mobile Safari/537.36',
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.5',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-FB-Friendly-Name': 'PolarisPostActionLoadPostQueryQuery',
        'X-BLOKS-VERSION-ID':
          '0d99de0d13662a50e0958bcb112dd651f70dea02e1859073ab25f8f2a477de96',
        'X-CSRFToken': 'uy8OpI1kndx4oUHjlHaUfu',
        'X-IG-App-ID': '1217981644879628',
        'X-FB-LSD': 'AVrqPT0gJDo',
        'X-ASBD-ID': '359341',
        'Sec-GPC': '1',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Referer: `https://www.instagram.com/p/${shortcode}/`
      },
      body
    },
    MAX_REDIRECTS
  );

  let payload: GraphPayload = {};
  try {
    payload = (await response.json()) as GraphPayload;
  } catch {
    payload = {};
  }

  return { payload, status: response.status };
}

async function fetchLegacyJson(shortcode: string, kind: 'p' | 'reel', signal?: AbortSignal): Promise<GraphPayload | null> {
  const { response } = await fetchWithRedirects(
    `https://www.instagram.com/${kind}/${shortcode}/?__a=1&__d=dis`,
    {
      method: 'GET',
      signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    },
    MAX_REDIRECTS
  );

  if (!response.ok) {
    return null;
  }

  try {
    return (await response.json()) as GraphPayload;
  } catch {
    return null;
  }
}

async function fetchPostHtml(shortcode: string, kind: 'p' | 'reel', signal?: AbortSignal): Promise<string | null> {
  const { response } = await fetchWithRedirects(
    `https://www.instagram.com/${kind}/${shortcode}/`,
    {
      method: 'GET',
      signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    },
    MAX_REDIRECTS
  );

  if (!response.ok) {
    return null;
  }

  return response.text();
}

export class InstagramUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstagramUnsupportedError';
  }
}

export function isInstagramHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return INSTAGRAM_SUFFIXES.some((suffix) => lower === suffix || lower.endsWith(`.${suffix}`));
}

export function isInstagramUrl(rawUrl: string): boolean {
  try {
    return isInstagramHost(validateHttpUrl(rawUrl).hostname);
  } catch {
    return false;
  }
}

export interface InstagramMediaInfo {
  mediaUrl: string;
  mediaKind: 'video' | 'image';
  canonicalUrl: string;
  title: string;
}

function detectUnavailableReasonFromHtml(html: string): string | null {
  const lower = html.toLowerCase();

  if (lower.includes('page not found') || lower.includes('not found')) {
    return 'Публикация Instagram не найдена.';
  }

  if (lower.includes('"gql_data":null') || lower.includes('"media":null')) {
    return 'Публикация Instagram недоступна без авторизации, удалена или ограничена настройками приватности.';
  }

  return null;
}

export async function resolveInstagramMedia(rawUrl: string, signal?: AbortSignal): Promise<InstagramMediaInfo> {
  const parsed = validateHttpUrl(rawUrl);
  if (!isInstagramHost(parsed.hostname)) {
    throw new InstagramUnsupportedError('Поддерживаются только URL Instagram.');
  }

  const candidates = getShortcodeCandidatesFromUrl(parsed.toString());
  if (!candidates.length) {
    throw new InstagramUnsupportedError('Поддерживаются только ссылки Instagram вида /p/<shortcode>/ или /reel/<shortcode>/.');
  }

  let lastReason: string | null = null;

  for (const candidate of candidates) {
    const fallbackTitle = `instagram-${candidate.shortcode}`;
    const canonicalUrl = `https://www.instagram.com/${candidate.kind}/${candidate.shortcode}/`;

    try {
      const graph = await fetchGraphPayload(candidate.shortcode, signal);
      if (graph.status === 401 || graph.status === 403 || graph.status === 429) {
        lastReason = 'Источник Instagram временно недоступен или требует авторизацию. Попробуйте позже.';
      } else if (graph.status === 404) {
        lastReason = 'Публикация Instagram не найдена.';
      } else {
        const media = getMediaFromGraphPayload(graph.payload);
        if (media) {
          return {
            mediaUrl: media.mediaUrl,
            mediaKind: media.kind,
            canonicalUrl,
            title: getTitleFromGraphPayload(graph.payload, fallbackTitle)
          };
        }
      }
    } catch (error) {
      if (error instanceof InstagramUnsupportedError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
    }

    const legacyPayload = await fetchLegacyJson(candidate.shortcode, candidate.kind, signal);
    if (legacyPayload) {
      const media = getMediaFromGraphPayload(legacyPayload);
      if (media) {
        return {
          mediaUrl: media.mediaUrl,
          mediaKind: media.kind,
          canonicalUrl,
          title: getTitleFromGraphPayload(legacyPayload, fallbackTitle)
        };
      }
    }

    const html = await fetchPostHtml(candidate.shortcode, candidate.kind, signal);
    if (html) {
      const htmlMedia = extractMediaUrlFromHtml(html);
      if (htmlMedia) {
        return {
          mediaUrl: htmlMedia.mediaUrl,
          mediaKind: htmlMedia.kind,
          canonicalUrl,
          title: fallbackTitle
        };
      }

      const unavailableReason = detectUnavailableReasonFromHtml(html);
      if (unavailableReason) {
        lastReason = unavailableReason;
      }
    }
  }

  throw new InstagramUnsupportedError(lastReason ?? 'Не удалось извлечь прямой media URL из ссылки Instagram.');
}
