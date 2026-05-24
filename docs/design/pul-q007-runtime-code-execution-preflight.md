# PUL-Q007 Runtime Code Execution Preflight

Date: 2026-05-12

PUL-Q007 is a runtime-source security policy: published runtime code
must not execute code that is not already present in the bundle. The
right enforcement is a Vitest static-policy suite that scans source
modules under `src/`, using the TypeScript AST scanner precedent from
`tests/runtime/screenshot-determinism-source.test.ts` and the CI-gate
precedent from `tests/runtime/workbench-graph.test.ts`.

This is not a new runtime validator. `src/runtime/validation.ts`
validates scene and composition declarations. Q007 validates source
structure before build output exists.

## Boundary

- Scan authored runtime source under `src/`: `src/runtime`,
  `src/scenes`, `src/compositions`, `src/main.ts`, and
  `src/workbench-graph.ts`.
- Detect runtime-value uses of `eval`, `new Function`, `Function(...)`,
  dynamic `import(...)` whose specifier is a remote URL or not
  statically local, and equivalent indirect spellings that execute
  string or remote code.
- Use the TypeScript compiler API. Do not add regex-only scanning,
  bundle parsing, browser execution, Vite server startup, or lifecycle
  invocation.
- Tests, docs, configs, generated artifacts, `dist/`, and `coverage/`
  are out of scope unless a future requirement explicitly widens the
  policy.
- Exemptions, if unavoidable, must be line-scoped, reasoned, and named
  for this policy (`PUL-Q007-allow: <reason>`). A broad file-level
  allowlist is a policy bypass.

## Required Reuse

Implementation must build on these incumbents:

- AST scan shape, file walker, rooted access-path matching, alias
  handling, wrapper unwrapping, same-line exemption parsing, and
  fail-loud Vitest reporting from
  `tests/runtime/screenshot-determinism-source.test.ts`.
- Repository-wide CI gate style from
  `tests/runtime/workbench-graph.test.ts`: deterministic findings,
  direct source paths and line numbers, and no advisory-only mode.
- Toolchain and workflow surface from ADR-009: Node 22, pnpm 9.15,
  Vitest, TypeScript strict mode, Biome, and the existing `pnpm test`
  / CI `test` job. Do not create a second workflow controller or a
  new package manager path.
- Runtime architectural boundaries from ADR-008 and ADR-009:
  declarative manifests over flow control, library encapsulation, and
  no remote or ambient runtime discovery as an authoring primitive.

## Cross-Cutting Layers

| Layer | Guardrail |
|-------|-----------|
| Source policy gate | Q007 lives in a Vitest source scan under `tests/runtime/`. It must fail CI through the existing `pnpm test` / `pnpm test:coverage` path. |
| Runtime validation | Do not add a Q007 `FindingCode` or teach `validateRuntime()` to parse source. The validation pass remains scene/composition metadata validation. |
| Asset and URL policy | Do not conflate remote code with assets. Asset URLs remain governed by `scene.assets`, `resolveAssetUrl()`, and `DEFAULT_ALLOWED_SCHEMES`; Q007 must not fetch URLs, probe redirects, or reinterpret asset allowlists as code-import allowlists. |
| Build and module graph | Do not depend on Vite output, sourcemaps, minified bundles, or browser execution. The authored source tree is the canonical inspectable surface. |
| Auth, secrets, and env binding | The scan needs no tokens, env vars, or repository secrets. Do not pass source snippets, URLs with credentials, or config through process argv. |
| OS/process exposure | The scan runs in-process under Vitest. Findings may report relative file path, line, label, and trimmed line text only. |
| Error envelope | Fail with bounded diagnostic text. Do not dump AST nodes, full files, registry objects, scene objects, captions, cookies, headers, env, or argv. Reuse `describeError()` only if unknown thrown values need rendering. |
| Observability | CI failure output is enough. Do not add telemetry, SARIF, artifacts, or logging infrastructure. |
| Persistence | No persistence is required. Do not write scan results to repo files or caches. |

## Extensibility

The seam is the forbidden-surface table plus matcher functions. Keep
the scanner generic enough that the A-series import bans can add
policy tables for forbidden import specifiers and forbidden
constructors without duplicating the file walker, exemption parser, or
diagnostic envelope.

Remote-import classification belongs in one helper that accepts the
static import specifier expression and answers whether it is:

- local static module path (`./`, `../`, package specifier) - allowed
  for Q007;
- remote absolute URL (`http:`, `https:`, protocol-relative) -
  forbidden;
- non-literal / computed / template with expressions - forbidden
  unless a future requirement defines a narrower local-only grammar.

## Gotchas And Anti-Patterns

- Do not rely on text search for `eval` or `Function`; comments,
  strings, type positions, property names, and local shadowing need
  AST treatment.
- Do not flag static local `import` declarations or local package
  imports. Q007 is about runtime code execution not present in the
  bundle, not normal ESM dependencies.
- Do not permit `import(specifier)` where `specifier` is computed,
  read from metadata, read from URL params, read from env, or built
  from a remote origin. That creates a surprise execution path even if
  today's value happens to be local.
- Do not create a scene loader plugin system, import allowlist config,
  runtime code-signing path, CSP generator, or dependency audit here.
- Do not move policy into runtime lifecycle hooks. A violating source
  file must fail before boot.
- Do not broaden GitHub permissions or add secrets for this gate.
- Do not make the gate advisory; any finding is a test failure.

## Non-Goals

PUL-Q007 does not change scene metadata, composition manifest shape,
asset scheme policy, URL navigation grammar, lifecycle ordering,
audio/timeline APIs, exception hierarchy, logging, persistence,
dependency scanning, CSP header generation, or bundle auditing.

It does not transition the requirement status, create traceability
links, implement the A-series import bans, or add a public CLI/report
format.
