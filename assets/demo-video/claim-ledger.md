# Sales Demo Claim Ledger

| On-screen claim | Exact meaning | Evidence command/file | Observed value | Safe caption |
| --- | --- | --- | --- | --- |
| `Outbound that keeps receipts` | Sales grounds outreach in verified evidence and preserved revisions | `README.md` | README states every factual claim traces to a verified evidence row and revisions are preserved | `Outbound that keeps receipts` |
| `Router context enters as a seed` | GTM router payload is imported as context, not evidence | `README.md`; `app/accounts/[id]/page.tsx`; `lib/gtm-handoff/import.ts` | README and UI warning describe router context as research seed only | `Router context enters Sales as a seed` |
| `6 accounts, 6 contacts, 6 handoffs` | Importing the router sample into a migrated temp DB creates six account/contact/handoff records | `assets/demo-video/proof/02-import-result.json`; `assets/demo-video/proof/03-db-counts.json` | accounts `6`, contacts `6`, `gtm_handoff_imports` `6` | `six router handoffs become Sales context` |
| `0 evidence rows from import` | Handoff import does not create verified evidence | `assets/demo-video/proof/03-db-counts.json`; `tests/integration/gtm-handoff-import.test.ts` | evidence count `0` | `zero evidence rows created` |
| `Research seed only. Not verified evidence.` | Sales separates imported context from verified evidence rows | `docs/sales-gtm-handoff.png`; `docs/sales-evidence-empty.png`; README | Account view preserves GTM context while evidence view is empty | `the app keeps research seed separate from verified evidence` |
| `Drafts can only cite verified rows` | Drafter filters evidence to verified rows and validates citation spans | `README.md`; `lib/drafter/draft.ts`; `lib/evidence/validate.ts` | Draft contract uses `cited_evidence_ids` and verbatim `supporting_spans` | `cited spans must be verbatim substrings` |
| `Three critics review every draft` | Workflow includes Skeptical Buyer, Sales Coach, and Writing Editor | `README.md`; `lib/critics/run-panel.ts`; `data/principles.md` | The three critic roles are documented and implemented | `critic review` |
| `sales.engagement-feedback.v1` | Sales exports engagement feedback using the versioned contract | `assets/demo-video/proof/05-engagement-summary.json`; `data/engagement-feedback.sample.json`; `lib/engagement/export.ts` | schemaVersion `sales.engagement-feedback.v1` | `Sales exports observed engagement` |
| `complete:false, scanned:9, emitted:4` | Demo sample reports incomplete coverage instead of implying full truth | `assets/demo-video/proof/05-engagement-summary.json` | coverage complete `false`, scanned `9`, emitted `4` | `honest incomplete coverage` |
| `1 commercial signal` | One emitted deal includes an opportunity-created commercial signal | `assets/demo-video/proof/05-engagement-summary.json` | `commercialSignals: 1` | `1 commercial signal` |
| `141 tests across 26 files` | Current Vitest suite passes | `assets/demo-video/proof/06-test.txt` | 26 test files and 141 tests passed | `tests passed across 26 files` |
| `typecheck passed` | TypeScript check exits successfully | `assets/demo-video/proof/07-typecheck.txt` | `tsc --noEmit` exits 0 | `Typecheck passed` |
| `build compiled` | Next production build completes | `assets/demo-video/proof/08-build.txt` | `Compiled successfully`; one Turbopack NFT-list warning is recorded | `Build compiled` |

## Claims Not Used

- Live customer, revenue, CRM sync, SMTP, SaaS, and multi-user claims were not used.
- The demo shows local workflows, evidence contracts, sample payloads, and tests. It does not claim live pipeline performance.
