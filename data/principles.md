# Sales Principles

The Sales Coach critic scores every draft against each principle below. Each principle has a stable `id` (so critic output can reference `verdict: fail` on `id: P1` without ambiguity), a one-line rule, a rationale, and a source. Edit freely — this file is the user-owned tactical rubric.

Principles below are seeded from the owner's personal knowledge base (Zuhn). Source IDs reference insights in that KB; read the full insight for the underlying reasoning.

---

## P1 — Specificity over enthusiasm

**Rule:** Every factual claim must be falsifiable. No unfalsifiable enthusiasm words ("passionate", "revolutionizing", "excited about", "love helping companies"). Replace with concrete metrics, specific examples, or named observations.

**Why:** Unfalsifiable statements carry zero information because every sender uses them — they activate skepticism filters instead of bypassing them. Falsifiable claims invite scrutiny and therefore signal confidence. Trust scales with falsifiability.

**Critic check:** Flag any sentence containing vague enthusiasm markers. Flag any claim that cannot be independently verified. Reward sentences with numbers, dates, names, or specific observations tied to evidence IDs.

**Source:** Zuhn INS-260404-124F — "Specificity of claims is the primary trust signal in cold professional outreach"

---

## P2 — Lead with evidence, not introduction

**Rule:** The first sentence references something specific the recipient did, said, shipped, or is dealing with — drawn from the evidence store. Never open with "I hope this finds you well", "I came across your profile", "I noticed you're the [title]", or any form of self-introduction before the reader sees why this message is for them.

**Why:** Generic openers force the recipient to do the mental work of figuring out why this matters. Most won't bother. Front-loading specificity makes the recipient feel seen, not sold to.

**Critic check:** Reject drafts where the first sentence is about the sender. Reject drafts where the first specific detail appears after sentence 2.

**Source:** Zuhn INS-260405-270B — "Effective cold outreach requires specificity and a clear value proposition"

---

## P3 — Earn the right to ask

**Rule:** Offer a specific observation, insight, or piece of useful value before making any ask. The ratio of "value delivered" to "value requested" should be greater than 1 in touch 1.

**Why:** The "just following up" email signals "I have nothing new to offer" and trains the recipient to ignore you. Every email is a brand impression. A message that adds something useful — a relevant data point, a contrarian take on their situation, a named customer doing something similar — converts at orders-of-magnitude better rates than one that asks without giving.

**Critic check:** Flag touches where the sender asks for time / a meeting / a reply before providing any concrete value. Flag any "just checking in" / "circling back" / "bumping this to the top of your inbox" constructions.

**Source:** Zuhn INS-260327-04D8 — "Write cold emails like texts to a friend"

---

## P4 — One ask, low friction

**Rule:** Exactly one CTA per email. The touch-1 ask is small and reversible (a 15-minute call, a single yes/no question, permission to send more info). Escalate ask size in later touches.

**Why:** Multiple asks split attention and convert zero. Big asks on touch 1 feel presumptuous given zero prior context. Small asks are easier to say yes to and earn the right to the larger ask later.

**Critic check:** Flag drafts with more than one question mark in the CTA block. Flag first-touch asks that require >15 min of the recipient's time.

**Source:** Owner's editorial — extends Zuhn INS-260405-270B ("make the ask small and frictionless")

---

## P5 — Pattern interrupt over pattern match

**Rule:** The message should be identifiably different from the 50 other vendor emails in the recipient's inbox this week. Prefer a contrarian insight, an acknowledged limitation, or a genuinely unusual format (Loom video, hand-written note reference, specific recent event) over the standard intro-problem-solution-CTA structure.

**Why:** 99% of sales outreach sounds identical. Recipients have an automatic "detect sales pitch, activate resistance, tune out" response. Doing something genuinely different is what gets attention. The ultimate pattern interrupt is authentic specificity that could not have come from a template.

**Critic check:** If the email could plausibly have been sent to 100 other prospects with minor substitutions, it fails. If the email contains a sentence no other sender in this category would write, it passes.

**Source:** Zuhn INS-260327-4E36 — "Be the pattern interrupt"

---

## P6 — Read-aloud test

**Rule:** Read the draft aloud. Any sentence that feels awkward to say to a real person's face gets deleted or rewritten in plain speech.

**Why:** Corporate-speak triggers both technological and human spam filters. Informal, human language ("hey", "I'd love to", "this might be relevant") reads as written by a real person — which it is. Templates produce robotic copy; writing to one specific person first and then templatizing is the right direction of travel.

**Critic check:** Flag phrases that don't pass the read-aloud test. Specific offenders: "I wanted to reach out", "I hope this finds you well", "Per my last email", "Following up on my previous message", "Circling back", "Wanted to touch base", "Hope you're doing well".

