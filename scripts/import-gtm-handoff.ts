import { importGtmHandoffFile } from '@/lib/gtm-handoff/import';
import { sqlite, sqlitePath } from '@/db';
import fs from 'node:fs';
import pathModule from 'node:path';

function usage(message?: string): never {
  if (message) console.error(message);
  console.error('usage: pnpm import:gtm-handoff <path-to-sales-handoff.json> [--out result.json]');
  process.exit(2);
}

const args = process.argv.slice(2);
// pnpm may forward the script delimiter as a literal first arg.
// Strip that delimiter, then parse the actual importer arguments normally.
if (args[0] === '--') args.shift();
const positionals: string[] = [];
let outPath: string | undefined;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg.startsWith('--out=')) {
    outPath = arg.slice('--out='.length);
    if (!outPath) usage();
    continue;
  }
  if (arg === '--out') {
    outPath = args[i + 1];
    if (!outPath || outPath.startsWith('--')) usage();
    i += 1;
    continue;
  }
  if (arg.startsWith('--')) usage(`unknown flag: ${arg}`);
  positionals.push(arg);
}
if (positionals.length !== 1) usage();
const inputPath = positionals[0];

try {
  const result = importGtmHandoffFile(inputPath);
  const cliResult = { ...result, databasePath: sqlitePath };
  const json = `${JSON.stringify(cliResult, null, 2)}\n`;
  if (outPath) {
    const resolvedOutPath = pathModule.resolve(outPath);
    fs.mkdirSync(pathModule.dirname(resolvedOutPath), { recursive: true });
    fs.writeFileSync(resolvedOutPath, json);
    console.error(
      `Imported ${result.imported.length} GTM handoff account(s); wrote result to ${resolvedOutPath}`,
    );
  } else {
    console.log(json.trimEnd());
  }
} finally {
  sqlite.close();
}
