# Sales Demo Storyboard

Target length: 38 seconds. Silent, captioned, code-grounded, delivered to the README as an optimized inline GIF backed by a 1280x720 MP4 source.

## Continuous Film

The demo is one continuous workspace rather than a slide sequence. Three panels stay anchored throughout:

- Left: `gtm-ops-router` handoff as context seed.
- Center: Sales workbench, evidence boundary, draft contract, and critic review.
- Right: engagement feedback export plus runtime proof.

## Beats

| Time | Beat | On-screen proof |
| --- | --- | --- |
| 0-7s | Open | Sales is a local-first sales ops workbench for receipt-backed outbound. |
| 7-11s | Bridge | Router seed -> Sales workbench -> router feedback. |
| 11-16s | Import | Sample handoff import creates 6 accounts, 6 contacts, 6 handoff records, and 0 evidence rows. |
| 16-22s | Boundary | Screenshots show router context preserved while evidence remains empty until verified. |
| 22-27s | Draft contract | Draft output must cite verified evidence IDs and quote supporting spans. |
| 27-31s | Critics | Skeptical Buyer, Sales Coach, and Writing Editor review the draft. |
| 31-35s | Feedback | Sales exports `sales.engagement-feedback.v1` with incomplete coverage reported honestly. |
| 35-38s | Proof | `pnpm test`, `pnpm typecheck`, and `pnpm build` pass on the current repo. |

## Visual Notes

- Keep the frame calm: do not show the draft contract and critic cards as competing full-strength layers.
- Let captions take turns; avoid bottom-line ghosting between beats.
- Keep the proof card above the persistent bottom proof strip.
- Use the 900px, 12fps GIF for README display. Keep MP4 as the high-resolution source, not the README embed.
