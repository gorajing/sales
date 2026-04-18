import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { spawnClaude, ClaudeError, RateLimitError } from '../../lib/claude/run';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const fixture = (obj: unknown) => {
  const envelope = { result: JSON.stringify(obj) };
  const tmp = path.join(os.tmpdir(), `fake-claude-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(envelope));
  return tmp;
};

afterEach(() => {
  delete process.env.CLAUDE_BIN;
  delete process.env.FAKE_CLAUDE_FIXTURE;
  delete process.env.FAKE_CLAUDE_FAIL;
  delete process.env.FAKE_CLAUDE_STDERR;
  delete process.env.FAKE_CLAUDE_EXIT;
});

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

  it('throws RateLimitError when stderr mentions rate limit', async () => {
    process.env.CLAUDE_BIN = path.resolve('tests/integration/fake-claude.sh');
    process.env.FAKE_CLAUDE_FAIL = '1';
    process.env.FAKE_CLAUDE_STDERR = 'API error: rate limit exceeded';
    process.env.FAKE_CLAUDE_EXIT = '1';
    delete process.env.FAKE_CLAUDE_FIXTURE;
    const schema = z.object({ x: z.number() });
    await expect(spawnClaude({ prompt: 'x', schema })).rejects.toBeInstanceOf(RateLimitError);
  });

  it('throws ClaudeError on non-zero exit without rate-limit signature', async () => {
    process.env.CLAUDE_BIN = path.resolve('tests/integration/fake-claude.sh');
    process.env.FAKE_CLAUDE_FAIL = '1';
    process.env.FAKE_CLAUDE_STDERR = 'unexpected internal error';
    process.env.FAKE_CLAUDE_EXIT = '2';
    delete process.env.FAKE_CLAUDE_FIXTURE;
    const schema = z.object({ x: z.number() });
    await expect(spawnClaude({ prompt: 'x', schema })).rejects.toMatchObject({
      name: 'ClaudeError',
      exitCode: 2,
    });
    // Also verify it is NOT a RateLimitError (which extends ClaudeError, so use a more specific check)
    let caught: unknown;
    try { await spawnClaude({ prompt: 'x', schema }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ClaudeError);
    expect(caught).not.toBeInstanceOf(RateLimitError);
  });

  it('extracts JSON from a markdown code fence when raw response is wrapped', async () => {
    // Envelope where result is text containing a fenced JSON block (typical Claude output)
    const fenced = "Here you go:\n\n```json\n{\"answer\":\"yes\",\"n\":7}\n```\n";
    const tmp = path.join(os.tmpdir(), `fake-claude-fenced-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ result: fenced }));
    process.env.CLAUDE_BIN = path.resolve('tests/integration/fake-claude.sh');
    process.env.FAKE_CLAUDE_FIXTURE = tmp;
    delete process.env.FAKE_CLAUDE_FAIL;
    delete process.env.FAKE_CLAUDE_STDERR;
    delete process.env.FAKE_CLAUDE_EXIT;
    const schema = z.object({ answer: z.string(), n: z.number() });
    const result = await spawnClaude({ prompt: 'x', schema });
    expect(result).toEqual({ answer: 'yes', n: 7 });
  });
});
