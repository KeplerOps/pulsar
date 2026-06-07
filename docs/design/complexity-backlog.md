# Cognitive-Complexity Backlog

Issue 90 introduced a hard per-function cognitive-complexity gate in
[`biome.json`](../../biome.json):

```jsonc
"linter": {
  "rules": {
    "complexity": {
      "noExcessiveCognitiveComplexity": {
        "level": "error",
        "options": { "maxAllowedComplexity": 15 }
      }
    }
  }
}
```

The threshold value (`15`) is the single canonical declaration. Any
ratchet — lowering the threshold or removing an exemption — happens
in `biome.json`. This document records the offending functions that
existed when the gate landed, with their scores, so the ratchet has a
target list. **`biome.json` is canonical; the score column below is a
snapshot, not a contract.**

## Why the gate

`noExcessiveCognitiveComplexity` is not in Biome's `recommended`
ruleset (Biome 1.9.4). SonarCloud's quality gate is new-code-scoped
and advisory, so it does not backstop the existing tree. Without an
explicit hard gate in Biome, god-functions can land unchecked. This
gate plugs that hole at the `pnpm lint` / pre-commit / CI layer
without expanding the rest of Biome's ruleset.

The threshold of 15 matches Biome's default and SonarCloud's default
cognitive-complexity ceiling. Threshold ratchets should lower the
number as the backlog shrinks; never raise it.

## Backlog (snapshot at issue 90)

Each entry below is an existing function that exceeded the threshold
when the gate landed and was carved out with a site-level
`// biome-ignore lint/complexity/noExcessiveCognitiveComplexity:
<reason>` suppression pointing back at this document. New code in the
same files is still gated — the suppression covers exactly one
function per site.

### Production source

| File | Symbol | Score |
|------|--------|-------|
| [`src/runtime/asset-preloader.ts`](../../src/runtime/asset-preloader.ts) | returned async `(scene) => ...` arrow inside `createAssetPreloader` | 16 |

The three `src/runtime/audio.ts` offenders — `async unlock()` (22),
`normalizeSources` (17), and `play(soundId, options)` (24) — were
removed when the audio engine was slimmed: `unlock()` delegates to the
`unlockHtml5Fallback` / `resumeWebAudioContext` module helpers, the
per-URL validation lives in the hoisted `normalizeAudioUrl`, and
`play()` delegates option validation to `validatePlay` and engine
output to `applyPlayToHandle`. Their site-level suppressions were
deleted with them.

`runLifecycle` (formerly score 21) was removed from this list when the
per-mode runner hints (`repeat` / `hold` / `cueGate` / `screenshot`)
collapsed from four `mode === X` ternaries into a single
`...runnerHints` spread sourced from
[`src/runtime/mode-profile.ts`](../../src/runtime/mode-profile.ts). Its
site-level suppression was deleted with it.

`buildLoad` (score 18) and `runTarget` (score 23) were removed when the
scene loader was decomposed into cohesive single-responsibility units:
per-navigation audio/presenter/ctx construction moved to
[`src/runtime/scene-loader-ctx.ts`](../../src/runtime/scene-loader-ctx.ts),
the unlock-gate predicate and chrome dispatch policy to
[`src/runtime/scene-loader-guard.ts`](../../src/runtime/scene-loader-guard.ts),
and the `beat` / `mode` grammar re-check unified onto the shared
`NAVIGATION_GRAMMAR` source in
[`src/runtime/navigation.ts`](../../src/runtime/navigation.ts). Both
site-level suppressions were deleted with them.

### Test fixtures and helpers

This test offender is an isolated function, not part of the
policy-scanner cluster, and is not covered by the file-level
overrides below. It gets a site-level suppression like the production
source above. It is listed here so the ratchet has the same
target/score record for it. (The `scene-loader.helpers.ts` `asTimeline`
and `scene-loader-present.test.ts` `mountPresent` offenders were removed
with the master-timeline scene-loader test suite under ADR-032.)

| File | Symbol | Score |
|------|--------|-------|
| [`tests/scenes/dom-css-accessibility-fixture.test.ts`](../../tests/scenes/dom-css-accessibility-fixture.test.ts) | recursive `walk` accessibility-attribute scan | 20 |

## File-level overrides (no ratchet target)

`biome.json` carries one `overrides` entry that disables the rule for
the policy-scanner cluster — files whose entire purpose is structural
multi-clause traversal of the codebase under `tests/runtime/`:

- `tests/runtime/policy-*.test.ts`
- `tests/runtime/source-policy.ts`
- `tests/runtime/screenshot-determinism-source.test.ts`

These files are deliberately exempted at the file level rather than
the site level. Their complexity is intrinsic to the audit shape they
implement and a refactor that drops them below 15 would obscure the
structural predicates the audits exist to enforce. They are not
listed in the ratchet target tables above — they are not ratchet
targets at all, by design. The override allowlist is enforced by
`tests/runtime/policy-biome-complexity-gate.test.ts` so the cluster
cannot be quietly widened.

This policy-scanner cluster (`policy-*.test.ts`, `source-policy.ts`,
`screenshot-determinism-source.test.ts`) does **not** run in the
default behavior suite (`pnpm test`). It is a separate, still-blocking
gate run via `pnpm policy` (`vitest.policy.config.ts`), wired into both
CI (the `policy` job) and the `policy` pre-commit hook. Its whole-tree
AST scans starved under the behavior suite's parallel load and
intermittently timed out, so the gate was relocated — the enforcement
set is unchanged. The Biome override above stays regardless of where
the suite runs; `biome.json` remains the canonical complexity-gate
declaration.

## Ratchet plan

The intent of the gate is to lower `maxAllowedComplexity` as the
backlog shrinks. A reasonable ordering:

1. Refactor the lowest-score offender (`asset-preloader.ts`, score
   16) first. Lower `maxAllowedComplexity` to 14 once it is removed
   from the table.
2. Continue function-by-function. Every removed suppression should be
   accompanied by a delete of the corresponding row in this file and,
   when it is the last suppression in a file, a check that no new
   offender has crept in.
3. When the table is empty, drop `maxAllowedComplexity` to the
   highest score among any new in-flight offenders (or to 10, the
   value most repos use once the legacy backlog is clear). Update
   this document to reflect the new threshold and target list.

Do not bypass the ratchet by raising the threshold, adding a
file-level override over `src/`, or moving offenders into ignored
paths. Those are the failure modes the
[issue-090 preflight](issue-090-complexity-gate-preflight.md)
explicitly rejects.
