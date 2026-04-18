import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { newId } from '@/lib/id';

const Body = z.object({
  touchId: z.string(),
  oldText: z.string(),
  newText: z.string(),
  source: z.enum(['critic_rewrite', 'manual_edit']).default('critic_rewrite'),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const touch = db.select().from(schema.touches)
    .where(eq(schema.touches.id, parsed.data.touchId)).get();
  if (!touch?.currentRevisionId) {
    return NextResponse.json({ error: 'no current revision' }, { status: 400 });
  }
  const current = db.select().from(schema.touchRevisions)
    .where(eq(schema.touchRevisions.id, touch.currentRevisionId)).get();
  if (!current) return NextResponse.json({ error: 'revision missing' }, { status: 500 });

  const newBody = current.body.replaceAll(parsed.data.oldText, parsed.data.newText);
  if (newBody === current.body) {
    return NextResponse.json({ error: 'oldText not found in body' }, { status: 400 });
  }

  const newRevisionId = newId('touchRevision');
  const existingRevisions = db.select().from(schema.touchRevisions)
    .where(eq(schema.touchRevisions.touchId, parsed.data.touchId)).all();

  db.insert(schema.touchRevisions).values({
    id: newRevisionId,
    touchId: parsed.data.touchId,
    revisionNumber: existingRevisions.length + 1,
    subject: current.subject,
    body: newBody,
    citedEvidenceIds: current.citedEvidenceIds,
    supportingSpans: current.supportingSpans,
    rationale: current.rationale,
    createdBy: parsed.data.source,
  }).run();
  db.update(schema.touches).set({ currentRevisionId: newRevisionId })
    .where(eq(schema.touches.id, parsed.data.touchId)).run();

  return NextResponse.json({ revisionId: newRevisionId }, { status: 201 });
}
