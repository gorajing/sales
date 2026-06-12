# Commands Run

This file records the commands used to produce and verify the README demo.

## Proof

```bash
SALES_DB_PATH="$DB_PATH" pnpm db:migrate
SALES_DB_PATH="$DB_PATH" pnpm import:gtm-handoff -- ../gtm-ops-router/data/sales-handoff.sample.json --out assets/demo-video/proof/02-import-result.json
pnpm gen:engagement-sample
pnpm test
pnpm typecheck
pnpm build
```

Observed proof files:

- `assets/demo-video/proof/03-db-counts.json`: 6 accounts, 6 contacts, 6 handoff imports, 0 evidence rows.
- `assets/demo-video/proof/05-engagement-summary.json`: schema `sales.engagement-feedback.v1`, coverage `complete:false`, `scanned:9`, `emitted:4`, `commercialSignals:1`.
- `assets/demo-video/proof/06-test.txt`: 26 test files and 141 tests passed.
- `assets/demo-video/proof/07-typecheck.txt`: `tsc --noEmit` exited 0.
- `assets/demo-video/proof/08-build.txt`: Next build compiled successfully with one Turbopack NFT-list warning in the trace through `lib/claude/run.ts`.

## Render

```bash
node assets/demo-video/build-scenes.mjs
NODE_PATH=/tmp/cinematic-video-tools/node_modules node /Users/jinchoi/.codex/skills/cinematic-explainer-videos/scripts/record_card.mjs --input assets/demo-video/scenes/film.html --out assets/demo-video/clips/film.mp4 --duration 38000 --width 1280 --height 720 --fps 30
node /Users/jinchoi/.codex/skills/cinematic-explainer-videos/scripts/assemble_timeline.mjs assets/demo-video/timeline.json
bash /Users/jinchoi/.codex/skills/cinematic-explainer-videos/scripts/extract_review_frames.sh assets/demo.mp4 assets/demo-video/review 1.0:intro-start 4.6:intro 7.4:bridge 10.8:import 15.8:boundary 21.8:draft 27.0:critics 29.5:feedback 36.0:close
```

## README GIF

```bash
ffmpeg -y -i assets/demo.mp4 -vf "fps=12,scale=900:-1:flags=lanczos,palettegen=stats_mode=diff" /tmp/sales-demo-palette.png
ffmpeg -y -i assets/demo.mp4 -i /tmp/sales-demo-palette.png -filter_complex "fps=12,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=2:diff_mode=rectangle" assets/demo.gif
ffmpeg -y -ss 10.8 -i assets/demo.gif -frames:v 1 assets/demo-video/review/gif-import-frame.png
ffmpeg -y -ss 29.5 -i assets/demo.gif -frames:v 1 assets/demo-video/review/gif-feedback-frame.png
ffmpeg -y -ss 36.0 -i assets/demo.gif -frames:v 1 assets/demo-video/review/gif-proof-frame.png
```

README remains `![Sales demo](assets/demo.gif)`.

## Final Media Metadata

MP4 (`assets/demo.mp4`):

```text
width=1280
height=720
r_frame_rate=30/1
avg_frame_rate=30/1
duration=38.000000
size=2102779
```

GIF (`assets/demo.gif`):

```text
width=900
height=506
r_frame_rate=12/1
avg_frame_rate=25/2
duration=38.000000
size=11700398
```
