import { spawn } from 'node:child_process';
import { z, type ZodType } from 'zod';

type Model = 'sonnet' | 'haiku' | 'opus';

export interface SpawnClaudeOptions<T> {
  prompt: string;
  schema: ZodType<T>;
  model?: Model;
  cwd?: string;
  timeoutMs?: number;
}

export class ClaudeError extends Error {
  constructor(message: string, public stderr: string, public exitCode: number | null) {
    super(message);
    this.name = 'ClaudeError';
  }
}

export class RateLimitError extends ClaudeError {}

// Simple global concurrency limit; Max 20 tolerates ~3 concurrent CLI processes.
const MAX_CONCURRENT = Number(process.env.CLAUDE_MAX_CONCURRENT ?? 3);
let inFlight = 0;
const queue: Array<() => void> = [];

async function acquire() {
  if (inFlight < MAX_CONCURRENT) { inFlight++; return; }
  await new Promise<void>((res) => queue.push(res));
  inFlight++;
}
function release() {
  inFlight--;
  const next = queue.shift();
  if (next) next();
}

export async function spawnClaude<T>({
  prompt, schema, model = 'sonnet', cwd = process.cwd(), timeoutMs = 120_000,
}: SpawnClaudeOptions<T>): Promise<T> {
  await acquire();
  try {
    const args = [
      '--print',
      '--output-format', 'json',
      '--model', model,
    ];
    const bin = process.env.CLAUDE_BIN ?? 'claude';

    return await new Promise<T>((resolve, reject) => {
      const child = spawn(bin, args, { cwd, env: process.env });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
        reject(new ClaudeError('Claude CLI timed out', stderr, null));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new ClaudeError(`Claude CLI failed to spawn: ${err.message}`, stderr, null));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        if (code !== 0) {
          if (/rate limit|quota/i.test(stderr)) {
            return reject(new RateLimitError('Rate limit hit', stderr, code));
          }
          return reject(new ClaudeError(`Claude CLI exit ${code}`, stderr, code));
        }
        try {
          // Claude CLI --output-format json wraps the response; the message content is a JSON string.
          const envelope = JSON.parse(stdout);
          const raw = typeof envelope.result === 'string' ? envelope.result : stdout;
          // Try to parse as JSON; if assistant returned JSON-as-text, extract it.
          let parsed: unknown;
          try { parsed = JSON.parse(raw); }
          catch {
            const match = raw.match(/```json\s*([\s\S]*?)```/);
            if (!match) throw new Error('no JSON in response');
            parsed = JSON.parse(match[1]);
          }
          resolve(schema.parse(parsed));
        } catch (err) {
          reject(new ClaudeError(
            `Response parse failed: ${(err as Error).message}`,
            `stdout=${stdout}\nstderr=${stderr}`, code,
          ));
        }
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  } finally {
    release();
  }
}
