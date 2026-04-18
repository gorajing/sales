import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../../db/schema';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));

function freshDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve(dirname, '../../db/migrations') });
  return { db, sqlite };
}

describe('schema', () => {
  it('creates and queries an account', () => {
    const { db } = freshDb();
    db.insert(schema.accounts).values({ id: 'acc_1', name: 'Acme' }).run();
    const rows = db.select().from(schema.accounts).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Acme');
  });

  it('defaults contact.archetype to unknown', () => {
    const { db } = freshDb();
    db.insert(schema.accounts).values({ id: 'acc_1', name: 'Acme' }).run();
    db.insert(schema.contacts).values({
      id: 'ct_1', accountId: 'acc_1', fullName: 'Jane',
    }).run();
    const row = db.select().from(schema.contacts).all()[0];
    expect(row.archetype).toBe('unknown');
  });

  it('enforces FK from evidence to account', () => {
    const { db } = freshDb();
    expect(() =>
      db.insert(schema.evidence).values({
        id: 'ev_1', accountId: 'acc_missing',
        sourceUrl: 'https://x', sourceType: 'manual',
        snippet: 's', extractedFact: 'f', capturedBy: 'manual',
      }).run()
    ).toThrow();
  });
});
