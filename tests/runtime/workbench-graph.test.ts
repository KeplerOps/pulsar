// PUL-P002 — validation runs in CI on every pull request.
//
// `validateRuntime` (PUL-F028) already executes during workbench
// bootstrap (`src/main.ts`), but Vite's build step does not run the
// bootstrap — CI never sees those findings. This test is the CI gate:
// it runs the canonical PUL-F028 pass over the *same* scene and
// composition declarations the workbench is wired to, so any
// structural breakage introduced by a future scene or composition
// fails CI before merge.
//
// The single source of truth for the registered graph is
// `src/workbench-graph.ts` (the composition-root layer next to
// `main.ts`, NOT under `src/runtime/`); both this test and
// `src/main.ts` import from it. A scene that is added to the registry
// path without being added here would also be invisible to the
// bootstrap validation (codex preflight: "preserve the single-source
// property").
//
// The second `describe` block injects a deliberately-broken scene next
// to the real graph and confirms the validator still surfaces
// findings — proves the gate fails loudly on broken input, satisfying
// PUL-P002's "CI MUST fail when validation reports any error" clause
// structurally rather than by trusting reviewers to notice.

import { describe, expect, it } from 'vitest';
import { validateRuntime } from '../../src/runtime/validation';
import { WORKBENCH_COMPOSITIONS, WORKBENCH_SCENES } from '../../src/workbench-graph';

describe('workbench graph validation (PUL-P002)', () => {
  it('reports zero findings against the registered scenes and compositions', () => {
    const findings = validateRuntime({
      scenes: WORKBENCH_SCENES,
      compositions: WORKBENCH_COMPOSITIONS,
    });
    // Empty array = clean graph. A non-empty array is a CI failure:
    // print every finding so the build log identifies the offender.
    if (findings.length > 0) {
      const detail = findings.map((f) => `[${f.code}] ${f.message}`).join('\n');
      throw new Error(`workbench graph validation failed:\n${detail}`);
    }
    expect(findings).toEqual([]);
  });

  it('surfaces findings when a malformed scene is appended to the registered graph', () => {
    // Defensive proof: the gate is the validator's output, not a
    // hard-coded length check. If a future refactor accidentally
    // suppresses findings (e.g. by passing the wrong inputs, by
    // catching exceptions, or by mocking the validator), this stanza
    // surfaces the regression in the SAME job. The broken scene
    // omits `cleanup` (clause d) so the finding is a stable
    // `scene-schema-invalid` whose message names cleanup.
    const broken: Record<string, unknown> = {
      id: 'broken-cleanup-fixture',
      title: 'Broken cleanup fixture',
      duration: 0,
      tags: [],
      assets: [],
      captions: [],
      audio: [],
      defaultNext: null,
      standalone: false,
      trailerSafe: false,
      create: () => undefined,
      timeline: () => undefined,
      // No `cleanup` — assertSceneModule rejects this.
    };
    // The validator's input is `Iterable<unknown>` so we widen the
    // composed array at this boundary rather than casting the broken
    // record into a SceneModule shape it does not satisfy.
    const scenes: readonly unknown[] = [...WORKBENCH_SCENES, broken];
    const findings = validateRuntime({
      scenes,
      compositions: WORKBENCH_COMPOSITIONS,
    });
    expect(findings.map((f) => f.code)).toContain('scene-schema-invalid');
    const offender = findings.find((f) => f.sceneId === 'broken-cleanup-fixture');
    expect(offender).toBeDefined();
    expect(offender?.message).toMatch(/cleanup/);
  });
});
