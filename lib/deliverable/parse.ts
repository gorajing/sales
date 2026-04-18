import { spawnClaude as realSpawn } from '../claude/run';
import { renderPrompt } from '../claude/prompts';
import fs from 'node:fs';
import path from 'node:path';
import {
  DeliverableStructure, ParsedAccount, ParsedDeliverable,
} from '../claude/types';

type SpawnFn = typeof realSpawn;

function loadSkill(name: string): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), `skills/${name}/SKILL.md`),
    'utf8',
  );
}

async function parseStructure(
  markdown: string,
  spawn: SpawnFn,
): Promise<DeliverableStructure> {
  const prompt = renderPrompt([
    { heading: 'Skill', body: loadSkill('parse-deliverable-structure') },
    { heading: 'Document', body: markdown },
  ]);
  return spawn({
    prompt, schema: DeliverableStructure, model: 'haiku',
    timeoutMs: 120_000,  // small output, should return quickly
  });
}

async function parseAccountSlab(
  slab: string,
  rank: number,
  spawn: SpawnFn,
): Promise<ParsedAccount> {
  const prompt = renderPrompt([
    { heading: 'Skill', body: loadSkill('parse-account-section') },
    { heading: 'Rank', body: `This account's rank is ${rank}. Copy this into the output \`rank\` field.` },
    { heading: 'Account section', body: slab },
  ]);
  return spawn({
    prompt, schema: ParsedAccount, model: 'sonnet',
    timeoutMs: 240_000,  // per-account output is bounded; 4 min is generous
  });
}

/**
 * Two-pass parse:
 *  1. Haiku extracts structure (name, account headers, outro start) — tiny output.
 *  2. Programmatically split the raw markdown into intro / per-account slabs / outro.
 *  3. Sonnet parses each account slab in parallel (bounded by spawnClaude's concurrency queue).
 */
export async function parseDeliverableMarkdown(
  markdown: string,
  spawn: SpawnFn = realSpawn,
): Promise<ParsedDeliverable> {
  const structure = await parseStructure(markdown, spawn);

  if (structure.account_headers.length === 0) {
    throw new Error('no account headers found in document');
  }

  // Find each heading's byte position in the original markdown
  const positions: Array<{ rank: number; heading: string; pos: number }> = [];
  for (const h of structure.account_headers) {
    const pos = markdown.indexOf(h.heading);
    if (pos < 0) {
      throw new Error(`account heading "${h.heading}" (rank ${h.rank}) not found verbatim in document`);
    }
    positions.push({ rank: h.rank, heading: h.heading, pos });
  }
  positions.sort((a, b) => a.pos - b.pos);

  const outroPos = structure.outro_start_heading
    ? (() => {
        const p = markdown.indexOf(structure.outro_start_heading!);
        return p >= 0 ? p : markdown.length;
      })()
    : markdown.length;

  const introMd = markdown.slice(0, positions[0].pos).trim() || null;
  const outroMd = outroPos < markdown.length ? markdown.slice(outroPos).trim() : null;

  const slabs: Array<{ rank: number; slab: string }> = [];
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].pos;
    const end = i + 1 < positions.length ? positions[i + 1].pos : outroPos;
    slabs.push({ rank: positions[i].rank, slab: markdown.slice(start, end) });
  }

  // Parse each account in parallel — bounded by spawnClaude's concurrency queue
  const parsedAccounts = await Promise.all(
    slabs.map((s) => parseAccountSlab(s.slab, s.rank, spawn))
  );

  parsedAccounts.sort((a, b) => a.rank - b.rank);

  return {
    name: structure.name,
    intro_md: introMd,
    outro_md: outroMd,
    accounts: parsedAccounts,
  };
}
