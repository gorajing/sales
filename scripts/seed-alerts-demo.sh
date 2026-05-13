#!/usr/bin/env bash
# Populate the local dev DB with a representative mix of alerts so
# /alerts can be visually inspected end-to-end. Designed for the Phase
# 2 manual checkpoint after the alerts UI shipped.
#
# Usage:
#   1. In one terminal: pnpm dev   (server runs on :3000)
#   2. In another:      ./scripts/seed-alerts-demo.sh
#   3. Open http://localhost:3000/alerts in a browser
#
# This script populates THREE scenarios so the operator can see every
# rendering state of the alert feed:
#
#   A. ACME on-fire — 4 intent signals → 80 score → on_fire tier →
#      fires `tier_promotion` with severity=urgent → BOTH slack+email
#      channels (both fall back to outbox/ since env vars are unset).
#      Will leave alert UNACKNOWLEDGED so the Acknowledge button is
#      visible in the UI.
#
#   B. WIDGETCO warm — 1 intent signal → 20 score → warm tier →
#      fires `tier_promotion` with severity=priority → slack only.
#      This script ACKNOWLEDGES it via the ack endpoint so the
#      operator sees the "Acknowledged by …" rendering.
#
#   C. ENGAGEMENT-CO spike — 3 engagement signals (no scoring rule
#      matches, so score stays 0/cold → no tier_promotion) → fires
#      `engagement_spike` instead. Demonstrates the spike-without-
#      score-change path.

set -euo pipefail

BASE="${BASE:-http://localhost:3000}"

# --- Pre-flight check ------------------------------------------------------

if ! curl -sf "$BASE/" -o /dev/null; then
  echo "ERROR: dev server not reachable at $BASE." >&2
  echo "       Start it with 'pnpm dev' in another terminal." >&2
  exit 1
fi

NOW=$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')

post_signal() {
  curl -sf -X POST "$BASE/api/signals" \
    -H 'Content-Type: application/json' \
    -d "$1"
}

post_recompute() {
  curl -sf -X POST "$BASE/api/scoring/recompute" \
    -H 'Content-Type: application/json' \
    -d "{\"accountId\":\"$1\"}"
}

# ---------------------------------------------------------------------------
# A. ACME → on_fire → urgent alert (will leave unacknowledged)
# ---------------------------------------------------------------------------

echo "=== Scenario A: Acme → on_fire (urgent alert, leave unacknowledged) ==="

for i in 1 2 3 4; do
  post_signal "{
    \"source\": \"intent_data\",
    \"account_domain\": \"acme.example\",
    \"signal_type\": \"intent\",
    \"fact\": \"surge $i\",
    \"source_url\": \"https://bombora.example/event/$i\",
    \"snippet\": \"acme weekly intent surge $i — vector database keywords\",
    \"captured_at\": \"$NOW\"
  }" > /dev/null
done

ACME_ID=$(post_signal "{
  \"source\": \"intent_data\",
  \"account_domain\": \"acme.example\",
  \"signal_type\": \"intent\",
  \"fact\": \"surge 5\",
  \"source_url\": \"https://bombora.example/event/5\",
  \"snippet\": \"acme weekly intent surge 5 — vector database keywords\",
  \"captured_at\": \"$NOW\"
}" | sed 's/.*"accountId":"\([^"]*\)".*/\1/')

ACME_RES=$(post_recompute "$ACME_ID")
echo "Acme: tier=$(echo "$ACME_RES" | sed 's/.*"tier":"\([^"]*\)".*/\1/'), \
score=$(echo "$ACME_RES" | sed 's/.*"score":\([0-9]*\).*/\1/')"

# ---------------------------------------------------------------------------
# B. WidgetCo → warm → priority alert (will acknowledge)
# ---------------------------------------------------------------------------

echo "=== Scenario B: WidgetCo → warm (priority alert, will be acknowledged) ==="

WIDGET_ID=$(post_signal "{
  \"source\": \"intent_data\",
  \"account_domain\": \"widgetco.example\",
  \"signal_type\": \"intent\",
  \"fact\": \"early intent signal\",
  \"source_url\": \"https://bombora.example/widget/1\",
  \"snippet\": \"widgetco evaluating database options — postgres alternative search\",
  \"captured_at\": \"$NOW\"
}" | sed 's/.*"accountId":"\([^"]*\)".*/\1/')

WIDGET_RES=$(post_recompute "$WIDGET_ID")
echo "WidgetCo: tier=$(echo "$WIDGET_RES" | sed 's/.*"tier":"\([^"]*\)".*/\1/'), \
score=$(echo "$WIDGET_RES" | sed 's/.*"score":\([0-9]*\).*/\1/')"

# Extract the alertId from the response and acknowledge it via the API.
WIDGET_ALERT_ID=$(echo "$WIDGET_RES" | sed 's/.*"alertId":"\([^"]*\)".*/\1/')
if [[ "$WIDGET_ALERT_ID" =~ ^al_ ]]; then
  curl -sf -X POST "$BASE/api/alerts/$WIDGET_ALERT_ID/ack" \
    -H 'Content-Type: application/json' \
    -d '{"by":"demo-operator@example.com"}' > /dev/null
  echo "WidgetCo alert $WIDGET_ALERT_ID: acknowledged"
fi

# ---------------------------------------------------------------------------
# C. Engagement spike (cold score, but ≥3 engagement signals)
# ---------------------------------------------------------------------------

echo "=== Scenario C: engagement-co → cold + spike (no tier_promotion) ==="

SPIKE_ID=$(post_signal "{
  \"source\": \"intent_data\",
  \"account_domain\": \"engagement-co.example\",
  \"signal_type\": \"engagement\",
  \"fact\": \"seed engagement signal\",
  \"source_url\": \"https://bombora.example/eng/seed\",
  \"snippet\": \"engagement-co type=email_open subject=hello id=seed\",
  \"captured_at\": \"$NOW\"
}" | sed 's/.*"accountId":"\([^"]*\)".*/\1/')

for i in 1 2; do
  post_signal "{
    \"source\": \"intent_data\",
    \"account_domain\": \"engagement-co.example\",
    \"signal_type\": \"engagement\",
    \"fact\": \"engagement event $i\",
    \"source_url\": \"https://bombora.example/eng/$i\",
    \"snippet\": \"engagement-co type=email_open subject=hello id=$i\",
    \"captured_at\": \"$NOW\"
  }" > /dev/null
done

SPIKE_RES=$(post_recompute "$SPIKE_ID")
echo "engagement-co: tier=$(echo "$SPIKE_RES" | sed 's/.*"tier":"\([^"]*\)".*/\1/'), \
spike=$(echo "$SPIKE_RES" | grep -o 'engagement_spike' | head -1)"

# ---------------------------------------------------------------------------

echo ""
echo "Seed complete. Open these URLs in your browser:"
echo "  $BASE/alerts                          → the alert feed"
echo "  $BASE/inbound                         → top-scored accounts"
echo "  $BASE/accounts/$ACME_ID  → Acme detail page"
echo ""
echo "Use ./scripts/reset-alerts-demo.sh to wipe and re-seed."
