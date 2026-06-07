import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Policy / source-scan gate — a separate, still-BLOCKING vitest project.
//
// These suites assert codebase STRUCTURE (no `eval` / `new Function` /
// remote dynamic import, no `Math.random` in `src/`, no direct `gsap`
// import in scenes, screenshot-determinism source invariants, the
// complexity-gate override allowlist, etc.). They catch zero runtime
// regressions; their expensive whole-tree AST scans starve under the
// parallel load of the behavior suite and intermittently time out at
// the default 5s limit (PUL-Q003 / PUL-Q007).
//
// They are excluded from `vitest.config.ts` (so `pnpm test` is
// behavior-only and flake-free) and run here via `pnpm policy`, wired
// as a blocking step in CI and pre-commit. The enforcement set is
// identical — only the place it runs has moved.
//
// Run serially with a generous timeout: a single AST pass over the
// whole source tree is the unit of work, so worker parallelism buys
// nothing and only re-introduces the starvation that caused the flake.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: [
        'tests/runtime/policy-*.test.ts',
        'tests/runtime/screenshot-determinism-source.test.ts',
      ],
      environment: 'node',
      setupFiles: ['./tests/setup.ts'],
      testTimeout: 60_000,
      hookTimeout: 60_000,
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
  }),
);
