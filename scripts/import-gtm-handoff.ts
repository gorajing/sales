import { importGtmHandoffFile } from '@/lib/gtm-handoff/import';
import { sqlite } from '@/db';

function usage(): never {
  console.error('usage: pnpm import:gtm-handoff <path-to-sales-handoff.json>');
  process.exit(2);
}

const path = process.argv[2];
if (!path) usage();

try {
  const result = importGtmHandoffFile(path);
  console.log(JSON.stringify(result, null, 2));
} finally {
  sqlite.close();
}
