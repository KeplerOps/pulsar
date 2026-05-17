# PUL-Q008 DOM/CSS Accessibility Preflight

PUL-Q008 tightens ADR-005's core promise: DOM/CSS scenes must keep the
browser's native accessibility tree intact. Text remains real DOM text,
focus follows DOM order, and ARIA attributes authored by the scene are
not stripped by the runtime.

This is not a new rendering surface, scene schema, sanitizer, virtual
accessibility tree, or accessibility framework. It is a preservation
contract over existing DOM/CSS scene authoring and runtime mounting.

## Boundary

- ADR-005 remains the rendering-surface decision. DOM/CSS is the
  default because the browser already owns text selection, focus, and
  accessibility semantics.
- `src/runtime/scene-loader.ts` remains the scene environment seam.
  Scenes receive `ctx.stage` and allocate DOM through
  `ctx.stage.ownerDocument`; they do not reach for ambient `document`
  or global DOM roots.
- `src/runtime/scene.ts` remains the scene contract. Do not add
  accessibility metadata fields to `SceneModule` for this requirement.
- `src/runtime/composition-resolver.ts` remains lifecycle orchestration.
  Accessibility preservation must not reorder scene lifecycle,
  synthesize alternate DOM, or remount scenes to normalize attributes.
- `tests/runtime/source-policy.ts` plus policy tests under
  `tests/runtime/policy-*.test.ts` are the canonical source-policy
  shape for structural authoring bans.
- Playwright browser specs under `tests-e2e/` are the canonical seam
  when behavior must be verified in a real browser engine.

## Required Reuse

Implementation must build on these incumbents:

- DOM scene seam: `WorkbenchSceneCtx.stage`,
  `ctx.stage.ownerDocument.createElement(...)`, scene-local
  `appendChild`, and lifecycle cleanup through `cleanup(ctx)`.
- Existing DOM bypass policy: PUL-Q004's source scan over
  `src/scenes/**/*.ts`, especially the bans on ambient `document`
  attachment roots, global listeners, observers, and DOM prototype
  monkey-patches.
- Source-policy helpers: `walkTsFiles`, `parseSource`,
  `collectLineExemptions`, `lineText`, access-path helpers, and
  bounded `{ file, line, text, label }` diagnostics from
  `tests/runtime/source-policy.ts`.
- Browser-workbench gate: ADR-030's Playwright project matrix and
  existing workbench URLs, if runtime behavior needs browser proof.
- Error/diagnostic style: fail-loud Vitest assertions, bounded
  messages, and existing `onError` / stage attributes only where a
  runtime failure already exists.
- Toolchain and workflow: ADR-009's TypeScript, Vite, Vitest,
  Playwright, Biome, pnpm, Node 22, and existing package scripts.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Scene schema gate | `assertSceneModule()` remains the only scene-shape validator. Do not add `accessibility`, `aria`, `focusOrder`, or `selectableText` scene fields. |
