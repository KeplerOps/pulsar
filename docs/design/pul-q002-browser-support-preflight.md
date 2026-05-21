# PUL-Q002 Browser Support Preflight

Date: 2026-05-13

PUL-Q002 defines the browser support floor for the runtime: latest
stable Chromium-based browsers, Firefox, and WebKit-based browsers as
of a project release. This is a release and toolchain compatibility
contract over the existing browser workbench. It is not a new runtime
mode, browser-detection subsystem, polyfill framework, or scene
authoring schema.

## Boundary

- ADR-007 remains the browser workbench contract. Browser support means
  the same URL grammar, modes, lifecycle, assets, audio, timeline, and
  error surfaces function across the supported engines.
- ADR-009 remains the toolchain contract. Vite, TypeScript strict mode,
  Vitest, Biome, pnpm 9.15, and Node 22 are the canonical build and CI
  surfaces. Do not add a second bundler, package manager, transpiler
  path, or workflow controller.
- `vite.config.ts` is the canonical browser-output target surface.
  Any compatibility target belongs there or in a directly related
  toolchain config consumed by Vite; do not scatter engine assumptions
  through runtime modules.
- `tsconfig.json` may use newer type libraries for authoring, but
  deployable syntax and APIs must be constrained by the Vite build
  target and cross-browser verification, not by TypeScript acceptance
  alone.
- `.github/workflows/ci.yml`, `package.json` scripts, and
  `.ground-control.yaml` workflow commands are the workflow vocabulary.
  Browser compatibility checks should plug into that vocabulary rather
  than inventing a parallel release gate.

## Required Reuse

Implementation must build on these incumbents:

- Browser workbench and URL/mode contract: ADR-007,
  `src/runtime/navigation.ts`, `src/runtime/scene-loader.ts`, and the
  `index.html` / `src/main.ts` Vite entrypoint.
- Runtime lifecycle and boundaries: scene registry, composition
  registry, validation, asset preloader, timeline engine, audio engine,
  presenter controller, and existing error rendering via
  `describeError()`, `onError`, and `data-pulsar-navigation-error`.
- Toolchain: `vite.config.ts`, `tsconfig.json`, `vitest.config.ts`,
  `package.json` scripts, `.github/workflows/ci.yml`, Biome, pnpm, and
  Node 22.
- Testing precedent: Vitest for static/source policy gates and pure
  runtime behavior. If browser execution is required, add Playwright as
  the browser runner already anticipated by ADR-009; do not use ad hoc
  Selenium, Puppeteer-only scripts, shell-driven browser launches, or
  manual checklist artifacts as the primary gate.
- Security and source-policy precedent:
  `tests/runtime/screenshot-determinism-source.test.ts`,
  `tests/runtime/policy-q007-remote-code-execution.test.ts`, and the
  validation/workbench graph gate patterns. Compatibility enforcement
  should be deterministic, source-controlled, and fail-loud.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Build target | Keep browser syntax/output compatibility centralized in Vite config or a Vite-consumed browser-target artifact. Do not rely on TypeScript's `target` / `lib` as the release support statement. |
