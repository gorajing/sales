import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auditPendingForAccount } from '@/lib/evidence/audit';
import { RateLimitError } from '@/lib/claude/run';
import { db, schema } from '@/db';
import { eq, desc } from 'drizzle-orm';

const RunBody = z.object({ accountId: z.string() });
const ResolveBody = z.object({
  evidenceId: z.string(),
  action: z.enum(['accept_correction', 'override_verified', 'remove']),
});

export async function POST(req: Request) {
  const body = await req.json();
  const run = RunBody.safeParse(body);
  if (run.success) {
    try {
      const counts = await auditPendingForAccount(run.data.accountId);
      return NextResponse.json(counts);
    } catch (err) {
      if (err instanceof RateLimitError) {
        return NextResponse.json({ error: 'Rate limit hit — try again later' }, { status: 429 });
      }
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
  }
  const resolve = ResolveBody.safeParse(body);
  if (!resolve.success) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  const { evidenceId, action } = resolve.data;
  if (action === 'remove') {
    // Delete audits first to avoid FK violations
    db.delete(schema.extractionAudits)
      .where(eq(schema.extractionAudits.evidenceId, evidenceId)).run();
    db.delete(schema.evidence).where(eq(schema.evidence.id, evidenceId)).run();
  } else if (action === 'override_verified') {
    db.update(schema.evidence).set({ extractionStatus: 'verified' })
      .where(eq(schema.evidence.id, evidenceId)).run();
    // Mark latest audit as user-overridden
    const latest = db.select().from(schema.extractionAudits)
      .where(eq(schema.extractionAudits.evidenceId, evidenceId))
      .orderBy(desc(schema.extractionAudits.createdAt)).all()[0];
    if (latest) {
      db.update(schema.extractionAudits).set({ resolvedBy: 'user_overrode' })
        .where(eq(schema.extractionAudits.id, latest.id)).run();
    }
  } else if (action === 'accept_correction') {
    const audit = db.select().from(schema.extractionAudits)
      .where(eq(schema.extractionAudits.evidenceId, evidenceId))
      .orderBy(desc(schema.extractionAudits.createdAt))
      .all()[0];
    if (audit?.suggestedCorrection) {
      db.update(schema.evidence)
        .set({ extractedFact: audit.suggestedCorrection, extractionStatus: 'verified' })
        .where(eq(schema.evidence.id, evidenceId)).run();
      // Mark this audit as user-accepted
      db.update(schema.extractionAudits).set({ resolvedBy: 'user_accepted' })
        .where(eq(schema.extractionAudits.id, audit.id)).run();
    }
  }
  return NextResponse.json({ ok: true });
}
