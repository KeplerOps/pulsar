#!/usr/bin/env python3
"""
Git Merge Guard Hook (PreToolUse)

Blocks git merge, git push --force, and git reset --hard operations.
Claude may commit and push, but must never merge or force-push.

Exit codes:
  0 = allow command
  2 = block command (shows error to user)
"""
import json
import sys

data = json.load(sys.stdin)
command = data.get("tool_input", {}).get("command", "")

blocked = [
    "git merge",
    "git push --force",
    "git push -f",
    "git reset --hard",
    "gh pr merge",
]

for cmd in blocked:
    if cmd in command:
        print(
            f"ERROR: Claude may not run '{cmd}'. The user handles all merges.",
            file=sys.stderr,
        )
        sys.exit(2)

sys.exit(0)
