import { NextResponse } from 'next/server';
import { z } from 'zod';
import { draftTouch } from '@/lib/drafter/draft';
import { RateLimitError } from '@/lib/claude/run';

const Body = z.object({ touchId: z.string(), contactId: z.string().optional() });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  try {
    const result = await draftTouch(parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json({ error: 'Rate limit hit — try again later' }, { status: 429 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
