# PUL-A009 Captions And Prompter Single-Source Preflight

PUL-A009 is an architectural constraint: prompter content is derived
from the same caption metadata the runtime accepts on scene modules.
There is no separate prompter authoring source, prompter manifest,
caption DTO, or composition-level caption override.

ADR-008 already makes this a structural-legibility rule. ADR-022 fixes
the `mode=prompter` loader bypass and captions aggregation seam.
ADR-027 fixes the `Caption.at` grammar. This preflight consolidates the
repo-wide guardrails for implementation; it does not create a new
caption model.

## Boundary

- `src/runtime/scene.ts` owns `Caption`, `SceneModule.captions`, and
  `assertSceneModule()`. Caption shape changes start here or do not
  exist.
- `src/runtime/registry.ts` owns scene registration and calls
  `assertSceneModule()` once. Do not add registry-local caption parsing.
- `src/runtime/validation.ts` may report scene-shape faults by reusing
  `assertSceneModule()`. It must not invent a validation-only caption
  schema.
- `src/runtime/scene-navigation.ts` owns addressed target resolution
  and immutable composition slices. Prompter derivation consumes the
  resolved slice; it must not re-resolve or flatten targets.
- `src/runtime/scene-loader.ts` owns mode dispatch. Under
  `mode=prompter`, it resolves navigation, sets bounded stage attrs,
  bypasses the visual lifecycle, and hands the derived script to
  `renderPrompter`.
- `src/runtime/prompter.ts` owns `PrompterScript` construction as a
  pure structural copy of scene metadata. It is an adapter payload, not
  a second authoring format.
- Composition entries may carry `range` and `behavior` as occurrence
  metadata, but caption text and `at` values still come from the
  registered scene module.

## Required Reuse

Implementation must build on these canonical incumbents:

- Caption schema: `Caption`, `SceneModule.captions`,
  `assertSceneModule()`, `isSceneModule()`, `isCaptionAt()` behavior
  inside `scene.ts`, `isKebabIdentifier()`, and
  `KEBAB_IDENTIFIER_FORM`.
- Scene and composition registration: `createSceneRegistry()`,
  `createCompositionRegistry()`, frozen registry snapshots,
  `assertCompositionManifest()`, `entryId()`, and object-form
  `range` / `behavior` handling.
- Navigation and mode dispatch: `parseNavigationSearch()`,
  `NAVIGATION_MODES`, `effectiveMode()`, loader-side
  `validateModeGrammar()` / `validateBeatGrammar()`, and
  `resolveSceneNavigation()`.
- Prompter seam: `buildPrompterScript()`, `PrompterScript`,
  `PrompterScriptEntry`, `PrompterRenderer`, `PrompterDispose`, and
  the loader's `renderPrompter` adapter path.
- Error and observability: `describeError()`,
  `describeErrorDetailed()`, `formatSceneContext()`, the loader
  `onError` sink, `data-pulsar-navigation-error`,
  `data-pulsar-scene-target`, and `data-pulsar-composition-target`.
- Validation and policy tests: `validateRuntime()` for structural
  graph validation, `tests/runtime/prompter.test.ts`,
  `tests/runtime/scene-loader-screenshot-prompter.test.ts`,
  `tests/runtime/validation.test.ts`, and source-policy tests.

