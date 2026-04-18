import { db, schema } from '@/db';
import { eq, asc } from 'drizzle-orm';

export interface PriorTouchSummary {
  position: number;
  channel: 'email' | 'linkedin';
  subject: string | null;
  body: string;
  linkedinKind: 'connect' | 'dm' | null; // null for email
}

export interface SequenceContext {
  currentPosition: number;
  totalTouches: number;
  currentChannel: 'email' | 'linkedin';
  currentLinkedinKind: 'connect' | 'dm' | null;
  priorTouches: PriorTouchSummary[];
}

function inferLinkedinKind(
  channel: 'email' | 'linkedin',
  thisLinkedinOrdinal: number, // 1 = first linkedin in sequence, 2 = second, etc.
): 'connect' | 'dm' | null {
  if (channel !== 'linkedin') return null;
  // First linkedin in a sequence = connect request; any subsequent = post-connect DM
  return thisLinkedinOrdinal === 1 ? 'connect' : 'dm';
}

export async function buildSequenceContext(touchRevisionId: string): Promise<SequenceContext> {
  const rev = db.select().from(schema.touchRevisions)
    .where(eq(schema.touchRevisions.id, touchRevisionId)).get();
  if (!rev) throw new Error('revision not found');
  const currentTouch = db.select().from(schema.touches)
    .where(eq(schema.touches.id, rev.touchId)).get();
  if (!currentTouch) throw new Error('touch not found');

  const allTouches = db.select().from(schema.touches)
    .where(eq(schema.touches.sequenceId, currentTouch.sequenceId))
    .orderBy(asc(schema.touches.position)).all();

  // Compute linkedin ordinal for the current touch
  let currentLinkedinOrdinal = 0;
  {
    let running = 0;
    for (const t of allTouches) {
      if (t.channel === 'linkedin') running++;
      if (t.id === currentTouch.id) { currentLinkedinOrdinal = running; break; }
    }
  }

  const priorTouches: PriorTouchSummary[] = [];
  let linkedinRunning = 0;
  for (const t of allTouches) {
    if (t.position >= currentTouch.position) break;
    if (t.channel === 'linkedin') linkedinRunning++;
    if (!t.currentRevisionId) continue;
    const pr = db.select().from(schema.touchRevisions)
      .where(eq(schema.touchRevisions.id, t.currentRevisionId)).get();
    if (!pr) continue;
    priorTouches.push({
      position: t.position,
      channel: t.channel as 'email' | 'linkedin',
      subject: pr.subject,
      body: pr.body,
      linkedinKind: inferLinkedinKind(t.channel as 'email' | 'linkedin', linkedinRunning),
    });
  }

  return {
    currentPosition: currentTouch.position,
    totalTouches: allTouches.length,
    currentChannel: currentTouch.channel as 'email' | 'linkedin',
    currentLinkedinKind: inferLinkedinKind(currentTouch.channel as 'email' | 'linkedin', currentLinkedinOrdinal),
    priorTouches,
  };
}

export function renderSequenceContext(ctx: SequenceContext): string {
  const header = `Current touch: ${ctx.currentPosition} of ${ctx.totalTouches}. Channel: ${ctx.currentChannel}${ctx.currentLinkedinKind ? ` (${ctx.currentLinkedinKind})` : ''}.`;

  const kindNote = ctx.currentLinkedinKind === 'dm'
    ? '\n\nThis is a post-connection LinkedIn DM. The recipient has already accepted. Apply warm-conversation conventions — do NOT flag "generic opener" or "no why-now hook" by default. The why-now was established in earlier touches.'
    : ctx.currentLinkedinKind === 'connect'
    ? '\n\nThis is a LinkedIn connection request. Apply cold-open conventions but keep it under ~60 words.'
    : ctx.currentPosition > 1
    ? '\n\nThis is NOT the first touch in the sequence. Earlier touches already established the observation and value. Do NOT flag "no why-now hook" or "must lead with specific observation" unless the earlier touches did not deliver them.'
    : '';

  if (ctx.priorTouches.length === 0) {
    return header + kindNote;
  }

  const priorLines = ctx.priorTouches.map((p) => {
    const kindTag = p.linkedinKind ? ` (${p.linkedinKind})` : '';
    const subj = p.subject ? ` — subject: "${p.subject}"` : '';
    // Keep prior touch bodies compact: truncate at ~300 chars
    const truncated = p.body.length > 300 ? p.body.slice(0, 300) + '…' : p.body;
    return `  Touch ${p.position} (${p.channel}${kindTag})${subj}:\n    ${truncated.replace(/\n+/g, ' ')}`;
  }).join('\n');

  return `${header}${kindNote}\n\nPrior touches in this sequence (in order):\n${priorLines}`;
}
