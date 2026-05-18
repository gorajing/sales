import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as schemaMod from '../../db/schema';

vi.mock('@/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  const schemaModInner = await import('../../db/schema');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const _dirname = path.dirname(fileURLToPath(import.meta.url));
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: schemaModInner });
  migrate(db, { migrationsFolder: path.resolve(_dirname, '../../db/migrations') });
  return { db, schema: schemaModInner };
});

import { db } from '@/db';
import { POST } from '../../app/api/connectors/poll/route';

const ENV = { ...process.env };
beforeEach(() => {
  // Delete children before parents — the end-to-end tests run
  // recompute, which creates lead_scores / routing_assignments /
  // alerts rows with FKs to accounts. Deleting accounts first would
  // trip "FOREIGN KEY constraint failed".
  db.delete(schemaMod.alerts).run();
  db.delete(schemaMod.routingAssignments).run();
  db.delete(schemaMod.leadScores).run();
  db.delete(schemaMod.evidence).run();
  db.delete(schemaMod.contacts).run();
  db.delete(schemaMod.accounts).run();
  db.delete(schemaMod.connectorPollState).run();
  delete process.env.INTERNAL_API_SECRET;
  delete process.env.GITHUB_TOKEN;
  process.env.DEFAULT_OWNER_EMAIL = 'triage@example.com';
});
afterEach(() => { process.env = { ...ENV }; });

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: 'POST', headers });
}

describe('POST /api/connectors/poll — auth (shared requireInternalSecret)', () => {
  it('dev (no INTERNAL_API_SECRET) is permissive → 200', async () => {
    // Future `since` → connectors fetch 0; isolates the HTTP/auth
    // concern from the scoring pipeline.
    const res = await POST(req('http://x/api/connectors/poll?since=2099-01-01T00:00:00.000Z'));
    expect(res.status).toBe(200);
  });

  it('secret set + wrong header → 401', async () => {
    process.env.INTERNAL_API_SECRET = 'sekret';
    const res = await POST(req('http://x/api/connectors/poll?since=2099-01-01T00:00:00.000Z', {
      'x-internal-secret': 'wrong',
    }));
    expect(res.status).toBe(401);
  });

  it('secret set + correct header → 200', async () => {
    process.env.INTERNAL_API_SECRET = 'sekret';
    const res = await POST(req('http://x/api/connectors/poll?since=2099-01-01T00:00:00.000Z', {
      'x-internal-secret': 'sekret',
    }));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/connectors/poll — params', () => {
  it('invalid ?since → 400', async () => {
    const res = await POST(req('http://x/api/connectors/poll?since=not-a-date'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/since/i);
  });

  it('unknown ?only connector → 400', async () => {
    const res = await POST(req('http://x/api/connectors/poll?only=bogus'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/connector/i);
  });

  it('?only=salesforce polls ONLY that connector', async () => {
    const res = await POST(req(
      'http://x/api/connectors/poll?only=salesforce&since=2099-01-01T00:00:00.000Z',
    ));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.connectors).toHaveLength(1);
    expect(body.connectors[0].connector).toBe('salesforce');
  });

  it('github is silently absent (not a failure) when GITHUB_TOKEN is unset', async () => {
    const res = await POST(req('http://x/api/connectors/poll?since=2099-01-01T00:00:00.000Z'));
    const body = await res.json();
    const names = body.connectors.map((c: { connector: string }) => c.connector).sort();
    expect(names).toEqual(['hubspot', 'outreach', 'salesforce']);
  });
});

describe('POST /api/connectors/poll — response honesty', () => {
  it('end-to-end: far-past since ingests fixtures, recompute runs, ok reflects AND of poll+recompute', async () => {
    const res = await POST(req(
      'http://x/api/connectors/poll?since=2000-01-01T00:00:00.000Z',
    ));
    const body = await res.json();
    expect(res.status).toBe(200);
    // Every fixture connector should have ingested its rows.
    expect(body.connectors.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect(body.connectors.reduce((n: number, c: { ingested: number }) => n + c.ingested, 0))
      .toBeGreaterThan(0);
    // recompute summary present and structured.
    expect(body.recompute).toBeDefined();
    expect(typeof body.recompute.attempted).toBe('number');
    // Top-level ok = poll-ok AND recompute-ok. With a valid
    // DEFAULT_OWNER_EMAIL and clean fixtures this is true; the field
    // MUST exist so callers don't have to infer success.
    expect(typeof body.ok).toBe('boolean');
    expect(body.ok).toBe(true);
  });

  it('a recompute config problem does not hide successful ingestion (ok:false but poll data truthful)', async () => {
    // Misconfigure DEFAULT_OWNER_EMAIL. Poll+ingest still succeed and
    // are reported truthfully; recompute is reported failed; top-level
    // ok:false so the response does not overstate.
    process.env.DEFAULT_OWNER_EMAIL = 'not-an-email';
    const res = await POST(req(
      'http://x/api/connectors/poll?since=2000-01-01T00:00:00.000Z',
    ));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.connectors.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect(body.connectors.reduce((n: number, c: { ingested: number }) => n + c.ingested, 0))
      .toBeGreaterThan(0);
    expect(body.ok).toBe(false);                 // does not overstate
    expect(body.recompute.failed.length).toBeGreaterThan(0);
    // The ingested evidence is really there — ingestion was NOT rolled
    // back by the recompute failure.
    expect(db.select().from(schemaMod.evidence).all().length).toBeGreaterThan(0);
  });
});
