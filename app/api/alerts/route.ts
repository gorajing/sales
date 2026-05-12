import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { requireInternalSecret, formatError } from '@/lib/alerts/http';

/**
 * GET /api/alerts — read API for the alert feed.
 *
 * Same auth + production guard as the ack endpoint. Returns up to 100
 * alerts ordered by `createdAt DESC, rowid DESC` (deterministic
 * tiebreaker — see `lib/alerts/queries.ts` for the rationale).
 *
 * Query params:
 *   - `open=1` — only unacknowledged rows.
 *   - `accountId=<id>` — filter to one account.
 *
 * The page at /alerts uses `recentAlerts()` directly rather than calling
 * this endpoint; this stays available for external integrations
 * (Phase 6 demo, slack notifications subscribing to the feed, etc.)
 * and for ad-hoc operator queries via curl.
 */

const HARD_LIMIT = 100;

export async function GET(req: Request) {
  const gate = requireInternalSecret(req);
  if (gate) return gate;

  try {
    const url = new URL(req.url);
    const onlyOpen = url.searchParams.get('open') === '1';
    const accountId = url.searchParams.get('accountId');

    const conditions = [
      onlyOpen ? isNull(schema.alerts.acknowledgedAt) : undefined,
      accountId ? eq(schema.alerts.accountId, accountId) : undefined,
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    const baseQuery = db.select().from(schema.alerts)
      .orderBy(sql`${schema.alerts.createdAt} DESC, rowid DESC`)
      .limit(HARD_LIMIT);

    const rows = conditions.length > 0
      ? baseQuery.where(and(...conditions)).all()
      : baseQuery.all();

    return NextResponse.json({ alerts: rows });
  } catch (err) {
    console.error('[alerts/list] internal error:', formatError(err));
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
