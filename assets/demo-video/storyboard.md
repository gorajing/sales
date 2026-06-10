# Sales Demo Storyboard

Target length: 40-42 seconds. Silent, captioned, code-grounded, with GitHub README delivery as an optimized inline GIF.

## Beat 1: Open

Caption: `Outbound that keeps receipts.`

Proof: README positions Sales as local-first B2B research/outreach where every factual claim traces to verified evidence.

## Beat 2: Import

Caption: `Router context enters as a seed.`

Proof: Migrated temp DB plus `pnpm import:gtm-handoff -- ../gtm-ops-router/data/sales-handoff.sample.json` processed 6 accounts, created 6 accounts, 6 contacts, and 6 handoff records.

## Beat 3: Boundary

Caption: `Research seed only. Not verified evidence.`

Proof: App account page shows the warning, while the Evidence page remains empty until facts are captured and audited.

## Beat 4: Draft Contract

Caption: `Drafts can only cite verified rows.`

Proof: README and `lib/evidence/validate.ts` require `cited_evidence_ids` and verbatim `supporting_spans`.

## Beat 5: Critics

Caption: `Three critics review every draft.`

Proof: README lists Skeptical Buyer, Sales Coach, and Writing Editor; `data/principles.md` is the user-owned Sales Coach rubric.

## Beat 6: Engagement Feedback

Caption: `The loop closes back to the router.`

Proof: `pnpm gen:engagement-sample` writes `sales.engagement-feedback.v1` with coverage `complete:false`, `scanned:9`, `emitted:4`, four deals, and one commercial signal.

## Beat 7: Runtime Proof

Caption: `The current suite passes.`

Proof: `pnpm test` reports 26 test files and 141 tests passing; `pnpm typecheck` passes; `pnpm build` compiles successfully.

## Beat 8: Close

Caption: `Sales is a proof-gated outreach workbench.`

Proof: README architecture: evidence, drafting, critique, and feedback export are separate contract layers.
