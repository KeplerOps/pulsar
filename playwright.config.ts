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
// `127.0.0.1` (not `localhost`) on both ends. Vite preview's default
// `host` is `localhost`, which resolves to both `127.0.0.1` (IPv4) and
// `::1` (IPv6) — on Ubuntu CI runners the resolver may serve only one
// family, so a Playwright probe of `http://127.0.0.1:<port>` can time
// out against a server that only bound to `::1`. Pinning the host to
// `127.0.0.1` in the preview command AND in the `url`/`baseURL` makes
// the bind and the probe deterministic.
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;
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
    // fixed `host:port`. `--strictPort` makes a port collision fail
    // loud rather than silently picking another port that the `url:`
    // wait wouldn't match. `--host 127.0.0.1` binds the preview
    // server to IPv4 only, matching the `BASE_URL` Playwright probes
    // — without the explicit host, Vite binds to `localhost` and
    // resolver-family quirks on the runner can leave the IPv4 probe
    // unanswered until the 120s `webServer.timeout` expires.
    command: `pnpm build && pnpm preview --port ${PORT} --strictPort --host ${HOST}`,
    url: BASE_URL,
    reuseExistingServer: !isCI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
