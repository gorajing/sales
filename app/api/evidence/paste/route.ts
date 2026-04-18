import { NextResponse } from 'next/server';
import { z } from 'zod';
import { extractFromPaste } from '@/lib/evidence/extract';

const PasteBody = z.object({
  accountId: z.string(),
  contactId: z.string().optional(),
  sourceUrl: z.string().url(),
  rawText: z.string().min(10),
  capturedBy: z.enum(['manual', 'claude_cli', 'perplexity_mcp',
    'chatgpt_mcp', 'deep_research_paste']).default('manual'),
});

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = PasteBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  try {
    const ids = await extractFromPaste(parsed.data);
    return NextResponse.json({ evidenceIds: ids }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
