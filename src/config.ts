import fs from 'fs';
import path from 'path';

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

fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

if (!fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
  fs.copyFileSync(LEGACY_DB_PATH, DB_PATH);
}