Do not add a second schema, parser, validator, exception hierarchy,
logging surface, persistence layer, workflow controller, or prompter
repository for captions.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Scene schema gate | `assertSceneModule()` remains the only caption shape-check. It accepts the existing `Caption.at` union and rejects malformed entries with indexed errors that do not echo caption text. |
| Registry boundary | Registries validate scene modules once and freeze snapshots. Do not store a normalized `PrompterCaption[]`, computed script, or editable caption cache in a registry. |
| Runtime validation | `validateRuntime()` reuses the scene schema gate and stays side-effect-free. It must not call lifecycle hooks, inspect DOM, build a prompter script, or compare caption text with another source. |
| URL / mode / navigation | Captions are not selected or authored by query string. `mode=prompter` chooses the view; `scene`, `composition`, `index`, and `beat` keep their existing grammar. No `caption=`, `script=`, `prompter=`, storage fallback, or silent direct-scene fallback. |
| Composition slice | Prompter consumes the resolved composition slice as snapshotted by `resolveSceneNavigation()`. Do not apply `applySingleSceneSlice()` under prompter, and do not let `range` / `behavior` rewrite captions. |
| Visual lifecycle | Prompter bypasses `createPreloader`, `buildCtx`, scene `create` / `timeline` / `cleanup`, and timeline execution. CSS-hiding a mounted scene is not equivalent. |
| DOM rendering security | Caption text is user-authored content. A visible prompter renderer must insert it as text (`textContent` or framework text binding), never as HTML. |
| Asset / network / audio | Captions must not trigger asset discovery, `fetch`, dynamic import, audio load, or preloader work. Asset and audio policy remains `scene.assets`, `scene.audio`, `resolveAssetUrl()`, and the audio service allowlist. |
| Auth / secrets / env / config | This requirement needs no auth, cookies, localStorage, sessionStorage, IndexedDB, env vars, config files, or process argv flags. Do not expose caption or script payloads through those surfaces. |
| OS-level exposure | Keep caption payloads in memory. Do not pass full scripts through shell commands, process arguments, filenames, CI annotations, or artifacts unless a future export requirement defines redaction and transport. |
| Error envelope | Public diagnostics may name scene ids, composition ids, indexes, fields, and rule names. They must not dump full caption text, `PrompterScript`, raw scene objects, DOM nodes, stacks, headers, cookies, env, auth values, or asset payloads. |
| Observability | Reuse stage attrs and `onError`. Do not add per-caption console logging, analytics, telemetry, or a second workbench event stream for scripts. |

## Extensibility

The required seam is the existing caption metadata plus prompter
script adapter:

- New caption fields belong on `Caption` / `SceneModule.captions` and
  flow through `buildPrompterScript()` structurally.
- If multiple consumers need to classify caption timing, put a small
  helper next to `Caption` in `src/runtime/scene.ts`; do not let UI,
  exporter, validator, and tests each infer the union differently.
- Visible prompter UI options belong on the `PrompterRenderer` adapter
  or a renderer-local policy object, not on scene modules or
  composition manifests.
- Beat-aware caption features resolve labels through the timeline seam
  after a timeline exists. The scene schema checks label shape only.

This leaves room for speaker labels, localization, active-line
highlighting, caption export, and beat-click seeking without creating a
second authoring source.

## Gotchas And Anti-Patterns

- Do not add `prompterCaptions`, `script`, `notes`, `teleprompter`, or
  `captionOverrides` fields to scenes or composition entries.
- Do not copy captions into a separate JSON file, module, workbench
  store, browser storage value, or generated artifact that authors edit
  directly.
- Do not create `PrompterCaption`, `CaptionSchema`, `CaptionError`, or
  a zod/AJV schema parallel to `assertSceneModule()`.
- Do not normalize, sort, resolve, filter, or coerce captions in
  `buildPrompterScript()` unless a future requirement defines that view
  policy. Structural copy is the contract.
- Do not treat numeric-looking string `at` values as milliseconds.
  String `at` values are beat labels.
- Do not validate caption beat existence by running `timeline(ctx)` in
  scene validation or prompter aggregation.
- Do not render caption text with `innerHTML`, log full scripts, or put
  captions into error messages.
- Do not make presenter overlays, chrome, exporter code, or tests read
  a caption source other than `SceneModule.captions`.

## Non-Goals

PUL-A009 does not implement visible prompter UI, caption editing,
caption persistence, localization, speaker attribution, caption export,
teleprompter scrolling, beat-click navigation, timeline authoring,
composition caption overrides, presenter overlays, remote protocols,
auth, telemetry, or requirement status transition.

It should not change URL grammar, workbench modes, composition
manifest shape, scene lifecycle ordering, asset preload policy, audio
behavior, runtime validation scope, error envelopes, logging,
persistence, or the Ground Control workflow.
