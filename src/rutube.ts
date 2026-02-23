import { MAX_REDIRECTS, REQUEST_TIMEOUT_MS } from './config';
import { fetchWithRedirects } from './security';

const RUTUBE_SUFFIXES = ['rutube.ru'];
const OK_SUFFIXES = ['ok.ru'];
const VK_SUFFIXES = ['vkvideo.ru', 'vk.com', 'vk.ru'];

const RUTUBE_VIDEO_REGEX = /^\/video\/(?:private\/)?([a-z0-9]+)\/?/i;
const OK_VIDEO_REGEX = /^\/(?:video|videoembed)\/(\d+)/i;
const VK_VIDEO_PATH_REGEX = /^\/(?:playlist\/.+\/)?video(-?\d+_\d+)/i;

interface RutubeOptionsResponse {
  title?: unknown;
  detail?: unknown;
  video_balancer?: {
    m3u8?: unknown;
  };
}

interface OkOptionsPayload {
  flashvars?: {
    metadata?: unknown;
  };
}

interface OkMetadataPayload {
  movie?: {
    title?: unknown;
  };
  hlsManifestUrl?: unknown;
}

interface VkVideoPayload {
  payload?: unknown;
}

type CookieJar = Record<string, Record<string, string>>;

export class RutubeUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RutubeUnsupportedError';
  }
}

function hasHostSuffix(hostname: string, suffixes: string[]): boolean {
  const lower = hostname.toLowerCase();
  return suffixes.some((suffix) => lower === suffix || lower.endsWith(`.${suffix}`));
}

function cleanTitle(value: string, fallback: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return fallback;
  }
  return cleaned.slice(0, 180);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function extractRutubeVideoId(input: URL): string | null {
  const match = RUTUBE_VIDEO_REGEX.exec(input.pathname);
  if (!match?.[1]) {
    return null;
  }
  return match[1];
}

function extractOkVideoId(input: URL): string | null {
  const match = OK_VIDEO_REGEX.exec(input.pathname);
  if (!match?.[1]) {
    return null;
  }
  return match[1];
}

export function isRutubeHost(hostname: string): boolean {
  return hasHostSuffix(hostname, RUTUBE_SUFFIXES);
}

export function isOkHost(hostname: string): boolean {
  return hasHostSuffix(hostname, OK_SUFFIXES);
}

export function isVkHost(hostname: string): boolean {
  return hasHostSuffix(hostname, VK_SUFFIXES);
}

export function isRutubeVideoPath(pathname: string): boolean {
  return RUTUBE_VIDEO_REGEX.test(pathname);
}

export function isOkVideoPath(pathname: string): boolean {
  return OK_VIDEO_REGEX.test(pathname);
}

export function isVkVideoPath(pathname: string): boolean {
  return VK_VIDEO_PATH_REGEX.test(pathname);
}

export interface ResolvedHlsSource {
  mediaUrl: string;
  title: string;
  requestHeaders?: Record<string, string>;
}

function mergeTimeoutSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const abortSignalAny = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;

  if (!signal) {
    return timeoutSignal;
  }

  if (abortSignalAny) {
    return abortSignalAny([signal, timeoutSignal]);
  }

  return signal;
}

function getSetCookieValues(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    const list = withGetSetCookie.getSetCookie();
    return Array.isArray(list) ? list : [];
  }

  const merged = headers.get('set-cookie');
  return merged ? [merged] : [];
}

function extractCookies(setCookie: string[], cookies: CookieJar = {}, defaultDomain: string): CookieJar {
  for (const pair of setCookie) {
    const cookieMatch = /([^=]+)=([^;]+)/.exec(pair);
    if (!cookieMatch?.[1]) {
      continue;
    }

    const domainMatch = /domain=([^;]+)/i.exec(pair);
    const cookieDomain = domainMatch?.[1] ? domainMatch[1].toLowerCase() : defaultDomain.toLowerCase();
    if (!cookies[cookieDomain]) {
      cookies[cookieDomain] = {};
    }

    const key = cookieMatch[1].trim();
    const value = cookieMatch[2] ?? '';
    if (value.toUpperCase() === 'DELETED') {
      delete cookies[cookieDomain][key];
    } else {
      cookies[cookieDomain][key] = value;
    }
  }

  return cookies;
}

