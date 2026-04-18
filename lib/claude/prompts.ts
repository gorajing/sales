import fs from 'node:fs';
import path from 'node:path';

export function loadFile(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8');
}

export interface PromptSection { heading: string; body: string; }

export function renderPrompt(sections: PromptSection[]): string {
  return sections.map(s => `## ${s.heading}\n\n${s.body.trim()}`).join('\n\n');
}
