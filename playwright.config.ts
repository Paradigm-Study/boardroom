import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: '/tmp/boardroom-playwright-results',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: 'line',
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:5177',
    trace: 'retain-on-failure',
  },
  webServer: {
    // --strictPort: if 5177 is taken Vite must fail fast, not auto-increment while
    // the health check (and every test) still targets 5177 — that would silently
    // run the suite against whatever answered there.
    // BOARDROOM_PROXY_TARGET points the /api + /events proxy at a dead port so a
    // developer's live daemon can never leak real cards into the run; every /api
    // call the tests need is fulfilled by page.route in the fixture.
    command: 'BOARDROOM_PROXY_TARGET=http://127.0.0.1:4949 npm run dev:web -- --host 127.0.0.1 --port 5177 --strictPort',
    url: 'http://127.0.0.1:5177',
    // Never reuse: a server already on 5177 (e.g. a manually-started dev:web
    // without the dead-port env) proxies to the REAL daemon, silently reopening
    // the leak the hermetic command above closes. Vite starts in ~1s; pay it.
    // (The e2e suite is currently local-only — CI runs vitest, not playwright.)
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
