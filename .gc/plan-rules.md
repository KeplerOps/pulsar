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
