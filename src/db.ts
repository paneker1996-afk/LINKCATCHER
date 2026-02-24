import Database from 'better-sqlite3';
import { DB_PATH } from './config';

export type ItemType = 'file' | 'hls' | 'youtube' | 'instagram' | 'rutube' | 'ok' | 'vk' | 'unsupported';
export type ItemStatus = 'queued' | 'downloading' | 'ready' | 'unsupported' | 'error';

export interface Item {
  id: string;
  sourceUrl: string;
  finalUrl: string;
  type: ItemType;
  status: ItemStatus;
  reason: string | null;
  title: string;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
}

export interface NewItem {
  id: string;
  sourceUrl: string;
  finalUrl: string;
  type: ItemType;
  status: ItemStatus;
  reason?: string | null;
  title: string;
  sizeBytes?: number;
}

export interface ItemPatch {
  sourceUrl?: string;
  finalUrl?: string;
  type?: ItemType;
  status?: ItemStatus;
  reason?: string | null;
  title?: string;
  sizeBytes?: number;
}

export interface TelegramUserInput {
  id: string;
  username?: string | null;
  firstName: string;
  lastName?: string | null;
  languageCode?: string | null;
  isBot?: boolean;
  isPremium?: boolean;
  allowsWriteToPm?: boolean;
  photoUrl?: string | null;
}

export interface TelegramSessionUser {
  id: string;
  username: string | null;
  firstName: string;
  lastName: string | null;
  languageCode: string | null;
  photoUrl: string | null;
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const ITEMS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    sourceUrl TEXT NOT NULL,
    finalUrl TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('file', 'hls', 'youtube', 'instagram', 'rutube', 'ok', 'vk', 'unsupported')),
    status TEXT NOT NULL CHECK(status IN ('queued', 'downloading', 'ready', 'unsupported', 'error')),
    reason TEXT,
    title TEXT NOT NULL,
    sizeBytes INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )
`;

const TELEGRAM_USERS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS telegram_users (
    telegramId TEXT PRIMARY KEY,
    username TEXT,
    firstName TEXT NOT NULL,
    lastName TEXT,
    languageCode TEXT,
    isBot INTEGER NOT NULL DEFAULT 0,
    isPremium INTEGER NOT NULL DEFAULT 0,
    allowsWriteToPm INTEGER NOT NULL DEFAULT 0,
    photoUrl TEXT,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  )
`;

const TELEGRAM_SESSIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS telegram_sessions (
    sessionId TEXT PRIMARY KEY,
    telegramId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    FOREIGN KEY (telegramId) REFERENCES telegram_users(telegramId) ON DELETE CASCADE
  )
`;

function migrateItemsTableIfNeeded(): void {
  const current = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'items'")
    .get() as { sql?: string } | undefined;

  if (!current?.sql) {
    db.exec(ITEMS_TABLE_SQL);
    return;
  }

  if (
    current.sql.includes("'youtube'") &&
    current.sql.includes("'instagram'") &&
    current.sql.includes("'rutube'") &&
    current.sql.includes("'ok'") &&
    current.sql.includes("'vk'")
  ) {
    return;
  }

  db.exec(`
    BEGIN;
    ALTER TABLE items RENAME TO items_old;
    ${ITEMS_TABLE_SQL};
    INSERT INTO items (id, sourceUrl, finalUrl, type, status, reason, title, sizeBytes, createdAt, updatedAt)
    SELECT id, sourceUrl, finalUrl, type, status, reason, title, sizeBytes, createdAt, updatedAt
    FROM items_old;
    DROP TABLE items_old;
    COMMIT;
  `);
}

migrateItemsTableIfNeeded();
db.exec(TELEGRAM_USERS_TABLE_SQL);
db.exec(TELEGRAM_SESSIONS_TABLE_SQL);
db.exec('CREATE INDEX IF NOT EXISTS idx_telegram_sessions_expires_at ON telegram_sessions (expiresAt)');
db.exec('CREATE INDEX IF NOT EXISTS idx_telegram_sessions_telegram_id ON telegram_sessions (telegramId)');

const insertItemStmt = db.prepare(`
  INSERT INTO items (id, sourceUrl, finalUrl, type, status, reason, title, sizeBytes, createdAt, updatedAt)
  VALUES (@id, @sourceUrl, @finalUrl, @type, @status, @reason, @title, @sizeBytes, @createdAt, @updatedAt)
