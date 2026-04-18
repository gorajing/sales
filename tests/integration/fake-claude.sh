#!/usr/bin/env bash
# Fake `claude` CLI for tests.
# Mode A (default): cat $FAKE_CLAUDE_FIXTURE to stdout (JSON envelope), exit 0.
# Mode B: if $FAKE_CLAUDE_FAIL=1, emit $FAKE_CLAUDE_STDERR to stderr and exit $FAKE_CLAUDE_EXIT (default 1).
set -e
cat >/dev/null
if [ "$FAKE_CLAUDE_FAIL" = "1" ]; then
  echo "${FAKE_CLAUDE_STDERR:-error}" >&2
  exit "${FAKE_CLAUDE_EXIT:-1}"
fi
if [ -z "$FAKE_CLAUDE_FIXTURE" ]; then
  echo "FAKE_CLAUDE_FIXTURE not set" >&2
  exit 2
fi
cat "$FAKE_CLAUDE_FIXTURE"
