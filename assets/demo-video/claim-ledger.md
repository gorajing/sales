# Sales Demo Claim Ledger

| On-screen claim | Exact meaning | Evidence command/file | Observed value | Safe caption |
| --- | --- | --- | --- | --- |
| `Outbound that keeps receipts` | Sales grounds outreach in verified evidence and revisions | `README.md` | README: every factual claim traces to a verified evidence row; every revision is preserved | `Outbound that keeps receipts` |
| `Router context enters as a seed` | GTM router payload is imported as context, not evidence | `README.md`; `app/accounts/[id]/page.tsx`; `lib/gtm-handoff/import.ts` | README and UI warning say research seed only; importer stores handoff records | `Router context enters as a seed` |
| `6 accounts, 6 contacts, 6 handoffs` | Importing the router sample into a migrated temp DB creates six account/contact/handoff records | `SALES_DB_PATH=/tmp/... pnpm db:migrate`; `SALES_DB_PATH=/tmp/... pnpm import:gtm-handoff -- ../gtm-ops-router/data/sales-handoff.sample.json --out /tmp/sales-handoff-import.json` | `processed: 6`, `accountsCreated: 6`, `contactsCreated: 6`, `handoffsCreated: 6` | `6 accounts, 6 contacts, 6 handoffs` |
| `0 evidence rows from import` | Handoff import does not create verified evidence | `tests/integration/gtm-handoff-import.test.ts`; README | Test asserts `evidence` has length 0 after import | `0 evidence rows from import` |
| `Drafts can only cite verified rows` | Drafter filters evidence to verified rows and validates citation spans | `README.md`; `lib/drafter/draft.ts`; `lib/evidence/validate.ts` | README and code enforce verified evidence plus span validation | `Drafts can only cite verified rows` |
| `Three critics review every draft` | The workflow includes Skeptical Buyer, Sales Coach, and Writing Editor critics | `README.md`; `lib/critics/run-panel.ts`; `data/principles.md` | README lists three critics; principles file is the Sales Coach rubric | `Three critics review every draft` |
| `sales.engagement-feedback.v1` | Sales exports engagement feedback using the versioned contract | `pnpm gen:engagement-sample`; `data/engagement-feedback.sample.json`; `lib/engagement/export.ts` | Sample schemaVersion is `sales.engagement-feedback.v1` | `sales.engagement-feedback.v1` |
| `complete:false, scanned:9, emitted:4` | The demo sample honestly reports incomplete coverage over routed deals | `pnpm gen:engagement-sample`; JSON summary command | `coverage: { complete: false, scanned: 9, emitted: 4, since: null }` | `complete:false, scanned:9, emitted:4` |
| `1 commercial signal` | One emitted deal includes an opportunity-created commercial signal | JSON summary command over `data/engagement-feedback.sample.json` | `commercialSignals: 1` | `1 commercial signal` |
| `26 test files, 141 tests` | Current Vitest suite passes | `pnpm test` | `Test Files 26 passed (26)`; `Tests 141 passed (141)` | `26 test files, 141 tests passed` |
| `typecheck passes` | TypeScript check passes | `pnpm typecheck` | `tsc --noEmit` exits 0 | `typecheck passes` |
| `build compiles successfully` | Next production build completes | `pnpm build` | `Compiled successfully`; static/dynamic route table emitted | `build compiles successfully` |

## Claims Not Used

- Live customer/revenue claims were not used. The repo proves local workflows, contracts, tests, and sample payloads, not live customer traction.
- SMTP, CRM sync, multi-user, and SaaS claims were not used because README marks them out of scope.
