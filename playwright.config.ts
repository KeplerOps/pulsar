// Playwright configuration for the PUL-Q002 browser-support gate.
//
// PUL-Q002 / ADR-030: the runtime must function in the latest stable
// releases of Chromium-based, Firefox, and WebKit-based browsers. The
// gate boots `pnpm preview` (Vite's production build host — same
// artifact the release ships) and exercises the workbench URL grammar
// through Playwright's bundled engines, one project per supported
// engine family.
//
// Scope: smoke. The spec asserts the runtime mounts, the PUL-F028
// validation pass succeeds, navigation parses the default workbench
// URL, and the placeholder scene reaches its `timeline` phase. Per-
// mode and screenshot-regression specs belong in their own files
// alongside `browser-support.spec.ts`; the project matrix here does
// not need to change for those to land.

import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const isCI = process.env.CI === 'true' || process.env.CI === '1';

export default defineConfig({
  testDir: 'tests-e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    // Build the production bundle, then host it via Vite preview on a
    // fixed port. `--strictPort` makes a port collision fail loud
    // rather than silently picking another port that the `url:` wait
    // wouldn't match.
    command: `pnpm build && pnpm preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !isCI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
