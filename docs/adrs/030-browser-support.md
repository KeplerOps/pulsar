# ADR-030: Browser Support Contract

## Status

Accepted

## Date

2026-05-13

## Context

PUL-Q002 declares the runtime's browser support floor:

> The runtime SHALL function in the latest stable releases of
> Chromium-based browsers, Firefox, and WebKit-based browsers as of
> the project release.

The requirement is non-functional and release-time: "latest stable as
of the project release" is a moving target that resolves at the
moment a tagged version is cut. The runtime's existing surfaces — the
ADR-007 workbench URL grammar, the ADR-002 scene and composition
contracts, ADR-003's GSAP timeline engine, ADR-004's Howler audio
service, the validation pass, the navigation parser, the error
envelope — are all framework-agnostic ESM that targets `es2022` via
Vite (ADR-009). Nothing in the runtime hard-codes a browser version,
sniffs a user-agent string, or branches on engine identity.

The remaining gap is enforcement. Without an automated gate, three
failure modes are equally likely:

1. A future contributor introduces a runtime API that works in
   Chromium and Firefox but not in WebKit (or vice versa), and the
   regression ships because no test ever boots the runtime in those
   engines.
2. A dependency upgrade flips an internal API path that breaks one
   engine.
3. A scene author bypasses the ADR-007 / ADR-004 / ADR-003 contracts
   with engine-specific code, drifting the runtime away from cross-
   engine parity.

Per the preflight (`docs/design/pul-q002-browser-support-preflight.md`),
the chosen seam is Playwright — ADR-009 already names it as the
browser-execution runner — exercising the production-build artifact
(`pnpm preview`) under the bundled Chromium, Firefox, and WebKit
engines. The preflight is explicit that the gate must be blocking,
not advisory, and that compatibility targets stay in Vite-consumed
config rather than scattering through runtime modules.

## Decision

PUL-Q002 is enforced by two complementary controls, recorded here so
the contract is durable across contributors and releases.

### Engine coverage

The supported engine set is:

- **Chromium-based browsers** — proxied by Playwright's bundled
  Chromium engine in the `chromium` Playwright project. This covers
  Chrome, Edge, Opera, Arc, Brave, and other Chromium consumers
  whose web-platform behavior is governed by the upstream Chromium
  release.
- **Firefox** — proxied by Playwright's bundled Firefox engine in
  the `firefox` Playwright project.
- **WebKit-based browsers** — proxied by Playwright's bundled
  WebKit engine in the `webkit` Playwright project. This covers
  Safari (macOS / iOS) and other WebKit consumers; per the
  preflight, Playwright's bundled WebKit is a useful automated
  proxy, not a substitute for every Safari embedding on every
  OS release.

Real Chrome, Edge, Safari Technology Preview, or OS-specific
channels can be added as additional Playwright projects without
touching the runtime. The project matrix is the extensibility seam.

### Refresh cadence ("as of the project release")

"Latest stable" is encoded by the `@playwright/test` minor version
pinned in `package.json`. Playwright's release cadence tracks the
upstream engine releases — a Playwright minor bump pulls forward the
bundled Chromium, Firefox, and WebKit. The release-time refresh
process for PUL-Q002 is therefore:

1. Cut a dependency-update PR that bumps `@playwright/test`'s caret
   range (and the lockfile).
2. Re-run the CI `browser-support` job; if it passes, the new
   engines are accepted as the supported floor.
3. Tag the release.

No browser version numbers appear in `src/`. No `browserslist`, no
`caniuse-lite` script, no Babel, no polyfills.

### Structural enforcement

Two gates, both blocking, both running on every pull request and
every push to `main` / `dev`:

1. **`browser-support` CI job** (`.github/workflows/ci.yml`) — installs
   `@playwright/test` and the bundled engines (`playwright install
   --with-deps chromium firefox webkit`), runs `pnpm test:browsers`,
   uploads the HTML report on failure. The job is part of the
   required status checks alongside `test`, `typecheck`, and `build`.
   The spec at `tests-e2e/browser-support.spec.ts` runs two
   end-to-end scenarios in every engine project:
   - **shell coverage** — boots `?scene=placeholder&mode=paused`,
     asserts `#stage` mounts, asserts the PUL-F028 validation pass
     succeeded (no `data-pulsar-validation-failed`), asserts the URL
     parser accepted the URL (no `data-pulsar-navigation-error`),
     and asserts `data-pulsar-scene-lifecycle="timeline"` is reached
     with the master timeline held at first frame.
   - **runtime-behavior coverage** — boots
     `?scene=browser-support-fixture&mode=loop`, which addresses the
     fixture scene at `src/scenes/browser-support-fixture.ts`. The
     fixture mounts a DOM element through `create(ctx)`, runs a real
     GSAP timeline through `ctx.gsap` that advances the element's
     `data-pulsar-fixture-state` from `"mounted"` to `"ran"` at the
     tween's end, and removes the element on `cleanup(ctx)`.
     `mode=loop` (ADR-018) restarts the master timeline on
     completion, so the state stays `"ran"` durably and the
     assertion is race-free. The spec asserts the state reaches
     `"ran"` (proving the GSAP timeline engine functions in this
     engine) and that the resolver mounted the addressed scene
     (`data-pulsar-scene-target="browser-support-fixture"`). Without
     this scenario the gate would only prove the workbench shell
     mounts; a WebKit-only regression in the GSAP timeline engine
     (ADR-003) or the composition resolver's mount path would ship
     undetected (codex pre-push review, cycle 1). Cleanup itself is
     exercised by the fixture and placeholder unit tests; the gate's
     job here is to prove the GSAP timeline runs end-to-end in every
     engine, not to re-verify cleanup hooks already covered by unit
     tests.

