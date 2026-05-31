Relocated the policy / source-scan suites
(`tests/runtime/policy-*.test.ts`,
`tests/runtime/screenshot-determinism-source.test.ts`, and their shared
`source-policy.ts` AST framework) out of the default behavior suite
into a dedicated, still-blocking gate. They run via a new `pnpm policy`
script against `vitest.policy.config.ts` (serial, generous timeout) and
are excluded from `vitest.config.ts`, so `pnpm test` is now
behavior-only and no longer flakes on the structural AST scans starving
under parallel load (PUL-Q003 / PUL-Q007 5s timeouts). Enforcement is
unchanged: `pnpm policy` is wired as a blocking job in
`.github/workflows/ci.yml` and a blocking hook in
`.pre-commit-config.yaml`, running the identical violation set. No
policy check was dropped or weakened; the Biome complexity-gate
override for the cluster is untouched.
