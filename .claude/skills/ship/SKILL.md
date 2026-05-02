---
name: ship
description: Ship current branch — CI, SonarCloud, test quality review, fix all issues. Assumes code is already committed and pushed.
disable-model-invocation: true
---

# Ship Current Branch

Assumes code is already committed and pushed. Handles: PR creation, CI monitoring, SonarCloud, test quality review, fixing all issues.

This skill omits the end-of-flow Codex cross-model review.

**IMPORTANT:** NEVER include Co-Authored-By, "Generated with Claude Code", or any Claude/AI attribution in commit messages, PR descriptions, or any other artifacts.

## Phase 0: Read Repo Workflow Config

If you are running `/ship` directly (not as part of an earlier `/implement` session), call the `gc_get_repo_ground_control_context` MCP tool with the absolute repo path to load the repo's workflow config. If running after `/implement`, reuse the config already cached in that session.

Cache the following fields for use below:
- `sonarcloud.project_key` and `sonarcloud.organization` — used by Phase 3. If the whole `sonarcloud` block is null, Phase 3 is skipped entirely.

If the tool does NOT return `status: "ok"`, stop and ask the user to create `.ground-control.yaml` at the repo root (include the `suggested_ground_control_yaml` from the tool response).

## Phase 1: Create PR

1. Determine the current branch: `git branch --show-current`
2. Check if a PR already exists: `gh pr list --head <branch> --json number,url`
3. If no PR exists, create one:
   ```
   gh pr create --base dev --title "<concise title>" --body "<description>"
   ```
4. Note the PR number.

## Phase 2: CI Monitor

`gh run watch` blocks indefinitely if no runner picks up the job. Use a bounded poll instead.

1. Find the latest workflow run: `gh run list --branch <branch> --limit 1 --json status,conclusion,databaseId,createdAt`. Cache the `databaseId` as `<id>`.
2. **Poll** `gh run view <id> --json status,conclusion` every 15 seconds.
3. **Queued-too-long guard.** If `status` is still `"queued"` after **5 minutes**, STOP and report.
4. **In-progress cap.** Wall-clock cap including the queued window is **45 minutes**.
5. When `status` becomes `"completed"`:
   - If `conclusion` is `"success"`, proceed.
   - Otherwise, get failed logs: `gh run view <id> --log-failed`. Diagnose, fix, `git add`, `git commit`, `git push`, and go back to step 1 of this phase.

## Phase 3: SonarCloud Check

**Skip this entire phase if `sonarcloud` was null in the Phase 0 config.** Log "SonarCloud skipped — no sonarcloud block in .ground-control.yaml" and proceed to Phase 4.

Otherwise:
1. Wait 60 seconds for SonarCloud analysis to propagate.
2. Use `get_project_quality_gate_status` with the `sonarcloud.project_key` cached in Phase 0 to check the quality gate.
3. Use `search_sonar_issues_in_projects` with the same key to find new issues on the current branch. If unavailable, use the REST API directly with `$SONAR_TOKEN`.
4. Repeat the same query with `types=SECURITY_HOTSPOT` via `api/hotspots/search` so security hotspots are not missed.
5. If issues found:
   - Fix them.
   - `git add`, `git commit`, `git push`.
   - Re-run Phase 2.
6. **Cycle cap: 5 iterations.** If still non-empty after 5 cycles, STOP and escalate.
7. If clean, proceed.

## Review loop rules (apply to the review phase below)

The test quality review phase below follows this **loop**:

1. **Invoke the review.**
2. **Read the FULL output.** Do not stop after the first few findings.
3. **Fix ALL issues the reviewer identifies — blocking or not, severity-rated or not, "nitpick" or not.** There is no triage bucket.
4. **If you cannot or believe you should not fix a specific finding**, you MUST stop and ask the user for explicit permission. Resume only after they explicitly confirm.
5. **Re-run the SAME review after fixing.**
6. **Repeat until the reviewer reports zero findings, OR the cycle cap is hit.**
7. **Cycle cap: 5 iterations.** If still reporting findings after 5 cycles, STOP and escalate.

For every cycle, after applying fixes, commit and push BEFORE re-running the review so the reviewer sees the updated tree. Format every fix commit as `Fix review findings (review-tests, cycle <N>)`.

## Phase 4: Test Quality Review

**CRITICAL: You MUST use the Skill tool to invoke the review-tests skill.**

1. Call the Skill tool with `skill="review-tests"` to invoke the test quality review.
2. Apply the **Review loop rules** above: fix every finding, ask user permission for anything you will not fix (warnings included — there is no triage bucket), re-invoke `skill="review-tests"` after each fix cycle, cap at 5 cycles.

## Phase 5: Final CI re-verification

After Phase 4 has reported zero findings (or you have documented user-approved exceptions):

1. Verify the branch is pushed with the latest fix commits.
2. Re-run Phase 2 (CI Monitor) to confirm CI is still green after the review fixes.
3. Re-run Phase 3 (SonarCloud) — or skip again if `sonarcloud` was null.
4. If either re-check fails, loop back through Phase 4 — the cycle cap (5) applies per phase, not total.

## Phase 6: Report (DO NOT MERGE)

**You MUST NOT merge the PR. You MUST NOT run `gh pr merge`. The user reviews and merges.**

- Summary of all changes made during the ship process
- Test quality review findings and fixes
- Confirmation: CI green, SonarCloud passed (or skipped if not configured), PR ready for user review
- PR URL
