import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import path from 'node:path';

declare global {
  // eslint-disable-next-line no-var
  var __salesDb: ReturnType<typeof drizzle<typeof schema>> | undefined;
  // eslint-disable-next-line no-var
  var __salesSqlite: Database.Database | undefined;
}

function createDb() {
  const dbPath = path.resolve(process.cwd(), 'data/sales.db');
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  globalThis.__salesSqlite = sqlite;
  return drizzle(sqlite, { schema });
}

export const db = globalThis.__salesDb ?? (globalThis.__salesDb = createDb());
export const sqlite = globalThis.__salesSqlite!;
export { schema };
