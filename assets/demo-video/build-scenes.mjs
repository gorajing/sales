#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OUT = new URL("./scenes/", import.meta.url);

const colors = {
  ink: "#151515",
  muted: "#5d646c",
  paper: "#f6f1e8",
  panel: "#fffdf8",
  dark: "#101216",
  blue: "#2457d6",
  green: "#167a52",
  mint: "#68d7a5",
  amber: "#b87900",
  coral: "#d94b3d",
};

function h(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function terminal(lines, variant = "") {
  const body = lines.map((line, index) => {
    if (line === "") {
      return `<div class="term-line blank" style="--delay:${340 + index * 190}ms">&nbsp;</div>`;
    }
    const text = typeof line === "string" ? line : line.text;
    const kind = typeof line === "string" ? "" : line.kind ?? "";
    const delay = typeof line === "string" ? `${340 + index * 190}ms` : line.delay ?? `${340 + index * 190}ms`;
    if (kind === "command") {
      const prompt = typeof line === "string" ? "sales %" : line.prompt ?? "sales %";
      return `<div class="term-line command" style="--delay:${delay};--chars:${String(text).length}"><span class="prompt">${h(prompt)}</span><span class="typed">${h(text)}</span></div>`;
    }
    return `<div class="term-line ${kind}" style="--delay:${delay}">${h(text)}</div>`;
  }).join("");
  return `<div class="terminal ${variant}">
    <div class="terminal-bar"><i></i><i></i><i></i><span>sales@local</span></div>
    <div class="terminal-body">${body}<div class="cursor"></div></div>
  </div>`;
}

const scenes = [
  {
    id: "01-open",
    theme: "paper",
    eyebrow: "Sales / evidence-grounded outreach",
    proof: "Proof: README.md + docs/sales-gtm-handoff.png",
    body: `
      <section class="open-grid">
        <div class="copy reveal" style="--d:120ms">
          <div class="kicker">local-first sales system</div>
          <h1>Outbound that keeps receipts.</h1>
          <p>Sales turns router handoffs into research context, verified evidence, cited drafts, critic review, and engagement feedback.</p>
        </div>
        <div class="workflow reveal" style="--d:280ms">
          <div class="step active"><b>router handoff</b><span>context seed</span></div>
          <div class="arrow"></div>
          <div class="step"><b>evidence</b><span>verified rows only</span></div>
          <div class="arrow"></div>
          <div class="step"><b>draft + critics</b><span>revision history</span></div>
          <div class="arrow"></div>
          <div class="step active"><b>feedback</b><span>router measurement</span></div>
        </div>
        <div class="screenshot-card reveal" style="--d:480ms">
          <img src="../../../docs/sales-gtm-handoff.png" alt="Sales GTM handoff screenshot">
        </div>
      </section>`
  },
  {
    id: "02-import",
    theme: "operator",
    eyebrow: "GTM handoff import",
    proof: "Proof: migrated temp DB + pnpm import:gtm-handoff",
    body: `
      <section class="terminal-metrics">
        <div class="metric-copy reveal" style="--d:100ms">
          <div class="kicker">contract boundary</div>
          <h2>Router context enters as a seed.</h2>
          <p>The importer creates accounts, contacts, and handoff records. It does not create verified evidence.</p>
          <div class="metric-row">
            <div><strong>6</strong><span>accounts</span></div>
            <div><strong>6</strong><span>contacts</span></div>
            <div><strong>6</strong><span>handoffs</span></div>
          </div>
        </div>
        ${terminal([
          { text: "SALES_DB_PATH=/tmp/sales.db pnpm db:migrate", kind: "command", delay: "260ms" },
          { text: "> sales@0.1.0 db:migrate", kind: "muted", delay: "1120ms" },
          "",
          { text: "SALES_DB_PATH=/tmp/sales.db pnpm import:gtm-handoff -- ../gtm-ops-router/data/sales-handoff.sample.json", kind: "command", delay: "1580ms" },
          { text: "Imported 6 GTM handoff account(s)", kind: "good", delay: "2940ms" },
          { text: "processed: 6", kind: "good", delay: "3220ms" },
          { text: "accountsCreated: 6  contactsCreated: 6", kind: "good", delay: "3440ms" },
          { text: "handoffsCreated: 6  evidenceCreated: 0", kind: "warn", delay: "3660ms" }
        ], "wide")}
      </section>`
  },
  {
    id: "03-boundary",
    theme: "studio",
    eyebrow: "Evidence boundary",
    proof: "Proof: app account/evidence pages",
    body: `
      <section class="boundary-shot">
        <div class="boundary-copy reveal" style="--d:120ms">
          <h2>Research seed only. Not verified evidence.</h2>
          <p>The account page preserves router context, while the Evidence page stays empty until public facts are captured and audited.</p>
          <div class="boundary-badge"><strong>0</strong><span>evidence rows from import</span></div>
        </div>
        <div class="stacked-shots reveal" style="--d:300ms">
          <img src="../../../docs/sales-gtm-handoff.png" alt="Sales account handoff">
          <img src="../../../docs/sales-evidence-empty.png" alt="Sales empty evidence">
        </div>
      </section>`
  },
  {
    id: "04-draft-contract",
    theme: "paper",
    eyebrow: "Drafting contract",
    proof: "Proof: README.md + lib/evidence/validate.ts",
    body: `
      <section class="contract-shot">
        <div class="contract-left reveal" style="--d:120ms">
          <h2>Drafts can only cite verified rows.</h2>
          <p>The drafter emits evidence IDs and supporting spans; validation rejects claims whose span is not a verbatim substring of the source snippet.</p>
        </div>
        <div class="rules reveal" style="--d:260ms">
          <div><b>pending audit</b><span>not draftable</span></div>
          <div><b>verified</b><span>allowed into the prompt</span></div>
          <div><b>supporting_spans</b><span>must quote the snippet</span></div>
          <div><b>immutable revision</b><span>accepted rewrite creates history</span></div>
        </div>
        <pre class="code reveal" style="--d:440ms"><code>cited_evidence_ids: ["ev_1"]
supporting_spans: [{
  evidence_id: "ev_1",
  span: "hiring a VP of Data"
}]

span must be inside the evidence snippet</code></pre>
      </section>`
  },
  {
    id: "05-critics",
    theme: "operator",
    eyebrow: "Critic panel",
    proof: "Proof: README.md + data/principles.md",
    body: `
      <section class="critic-shot">
        <div class="critic-copy reveal" style="--d:120ms">
          <div class="kicker">quality gate</div>
          <h2>Three critics review every draft.</h2>
          <p>The Sales Coach scores against the owner-owned principles file, so the bar can evolve without changing application code.</p>
        </div>
        <div class="critic-grid">
          <article class="critic reveal" style="--d:260ms"><b>Skeptical Buyer</b><span>Would I delete this in two seconds?</span></article>
          <article class="critic reveal" style="--d:420ms"><b>Sales Coach</b><span>Checks every principle in data/principles.md.</span></article>
          <article class="critic reveal" style="--d:580ms"><b>Writing Editor</b><span>Concision, AI tells, active voice.</span></article>
        </div>
        <div class="principle reveal" style="--d:780ms">
          <b>Principle file is the tactical bar.</b>
          <span>Claims must be specific, sourced, and buyer-relevant.</span>
        </div>
      </section>`
  },
  {
    id: "06-feedback",
    theme: "studio",
    eyebrow: "Engagement feedback",
    proof: "Proof: pnpm gen:engagement-sample",
    body: `
      <section class="feedback-shot">
        <div class="feedback-copy reveal" style="--d:120ms">
          <h2>The loop closes back to the router.</h2>
          <p>Sales emits observed engagement as a versioned payload with honest coverage, not a pretend-complete attribution story.</p>
        </div>
        <div class="json-panel reveal" style="--d:260ms">
          <div class="json-title">sales.engagement-feedback.v1</div>
          <pre><code>{
  "coverage": {
    "complete": false,
    "scanned": 9,
    "emitted": 4
  },
  "deals": 4,
  "commercialSignals": 1
}</code></pre>
        </div>
        <div class="coverage reveal" style="--d:520ms">
          <div><strong>9</strong><span>routed deals scanned</span></div>
          <div><strong>4</strong><span>deals emitted</span></div>
          <div><strong>1</strong><span>commercial signal</span></div>
        </div>
      </section>`
  },
  {
    id: "07-proof",
    theme: "operator",
    eyebrow: "Runtime proof",
    proof: "Proof: pnpm test + typecheck + build",
    body: `
      <section class="proof-shot">
        ${terminal([
          { text: "pnpm test", kind: "command", delay: "240ms" },
          { text: "Test Files  26 passed (26)", kind: "good", delay: "980ms" },
          { text: "Tests       141 passed (141)", kind: "good", delay: "1240ms" },
          "",
          { text: "pnpm typecheck", kind: "command", delay: "1720ms" },
          { text: "tsc --noEmit", kind: "muted", delay: "2380ms" },
          "",
          { text: "pnpm build", kind: "command", delay: "2800ms" },
          { text: "Compiled successfully", kind: "good", delay: "3500ms" },
          { text: "Route (app): 24 routes", kind: "muted", delay: "3740ms" }
        ], "proof")}
        <div class="proof-aside reveal" style="--d:720ms">
          <strong>141</strong>
          <span>tests passed</span>
          <p>Import, evidence validation, critics, engagement export, and UI routes are covered by the current suite.</p>
        </div>
      </section>`
  },
  {
    id: "08-close",
    theme: "paper",
    eyebrow: "Local-first sales ops",
    proof: "Proof: README.md architecture section",
    body: `
      <section class="close-shot">
        <div class="close-copy reveal" style="--d:120ms">
          <h2>Sales is a proof-gated outreach workbench.</h2>
          <p>Router handoffs stay context. Evidence becomes citations. Critics improve drafts. Engagement feeds measurement.</p>
        </div>
        <div class="final-grid reveal" style="--d:360ms">
          <div><b>gtm handoff</b><span>context only</span></div>
          <div><b>verified evidence</b><span>draftable facts</span></div>
          <div><b>critic panel</b><span>quality pressure</span></div>
          <div><b>feedback export</b><span>measurement loop</span></div>
        </div>
      </section>`
  }
];

function page(scene, index) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=1280,height=720,initial-scale=1">
<title>${h(scene.id)}</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;width:1280px;height:720px;overflow:hidden}
body{--ink:${colors.ink};--muted:${colors.muted};--paper:${colors.paper};--panel:${colors.panel};--dark:${colors.dark};--blue:${colors.blue};--green:${colors.green};--mint:${colors.mint};--amber:${colors.amber};--coral:${colors.coral};background:var(--paper);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;letter-spacing:0}
body.operator{background:var(--dark);color:#f4f0e7}body.studio{background:#fbfaf7}
body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.11;background:linear-gradient(90deg,transparent 0 79px,rgba(28,29,31,.12) 80px),linear-gradient(transparent 0 79px,rgba(28,29,31,.08) 80px);background-size:80px 80px}
body.operator:before{opacity:.14;background:linear-gradient(90deg,transparent 0 79px,rgba(255,255,255,.055) 80px),linear-gradient(transparent 0 79px,rgba(255,255,255,.04) 80px);background-size:80px 80px}
.stage{position:relative;width:1280px;height:720px;padding:34px 48px 30px;display:grid;grid-template-rows:44px 1fr 30px;gap:20px}
.topbar,.footer{display:flex;align-items:center;justify-content:space-between;z-index:2}.topbar{font-size:16px;font-weight:650;color:var(--muted)}.operator .topbar,.operator .footer{color:#adb5bd}.stamp{border:1px solid rgba(130,120,105,.28);border-radius:8px;padding:7px 12px;background:rgba(255,253,248,.7)}.operator .stamp{border-color:#353a44;background:rgba(255,255,255,.04)}
.content{position:relative;z-index:1}.footer{font-size:15px;color:var(--muted)}.proof-line{border-left:3px solid var(--blue);padding-left:11px}.progress{width:230px;height:6px;border-radius:99px;background:rgba(120,110,95,.25);overflow:hidden}.progress i{display:block;height:100%;width:${Math.round(((index + 1) / scenes.length) * 100)}%;background:linear-gradient(90deg,var(--blue),var(--green),var(--amber))}
h1,h2,p{margin:0}h1{font-size:68px;line-height:.95;font-weight:860;max-width:600px}h2{font-size:54px;line-height:.98;font-weight:850}p{font-size:25px;line-height:1.18;color:var(--muted);font-weight:560}.operator p{color:#c3c9cf}.kicker{font-size:17px;font-weight:800;color:var(--blue)}.operator .kicker{color:#6aa3ff}
.reveal{opacity:0;transform:translateY(16px);animation:reveal 640ms cubic-bezier(.22,.72,.2,1) forwards;animation-delay:var(--d,0ms)}@keyframes reveal{to{opacity:1;transform:translateY(0)}}
.open-grid{height:100%;display:grid;grid-template-columns:440px 1fr;grid-template-rows:1fr 172px;gap:24px 34px;align-items:center}.copy{display:flex;flex-direction:column;gap:18px}.workflow{grid-column:1/3;display:grid;grid-template-columns:1fr 44px 1fr 44px 1fr 44px 1fr;gap:10px;align-items:center}.step{border:1px solid rgba(120,110,95,.28);border-radius:8px;background:rgba(255,253,248,.86);padding:18px;box-shadow:0 18px 38px rgba(20,24,28,.08)}.step.active{border-color:rgba(36,87,214,.35)}.step b{display:block;font-size:22px}.step span{display:block;margin-top:6px;color:var(--muted);font-size:17px;font-weight:650}.arrow{height:8px;border-radius:99px;background:linear-gradient(90deg,var(--blue),var(--green));transform-origin:left;animation:grow 900ms ease forwards}@keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}.screenshot-card{height:330px;border:1px solid rgba(120,110,95,.28);border-radius:8px;background:#fff;box-shadow:0 25px 70px rgba(20,24,28,.16);overflow:hidden}.screenshot-card img{width:100%;height:100%;object-fit:cover;object-position:top left}
.terminal{border-radius:9px;background:#0d1117;color:#e8edf2;box-shadow:0 24px 60px rgba(0,0,0,.28),inset 0 0 0 1px rgba(255,255,255,.09);overflow:hidden;font-family:"SF Mono",Menlo,Consolas,monospace}.terminal-bar{height:38px;display:flex;align-items:center;gap:8px;padding:0 15px;border-bottom:1px solid rgba(255,255,255,.08);color:#8d969f;font-family:-apple-system,BlinkMacSystemFont,"Inter",sans-serif;font-size:14px}.terminal-bar i{width:11px;height:11px;border-radius:99px;background:#ff5f57}.terminal-bar i:nth-child(2){background:#febc2e}.terminal-bar i:nth-child(3){background:#28c840}.terminal-bar span{margin-left:8px}.terminal-body{padding:22px 25px;font-size:19px;line-height:1.35;min-height:260px}.terminal.wide{height:100%}.terminal.proof{height:100%}.terminal.proof .terminal-body{font-size:24px;line-height:1.32}.term-line{white-space:pre-wrap;opacity:0;transform:translateY(3px);animation:termIn 170ms ease-out forwards;animation-delay:var(--delay)}.blank{height:9px}.command{display:flex;gap:9px;white-space:nowrap;overflow:hidden;opacity:1;transform:none;animation:none}.prompt{color:#8a929b;opacity:0;animation:termIn 120ms ease-out forwards;animation-delay:var(--delay)}.typed{display:inline-block;max-width:0;overflow:hidden;white-space:nowrap;color:#78e6ac;animation:typeCommand 900ms steps(42,end) forwards;animation-delay:calc(var(--delay) + 100ms)}.good{color:#fff;font-weight:770}.muted{color:#aeb6bf}.warn{color:#f1c35b;font-weight:770}.cursor{display:inline-block;width:10px;height:21px;margin-top:10px;background:#78e6ac;animation:cursor 900ms steps(2,end) infinite}@keyframes termIn{to{opacity:1;transform:translateY(0)}}@keyframes typeCommand{to{max-width:1050px}}@keyframes cursor{50%{opacity:0}}
.terminal-metrics{height:100%;display:grid;grid-template-columns:390px 1fr;gap:28px}.metric-copy{align-self:center;display:flex;flex-direction:column;gap:17px}.metric-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:8px}.metric-row div{border:1px solid #343944;border-radius:8px;background:rgba(255,255,255,.05);padding:14px}.metric-row strong{display:block;font-size:42px;color:var(--mint);line-height:.9}.metric-row span{display:block;margin-top:8px;color:#c3c9cf;font-size:16px;font-weight:700}
.boundary-shot{height:100%;display:grid;grid-template-columns:420px 1fr;gap:30px;align-items:center}.boundary-copy{display:flex;flex-direction:column;gap:18px}.boundary-badge{border:1px solid rgba(120,110,95,.28);border-radius:8px;background:#fffdf8;padding:18px;width:245px}.boundary-badge strong{display:block;font-size:72px;color:var(--green);line-height:.8}.boundary-badge span{display:block;margin-top:10px;font-size:18px;font-weight:750;color:var(--muted)}.stacked-shots{height:430px;position:relative}.stacked-shots img{position:absolute;border:1px solid rgba(120,110,95,.28);border-radius:8px;background:#fff;box-shadow:0 24px 60px rgba(20,24,28,.16);width:640px}.stacked-shots img:first-child{top:0;right:0}.stacked-shots img:last-child{bottom:0;left:0;width:600px}
.contract-shot{height:100%;display:grid;grid-template-columns:410px 1fr;grid-template-rows:1fr 190px;gap:24px}.contract-left{align-self:center;display:flex;flex-direction:column;gap:18px}.rules{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-content:center}.rules div{border:1px solid rgba(120,110,95,.28);border-radius:8px;background:#fffdf8;padding:22px;box-shadow:0 16px 36px rgba(20,24,28,.08)}.rules b{display:block;font-size:24px}.rules span{display:block;margin-top:9px;color:var(--muted);font-weight:650}.code{grid-column:1/3;margin:0;border-radius:8px;background:#111418;color:#edf2e9;padding:23px 28px;font-family:"SF Mono",Menlo,Consolas,monospace;font-size:22px;line-height:1.32;box-shadow:0 22px 50px rgba(20,24,28,.18)}
.critic-shot{height:100%;display:grid;grid-template-columns:410px 1fr;grid-template-rows:1fr 126px;gap:22px}.critic-copy{align-self:center;display:flex;flex-direction:column;gap:18px}.critic-grid{display:grid;grid-template-columns:1fr;gap:14px;align-content:center}.critic{border:1px solid #343944;border-radius:8px;background:rgba(255,255,255,.055);padding:24px}.critic b{display:block;font-size:30px;color:#fff}.critic span{display:block;margin-top:10px;color:#c3c9cf;font-size:22px;font-weight:600}.principle{grid-column:1/3;border:1px solid #343944;border-radius:8px;background:rgba(255,255,255,.055);padding:24px;display:flex;align-items:center;justify-content:space-between}.principle b{font-size:27px}.principle span{font-size:23px;color:#c3c9cf;font-weight:650}
.feedback-shot{height:100%;display:grid;grid-template-columns:380px 1fr;grid-template-rows:1fr 136px;gap:22px}.feedback-copy{align-self:center;display:flex;flex-direction:column;gap:18px}.json-panel{border:1px solid rgba(120,110,95,.28);border-radius:8px;background:#111418;color:#edf2e9;box-shadow:0 24px 60px rgba(20,24,28,.16);overflow:hidden}.json-title{height:42px;border-bottom:1px solid rgba(255,255,255,.09);padding:11px 18px;color:#9aa4ad;font-family:"SF Mono",Menlo,Consolas,monospace}.json-panel pre{margin:0;padding:28px 34px;font-family:"SF Mono",Menlo,Consolas,monospace;font-size:27px;line-height:1.35}.coverage{grid-column:1/3;display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}.coverage div{border:1px solid rgba(120,110,95,.28);border-radius:8px;background:#fffdf8;padding:22px;text-align:center}.coverage strong{display:block;font-size:58px;line-height:.8;color:var(--green)}.coverage span{display:block;margin-top:13px;color:var(--muted);font-weight:760;font-size:19px}
.proof-shot{height:100%;display:grid;grid-template-columns:1fr 300px;gap:26px}.proof-aside{align-self:end;border:1px solid #343944;border-radius:8px;background:rgba(255,255,255,.055);padding:26px}.proof-aside strong{display:block;font-size:90px;line-height:.8;color:var(--mint)}.proof-aside span{display:block;margin-top:12px;font-size:25px;font-weight:820;color:#fff}.proof-aside p{margin-top:18px;font-size:20px}
.close-shot{height:100%;display:grid;grid-template-columns:1fr 480px;gap:34px;align-items:center}.close-copy h2{font-size:64px}.close-copy p{margin-top:22px;max-width:650px}.final-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.final-grid div{border:1px solid rgba(120,110,95,.28);border-radius:8px;background:#fffdf8;padding:24px;box-shadow:0 18px 38px rgba(20,24,28,.08)}.final-grid b{display:block;font-size:25px}.final-grid span{display:block;margin-top:9px;color:var(--muted);font-size:18px;font-weight:680}
</style>
<body class="${h(scene.theme)}">
<main class="stage">
  <header class="topbar reveal" style="--d:40ms"><div><strong>Sales</strong> / proof-gated outreach</div><div class="stamp">${h(scene.eyebrow)}</div></header>
  <section class="content">${scene.body}</section>
  <footer class="footer reveal" style="--d:840ms"><div class="proof-line">${h(scene.proof)}</div><div class="progress"><i></i></div></footer>
</main>
</body>
</html>`;
}

await mkdir(OUT, { recursive: true });
for (let i = 0; i < scenes.length; i += 1) {
  const scene = scenes[i];
  await writeFile(join(OUT.pathname, `${scene.id}.html`), page(scene, i), "utf8");
}
console.log(`Wrote ${scenes.length} scenes to ${OUT.pathname}`);
