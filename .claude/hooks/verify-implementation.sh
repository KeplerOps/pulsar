#!/usr/bin/env bash
# Stop hook: blocks Claude from finishing if implementation checklist is incomplete.
# Only enforces when /implement was invoked in THIS session (scoped by $PPID).
#
# Universal check: CHANGELOG.md must be in the diff when source files changed.
# /implement owns its own review gate via /review-tests; no codex review here.

set -euo pipefail

INPUT=$(cat)

# Don't loop — if we're already in a stop-hook retry, let it through
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

# Only enforce if /implement was invoked in this session
SKILL_LOG="/tmp/claude-skill-log/${PPID}.jsonl"
if [ ! -f "$SKILL_LOG" ]; then
  exit 0
fi

HAS_IMPLEMENT=$(grep -c '"skill":"implement"' "$SKILL_LOG" || true)
if [ "$HAS_IMPLEMENT" -eq 0 ]; then
  exit 0
fi

# Find repo root (no hardcoded paths)
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
if [ -z "$REPO_ROOT" ]; then
  exit 0
fi
cd "$REPO_ROOT"

# Determine base branch (dev if it exists, otherwise main)
if git rev-parse --verify origin/dev >/dev/null 2>&1; then
  BASE="origin/dev"
else
  BASE="origin/main"
fi

# Only check if there are changes against base
CHANGED=$(git diff --name-only "${BASE}...HEAD" 2>/dev/null || echo "")
if [ -z "$CHANGED" ]; then
  exit 0
fi

REASONS=""

# Check 1: CHANGELOG.md must be in the diff if source files changed
HAS_CHANGELOG=$(echo "$CHANGED" | grep -c 'CHANGELOG.md' || true)
if [ "$HAS_CHANGELOG" -eq 0 ]; then
  REASONS="${REASONS}CHANGELOG.md was not updated despite source code changes. "
fi

# Run project-specific checks if they exist
EXTRA_CHECKS="$REPO_ROOT/.claude/hooks/verify-extra.sh"
if [ -f "$EXTRA_CHECKS" ]; then
  EXTRA_REASONS=$(CHANGED="$CHANGED" bash "$EXTRA_CHECKS" || true)
  if [ -n "$EXTRA_REASONS" ]; then
    REASONS="${REASONS}${EXTRA_REASONS}"
  fi
fi

if [ -n "$REASONS" ]; then
  jq -n --arg reason "$REASONS" '{"decision": "block", "reason": $reason}'
  exit 0
fi

# All checks passed
exit 0
