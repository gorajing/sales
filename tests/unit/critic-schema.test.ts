import { describe, it, expect } from 'vitest';
import { CriticResult } from '../../lib/claude/types';

describe('CriticResult schema', () => {
  it('accepts null suggested_rewrite', () => {
    const input = {
      verdict: 'revise',
      findings: [
        { issue: 'Delete this sentence', quote: 'whatever', suggested_rewrite: null, principle_id: null },
      ],
    };
    const parsed = CriticResult.parse(input);
    expect(parsed.findings[0].suggested_rewrite).toBeNull();
  });

  it('still accepts string suggested_rewrite', () => {
    const input = {
      verdict: 'revise',
      findings: [
        { issue: 'Tighten', quote: 'q', suggested_rewrite: 'tighter version', principle_id: 'P7' },
      ],
    };
    expect(() => CriticResult.parse(input)).not.toThrow();
  });
});
