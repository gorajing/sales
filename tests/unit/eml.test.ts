import { describe, it, expect } from 'vitest';
import { buildEml } from '../../lib/export/eml';

describe('buildEml', () => {
  it('builds a minimal eml with CRLF headers', () => {
    const eml = buildEml({ subject: 'Hi', body: 'Hey Jane\n\nThoughts?' });
    expect(eml).toMatch(/^From: /);
    expect(eml).toContain('Subject: Hi');
    expect(eml.split('\r\n\r\n')[1]).toBe('Hey Jane\n\nThoughts?');
  });

  it('includes to/from when provided', () => {
    const eml = buildEml({
      subject: 'Hi', body: 'x',
      to: 'jane@acme.com', from: 'me@example.com',
    });
    expect(eml).toContain('From: me@example.com');
    expect(eml).toContain('To: jane@acme.com');
  });
});
