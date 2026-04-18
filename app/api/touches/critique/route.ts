import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runCriticPanel } from '@/lib/critics/run-panel';
import { RateLimitError } from '@/lib/claude/run';

const Body = z.object({ touchRevisionId: z.string() });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  try {
    const critiques = await runCriticPanel(parsed.data.touchRevisionId);
    return NextResponse.json({ critiques });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return NextResponse.json({ error: 'Rate limit hit — try again later' }, { status: 429 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