| Runtime validation | Do not add browser-support `FindingCode`s or browser-specific scene schemas. `validateRuntime()` remains structural scene/composition validation. |
| URL and mode grammar | Browser support must exercise the existing workbench URL grammar. Do not introduce `browser=`, `engine=`, compatibility modes, or per-engine query flags. |
| Scene contract | Scenes must continue using declared assets, `ctx.gsap`, `ctx.audio`, lifecycle cleanup, captions, and registry metadata. Do not add scene-level browser support declarations unless a future requirement defines a real capability negotiation model. |
| Asset policy | Reuse `scene.assets`, `createAssetPreloader()`, `resolveAssetUrl()`, and `DEFAULT_ALLOWED_SCHEMES`. Do not add engine-specific asset inventories, CDN probes, or browser-dependent URL allowlists. |
| Timeline / audio | Cross-browser behavior must flow through ADR-003's GSAP wrapper and ADR-004's Howler audio service. Do not special-case browser engines inside scenes or import raw engine APIs around the runtime services. |
| Error envelope | Compatibility failures exposed in the workbench must use the existing `onError` / stage diagnostic path and bounded messages. Do not dump raw scene objects, full URLs with credentials, headers, cookies, env, or browser profile data. |
| Auth, secrets, and env binding | Browser compatibility does not require credentials. CI browser jobs must not add tokens, cookies, localStorage seeds, or secret-bearing env vars. If a browser channel or base URL is configurable, keep it non-secret and typed at the test-runner edge. |
| OS/process exposure | Do not pass secrets or full user URLs through process argv. Browser test invocation may pass non-secret project names, ports, and paths; runtime inputs should stay in normalized workbench URLs. |
| Observability | CI failure output and existing runtime diagnostics are enough. Do not add telemetry, analytics, persistent browser logs, SARIF, or artifacts unless a later requirement asks for machine-readable browser reports. |
| Persistence | Browser support must not persist feature detection, last successful browser, or mode state in localStorage, sessionStorage, cookies, IndexedDB, or `history.state`. ADR-007's URL-only state rule still applies. |

## Intended Design

Treat PUL-Q002 as two complementary controls:

1. A documented support contract tied to the release, naming latest
   stable Chromium-based, Firefox, and WebKit-based engines as the
   supported set.
2. An automated browser smoke/regression gate that boots the existing
   Vite workbench and exercises representative URLs across Chromium,
   Firefox, and WebKit projects.

The gate should verify that the runtime boots, parses a normal
workbench URL, reaches a valid scene state, and preserves the existing
navigation/error contract. It should not inspect every scene, replace
unit coverage, or become visual regression unless a screenshot
requirement expands it.

Playwright is the expected seam for browser execution because ADR-009
already names it for browser/screenshot testing. Keep the project list
parameterized by browser engine so a future release job can add real
browser channels or OS-specific coverage without rewriting test logic.

## Extensibility

The required seam is the browser-project matrix. Keep the compatibility
check parameterized by browser project and workbench URL list:

- browser project: Chromium, Firefox, WebKit now; real Chrome, Edge, or
  Safari Technology Preview later if release policy requires it;
- URL set: a small canonical smoke set now; screenshot or
  mode-specific URLs later without changing runtime code;
- host: Vite dev server or preview server selected at the runner edge,
  not inside runtime modules.

Do not encode release browser versions in scene code. If exact release
evidence is needed, record it in release notes or a release-check
artifact, not as runtime behavior.

## Gotchas And Anti-Patterns

- "Latest stable" is time-dependent. Do not hard-code browser version
  numbers in source without an explicit release process for updating
  them.
- Playwright's bundled WebKit is not identical to Safari on every macOS
  or iOS release. It is a useful automated engine gate, not proof that
  every Safari/WebKit embedding behaves identically.
- Vite `build.target: 'es2022'` and `tsconfig` `target: 'ES2024'`
  must not be treated as browser support proof. They constrain syntax
  and types; runtime APIs and CSS behavior still need browser execution.
- Do not add UA sniffing, per-browser branches, feature flags, or
  fallback code paths before a concrete incompatibility is observed and
  covered by a regression test.
- Do not add Babel, Browserslist, polyfills, PostCSS, caniuse-lite
  update scripts, or compatibility shims just to satisfy the
  requirement. Add them only if the existing Vite target and browser
  tests expose a real gap.
- Do not broaden the dependency audit, OSV scanner, SonarCloud, or
  GitHub token permissions as part of browser support.
- Do not make browser compatibility advisory. If an automated browser
  gate is added, failures must fail CI or the release check that owns
  PUL-Q002.

## Non-Goals

PUL-Q002 does not require legacy browser support, IE support, mobile
Safari certification, Android WebView certification, accessibility
conformance, visual pixel parity across engines, screenshot
regression, performance budgets, CSP/header generation, dependency
upgrades, polyfill installation, telemetry, analytics, persistence, or
new runtime configuration.

It does not change scene metadata, composition manifest shape, URL
grammar, workbench modes, asset scheme policy, validation finding
codes, exception hierarchy, logging framework, timeline transport,
audio service, presenter controls, or lifecycle ordering.
