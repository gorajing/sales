import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { newId } from '@/lib/id';

const ImportBody = z.object({
  touchId: z.string(),
  subject: z.string().nullable().default(null),
  body: z.string().min(1),
});

export async function POST(req: Request) {
  const parsed = ImportBody.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const touch = db.select().from(schema.touches)
    .where(eq(schema.touches.id, parsed.data.touchId)).get();
  if (!touch) return NextResponse.json({ error: 'touch not found' }, { status: 404 });

  const newRevisionId = newId('touchRevision');
  const existing = db.select().from(schema.touchRevisions)
    .where(eq(schema.touchRevisions.touchId, parsed.data.touchId)).all();

  db.insert(schema.touchRevisions).values({
    id: newRevisionId,
    touchId: parsed.data.touchId,
    revisionNumber: existing.length + 1,
    subject: parsed.data.subject,
    body: parsed.data.body,
    citedEvidenceIds: [],
    supportingSpans: [],
    rationale: 'Imported from paste; claim audit not yet run.',
    createdBy: 'manual_edit',
  }).run();
  db.update(schema.touches).set({ currentRevisionId: newRevisionId })
    .where(eq(schema.touches.id, parsed.data.touchId)).run();

  return NextResponse.json({ revisionId: newRevisionId }, { status: 201 });
}