2. **Source-policy gate** (`tests/runtime/policy-q002-browser-support.test.ts`)
   — a Vitest structural test that the gate exists. It asserts
   `playwright.config.ts` declares all three engine projects, the
   spec file imports from `@playwright/test`, `package.json` declares
   the `@playwright/test` dev dependency and the `test:browsers`
   script, and the CI workflow's `browser-support` job declares
   active steps that run `pnpm test:browsers` and
   `playwright install`. The workflow check parses the YAML
   structure and resolves the job by name rather than matching
   whole-file text, so commented-out steps, prose, and
   `if: false`-disabled jobs do not satisfy the assertion (codex
   pre-push review, cycle 1, class finding). Defense in depth:
   silently disabling the CI job, removing the spec, or unpinning
   Playwright surfaces as a failed `pnpm test`, not as a green-but-
   broken CI.

### Boundaries

- Compatibility targets stay in `vite.config.ts` (`build.target:
  'es2022'`). Runtime modules do not branch on engine identity, do
  not sniff `navigator.userAgent` / `navigator.vendor`, do not adopt
  per-engine feature flags. If a future, observed, narrowly scoped
  incompatibility forces a feature detection, the workaround lives
  beside a regression test added under this gate — the gate's CI
  failure is what proves the workaround was needed.
- The workbench URL grammar (ADR-007) is unchanged. No `browser=`,
  no `engine=`, no compatibility mode.
- Scene metadata, composition manifests, asset policy, audio service
  contract, timeline engine, presenter controls — all unchanged.
- The browser job does not add any new repository secret, expand
  token permissions beyond `contents: read`, or introduce telemetry
  / analytics / persistent browser logs.

## Consequences

### Positive

- PUL-Q002 transitions from a documented promise to a structurally
  enforced contract. A regression that breaks any of the three engine
  families fails CI before the merge button is reachable.
- One automated source of truth for "latest stable" — the pinned
  Playwright minor. Release-time updates are a single dependency
  bump, not a manual matrix re-derivation.
- Defense-in-depth: silently removing the CI job is caught by the
  Vitest source-policy gate, and silently breaking the smoke spec is
  caught by the CI job. Both must be intentionally deleted to bypass
  PUL-Q002.
- The seam (Playwright project matrix + `tests-e2e/` directory)
  extends to per-mode coverage and screenshot regression without
  re-architecting the gate.

### Negative

- The `browser-support` job adds an additional CI slot. Bundle of
  Playwright + browser binaries plus the production build adds
  several minutes of wall-clock to PR feedback.
- The Playwright bundled engines do not cover every real OS/browser
  combination (notably, real Safari on macOS / iOS). The contract is
  explicit about that proxy boundary.
- The repository now owns one more dev dependency (`@playwright/test`).
  Upgrading is a normal dependency-update PR; the OSV-Scanner job
  in CI continues to gate vulnerabilities.

### Risks

| Risk | Mitigation |
|------|-----------|
| The smoke spec stays green even when a deeper engine-specific bug exists | The spec is a smoke gate, not a regression suite. Per-mode and per-scene specs land alongside `browser-support.spec.ts` when individual features mature; the gate scales with coverage. |
| A Playwright minor bump pulls forward an engine version that breaks the runtime | The CI job fails on the bump PR, which is the entire point. The release-time refresh process holds that PR back until the runtime is fixed. |
| Real Safari on iOS diverges from Playwright's bundled WebKit | The ADR is explicit that bundled WebKit is a proxy; real-device coverage, if required, is added as additional Playwright projects or a separate device farm — both extensions of the existing matrix, not replacements. |
| A future scene author adds a per-engine branch | The source-policy gate does not ban user-agent reads outright (a narrowly-scoped, tested workaround for an observed bug is legitimate). Code review enforces the "observed and tested" requirement; the preflight names UA sniffing as an anti-pattern. |
| Pre-commit runs Playwright on every commit and slows the loop | Pre-commit's `vitest` hook stays browser-free; `pnpm test:browsers` is opt-in locally and runs only inside the dedicated CI job. |

## Related ADRs

- [ADR-007](007-browser-workbench.md) — defines the workbench URL
  grammar and present-mode lifecycle the smoke spec exercises.
- [ADR-009](009-repo-layout-and-build-tooling.md) — names Playwright
  as the planned browser-execution runner; ADR-030 makes its first
  concrete use the PUL-Q002 gate.
- [ADR-002](002-scene-registry-and-compositions.md),
  [ADR-003](003-gsap-timeline-engine.md),
  [ADR-004](004-howler-audio-engine.md) — the runtime contracts the
  smoke spec proves are intact under all three engines.
