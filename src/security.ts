import dns from 'dns/promises';
import net from 'net';
import path from 'path';
import { MAX_REDIRECTS, REQUEST_TIMEOUT_MS } from './config';

export class UserInputError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'UserInputError';
    this.statusCode = statusCode;
  }
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((value) => Number.parseInt(value, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;

  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;

  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true;
  }

  if (lower.startsWith('::ffff:')) {
    const ipv4 = lower.slice('::ffff:'.length);
    return isPrivateIpv4(ipv4);
  }

  return false;
}

function isPrivateIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    return isPrivateIpv4(ip);
  }
  if (family === 6) {
    return isPrivateIpv6(ip);
  }
  return true;
}

export function validateHttpUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    throw new UserInputError('Некорректный формат URL. Укажите полный http(s)-адрес.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new UserInputError('Поддерживаются только URL с http:// и https://.');
  }

  if (!parsed.hostname) {
    throw new UserInputError('В URL должно быть указано имя хоста.');
  }

  if (parsed.username || parsed.password) {
    throw new UserInputError('URL со встроенными учетными данными не допускаются.');
  }

  return parsed;
}

export async function assertSafeUrl(inputUrl: URL): Promise<void> {
  if (!['http:', 'https:'].includes(inputUrl.protocol)) {
    throw new UserInputError('Допускаются только URL с протоколами http(s).');
  }

  const hostname = inputUrl.hostname.toLowerCase();

  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new UserInputError('URL из локальной или приватной сети запрещены.');
  }

  const ipFamily = net.isIP(hostname);
  if (ipFamily !== 0) {
    if (isPrivateIp(hostname)) {
      throw new UserInputError('URL из локальной или приватной сети заблокированы.');
    }
    return;
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new UserInputError('Не удалось разрешить имя хоста.');
  }

  if (records.length === 0) {
    throw new UserInputError('Не удалось разрешить имя хоста.');
  }

  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new UserInputError('Назначения в локальной или приватной сети заблокированы.');
    }
  }
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function mergeWithTimeoutSignal(signal: AbortSignal | undefined): AbortSignal {
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

export async function fetchWithRedirects(
  url: string | URL,
  init: RequestInit = {},
  maxRedirects = MAX_REDIRECTS
): Promise<{ response: Response; finalUrl: URL }> {
  let current = typeof url === 'string' ? new URL(url) : new URL(url.toString());

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertSafeUrl(current);

    const response = await fetch(current.toString(), {
      ...init,
      redirect: 'manual',
      signal: mergeWithTimeoutSignal((init.signal ?? undefined) as AbortSignal | undefined)
    });

    if (!isRedirectStatus(response.status)) {
      return { response, finalUrl: current };
    }

    const location = response.headers.get('location');
    await response.body?.cancel();

    if (!location) {
      throw new Error('В ответе на редирект отсутствует заголовок Location.');
    }

    current = new URL(location, current);
  }

  throw new Error(`Слишком много редиректов (максимум ${maxRedirects}).`);
}

export function safeJoin(baseDir: string, requestPath: string): string {
  const baseResolved = path.resolve(baseDir);
  const cleaned = requestPath.replace(/\\/g, '/');
  const normalized = path.posix.normalize(`/${cleaned}`).slice(1);

  if (!normalized || normalized.startsWith('..') || normalized.includes('\u0000')) {
    throw new UserInputError('Некорректный путь к медиа.');
  }

  const joined = path.resolve(baseResolved, normalized);
  if (joined !== baseResolved && !joined.startsWith(`${baseResolved}${path.sep}`)) {
    throw new UserInputError('Некорректный путь к медиа.');
  }

  return joined;
}

export function isSafeItemId(id: string): boolean {
  return /^[a-zA-Z0-9-]{1,100}$/.test(id);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Непредвиденная ошибка';
}
