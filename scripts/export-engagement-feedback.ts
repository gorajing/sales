import { buildEngagementFeedback } from '@/lib/engagement/export';
import { sqlite } from '@/db';
import fs from 'node:fs';
import pathModule from 'node:path';

function usage(message?: string): never {
  if (message) console.error(message);
  console.error('usage: pnpm export:engagement-feedback [--out result.json]');
  process.exit(2);
}

const args = process.argv.slice(2);
// pnpm may forward the script delimiter as a literal first arg.
// Strip that delimiter, then parse the actual exporter arguments normally.
if (args[0] === '--') args.shift();
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
  usage(`unknown flag: ${arg}`);
}

try {
  // new Date().toISOString() always yields canonical YYYY-MM-DDTHH:mm:ss.sssZ.
  const feedback = buildEngagementFeedback({ generatedAt: new Date().toISOString() });
  const json = `${JSON.stringify(feedback, null, 2)}\n`;
  if (outPath) {
    const resolvedOutPath = pathModule.resolve(outPath);
    fs.mkdirSync(pathModule.dirname(resolvedOutPath), { recursive: true });
    fs.writeFileSync(resolvedOutPath, json);
    console.error(
      `Exported ${feedback.deals.length} deal(s) ` +
        `(${feedback.coverage.emitted}/${feedback.coverage.scanned}), wrote ${resolvedOutPath}`,
    );
  } else {
    console.log(json.trimEnd());
  }
} finally {
  sqlite.close();
}
