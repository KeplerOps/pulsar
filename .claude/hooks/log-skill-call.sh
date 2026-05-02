#!/usr/bin/env bash
# PostToolUse hook: logs Skill tool invocations to a per-session log file.
# The Stop hook (verify-implementation.sh) checks this log to confirm
# that /implement was invoked in this session.
# Scoped by $PPID (Claude Code process ID) so concurrent sessions don't interfere.

INPUT=$(cat)
SKILL_NAME=$(echo "$INPUT" | jq -r '.tool_input.skill // empty')

if [ -z "$SKILL_NAME" ]; then
  exit 0
fi

LOG_DIR="/tmp/claude-skill-log"
mkdir -p "$LOG_DIR"

# Prune stale log files from dead sessions (older than 24h)
find "$LOG_DIR" -name "*.jsonl" -mtime +1 -delete 2>/dev/null || true

LOG_FILE="$LOG_DIR/${PPID}.jsonl"

echo "{\"skill\":\"$SKILL_NAME\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >> "$LOG_FILE"
exit 0
