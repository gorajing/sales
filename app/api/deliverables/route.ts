import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, schema } from '@/db';
import { desc } from 'drizzle-orm';
import { parseDeliverableMarkdown } from '@/lib/deliverable/parse';
import { importParsedDeliverable } from '@/lib/deliverable/import';
import { RateLimitError } from '@/lib/claude/run';

const CreateBody = z.object({
  rawMarkdown: z.string().min(50),
});

export async function GET() {
  const rows = db.select().from(schema.deliverables)
    .orderBy(desc(schema.deliverables.createdAt)).all();
  return NextResponse.json({ deliverables: rows });
}

export async function POST(req: Request) {
  const parsed = CreateBody.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  try {
    const parsedDoc = await parseDeliverableMarkdown(parsed.data.rawMarkdown);
    const result = await importParsedDeliverable(parsedDoc, parsed.data.rawMarkdown);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json({ error: 'Rate limit hit — try again later' }, { status: 429 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
