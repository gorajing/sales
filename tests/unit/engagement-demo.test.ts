import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// In-memory DB — replaces @/db for all imports in this file (mirrors
// tests/unit/engagement-export.test.ts).
// ---------------------------------------------------------------------------
vi.mock('@/db', async () => {
  const _path = await import('node:path');
  const _url = await import('node:url');
  const _schema = await import('../../db/schema');
  const _Database = (await import('better-sqlite3')).default;
  const { drizzle: _drizzle } = await import('drizzle-orm/better-sqlite3');
  const { migrate: _migrate } = await import('drizzle-orm/better-sqlite3/migrator');

  const _dirname = _path.dirname(_url.fileURLToPath(import.meta.url));
  const sqlite = new _Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = _drizzle(sqlite, { schema: _schema });
  _migrate(db, { migrationsFolder: _path.resolve(_dirname, '../../db/migrations') });
  return { db, schema: _schema };
});

import { seedEngagementDemo } from '../../lib/engagement/demo';
import { buildEngagementFeedback } from '../../lib/engagement/export';

const SAMPLE_PATH = new URL(
  '../../data/engagement-feedback.sample.json',
  import.meta.url,
);

// The exact literals scripts/gen-engagement-sample.ts uses.
const GENERATED_AT = '2026-05-29T07:00:00.000Z';
const PURPOSE =
  'Demo engagement overlay: observed front-funnel engagement for router measurement.';

beforeEach(async () => {
  const { db, schema: s } = await import('@/db');
  db.delete(s.engagementEvents).run();
  db.delete(s.touches).run();
  db.delete(s.sequences).run();
  db.delete(s.gtmHandoffImports).run();
  db.delete(s.accounts).run();
});

describe('engagement demo (cross-repo loop closure)', () => {
  it('seeds 9 routed deals and emits feedback for 4 with honest coverage', () => {
    seedEngagementDemo();
    const payload = buildEngagementFeedback({ generatedAt: GENERATED_AT, purpose: PURPOSE });

    expect(payload.coverage).toEqual({ complete: false, scanned: 9, emitted: 4, since: null });
    expect(payload.deals.map((d) => d.routerDealId)).toEqual([
      'D-8eb789ad84fc',
      'D-a2ff6592e43f',
      'D-cdea8ac45022',
      'D-fb65c15017ef',
    ]);
  });

  it('reproduces the committed sample byte-for-byte (drift guard)', () => {
    seedEngagementDemo();
    const payload = buildEngagementFeedback({ generatedAt: GENERATED_AT, purpose: PURPOSE });

    // Exact serialized bytes — the same comparison the cross-repo diff makes.
    // This is what guarantees the router's committed fixture and the live sales
    // producer stay identical.
    const committed = readFileSync(SAMPLE_PATH, 'utf8');
    expect(`${JSON.stringify(payload, null, 2)}\n`).toBe(committed);
  });

  it('records the demo through the real boundary, marking sent touches sent', async () => {
    seedEngagementDemo();
    const { db, schema: s } = await import('@/db');
    const { eq } = await import('drizzle-orm');

    // ryder-touch-1 was 'ready'; the sent event must have flipped it.
    const touch = db.select().from(s.touches).where(eq(s.touches.id, 'ryder-touch-1')).get();
    expect(touch?.status).toBe('sent');
    expect(touch?.sentAt).toBe('2026-05-01T09:00:00.000Z');
  });
});
