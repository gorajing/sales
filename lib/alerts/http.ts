import { NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Small HTTP helpers shared by the alerts endpoints. Same pattern as
 * /api/signals and /api/scoring/recompute — duplicated rather than
 * abstracted into a single shared module until the THIRD endpoint
 * needs them (then it's worth extracting to `lib/http/`).
 */

/** Equal-length precondition for timingSafeEqual is met via SHA-256
 *  digest, so the comparator doesn't reveal secret length via fast-fail.
 *  Same shape as recompute's helper. */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

export function parseMediaType(header: string | null): string | null {
  if (header === null) return null;
  return header.split(';')[0].trim().toLowerCase();
}

/**
 * Auth + production-config gate. Mirrors /api/signals + /api/scoring/recompute:
 *   - NODE_ENV=production AND secret unset → 503 misconfigured (fail safe).
 *   - secret set + header missing/wrong → 401.
 *   - secret unset in dev → permissive (return null = allow).
 *   - secret set + header correct → permissive (return null = allow).
 *
 * Returns `null` on allow, or a `NextResponse` to return immediately.
 */
export function requireInternalSecret(
  req: Request,
  envVar = 'INTERNAL_API_SECRET',
  headerName = 'x-internal-secret',
): NextResponse | null {
  const expected = process.env[envVar];
  if (!expected && process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      {
        error: 'misconfigured',
        detail: `${envVar} must be set in production. ` +
                'Unauthenticated mode is local-dev only.',
      },
      { status: 503 },
    );
  }
  if (expected) {
    const presented = req.headers.get(headerName);
    if (presented === null || !timingSafeStringEqual(presented, expected)) {
      return NextResponse.json(
        { error: 'unauthorized', detail: `missing or invalid ${headerName.toUpperCase()}` },
        { status: 401 },
      );
    }
  }
  return null;
}

/**
 * Read up to `maxBytes` from the request body, bailing on the first chunk
 * that crosses the cap. Peak memory is bounded at a small constant
 * multiple of `maxBytes`, regardless of whether Content-Length is
 * present or honest. Byte-accurate; counts bytes, not UTF-16 code units.
 *
 * Duplicated from app/api/signals/route.ts and
 * app/api/scoring/recompute/route.ts. With three HTTP boundaries now
 * needing the same primitive, this is the time to consolidate
 * (recompute's local copy noted "extract on third caller"). For now
 * the alerts endpoints use this version; recompute can migrate in a
 * follow-up cleanup so this commit stays scoped to /alerts.
 */
export async function readBoundedBody(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; reason: 'too_large' | 'read_error' }> {
  const reader = req.body?.getReader();
  if (!reader) return { ok: true, text: '' };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'read_error' };
  }
  return { ok: true, text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8') };
}

/** Format an unknown thrown value into a server-side log line. Same
 *  cycle + depth guards as the recompute route's helper. */
const MAX_CAUSE_DEPTH = 4;

export function formatError(err: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): string {
  if (err instanceof Error) {
    if (seen.has(err)) return `${err.name}: ${err.message} (cycle truncated)`;
    seen.add(err);
    const head = err.stack ?? `${err.name}: ${err.message}`;
    if (err.cause === undefined) return head;
    if (depth + 1 >= MAX_CAUSE_DEPTH) {
      return `${head}\n  caused by: (depth limit ${MAX_CAUSE_DEPTH} reached)`;
    }
    return `${head}\n  caused by: ${formatError(err.cause, depth + 1, seen)}`;
  }
  try {
    const j = JSON.stringify(err);
    if (j !== undefined) return j;
  } catch {
    /* BigInts / cyclic refs — fall through */
  }
  return String(err);
}
