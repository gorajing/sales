import { NextResponse } from 'next/server';
import { db, schema } from '@/db';
import { newId } from '@/lib/id';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';

const CreateContact = z.object({
  accountId: z.string(),
  fullName: z.string().min(1),
  title: z.string().optional(),
  linkedinUrl: z.string().url().optional(),
  email: z.string().email().optional(),
  archetype: z.enum(['gatekeeper', 'business_user', 'enabler', 'leader', 'unknown'])
    .default('unknown'),
  notes: z.string().optional(),
});

const UpdateContact = z.object({
  id: z.string(),
  archetype: z.enum(['gatekeeper', 'business_user', 'enabler', 'leader', 'unknown']).optional(),
  title: z.string().optional(),
  email: z.string().email().optional(),
  notes: z.string().optional(),
});

export async function GET(req: Request) {
  const url = new URL(req.url);
  const accountId = url.searchParams.get('accountId');
  const q = accountId
    ? db.select().from(schema.contacts)
        .where(eq(schema.contacts.accountId, accountId))
        .orderBy(desc(schema.contacts.createdAt))
    : db.select().from(schema.contacts)
        .orderBy(desc(schema.contacts.createdAt));
  return NextResponse.json({ contacts: q.all() });
}

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = CreateContact.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const id = newId('contact');
  db.insert(schema.contacts).values({ id, ...parsed.data }).run();
  return NextResponse.json({ id }, { status: 201 });
}

export async function PATCH(req: Request) {
  const body = await req.json();
  const parsed = UpdateContact.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const { id, ...patch } = parsed.data;
  db.update(schema.contacts).set(patch).where(eq(schema.contacts.id, id)).run();
  return NextResponse.json({ ok: true });
}
