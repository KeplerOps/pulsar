# Issue 100 Runtime Comment Audit Preflight

Date: 2026-05-23

Issue 100 is source-comment hygiene. The change should make runtime
comments trustworthy without changing runtime behavior or moving broad
architecture rationale back into code. ADRs and design docs remain the
durable home for system-level decisions; source comments should explain
local invariants, boundary contracts, machine-read policy exceptions,
and non-obvious constraints.

No new ADR is needed. Existing ADRs already decide the runtime seams:
scene and composition contracts (ADR-002 / ADR-008), timeline and audio
adapters (ADR-003 / ADR-004 / ADR-025), workbench URL dispatch
(ADR-007 / ADR-013 / ADR-014), validation (ADR-008 / PUL-F028), error
surfaces (ADR-028 plus PUL-Q006 / PUL-Q009), and chrome/workbench
ownership (ADR-031).

## Boundary

- Scope the audit to runtime-authored source under `src/main.ts`,
  `src/runtime/**`, `src/system/**`, `src/scenes/**`, and
  `src/compositions/**`, including TypeScript and runtime CSS comments.
  Tests and docs may be consulted to verify status, but they are not
  the primary target.
- Review comments containing `future`, `placeholder`, `not yet`,
  `follow-up`, `OMITTED`, `TODO`, `FIXME`, ADR references, and PUL
  references. A match is not automatically stale; decide from the
  current code and the relevant ADR/design doc.
- Keep comments that state local invariants, security boundaries,
  policy-exemption rationale, ownership boundaries, or failure
  envelopes. Trim broad history and duplicated ADR prose when the code
  nearby is self-evident.
- Do not change exported types, runtime strings, DOM attributes,
  validation logic, policies, source scanners, tests, build config, or
  behavior unless a comment exposes a real defect. If that happens,
  keep the behavioral fix focused and test it as a defect, not as a
  comment-audit side effect.
- This requirement-free issue does not create or transition Ground
  Control requirements and does not create IMPLEMENTS / TESTS
  traceability links.

## Required Reuse

- Durable rationale: `docs/adrs/**`, `docs/design/**`,
  `docs/design/README.md`, and `docs/requirements/conventions.md`.
- Workflow policy: `.ground-control.yaml`, `.gc/plan-rules.md`,
  `AGENTS.md`, and `changelog.d/README.md`.
- Validation/schema incumbents: `assertSceneModule()`,
  `assertCompositionManifest()`, `createIdRegistry()`,
  `validateRuntime()`, `resolveAssetUrl()`, `PRESENTER_COMMAND_KINDS`,
  `isPresenterCommand()`, `formatSceneContext()`,
  `describeError()`, and `describeErrorDetailed()`.
- Policy-source incumbents: `tests/runtime/source-policy.ts`,
  `tests/runtime/screenshot-determinism-source.test.ts`,
  `tests/runtime/policy-*.test.ts`, and Biome `biome-ignore`
  comments with non-empty rationales.
- Verification commands stay the repo defaults from `package.json` and
  `.ground-control.yaml`: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
  and the combined completion command.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Source-policy comments | `// PUL-*-allow: <reason>` comments are executable policy inputs. Preserve the exact allow tag, same-line placement, and non-empty reason unless replacing it with an equivalent valid exemption. |
| Lint suppressions | `// biome-ignore ...: <reason>` comments are lint policy, not prose. Do not remove or generalize them while trimming architectural comments. |
| Scene/composition schemas | Comment edits must not introduce parallel DTO language such as `SceneDTO`, `CaptionSchema`, duplicate manifest shapes, or new validation tables. Refer to the canonical runtime types and validators. |
| URL and mode dispatch | Do not imply scenes own query parsing, mode flags, or history state. URL grammar remains `parseNavigationSearch()` and mode resolution remains `effectiveMode()` at the runtime/workbench boundary. |
| Timeline boundary | `src/runtime/timeline.ts` is the GSAP adapter and beat-label home. Comments should not describe a placeholder runner where `createGsapCompositionTimeline()` now owns the path. |
| Audio boundary | Audio remains `ctx.audio`, `createAudioService()`, and the Howler engine wrapper. Comments should distinguish Howler's engine behavior from the explicit present-mode unlock adapter in `audio-unlock-dom.ts`. |
| Validation boundary | Validation remains an orchestrator over existing runtime contracts. Do not document validation as a second registry, schema system, linter, or lifecycle runner. |
| Error envelope | Public diagnostics stay bounded through `describeErrorDetailed()` and `formatSceneContext()`. Do not change error messages or add comments that encourage parsing `Error.message` for structured data. |
| Security policy | The audit adds no auth surface, secret handling, cookies, local/session storage, `import.meta.env`, `process.env`, `process.argv`, remote dynamic import, `eval`, or generated code path. Existing source-policy gates remain authoritative. |
| OS/process exposure | No command should pass source snippets, tokens, headers, credentials, or env values through process argv. The audit is static source review plus repo-local tests. |
| Changelog policy | Docs-only preflight changes need no fragment. Source-comment-only changes are documentation/process-only unless they alter user-visible behavior or public surfaces; do not hand-edit `CHANGELOG.md`. |

## Extensibility

The only useful seam for future repeat audits is the search scope and
term set. Keep it parameterized as roots plus terms, not as a runtime
concept or comment taxonomy. If stale-comment enforcement becomes
recurring, the canonical place is a focused source-policy test that
reuses `tests/runtime/source-policy.ts`; do not add a separate scanner,
package script, config schema, or CI workflow for this issue.

## Gotchas

- `placeholder` is often an intentional scene id, tag, DOM marker, or
  no-op adapter. Do not rename identifiers or remove local comments
  just because the word appears.
- `future` can mean a deliberate extension seam, not stale work.
  Examples include optional future URL parameters, future command
  variants, and future renderer surfaces. Keep these when they explain
  why the current boundary is shaped for extension.
- `not yet run` in fixtures can describe observed runtime state rather
  than missing implementation.
- Some comments are known high-risk candidates because adjacent code
  has moved: bootstrap text that still says a placeholder timeline
  runner is waiting for ADR-003, prompter comments that predate the L2
  renderer wiring, and audio comments that say unlock is entirely
  auto-handled by Howler. Verify against code before editing.
- ADR references inside source can drift when later ADRs supersede a
  section. Prefer a short local invariant plus a single current ADR
  reference over a historical chain.
- Broad rationale belongs in ADRs/design docs. Do not expand source
  comments to compensate for deleting stale text.
- Removing a source-policy exemption rationale can break tests even
  though runtime behavior is unchanged.

## Anti-Patterns

- Implementing a comment-audit runtime helper, enum, config file, lint
  plugin, or custom script.
- Rewriting comments by requirement status alone without checking the
  current source and accepted ADRs.
- Updating runtime behavior to make an old comment true.
- Changing public error strings, data attributes, URL grammar, command
  kinds, validation findings, or policy allow tags as part of prose
  cleanup.
- Duplicating scene, composition, caption, presenter, audio, asset, or
  error schemas in comments.
- Adding changelog fragments for docs-only or source-comment-only
  changes when no user-visible behavior changed.

## Non-Goals

Issue 100 does not add new architecture, requirements, ADR decisions,
workflow automation, source-policy enforcement, validation behavior,
runtime features, browser UI, telemetry, security policy, persistence,
or release tooling.

It also does not require exhaustive prose normalization. The goal is to
remove or correct stale future-work language while preserving comments
that carry real local maintenance value.
