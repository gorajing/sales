import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Build the committed engagement-feedback sample against a THROWAWAY database so
// we never touch the dev DB. SALES_DB_PATH must be set before @/db is imported
// (it resolves the path at module init), so we set it first and pull @/db in
// via dynamic import. Wrapped in an async IIFE because tsx transforms scripts to
// CJS, which disallows top-level await.
void (async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-engagement-demo-'));
  process.env.SALES_DB_PATH = path.join(tmpDir, 'demo.db');

  const { db, sqlite } = await import('@/db');
  const { migrate } = await import('drizzle-orm/better-sqlite3/migrator');
  migrate(db, { migrationsFolder: path.resolve('db/migrations') });

  const { seedEngagementDemo } = await import('@/lib/engagement/demo');
  const { buildEngagementFeedback } = await import('@/lib/engagement/export');

  seedEngagementDemo();

  // generatedAt + purpose are frozen literals so the sample is byte-stable and
  // matches the router's committed fixture exactly.
  const payload = buildEngagementFeedback({
    generatedAt: '2026-05-29T07:00:00.000Z',
    purpose:
      'Demo engagement overlay: observed front-funnel engagement for router measurement.',
  });

  const outPath = path.resolve('data/engagement-feedback.sample.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

  sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.error(`wrote ${outPath}`);
})();
