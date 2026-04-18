#!/usr/bin/env bash
# Fake `claude` CLI for tests. Reads stdin, ignores it, and emits a fixture
# whose path is specified via FAKE_CLAUDE_FIXTURE env var.
set -e
if [ -z "$FAKE_CLAUDE_FIXTURE" ]; then
  echo "FAKE_CLAUDE_FIXTURE not set" >&2
  exit 2
fi
cat >/dev/null
cat "$FAKE_CLAUDE_FIXTURE"
