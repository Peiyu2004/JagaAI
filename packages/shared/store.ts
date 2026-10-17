import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const dataDir = path.resolve(process.env.JAGAAI_DATA_DIR || 'data');
export const mediaDir = path.join(dataDir, 'media');
mkdirSync(mediaDir, { recursive: true });
export const db = new DatabaseSync(path.join(dataDir, 'jagaai.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT NOT NULL, townshipId TEXT, data TEXT NOT NULL, PRIMARY KEY(kind,id)); CREATE INDEX IF NOT EXISTS documents_township ON documents(kind,townshipId);');
export const uid = (prefix = 'id') => `${prefix}_${randomUUID()}`;
export const now = () => new Date().toISOString();
export function get<T = any>(kind: string, id: string): T | undefined {
  const row = db.prepare('SELECT data FROM documents WHERE kind=? AND id=?').get(kind, id);
  return row ? JSON.parse(String(row.data)) : undefined;
}
export function list<T = any>(kind: string, townshipId?: string): T[] {
  const rows = townshipId === undefined ? db.prepare('SELECT data FROM documents WHERE kind=?').all(kind) : db.prepare('SELECT data FROM documents WHERE kind=? AND townshipId=?').all(kind, townshipId);
  return rows.map(row => JSON.parse(String(row.data)));
}
export function put<T extends {id: string; townshipId?: string}>(kind: string, record: T): T {
  db.prepare('INSERT INTO documents(kind,id,townshipId,data) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET townshipId=excluded.townshipId,data=excluded.data').run(kind, record.id, record.townshipId || null, JSON.stringify(record));
  return record;
}
export function remove(kind: string, id: string) { db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run(kind, id); }
export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function audit(actor: {id:string;townshipId:string}, action: string, targetType: string, targetId: string) {
  return put('auditLogs', { id: uid('audit'), townshipId: actor.townshipId, actorId: actor.id, action, targetType, targetId, createdAt: now() });
}
