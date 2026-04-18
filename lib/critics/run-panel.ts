import { critiqueSkepticalBuyer } from './skeptical-buyer';
import { critiqueSalesCoach } from './sales-coach';
import { critiqueWritingEditor } from './writing-editor';
import { validateRewrite } from './rewrite-safety';
import { db, schema } from '@/db';
import { eq } from 'drizzle-orm';
import { newId } from '../id';
import type { CriticResult } from '../claude/types';

export interface CritiqueRow {
  criticName: 'skeptical_buyer' | 'sales_coach' | 'writing_editor';
  result: CriticResult;
}

export async function runCriticPanel(touchRevisionId: string): Promise<CritiqueRow[]> {
  const rev = db.select().from(schema.touchRevisions)
    .where(eq(schema.touchRevisions.id, touchRevisionId)).get();
  if (!rev) throw new Error('revision not found');
  const touch = db.select().from(schema.touches)
    .where(eq(schema.touches.id, rev.touchId)).get();
  if (!touch) throw new Error('touch not found');

  const body = rev.body;
  const subject = rev.subject;
  const channel = touch.channel;

  const [skep, coach, editor] = await Promise.all([
    critiqueSkepticalBuyer(body, subject, channel),
    critiqueSalesCoach(body, subject, channel),
    critiqueWritingEditor(body, subject, channel),
  ]);

  const rows: CritiqueRow[] = [
    { criticName: 'skeptical_buyer', result: skep },
    { criticName: 'sales_coach', result: coach },
    { criticName: 'writing_editor', result: editor },
  ];

  // Structural safety check on each suggested_rewrite
  for (const row of rows) {
    row.result.findings = row.result.findings.map((f) => {
      if (!f.suggested_rewrite) return f;
      const check = validateRewrite(f.quote, f.suggested_rewrite);
      if (check.ok) return f;
      return {
        ...f,
        issue: `${f.issue} [rewrite auto-rejected: ${check.reason}]`,
        suggested_rewrite: null,
      };
    });
  }

  for (const { criticName, result } of rows) {
    db.insert(schema.critiques).values({
      id: newId('critique'),
      touchRevisionId,
      criticName,
      verdict: result.verdict,
      findingsJson: result.findings,
    }).run();
  }

  return rows;
}
