import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { newId } from '@/lib/id';
import { z } from 'zod';
import { desc } from 'drizzle-orm';

const CreateAccount = z.object({
  name: z.string().min(1),
  domain: z.string().optional(),
  industry: z.string().optional(),
  size: z.string().optional(),
  notes: z.string().optional(),
});

export async function GET() {
  const rows = db.select().from(schema.accounts).orderBy(desc(schema.accounts.createdAt)).all();
  return NextResponse.json({ accounts: rows });
}

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = CreateAccount.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const id = newId('account');
  // Normalize domain to lowercase and treat blank as null so the
  // case-insensitive partial unique index can do its job.
  const trimmedDomain = parsed.data.domain?.toLowerCase().trim() || null;
  db.insert(schema.accounts).values({
    id,
    ...parsed.data,
    domain: trimmedDomain,
  }).run();
  return NextResponse.json({ id }, { status: 201 });
}
