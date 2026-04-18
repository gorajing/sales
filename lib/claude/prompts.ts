import fs from 'node:fs';
import path from 'node:path';

/**
 * Read a file relative to the Next.js project root (process.cwd()).
 * Always call with a project-relative path like 'data/principles.md'
 * or 'skills/draft-touch/SKILL.md'. Not a general-purpose file loader.
 */
export function loadFile(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8');
}

export interface PromptSection { heading: string; body: string; }

export function renderPrompt(sections: PromptSection[]): string {
  return sections.map(s => `## ${s.heading}\n\n${s.body.trim()}`).join('\n\n');
}
