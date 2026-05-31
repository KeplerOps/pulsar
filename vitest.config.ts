import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['tests/**/*.test.ts'],
      // The policy / source-scan suites live in their own blocking gate
      // (`vitest.policy.config.ts`, run via `pnpm policy`). They assert
      // codebase structure, not runtime behavior, and their whole-tree
      // AST scans starved under parallel load and intermittently timed
      // out here. Excluding them keeps `pnpm test` behavior-only and
      // flake-free; enforcement is unchanged — see complexity-backlog.md.
      exclude: [
        ...configDefaults.exclude,
        'tests/runtime/policy-*.test.ts',
        'tests/runtime/screenshot-determinism-source.test.ts',
      ],
      environment: 'node',
      setupFiles: ['./tests/setup.ts'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
        reportsDirectory: 'coverage',
        include: ['src/**/*.ts'],
        exclude: ['src/main.ts', '**/*.config.ts'],
      },
    },
  }),
);
