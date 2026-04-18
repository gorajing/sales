import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { newId } from '@/lib/id';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';

const Create = z.object({
  accountId: z.string(),
  channels: z.array(z.enum(['email', 'linkedin'])).min(1).max(10),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const accountId = url.searchParams.get('accountId');
  const q = accountId
    ? db.select().from(schema.sequences)
        .where(eq(schema.sequences.accountId, accountId))
        .orderBy(desc(schema.sequences.createdAt))
    : db.select().from(schema.sequences)
        .orderBy(desc(schema.sequences.createdAt));
  return NextResponse.json({ sequences: q.all() });
}

export async function POST(req: Request) {
  const parsed = Create.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const sequenceId = newId('sequence');
  db.insert(schema.sequences).values({
    id: sequenceId, accountId: parsed.data.accountId,
  }).run();
  const touchIds: string[] = [];
  parsed.data.channels.forEach((channel, idx) => {
    const id = newId('touch');
    db.insert(schema.touches).values({
      id, sequenceId, position: idx + 1, channel,
    }).run();
    touchIds.push(id);
  });
  return NextResponse.json({ sequenceId, touchIds }, { status: 201 });
}
