import Database from 'better-sqlite3';
import { DB_PATH } from './config';

export type ItemType = 'file' | 'hls' | 'youtube' | 'instagram' | 'rutube' | 'ok' | 'vk' | 'unsupported';
export type ItemStatus = 'queued' | 'downloading' | 'ready' | 'unsupported' | 'error';

export interface Item {
  id: string;
  ownerId: string;
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
  ownerId: string;
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

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const ITEMS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    ownerId TEXT NOT NULL,
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

function migrateItemsTableIfNeeded(): void {
  const current = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'items'")
    .get() as { sql?: string } | undefined;

  if (!current?.sql) {
    db.exec(ITEMS_TABLE_SQL);
    return;
  }

  if (
    current.sql.includes('ownerId') &&
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
    INSERT INTO items (id, ownerId, sourceUrl, finalUrl, type, status, reason, title, sizeBytes, createdAt, updatedAt)
    SELECT id, 'legacy', sourceUrl, finalUrl, type, status, reason, title, sizeBytes, createdAt, updatedAt
    FROM items_old;
    DROP TABLE items_old;
    COMMIT;
  `);
}

migrateItemsTableIfNeeded();

db.exec('CREATE INDEX IF NOT EXISTS idx_items_owner_created ON items(ownerId, createdAt DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_items_owner_id ON items(ownerId, id)');

const insertItemStmt = db.prepare(`
  INSERT INTO items (id, ownerId, sourceUrl, finalUrl, type, status, reason, title, sizeBytes, createdAt, updatedAt)
  VALUES (@id, @ownerId, @sourceUrl, @finalUrl, @type, @status, @reason, @title, @sizeBytes, @createdAt, @updatedAt)
`);

const getItemStmt = db.prepare('SELECT * FROM items WHERE id = ?');
const getItemByOwnerStmt = db.prepare('SELECT * FROM items WHERE id = ? AND ownerId = ?');
const listItemsStmt = db.prepare('SELECT * FROM items ORDER BY createdAt DESC');
const listItemsByOwnerStmt = db.prepare('SELECT * FROM items WHERE ownerId = ? ORDER BY createdAt DESC');
const deleteItemStmt = db.prepare('DELETE FROM items WHERE id = ?');
const deleteItemByOwnerStmt = db.prepare('DELETE FROM items WHERE id = ? AND ownerId = ?');

export function createItem(input: NewItem): Item {
  const now = Date.now();
  const record: Item = {
    id: input.id,
    ownerId: input.ownerId,
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

export function getItemByOwner(id: string, ownerId: string): Item | null {
  const row = getItemByOwnerStmt.get(id, ownerId) as Item | undefined;
  return row ?? null;
}

export function listItems(): Item[] {
  return listItemsStmt.all() as Item[];
}

export function listItemsByOwner(ownerId: string): Item[] {
  return listItemsByOwnerStmt.all(ownerId) as Item[];
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

export function deleteItemByOwner(id: string, ownerId: string): boolean {
  const result = deleteItemByOwnerStmt.run(id, ownerId);
  return result.changes > 0;
}