**Source:** Zuhn INS-260327-04D8 — "Write cold emails like texts to a friend — read them aloud"

---

## P7 — Respect the reader's time

**Rule:** Cold emails ≤120 words. LinkedIn DMs ≤60 words. If a thought needs more space, move it to an attachment or a second touch.

**Why:** Length signals the sender's time cost, not the reader's value. Every unnecessary sentence is a reason to stop reading.

**Critic check:** Word count over cap = automatic revise. Flag paragraphs longer than 4 sentences.

**Source:** Owner's editorial — industry consensus; reinforced by Zuhn INS-260327-04D8

---

## P8 — Evidence-grounded personalization only

**Rule:** Any personalization claim in the draft must trace to a specific `evidence_id` in the store. Do not invent "I saw your post about X" unless the post is in the evidence pack. Do not guess at strategic initiatives; cite them from news, 10-Ks, job posts, or LinkedIn.

**Why:** Fake personalization is worse than no personalization — it reads as confident wrongness. Real personalization is the highest-leverage lever in cold outreach, but only when real.

**Critic check:** Cross-reference every personalized claim with `cited_evidence_ids`. Any unsourced personal reference = reject.

**Source:** Owner's editorial — anti-hallucination invariant; enforced structurally at the validator layer, restated here for the Sales Coach critic.

---

## P9 — Show, don't claim

**Rule:** Never use the words "best", "industry-leading", "world-class", "cutting-edge", "unique". Show the thing those words are trying to claim through specifics: a metric, a customer name, a specific capability with numbers attached.

**Why:** Claims of quality activate skepticism; specifics earn trust. Restraint in claims signals deeper knowledge. Overclaiming signals the opposite.

**Critic check:** Flag any sentence containing a superlative adjective that isn't backed by a cited evidence ID with a quantitative claim.

**Source:** Zuhn principle "Credibility is built by what you show, not what you claim" (from brief, supports INS-260404-124F)

---

## P10 — Earn the "not right for you" line

**Rule:** When the evidence suggests fit is genuinely weak, say so. "Based on [specific evidence], this probably isn't right for you right now — but here's what I'd actually recommend: [specific alternative or advice]." Do not force-fit a pitch when the evidence doesn't support it.

**Why:** Disqualifying authentically is a pattern interrupt. It signals that you actually read the material, that you respect the recipient's time, and that you aren't running a generic play. Paradoxically, it converts better than forced fit because it rebuilds trust.

**Critic check:** Flag drafts that pitch a solution when cited evidence suggests low fit. The Sales Coach should surface this as a reframe suggestion, not a rejection.

**Source:** Zuhn INS-260327-4E36 — "Be the pattern interrupt" (disqualification example)

---

## P11 — Match frame to buyer archetype

**Rule:** Identify the recipient's archetype (gatekeeper / business user / enabler / leader) from evidence and match the frame accordingly:
- **Gatekeeper** (procurement, ops): same thing cheaper / faster / safer. Painkiller frame, ROI math.
- **Business user** (the person who uses it): deliver more, do their job better. Vitamin frame, workflow improvement.
- **Enabler** (HR, IT, enablement): help others do better work. Vitamin frame, team-level wins.
- **Leader** (exec, founder): growth, differentiation, strategic positioning. Candy frame, outcome narrative.

**Why:** A single deal may need different framings for different stakeholders. Uniform pitching to the wrong archetype = zero conversion, even with perfect copy. The evidence store should capture the archetype on the contact row.

**Critic check:** If `contact.archetype` is set and the draft's frame doesn't match, flag with a suggested reframe. If archetype is unknown, prompt for it before drafting.

**Source:** Zuhn principle "Buyer-specific messaging segmentation outperforms uniform pitching" (from brief)

---

## P12 — Every touch is a brand impression

**Rule:** If a touch has nothing new to add, don't send it. Delete it from the sequence. A skipped low-value touch is better than a "just following up" touch.

**Why:** Low-value follow-ups condition the recipient to ignore future messages from you permanently. Every email is either building credibility or burning it; there is no neutral.

**Critic check:** Flag touches where the new content reduces to "checking in", "bumping this up", or a restatement of the previous touch without new evidence or a new angle.

**Source:** Zuhn INS-260327-04D8 — "Every single email is a brand impression"

---

## Meta

- Principles are evaluated independently; a draft can pass 11 and fail 1 — the Sales Coach surfaces which.
- Each principle's critic output is `{ principle_id, verdict: pass|fail|n/a, quoted_violation: "...", suggested_rewrite: "..." }`.
- Add new principles freely. Remove ones that stop matching your motion. Changing the file changes the critic.
- Consult Zuhn periodically to refresh the seed — principles tagged `[untested]` in Zuhn may move to `[confirmed]` or `[falsified]` over time based on tracked outcomes.