function encodeCookies(cookies: CookieJar, domain: string): string {
  return Object.entries(cookies[domain.toLowerCase()] ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function extractCookiesFromResponse(response: Response, cookies: CookieJar, defaultDomain: string): CookieJar {
  const setCookie = getSetCookieValues(response.headers);
  return extractCookies(setCookie, cookies, defaultDomain);
}

function parseVkVideoId(url: URL): string | null {
  const match = VK_VIDEO_PATH_REGEX.exec(url.pathname);
  return match?.[1] ?? null;
}

const VK_BROWSER_HEADERS: Record<string, string> = {
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-encoding': 'gzip, deflate, br, zstd',
  'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'sec-ch-ua': '"Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
};

export async function resolveRutubeMedia(sourceUrl: string, signal?: AbortSignal): Promise<ResolvedHlsSource> {
  const parsed = new URL(sourceUrl);
  const videoId = extractRutubeVideoId(parsed);
  if (!videoId) {
    throw new RutubeUnsupportedError('Ссылка RuTube должна быть вида /video/<id>/ или /video/private/<id>/.');
  }

  const querySuffix = parsed.search ? `&${parsed.search.slice(1)}` : '';
  const apiUrl = `https://rutube.ru/api/play/options/${videoId}/?no_404=true&referer=https%3A%2F%2Frutube.ru${querySuffix}`;
  const { response } = await fetchWithRedirects(
    apiUrl,
    {
      method: 'GET',
      signal
    },
    MAX_REDIRECTS
  );

  if (!response.ok) {
    throw new RutubeUnsupportedError(`Не удалось получить данные RuTube (${response.status} ${response.statusText}).`);
  }

  let payload: RutubeOptionsResponse;
  try {
    payload = (await response.json()) as RutubeOptionsResponse;
  } catch {
    throw new RutubeUnsupportedError('RuTube вернул некорректный JSON ответа.');
  }

  if (typeof payload.detail === 'object' && payload.detail !== null) {
    throw new RutubeUnsupportedError('RuTube не дал доступ к видео (возможно, оно недоступно или приватно).');
  }

  const mediaUrl = typeof payload.video_balancer?.m3u8 === 'string' ? payload.video_balancer.m3u8.trim() : '';
  if (!mediaUrl) {
    throw new RutubeUnsupportedError('Не удалось извлечь HLS URL из ответа RuTube.');
  }

  const rawTitle = typeof payload.title === 'string' ? payload.title : '';
  const title = cleanTitle(rawTitle, `rutube-${videoId}`);

  return {
    mediaUrl,
    title
  };
}

export async function resolveOkMedia(sourceUrl: string, signal?: AbortSignal): Promise<ResolvedHlsSource> {
  const parsed = new URL(sourceUrl);
  const videoId = extractOkVideoId(parsed);
  if (!videoId) {
    throw new RutubeUnsupportedError('Ссылка OK должна быть вида /video/<id> или /videoembed/<id>.');
  }

  const embedUrl = `https://ok.ru/videoembed/${videoId}`;
  const { response } = await fetchWithRedirects(
    embedUrl,
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
    throw new RutubeUnsupportedError(`Не удалось открыть страницу OK (${response.status} ${response.statusText}).`);
  }

  const html = await response.text();
  const match = /<div\s+data-module="OKVideo".+data-options="(.+?)"\s+data-player-container-id=/is.exec(html);
  if (!match?.[1]) {
    throw new RutubeUnsupportedError('Не удалось извлечь параметры видео из страницы OK.');
  }

  let optionsPayload: OkOptionsPayload;
  try {
    const decoded = decodeHtmlEntities(match[1]);
    optionsPayload = JSON.parse(decoded) as OkOptionsPayload;
  } catch {
    throw new RutubeUnsupportedError('Не удалось разобрать JSON параметров OK.');
  }

  let metadata: OkMetadataPayload;
  try {
    const metadataString =
      typeof optionsPayload.flashvars?.metadata === 'string' ? optionsPayload.flashvars.metadata : '{}';
    metadata = JSON.parse(decodeHtmlEntities(metadataString)) as OkMetadataPayload;
  } catch {
    throw new RutubeUnsupportedError('Не удалось разобрать metadata OK.');
  }

  const mediaUrl = typeof metadata.hlsManifestUrl === 'string' ? metadata.hlsManifestUrl.trim() : '';
  if (!mediaUrl) {
    throw new RutubeUnsupportedError('Не удалось получить HLS URL из metadata OK.');
  }

  const rawTitle = typeof metadata.movie?.title === 'string' ? metadata.movie.title : '';
  const title = cleanTitle(rawTitle, `ok-${videoId}`);

  return {
    mediaUrl,
    title
  };
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

async function fetchVkManual(
  url: string,
  init: RequestInit,
  signal?: AbortSignal
): Promise<Response> {
  return fetch(url, {
    ...init,
    redirect: 'manual',
    signal: mergeTimeoutSignal(signal)
  });
}

function unwrapVkJsonText(rawText: string): string {
  const text = rawText.trimStart();
  if (text.startsWith('<!--')) {
    return text.slice(4);
  }
  return text;
}

export async function resolveVkMedia(sourceUrl: string, signal?: AbortSignal): Promise<ResolvedHlsSource> {
  const parsed = new URL(sourceUrl);
  const videoId = parseVkVideoId(parsed);
  if (!videoId) {
    throw new RutubeUnsupportedError(
      'Ссылка VK должна быть вида /video<owner>_<id> или /playlist/.../video<owner>_<id>.'
    );
  }

  const cookies: CookieJar = {};

  const getUrlResp = await fetchVkManual(
    parsed.toString(),
    {
      method: 'GET',
      headers: VK_BROWSER_HEADERS
    },
    signal
  );
  extractCookiesFromResponse(getUrlResp, cookies, '.vkvideo.ru');

  if (!isRedirectStatus(getUrlResp.status)) {
    throw new RutubeUnsupportedError('VK Video не вернул ожидаемый редирект для анонимного доступа.');
  }

  const location1 = getUrlResp.headers.get('location');
  if (!location1) {
    throw new RutubeUnsupportedError('VK Video не вернул Location на шаге авторизации.');
  }

  const autoLoginResp = await fetchVkManual(
    new URL(location1, parsed).toString(),
    {
      method: 'GET',
      headers: VK_BROWSER_HEADERS
    },
    signal
  );
  extractCookiesFromResponse(autoLoginResp, cookies, '.vk.com');

  const location2 = autoLoginResp.headers.get('location');
  if (!location2) {
    throw new RutubeUnsupportedError('VK Video не вернул второй Location на шаге авторизации.');
  }

  const anonymousLogin = await fetchVkManual(
    new URL(location2, parsed).toString(),
    {
      method: 'GET',
      headers: {
        ...VK_BROWSER_HEADERS,
        Cookie: encodeCookies(cookies, '.vkvideo.ru')
      }
    },
    signal
  );
  extractCookiesFromResponse(anonymousLogin, cookies, '.vkvideo.ru');

  const location3 = anonymousLogin.headers.get('location');
  if (!location3) {
    throw new RutubeUnsupportedError('VK Video не вернул третий Location на шаге авторизации.');
  }

  const getPage = await fetchVkManual(
    new URL(location3, parsed).toString(),
    {
      method: 'GET',
      headers: {
        ...VK_BROWSER_HEADERS,
        Cookie: encodeCookies(cookies, '.vkvideo.ru')
      }
    },
    signal
  );
  extractCookiesFromResponse(getPage, cookies, '.vkvideo.ru');

  const body =
    'al=1&autoplay=1&claim=&force_no_repeat=true&is_video_page=true&list=&module=direct&show_next=1&video=' +
    encodeURIComponent(videoId);

  const headers = {
    ...VK_BROWSER_HEADERS,
    Cookie: encodeCookies(cookies, '.vkvideo.ru'),
    'content-type': 'application/x-www-form-urlencoded',
    origin: 'https://vkvideo.ru',
    referer: sourceUrl,
    accept: '*/*'
  };

  const vkVideoInfo = await fetchVkManual(
    'https://vkvideo.ru/al_video.php?act=show',
    {
      method: 'POST',
      headers,
      body
    },
    signal
  );

  const text = await vkVideoInfo.text();
  let payload: VkVideoPayload;
  try {
    payload = JSON.parse(unwrapVkJsonText(text)) as VkVideoPayload;
  } catch {
    throw new RutubeUnsupportedError('Не удалось разобрать ответ VK Video для параметров потока.');
  }

  const payloadArray = Array.isArray(payload.payload) ? payload.payload : [];
  const info = payloadArray[1] as unknown;
  const infoArray = Array.isArray(info) ? info : [];
  const titleRaw = typeof infoArray[0] === 'string' ? infoArray[0] : '';
  const playerBox = infoArray[4] as { player?: { params?: Array<{ hls?: unknown }> } } | undefined;
  const hlsRaw = playerBox?.player?.params?.[0]?.hls;
  const hlsUrl = typeof hlsRaw === 'string' ? hlsRaw.trim() : '';

  if (!hlsUrl) {
    throw new RutubeUnsupportedError('Не удалось извлечь HLS URL из ответа VK Video.');
  }

  const vkCookieHeader = encodeCookies(cookies, '.vkvideo.ru');

  return {
    mediaUrl: hlsUrl,
    title: cleanTitle(titleRaw, `vk-${videoId}`),
    requestHeaders: {
      Accept: '*/*',
      Referer: sourceUrl,
      Origin: 'https://vkvideo.ru',
      'User-Agent': VK_BROWSER_HEADERS['user-agent'],
      ...(vkCookieHeader ? { Cookie: vkCookieHeader } : {})
    }
  };
}