| DOM allocation and ownership | Scenes mutate only the injected stage and allocate through `ctx.stage.ownerDocument`. Keep PUL-Q004's ambient-document bans; do not add runtime DOM cloning, sanitizing, or off-stage staging that can drop attributes or selection. |
| Text semantics | Visible text in DOM/CSS scenes must be DOM text (`textContent` or framework text binding), not CSS `content`, canvas text, rasterized screenshots, or duplicated hidden strings used as an accessibility substitute. |
| Focus order | Runtime code must not impose positive `tabindex`, global focus traps, keyboard listeners, or reorderable roving focus for ordinary scenes. If a scene needs focusable controls, DOM order is the source of truth. |
| ARIA preservation | The runtime must not strip, rename, filter, or reserialize `aria-*`, `role`, `tabindex`, `aria-labelledby`, or `aria-describedby` attributes authored by a scene. |
| Source policy gate | Prefer a Vitest AST source policy for structural anti-patterns that can be seen in source. Reuse `source-policy.ts`; do not add regex-only scans, a second file walker, broad allowlists, or advisory output. |
| Browser behavior gate | Use Playwright only for browser facts source scans cannot prove, such as text selection or computed accessibility exposure. Keep it inside the existing project matrix and URL/workbench model. |
| Runtime validation | Do not add Q008 `FindingCode`s or make `validateRuntime()` inspect DOM, execute scene lifecycle hooks, parse CSS, or build accessibility trees. |
| Asset/security policy | Do not fetch, decode, OCR, or rasterize assets to prove text or ARIA. Asset loading remains `scene.assets` through `createAssetPreloader()` and existing URL/scheme checks. |
| Auth, secrets, and env binding | Q008 needs no credentials, env vars, cookies, localStorage, sessionStorage, IndexedDB, or secret-bearing config. Browser tests must use ordinary workbench URLs and non-secret options. |
| OS/process exposure | Keep enforcement in process under Vitest/Playwright. Diagnostics may report relative file path, line, label, and trimmed source only; do not pass DOM snapshots, page HTML, captions, URLs with credentials, or scene objects through argv or artifacts. |
| Error envelope | Public diagnostics must not dump DOM nodes, serialized subtrees, accessibility trees, full captions, stacks, cookies, headers, env, or auth values. Q008 violations are policy/test failures unless a runtime error already exists. |
| Observability and persistence | CI/test output is enough. Do not add telemetry, persistent accessibility reports, local caches, storage flags, or browser profile state. |

## Design Guardrails

Treat accessibility preservation as a native-DOM invariant. The runtime
should pass scene-authored DOM through untouched except for lifecycle
mounting, timeline animation, and cleanup already owned by the
resolver/loader/timeline seams.

The extensibility seam is a small, parameterized source-policy rule
set over scene-authored DOM/CSS hazards. Keep it table-driven by
attribute/property/API family so future rules can add specific bans
without rewriting the walker. The key parameter is surface family:
text-selection blockers, focus-order overrides, ARIA stripping or
rewriting, hidden accessibility substitutes, and non-DOM text
rendering.

When source cannot prove the behavior, use the existing Playwright
browser matrix with one or more fixture scenes. The parameter there is
workbench URL plus assertion kind, not browser-specific runtime code.

## Gotchas And Anti-Patterns

- Do not satisfy Q008 by building a parallel accessibility model,
  mirror tree, hidden text transcript, or ARIA generator beside the
  visible DOM.
- Do not convert DOM/CSS text scenes into canvas, SVG text-only
  snapshots, images, video frames, or CSS generated text just to make
  animation easier.
- Do not use blanket `user-select: none`, `pointer-events: none` on
  text containers, `aria-hidden` on scene roots, `inert` on active
  scene DOM, or `display: contents` as a layout shortcut without a
  browser-tested accessibility reason.
- Do not add positive `tabindex` to make visual order win over DOM
  order. Reorder the DOM instead.
- Do not sanitize scene DOM by copying only an allowlist of
  attributes. That is exactly how ARIA gets stripped.
- Do not use shadow DOM as an accessibility hiding place. If a future
  component needs shadow DOM, it must prove text selection, focus, and
  ARIA behavior in browser tests.
- Do not duplicate PUL-Q004's DOM ownership scanner. Extend the shared
  source-policy helpers or add a sibling policy test with the same
  exemption and diagnostic conventions.
- Do not route Q008 through `validateRuntime()`, scene metadata,
  composition manifests, URL grammar, asset policy, or presenter
  commands.

## Non-Goals

PUL-Q008 does not require WCAG certification, a full accessibility
audit, screen-reader transcript generation, ARIA lint coverage for
every possible misuse, keyboard interaction design for interactive
widgets, focus trapping, captions/prompter changes, telemetry,
browser extensions, CSP/header changes, or dependency additions.

It does not change scene metadata, composition manifest shape,
navigation grammar, workbench modes, lifecycle ordering, timeline
transport, audio behavior, asset preload policy, validation finding
codes, exception hierarchy, logging, persistence, or requirement
status.
