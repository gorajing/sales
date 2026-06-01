import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import fs from 'node:fs';
import path from 'node:path';

declare global {
  // eslint-disable-next-line no-var
  var __salesDb: ReturnType<typeof drizzle<typeof schema>> | undefined;
  // eslint-disable-next-line no-var
  var __salesSqlite: Database.Database | undefined;
  // eslint-disable-next-line no-var
  var __salesSqlitePath: string | undefined;
  // eslint-disable-next-line no-var
  var __salesUsingDefaultDbPath: boolean | undefined;
}

function defaultDbPath() {
  return path.resolve(process.cwd(), 'data/sales.db');
}

function resolveDbPath() {
  return process.env.SALES_DB_PATH
    ? path.resolve(process.env.SALES_DB_PATH)
    : defaultDbPath();
}

// Whether two paths point at the SAME file, by inode — not string equality.
// Path strings lie on case-insensitive filesystems (…/sales vs …/Sales) and
// through symlinks; inode identity is the ground truth. Returns false if either
// path does not exist (they can't be the same existing file).
function isSameExistingFile(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

function createDb() {
  const dbPath = resolveDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  globalThis.__salesSqlite = sqlite;
  globalThis.__salesSqlitePath = dbPath;
  // Capture, AT OPEN TIME and beside the handle, whether this handle is the
  // default dev DB — by inode, after `new Database` has created the file. This
  // recognizes the dev DB even through an explicit SALES_DB_PATH, a case-variant
  // path, or a symlink. Computed here (same cwd as the open) and stored on
  // globalThis so it never drifts from the reused handle.
  globalThis.__salesUsingDefaultDbPath = isSameExistingFile(dbPath, defaultDbPath());
  return drizzle(sqlite, { schema });
}

export const db = globalThis.__salesDb ?? (globalThis.__salesDb = createDb());
export const sqlite = globalThis.__salesSqlite!;
export const sqlitePath = globalThis.__salesSqlitePath ?? resolveDbPath();
// True when the opened handle IS the default dev DB (data/sales.db). Reads the
// open-time flag stored beside the handle (see createDb), so it always matches
// `db` even if env/cwd drift after the handle was created.
export const usingDefaultDbPath =
  globalThis.__salesUsingDefaultDbPath ?? isSameExistingFile(resolveDbPath(), defaultDbPath());
export { schema };
