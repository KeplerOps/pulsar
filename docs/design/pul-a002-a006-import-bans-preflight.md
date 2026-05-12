# PUL-A002..A006 Import Bans Preflight

Date: 2026-05-12

PUL-A002, PUL-A003, PUL-A004, and PUL-A006 share PUL-A001's shape: a
structural source-policy gate that flags forbidden module specifiers
in a given file scope. PUL-A005 (composition declarativeness) is the
one outlier in this bundle; it reuses the shared scanner's AST helpers
and exemption parser but supplies its own decision rule. This note
captures the cluster-level guardrails so each per-requirement test
file inherits a single source of truth.

The PUL-A001 preflight authorises this inheritance explicitly:

> The seam is a parameterized forbidden-import policy table in the
> shared source scanner. A001 contributes a rule shaped like:
> scope, forbidden module specifiers, allowed production boundary,
> exemption tag. The same scanner should later accept A002 / A003 /
> A004 / A006 entries with different scopes and specifiers. Do not
> bake "timeline" into the walker, diagnostics, or exemption parser.

## Per-requirement table

| Req | Scope (file set) | Forbidden specifiers | Allowed boundary | Exemption tag |
|-----|------------------|----------------------|------------------|---------------|
| PUL-A002 | `src/scenes/**/*.ts` | `howler`, `howler/*` (+ `new Audio()` / `new HTMLAudioElement()` value-position) | `src/runtime/audio.ts` (out of scope) | `PUL-A002-allow` |
| PUL-A003 | `src/**/*.ts` minus `src/scenes/**` (runtime-core file set) | `pixi.js`, `pixi.js/*`, `three`, `three/*`, `phaser`, `phaser/*` | scene-local imports under `src/scenes/**` | `PUL-A003-allow` |
| PUL-A004 | `src/**/*.ts` minus `src/scenes/**` (runtime-core file set) | `remotion`, `remotion/*`, `@remotion/*` | export pipeline (separate codebase, ADR-006) | `PUL-A004-allow` |
| PUL-A005 | `src/compositions/**/*.ts` | (special: declarative-manifest shape; see below) | n/a | `PUL-A005-allow` |
| PUL-A006 | `src/**/*.ts` minus `src/scenes/**` (runtime-core file set) | `reveal.js`, `reveal.js/*`, `spectacle`, `spectacle/*`, `@spectacle/*` | companion projects (separate, ADR-001) | `PUL-A006-allow` |

The "runtime-core file set" is computed at scan time as
`walkTsFiles(SRC_ROOT)` filtered to exclude `src/scenes/`. This makes
the scope self-extending: a new top-level runtime module (e.g.,
`src/feature-flags.ts`) is picked up automatically.

## Required Reuse

Each test file MUST build on these incumbents (defined in
`tests/runtime/source-policy.ts`):

- `walkTsFiles(root, excludes?)` — the file walker.
- `parseSource(text, file)` — TypeScript `SourceFile` factory with
  parent pointers populated.
- `collectLineExemptions(sourceFile, allowTag)` — line-scoped
  exemption parser. A marker hidden inside a string literal is not
  honoured; empty or whitespace-only rationales are rejected.
- `scanImportSpecifiers(sourceFile, rule, exempted)` — the import-ban
  scanner. Handles static imports, dynamic `import(...)`,
  `import type ... from 'x'`, `export ... from 'x'`, and
  `import x = require('y')`. Type-only imports are flagged because
  the specifier is still surfaced into scene authoring.
- `unwrap(node)` and `isInTypePosition(node)` — for the policies that
  need value-position vs type-position discrimination (PUL-A002's
  `HTMLAudioElement` constructor check; PUL-Q007's `eval` / `Function`
  detector).

## Cross-Cutting Layers (same as PUL-A001 preflight)

Each policy MUST:

- Live in a Vitest source scan under `tests/runtime/`. Fail through
  the existing `pnpm test` / CI `test` job. No separate workflow
  controller, no second package manager path, no advisory-only mode.
- Emit findings as `{ file, line (1-based), text (trimmed), label }`
  records. Never dump AST nodes, full files, registry objects, scene
  objects, captions, cookies, headers, env, or argv.
- Run in-process under Vitest. No HTTP, no FS writes, no env reads
  beyond what `process.argv`-free Vitest already provides.
- Use ASCII-only diagnostic text so CI logs render uniformly.

## PUL-A005 Specifics

PUL-A005 is not an import ban; it is a structural-shape requirement
on every exported `CompositionManifest`-typed binding under
`src/compositions/**/*.ts`. The detection rule is two-phase:

1. **Top-level statement shape.** A composition module's top-level
   statements MUST be import declarations, export declarations, type
   aliases, interface declarations, or `const`-only variable
   statements. Top-level `if` / `switch` / `for` / `while` / function
   declarations / mutable `let` declarations / expression statements
   are imperative-dispatch shapes and are forbidden.
2. **Manifest-binding shape.** For every variable declaration whose
   type annotation references `CompositionManifest`, the initializer
   MUST be an `ArrayLiteralExpression` whose elements are all
   `StringLiteral` or `NoSubstitutionTemplateLiteral` nodes. A
   conditional expression, a function call, a runtime-mutable
   identifier reference, a substituted template literal, or a spread
   expression is forbidden.

This intentionally rejects the otherwise-tempting "extract a const
helper for the manifest" pattern. The exemption marker
`// PUL-A005-allow: <reason>` is available when a real composition
needs an indirection (e.g., a single source-of-truth for the
placeholder scene id shared between the workbench and a fixture); the
absence of a relaxation knob is intentional, so the structural rule
stays sharp.

## Gotchas And Anti-Patterns

- Do not regex-scan for module specifiers. Use the TypeScript AST
  through `scanImportSpecifiers`. The same package name in a comment,
  string literal, identifier, or JSDoc reference is not an import.
- Do not allow a wrapper module (`./shims/gsap.ts`) that itself imports
  the forbidden package to silently bridge scenes to the library. The
  wrapper is the violation; only the named runtime adapter is allowed.
- Do not add a runtime plugin system, import allowlist config, CSP
  generator, dependency audit, or bundle inspector for these gates.
  The policy is structural, not lifecycle-bound.
- Do not relax exemption-marker line scoping. A file-scoped allowlist
  defeats the requirement.
- Do not introduce a second exception hierarchy, FindingCode, or
  validation surface for these policies. Source policy stays separate
  from `validateRuntime()`.

## Non-Goals

This bundle does not change scene metadata, composition manifests
(beyond confirming their shape), URL grammar, lifecycle ordering,
audio/timeline APIs, asset policy, runtime error classification,
dependency versions, CI workflow topology, logging, or persistence.

It does not promote any of PUL-A001..PUL-A006 to ACTIVE outside the
`/implement` transition step, create traceability links outside the
reconciliation step, or rewrite the existing placeholder scene or
default composition (both are already compliant by construction).