`);

const getItemStmt = db.prepare('SELECT * FROM items WHERE id = ?');
const listItemsStmt = db.prepare('SELECT * FROM items ORDER BY createdAt DESC');
const deleteItemStmt = db.prepare('DELETE FROM items WHERE id = ?');
const upsertTelegramUserStmt = db.prepare(`
  INSERT INTO telegram_users (
    telegramId,
    username,
    firstName,
    lastName,
    languageCode,
    isBot,
    isPremium,
    allowsWriteToPm,
    photoUrl,
    createdAt,
    updatedAt
  ) VALUES (
    @telegramId,
    @username,
    @firstName,
    @lastName,
    @languageCode,
    @isBot,
    @isPremium,
    @allowsWriteToPm,
    @photoUrl,
    @createdAt,
    @updatedAt
  )
  ON CONFLICT(telegramId) DO UPDATE SET
    username = excluded.username,
    firstName = excluded.firstName,
    lastName = excluded.lastName,
    languageCode = excluded.languageCode,
    isBot = excluded.isBot,
    isPremium = excluded.isPremium,
    allowsWriteToPm = excluded.allowsWriteToPm,
    photoUrl = excluded.photoUrl,
    updatedAt = excluded.updatedAt
`);
const insertTelegramSessionStmt = db.prepare(`
  INSERT OR REPLACE INTO telegram_sessions (sessionId, telegramId, createdAt, expiresAt)
  VALUES (@sessionId, @telegramId, @createdAt, @expiresAt)
`);
const getTelegramSessionUserStmt = db.prepare(`
  SELECT
    u.telegramId AS id,
    u.username AS username,
    u.firstName AS firstName,
    u.lastName AS lastName,
    u.languageCode AS languageCode,
    u.photoUrl AS photoUrl
  FROM telegram_sessions s
  JOIN telegram_users u ON u.telegramId = s.telegramId
  WHERE s.sessionId = ? AND s.expiresAt > ?
  LIMIT 1
`);
const deleteTelegramSessionStmt = db.prepare('DELETE FROM telegram_sessions WHERE sessionId = ?');
const deleteExpiredTelegramSessionsStmt = db.prepare('DELETE FROM telegram_sessions WHERE expiresAt <= ?');

export function createItem(input: NewItem): Item {
  const now = Date.now();
  const record: Item = {
    id: input.id,
    sourceUrl: input.sourceUrl,
    finalUrl: input.finalUrl,
    type: input.type,
    status: input.status,
    reason: input.reason ?? null,
    title: input.title,
    sizeBytes: input.sizeBytes ?? 0,
    createdAt: now,
    updatedAt: now
  };

  insertItemStmt.run(record);
  return record;
}

export function getItem(id: string): Item | null {
  const row = getItemStmt.get(id) as Item | undefined;
  return row ?? null;
}

export function listItems(): Item[] {
  return listItemsStmt.all() as Item[];
}

export function updateItem(id: string, patch: ItemPatch): void {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return;
  }

  const assignments = entries.map(([key]) => `${key} = @${key}`).join(', ');
  const statement = db.prepare(`UPDATE items SET ${assignments}, updatedAt = @updatedAt WHERE id = @id`);

  statement.run({
    id,
    updatedAt: Date.now(),
    ...Object.fromEntries(entries)
  });
}

export function deleteItem(id: string): boolean {
  const result = deleteItemStmt.run(id);
  return result.changes > 0;
}

export function upsertTelegramUser(input: TelegramUserInput): void {
  const now = Date.now();
  upsertTelegramUserStmt.run({
    telegramId: input.id,
    username: input.username ?? null,
    firstName: input.firstName,
    lastName: input.lastName ?? null,
    languageCode: input.languageCode ?? null,
    isBot: input.isBot ? 1 : 0,
    isPremium: input.isPremium ? 1 : 0,
    allowsWriteToPm: input.allowsWriteToPm ? 1 : 0,
    photoUrl: input.photoUrl ?? null,
    createdAt: now,
    updatedAt: now
  });
}

export function createTelegramSession(sessionId: string, telegramId: string, expiresAt: number): void {
  insertTelegramSessionStmt.run({
    sessionId,
    telegramId,
    createdAt: Date.now(),
    expiresAt
  });
}

export function getTelegramSessionUser(sessionId: string): TelegramSessionUser | null {
  const row = getTelegramSessionUserStmt.get(sessionId, Date.now()) as TelegramSessionUser | undefined;
  return row ?? null;
}

export function deleteTelegramSession(sessionId: string): void {
  deleteTelegramSessionStmt.run(sessionId);
}

export function purgeExpiredTelegramSessions(): void {
  deleteExpiredTelegramSessionsStmt.run(Date.now());
}
