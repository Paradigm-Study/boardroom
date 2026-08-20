import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  // CI (the non-required e2e-browser job) runs the browser specs only. The
  // menubar (Electron) spec stays local-only: it needs menubar/node_modules —
  // whose postinstall icon generation needs macOS iconutil — plus a display,
  // neither of which the ubuntu runner has.
  testIgnore: process.env.CI ? '**/menubar-*.spec.ts' : [],
  outputDir: '/tmp/boardroom-playwright-results',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: 'line',
  use: {
    ...devices['Desktop Chrome'],
    // Local runs drive the branded Chrome already on dev machines; CI installs
    // Playwright's bundled Chromium (`npx playwright install --with-deps
    // chromium`) and must not ask for a channel it didn't install.
    channel: process.env.CI ? undefined : 'chrome',
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
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
