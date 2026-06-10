# Commands Run

This file records the commands used to produce and verify the README demo.

- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `pnpm gen:engagement-sample`
- `node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync("data/engagement-feedback.sample.json","utf8")); console.log(JSON.stringify({schemaVersion:p.schemaVersion, coverage:p.coverage, deals:p.deals.length, firstDeal:p.deals[0].routerDealId, lastDeal:p.deals[p.deals.length-1].routerDealId, commercialSignals:p.deals.reduce((n,d)=>n+(d.commercialSignals?.length||0),0)},null,2));'`
- `SALES_DB_PATH=/tmp/... pnpm db:migrate`
- `SALES_DB_PATH=/tmp/... pnpm import:gtm-handoff -- ../gtm-ops-router/data/sales-handoff.sample.json --out /tmp/sales-handoff-import.json`
- `node assets/demo-video/build-scenes.mjs`
- `NODE_PATH=/tmp/cinematic-video-tools/node_modules node /Users/jinchoi/.codex/skills/cinematic-explainer-videos/scripts/record_card.mjs --input assets/demo-video/scenes/... --out assets/demo-video/clips/... --duration 6000`
- `node /Users/jinchoi/.codex/skills/cinematic-explainer-videos/scripts/assemble_timeline.mjs assets/demo-video/timeline.json`
- `cp assets/demo-video/sales-explainer.mp4 assets/demo.mp4`
- `ffmpeg -y -i assets/demo.mp4 -vf "fps=10,scale=800:-1:flags=lanczos,palettegen=stats_mode=diff" /tmp/sales-demo-palette.png`
- `ffmpeg -y -i assets/demo.mp4 -i /tmp/sales-demo-palette.png -lavfi "fps=10,scale=800:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=2:diff_mode=rectangle" assets/demo.gif`
- `bash /Users/jinchoi/.codex/skills/cinematic-explainer-videos/scripts/extract_review_frames.sh assets/demo.mp4 assets/demo-video/review ...`
- `ffmpeg -y -ss 9.4 -i assets/demo.gif -frames:v 1 assets/demo-video/review/gif-import-frame.png`
- `ffmpeg -y -ss 27.8 -i assets/demo.gif -frames:v 1 assets/demo-video/review/gif-feedback-frame.png`
- `ffmpeg -y -ss 34.5 -i assets/demo.gif -frames:v 1 assets/demo-video/review/gif-proof-frame.png`
- `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -show_entries format=duration,size -of default=nw=1 assets/demo.mp4`
- `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -show_entries format=duration,size -of default=nw=1 assets/demo.gif`
- `curl -sS -H 'Accept: application/vnd.github+json' https://api.github.com/markdown -d '{"mode":"gfm","context":"gorajing/sales","text":"![Sales demo](assets/demo.gif)"}'`
- README stale-media scan found no HD-demo CTA, local mp4 CTA, video embed, or poster-to-mp4 link.

## Final Media Metadata

MP4 (`assets/demo.mp4`):

```text
width=1280
height=720
r_frame_rate=30/1
avg_frame_rate=30/1
duration=40.766667
size=3405358
```

GIF (`assets/demo.gif`):

```text
width=800
height=450
r_frame_rate=10/1
avg_frame_rate=10/1
duration=40.800000
size=11304407
```

GitHub Markdown API rendered `![Sales demo](assets/demo.gif)` as an `<img>` with `data-animated-image`.
