import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { spawnClaude, ClaudeError } from '../../lib/claude/run';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const fixture = (obj: unknown) => {
  const envelope = { result: JSON.stringify(obj) };
  const tmp = path.join(os.tmpdir(), `fake-claude-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(envelope));
  return tmp;
};

describe('spawnClaude', () => {
  it('parses a valid JSON result against the schema', async () => {
    const fx = fixture({ answer: 'yes', n: 42 });
    process.env.CLAUDE_BIN = path.resolve('tests/integration/fake-claude.sh');
    process.env.FAKE_CLAUDE_FIXTURE = fx;
    const schema = z.object({ answer: z.string(), n: z.number() });
    const result = await spawnClaude({ prompt: 'anything', schema });
    expect(result).toEqual({ answer: 'yes', n: 42 });
  });

  it('throws ClaudeError on schema mismatch', async () => {
    const fx = fixture({ wrong: true });
    process.env.CLAUDE_BIN = path.resolve('tests/integration/fake-claude.sh');
    process.env.FAKE_CLAUDE_FIXTURE = fx;
    const schema = z.object({ answer: z.string() });
    await expect(spawnClaude({ prompt: 'x', schema })).rejects.toBeInstanceOf(ClaudeError);
  });
});
