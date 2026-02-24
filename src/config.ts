import fs from 'fs';
import path from 'path';

function loadDotEnvIfExists(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const normalized = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed;
    const separatorIndex = normalized.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    if (process.env[key] !== undefined) {
      continue;
    }

    let rawValue = normalized.slice(separatorIndex + 1).trim();
    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) {
      rawValue = rawValue.slice(1, -1);
    }

    process.env[key] = rawValue;
  }
}

loadDotEnvIfExists();

function readPositiveIntFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function readBooleanFromEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  return /^(1|true|yes)$/i.test(value.trim());
}

function readStringFromEnv(name: string, fallback = ''): string {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  return value.trim();
}

export const ROOT_DIR = process.cwd();

function readDirFromEnv(name: string, fallbackRelativePath: string): string {
  const raw = process.env[name];
  if (!raw || !raw.trim()) {
    return path.resolve(ROOT_DIR, fallbackRelativePath);
  }
  return path.resolve(ROOT_DIR, raw.trim());
}

export const STORAGE_DIR = readDirFromEnv('STORAGE_DIR', 'storage');
export const DATA_DIR = readDirFromEnv('DATA_DIR', 'data');
export const LEGACY_DB_PATH = path.resolve(DATA_DIR, 'video-inbox.db');
export const DB_PATH = (() => {
  const override = process.env.DB_PATH;
  if (override && override.trim()) {
    return path.resolve(ROOT_DIR, override.trim());
  }
  return path.resolve(DATA_DIR, 'linkcatcher.db');
})();

export const MAX_REDIRECTS = 5;
export const MAX_DOWNLOAD_BYTES = readPositiveIntFromEnv('MAX_DOWNLOAD_BYTES', 1_073_741_824); // 1GB
export const MAX_HLS_SEGMENTS = readPositiveIntFromEnv('MAX_HLS_SEGMENTS', 5_000);
export const REQUEST_TIMEOUT_MS = readPositiveIntFromEnv('REQUEST_TIMEOUT_MS', 30_000);
export const PROGRESS_UPDATE_STEP_BYTES = 256 * 1024;
export const TELEGRAM_ENABLED = readBooleanFromEnv('TELEGRAM_ENABLED', false);
export const BOT_TOKEN = readStringFromEnv('BOT_TOKEN');
export const WEBAPP_URL = readStringFromEnv('WEBAPP_URL');
export const BASE_URL = readStringFromEnv('BASE_URL');
export const SESSION_SECRET = readStringFromEnv('SESSION_SECRET');
export const SESSION_TTL_SECONDS = readPositiveIntFromEnv('SESSION_TTL_SECONDS', 7 * 24 * 60 * 60);
export const TELEGRAM_AUTH_MAX_AGE_SECONDS = readPositiveIntFromEnv('TELEGRAM_AUTH_MAX_AGE_SECONDS', 86_400);
export const DOWNLOAD_LINK_TTL_SECONDS = readPositiveIntFromEnv('DOWNLOAD_LINK_TTL_SECONDS', 300);

fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

if (!fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
  fs.copyFileSync(LEGACY_DB_PATH, DB_PATH);
}
