# Pulsar plan rules

Mandatory constraints the `/implement` skill applies during plan phase.

## Screenshot determinism

For `PUL-Q001`, implementation must reuse the canonical runtime
surfaces from ADR-007:

- Parse and validate `mode=screenshot` through the workbench URL
  grammar. Do not let scenes parse query strings or define local mode
  flags.
- Resolve scenes, compositions, beats, assets, captions, and cleanup
  through the ADR-002 contracts. Do not add a parallel screenshot
  manifest or scene schema.
- Freeze timeline state through the ADR-003 GSAP runtime integration.
  Do not use wall-clock animation, CSS animation time, timers, or
  `requestAnimationFrame` time to determine the captured frame.
- Silence audio through the ADR-004 audio service. Do not add raw
  screenshot-only `<audio>` handling in scenes.
- Gate capture readiness on declared asset and font loading. Do not
  accept remote mutable assets, undeclared fonts, or network-order races
  as deterministic.
- Keep entropy runtime-mediated. Screenshot output must not depend on
  `Date`, `Math.random`, `crypto.getRandomValues`, `performance.now`,
  local/session storage, cookies, environment variables, or process
  arguments.
- Route invalid URL, target, asset, and readiness failures through the
  existing navigation/error surface. Error envelopes must not echo
  secrets, credentials, cookies, headers, raw environment values, or raw
  scene payloads.

Future screenshot variants belong in validated screenshot options beside
the workbench URL grammar, not in scene-local flags or duplicate schemas.

## Changelog fragments

Every PR that changes user-visible behavior — runtime features,
scene/composition contracts, validation, error surface, public DOM
data attributes, build outputs, presenter or workbench UX — must drop
a fragment under `changelog.d/<issue-or-pr>.<type>.md` (or
`changelog.d/+<slug>.<type>.md` for orphan / meta entries with no
issue or PR anchor). `<type>` is one of `security`, `removed`,
`deprecated`, `added`, `changed`, `fixed`.

PRs MUST NOT hand-edit `CHANGELOG.md`. Release-time `towncrier build`
collates fragments into the changelog; the only commit that touches
`CHANGELOG.md` directly is the release-collation commit, which by
definition touches only `CHANGELOG.md` and the fragments it consumed.

Pure-housekeeping diffs — CI-only changes under `.github/workflows/`,
docs-only changes under `docs/**`, `architecture/**`, `README.md`,
`.gc/**`, `changelog.d/**` itself, `skills/**`, and equivalents — do
not require a fragment. The line is "did user-visible behavior
change," not "are any non-docs paths in the diff."

See [`changelog.d/README.md`](../changelog.d/README.md) for the
content shape and how to preview a release section locally.
