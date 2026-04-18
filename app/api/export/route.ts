import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { buildEml } from '@/lib/export/eml';
import { z } from 'zod';

const Body = z.object({ sequenceId: z.string() });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const touches = db.select().from(schema.touches)
    .where(eq(schema.touches.sequenceId, parsed.data.sequenceId)).all()
    .sort((a, b) => a.position - b.position);

  const artifacts = touches.map((t) => {
    if (!t.currentRevisionId) return null;
    const rev = db.select().from(schema.touchRevisions)
      .where(eq(schema.touchRevisions.id, t.currentRevisionId)).get();
    if (!rev) return null;
    if (t.channel === 'email') {
      return {
        position: t.position,
        channel: 'email' as const,
        filename: `touch-${t.position}.eml`,
        content: buildEml({ subject: rev.subject ?? '(no subject)', body: rev.body }),
      };
    }
    return {
      position: t.position,
      channel: 'linkedin' as const,
      filename: `touch-${t.position}-linkedin.txt`,
      content: rev.body,
    };
  }).filter((a): a is NonNullable<typeof a> => a !== null);

  return NextResponse.json({ artifacts });
}
