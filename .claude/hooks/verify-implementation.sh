#!/usr/bin/env bash
# Stop hook: blocks Claude from finishing if implementation checklist is incomplete.
# Only enforces when /implement was invoked in THIS session (scoped by $PPID).
#
# Universal check: a towncrier changelog fragment under changelog.d/ must be
# present when src/ changes (see changelog.d/README.md and .gc/plan-rules.md).
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

# Check 1: a towncrier changelog fragment must accompany src/ changes.
# The repo migrated to towncrier — the signal is a fragment under
# changelog.d/, NOT a direct CHANGELOG.md edit (.gc/plan-rules.md and
# changelog.d/README.md forbid hand-editing CHANGELOG.md outside release
# collation). Only src/ changes can ship user-visible behavior; docs,
# tests, CI, and meta paths never require a fragment.
SOURCE_CHANGED=$(echo "$CHANGED" | grep -c '^src/' || true)
HAS_FRAGMENT=$(echo "$CHANGED" | grep -Ec '^changelog\.d/.+\.(security|removed|deprecated|added|changed|fixed)\.md$' || true)
if [ "$SOURCE_CHANGED" -gt 0 ] && [ "$HAS_FRAGMENT" -eq 0 ]; then
  REASONS="${REASONS}src/ changed but no changelog.d/ fragment was added. If this PR changes user-visible behavior, add a fragment under changelog.d/<issue-or-pr>.<type>.md (type: security|removed|deprecated|added|changed|fixed; see changelog.d/README.md). If the change is behavior-preserving (comment-only, internal refactor), no fragment is required. "
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
