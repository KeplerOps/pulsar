# Issue 97 Browser Runtime Smoke Preflight

Date: 2026-05-18

Issue 97 expands browser-level runtime smoke coverage. It is a
coverage/workflow hardening issue over the existing browser workbench,
not a new runtime mode, router, scene schema, browser stack, or visual
regression framework.

## Existing Contracts

- ADR-007 owns the workbench URL grammar and modes. Browser smoke URLs
  must use the real grammar: default route, `scene`, `composition`, and
  `mode`. Do not add test-only query parameters or persisted browser
  state.
- ADR-013 owns URL parsing and validation through
  `src/runtime/navigation.ts`. Tests should address URLs; they must not
  parse or construct internal navigation targets in the browser.
- ADR-014, `src/runtime/scene-loader.ts`, and
  `src/runtime/scene-navigation.ts` own target resolution, lifecycle
  dispatch, abort/cleanup, and stage diagnostics. Browser assertions
  should observe those public DOM attributes instead of reaching into
  runtime internals.
- ADR-030 already adopts Playwright as the browser runner, with
  `playwright.config.ts`, `tests-e2e/`, `package.json`
  `test:browsers`, and the `.github/workflows/ci.yml`
  `browser-support` job as the canonical workflow. Extend this stack;
  do not add a second browser runner or CI job unless a future issue
  changes the workflow contract.
- `src/workbench-graph.ts` is the single source of registered
  workbench scenes and compositions. Any browser-addressed fixture must
  be registered there and pass the existing `validateRuntime()` boot
  gate; do not create a test-only registry path.
- `tests/runtime/policy-q002-browser-support.test.ts` is the structural
  defense that the Playwright gate remains wired. If the canonical
  browser smoke artifact changes name or ownership, update that policy
  gate with the workflow change.

## Guardrails

- Keep `pnpm test:browsers` as the full browser matrix command. Local
  project-specific Playwright commands are fine, but the package script
  must not pin `--project` or bypass `playwright.config.ts`.
- Continue booting the production build through Vite preview unless a
  future ADR changes ADR-030. This catches build-time and browser-load
  failures that dev-server-only tests can hide.
- Reuse existing runtime observables:
  `#stage`, `data-pulsar-validation-failed`,
  `data-pulsar-navigation-error`, `data-pulsar-scene-target`,
  `data-pulsar-composition-target`,
  `data-pulsar-scene-lifecycle`, and
  `data-pulsar-chrome-visibility`. Add a new observable only when a
  product/runtime contract needs it outside tests.
- Route rendered DOM assertions through real scene output. Fixture
  scenes may expose stable `data-pulsar-*` attributes, but they must
  still use the normal scene lifecycle, `ctx.stage`, `ctx.gsap`, and
  cleanup contract.
- Screenshot inspection is a blank-stage guard, not pixel-perfect
  visual regression for this issue. Use Playwright screenshots or image
  inspection enough to prove the stage is nonblank/meaningfully
  rendered; do not introduce baseline snapshot management unless a
  separate requirement asks for visual regression.
- Keep browser errors fail-loud by collecting page errors and
  `console.error` as existing e2e specs do. Do not mask runtime errors
  with permissive retries or broad console filters.
- Document the workflow in the canonical package-script/test docs
  surface. Do not add a parallel manual checklist that can drift from
  `pnpm test:browsers` and CI.

## Cross-Cutting Layers

| Layer | Requirement for the issue 97 design |
|-------|-------------------------------------|
| Security and secrets | Browser smoke needs no credentials, cookies, localStorage seeds, tokens, or secret env vars. CI permissions stay `contents: read`; no new repository secrets. |
| URL validation | All addressed URLs must pass `parseNavigationSearch()` and `NAVIGATION_MODES`. Query values remain identifiers, never file paths, module specifiers, inline manifests, or network fetch targets. |
| Runtime validation | The workbench boot path must keep using `validateRuntime()` over `WORKBENCH_SCENES` and `WORKBENCH_COMPOSITIONS` before lifecycle effects. Do not bypass validation for fixtures. |
| Lifecycle and cleanup | Browser fixtures must run through `createSceneLoader()` / `resolveSceneNavigation()` / `resolveComposition()`. Do not mount fixture DOM outside scene `create(ctx)` or skip cleanup. |
| Error envelope | Expected success assertions should require absence of `data-pulsar-navigation-error` and `data-pulsar-validation-failed`. Failure diagnostics must not dump secrets, full credentialed URLs, cookies, headers, or raw scene payloads. |
| OS/process exposure | Playwright may receive non-secret ports, hosts, project names, and paths through config/argv. Do not pass secret-bearing URLs or env-derived credentials through process argv. |
| Observability | CI artifacts stay Playwright's report, traces on retry, and failure screenshots/test-results. Do not add telemetry, analytics, persistent browser logs, or SARIF for this smoke suite. |
| Persistence | Tests must not depend on or write persisted browser state. URL remains the only target/mode source per ADR-007 and ADR-013. |

## Extensibility

The required seams are the Playwright project matrix and a small,
explicit list of workbench URL cases. The matrix already parameterizes
Chromium, Firefox, and WebKit. The URL list should be easy to extend
with one future mode, fixture scene, or composition case without
rewriting the runner, changing runtime code, or duplicating validation.

If blank-stage detection later becomes full visual regression, extend
the screenshot seam under `tests-e2e/` with explicit baselines and
review policy. Do not overload the smoke test with implicit pixel
approval semantics.

## Gotchas

- The current browser-support spec already covers `?scene=...` and a
  mode-specific route, but issue 97 additionally requires default route
  and `?composition=...` coverage plus screenshot/blank-stage
  inspection. Do not mistake the existing gate wiring for complete
  issue 97 acceptance.
- The default route has `locator.kind: "none"` and may intentionally
  leave the stage in placeholder state. Its assertions should prove the
  app booted without validation/navigation errors and that the shell is
  observable; do not silently redefine default navigation semantics.
- `mode=screenshot` is single-scene execution per ADR-021. A browser
  smoke case may inspect it, but it must not imply composition-wide
  capture or baseline visual regression.
- Playwright retries in CI are for runner flake, not for hiding runtime
  nondeterminism. Route-specific failures should remain actionable.
- `127.0.0.1` host pinning in `playwright.config.ts` is intentional for
  CI resolver determinism. Do not switch back to `localhost` casually.

## Anti-Patterns

- No Puppeteer/Selenium/custom shell browser launcher alongside
  Playwright.
- No duplicate URL parser, mode allowlist, route manifest, scene
  registry, composition registry, validation schema, exception
  hierarchy, or logging system for e2e.
- No test-only dynamic imports, URL-derived module paths, inline
  composition manifests, or direct filesystem/network loading from
  query parameters.
- No scene branches on Playwright, browser engine, CI, or user agent.
- No product runtime attributes whose only purpose is satisfying one
  test when an existing observable already proves the behavior.
- No new changelog fragment is required for this preflight note alone.
  The eventual source/test implementation should add one because it
  changes repository behavior.

## Non-Goals

Issue 97 does not require mobile browser certification, real Safari
device coverage, accessibility expansion beyond existing PUL-Q008
tests, pixel-perfect visual regression, performance budgets, CSP/header
work, dependency upgrades, browser version pinning in source, telemetry,
analytics, persistent browser profiles, or new runtime configuration.

It should not change scene metadata shape, composition manifest shape,
URL grammar, workbench mode semantics, asset scheme policy, validation
finding codes, runtime exception hierarchy, logging framework, timeline
transport, audio service, presenter controls, or lifecycle ordering.
