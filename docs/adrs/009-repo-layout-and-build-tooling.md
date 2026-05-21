# ADR-009: Repo Layout and Build Tooling

## Status

Accepted

## Date

2026-05-03

## Context

ADRs 001–008 fix Pulsar's runtime architecture (custom runtime, scene
registry, GSAP timelines, Howler audio, DOM/CSS surface, Remotion
exporter, browser workbench, agent-native authoring) but pin nothing
about toolchain: language, module format, package manager, test
runner, build tool, lint/format chain, Node version, or directory
layout. Until those land, the runtime has nowhere to live: scene
modules cannot be authored, validation cannot run, the live runtime
cannot start, and no requirement that depends on shipping code
(PUL-F001 onward) can transition to ACTIVE.

`PUL-P003` requires architecture decisions to be recorded as ADRs.
`PUL-P002` requires validation to run in CI on every pull request. The
`/implement` workflow requires populated `workflow.*` commands in
`.ground-control.yaml` and a working completion gate. The CI workflow
file (`.github/workflows/ci.yml`) currently runs
`echo "TODO — add … when tech stack is chosen"`.

This ADR makes the toolchain choice explicit. It does not introduce
any new architectural commitment beyond what 001–008 already require;
it ratifies the smallest concrete toolchain that satisfies them.

## Decision

Pulsar uses the following toolchain:

| Concern | Choice |
|---|---|
| Language | TypeScript (strict) |
| Module format | ESM |
| Package manager | pnpm |
| Build tool | Vite |
| Test runner (unit) | Vitest |
| Test runner (E2E / screenshot regression) | Playwright (added when scenes exist; not required for the runtime core) |
| Linter / formatter | Biome |
| Node | 22 LTS, pinned via `.nvmrc` and `package.json` `engines` |
| Repo topology | Single repo, single package |

### Directory layout

```
src/runtime/         scene registry, lifecycle, mode dispatch
src/scenes/          scene modules
src/compositions/    composition manifests
tests/               mirror of src/ for Vitest
assets/              static asset inventory
```

`docs/`, `.gc/`, `.claude/`, `.github/`, `.ground-control.yaml`, etc.
remain at repo root as already established.

### Workspaces

Single-package now. Promote to pnpm workspaces when the Remotion
exporter (per ADR-006) lands: `PUL-A004` mandates the exporter live in
a separate codebase, but a separate codebase does not require a
separate git repo — workspaces satisfy the constraint without the
overhead of a second repo.

### Library encapsulation

GSAP and Howler enter the dependency tree via the runtime context
(ADR-003 / `PUL-A001`, ADR-004 / `PUL-A002`). Scene modules import
them indirectly through `ctx`. The runtime core does not import
PixiJS, Three.js, Phaser, Remotion, or slide-framework primitives
(`PUL-A003`, `PUL-A004`, `PUL-A006`).

### Workflow command surface

`.ground-control.yaml` workflow commands map to package scripts:

| Field | Command |
|---|---|
| `workflow.lint_command` | `pnpm lint` |
| `workflow.format_command` | `pnpm format` |
| `workflow.test_command` | `pnpm test` |
| `workflow.completion_command` | `pnpm lint && pnpm typecheck && pnpm test` |

CI runs the same scripts. The `completion_command` is the gate the
`/implement` skill exercises before declaring a change ready.

## Consequences

### Positive

- Types as documentation, satisfying ADR-008's structural-legibility
  commitment without separate doc surfaces.
- One tool for lint and format (Biome) — less config and ceremony
  than ESLint + Prettier.
- ESM-native runtime, build, and test paths — no CJS/ESM split.
- One package today; no workspace overhead until the exporter forces
  it.
- All four `workflow.*` commands map to `pnpm <script>` invocations,
  so `.ground-control.yaml` and CI share vocabulary.

### Negative

- Biome is younger than ESLint + Prettier; some lint rules and editor
  integrations are less mature.
- Adding the Remotion exporter later requires migrating to pnpm
  workspaces — one mechanical migration, not a recurring cost.
- TypeScript strictness adds a typecheck step before any new scene
  compiles; authors and agents must keep type annotations valid.

### Risks

| Risk | Mitigation |
|------|-----------|
| Biome hits a rule or plugin wall | Swap to ESLint + Prettier in a single PR; the package scripts are the contract, not the tool. |
| Vitest browser-mode coverage is insufficient for runtime work | Add Playwright as a parallel test runner (already planned for screenshot regression per ADR-008 #8). |
| pnpm workspaces is incompatible with a future tool | Single-package today defers the decision; npm or yarn workspaces remain options. |
| TypeScript types drift from runtime behavior | The runtime ships a structural validator (per ADR-008 #7); types and validator must agree, or the validator is the source of truth. |

## Related ADRs

- [ADR-001](001-custom-experience-runtime.md) — runtime is custom and
  framework-agnostic; toolchain stays light.
- [ADR-002](002-scene-registry-and-compositions.md) — scenes are
  modules with metadata; ESM + TypeScript matches the contract.
- [ADR-003](003-gsap-timeline-engine.md) — GSAP via `ctx.gsap`;
  bundled by Vite, no direct scene import.
- [ADR-004](004-howler-audio-engine.md) — Howler via `ctx.audio`;
  same pattern.
- [ADR-005](005-dom-css-default-rendering-surface.md) — DOM/CSS
  default surface; Vite renders, no canvas/WebGL toolchain in core.
- [ADR-006](006-remotion-export-path.md) — Remotion exporter is a
  separate codebase; the deferred workspaces topology decision lives
  here.
- [ADR-007](007-browser-workbench.md) — workbench URL grammar; Vite
  dev server is the workbench host.
- [ADR-008](008-agent-native-authoring.md) — agent-native authoring;
  TypeScript types and pnpm scripts serve this directly.
