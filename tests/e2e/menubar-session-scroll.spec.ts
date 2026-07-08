import { expect, test, type Page } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from 'playwright'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  mockBoardroomApi,
  reachableScrollTop,
  safeScrollTarget,
  scrollCards,
  storedSessionScrollTop,
} from './sessionScroll.fixture.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const requireFromSpec = createRequire(import.meta.url)
const electronExecutable = requireFromSpec(path.join(repoRoot, 'menubar/node_modules/electron')) as string

async function showMenubarWindow(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow({ timeout: 15_000 })
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setBounds({ width: 960, height: 700 })
    win?.show()
    win?.focus()
  })
  await page.setViewportSize({ width: 960, height: 700 })
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThan(900)
  return page
}

async function readState(page: Page): Promise<{ scrollHeight: number; scrollY: number; url: string }> {
  return page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    scrollY: window.scrollY,
    url: location.href,
  }))
}

async function waitForCardHash(page: Page, id: string): Promise<void> {
  await page.waitForFunction(expected => location.hash === `#/card/${expected}`, id)
}

test('menubar dashboard restores per-session scroll after wrapper reload', async () => {
  let app: ElectronApplication | undefined
  const logs: string[] = []

  try {
    app = await electron.launch({
      executablePath: electronExecutable,
      cwd: path.join(repoRoot, 'menubar'),
      args: ['.'],
      env: {
        ...process.env,
        BOARDROOM_PORT: '5177',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
    })

    app.on('console', msg => {
      const text = msg.text()
      if (text.includes('ERR_ABORTED (-3) loading')) return
      if (text.includes("Warning: The 'NO_COLOR' env is ignored")) return
      if (msg.type() === 'error' && !text.includes('[events] disconnected')) logs.push(`main: ${text}`)
    })

    const page = await showMenubarWindow(app)
    // The menubar preloads the dashboard at LAUNCH — before this test can attach its
    // page.route mocks — so that first load's /api + /events requests hit the
    // hermetic dead-daemon proxy (playwright.config webServer) and 502. That is
    // deterministic startup noise, not the scroll behavior under test — but only
    // until the mocks attach: after mocksReady flips, a 502 is a REAL failure (an
    // API request the fixture forgot to cover) and must fail the run.
    // App.tsx's fetchEntries().catch logs the same pre-mock daemon-unreachable
    // condition via console.warn('[boardroom] failed to fetch entries', err) — a
    // different text shape than the browser's native "Failed to load resource"
    // message, and the underlying error varies (a non-JSON 502 body via the vite
    // proxy, or a raw "TypeError: Failed to fetch" when the connection is refused
    // outright), so match on the log's own prefix rather than the error detail —
    // same approach as the unconditional '[boardroom] card stream error' clause.
    let mocksReady = false
    page.on('console', msg => {
      const text = msg.text()
      if (text.includes('[boardroom] card stream error')) return
      if (!mocksReady && text.includes('Failed to load resource') && text.includes('502')) return
      if (!mocksReady && text.includes('[boardroom] failed to fetch entries')) return
      if (msg.type() === 'warning' || msg.type() === 'error') logs.push(`page ${msg.type()}: ${text}`)
    })
    page.on('pageerror', err => logs.push(`pageerror: ${err.message}`))
    await mockBoardroomApi(page)
    const dashboardUrl = `http://127.0.0.1:5177/?e2e=${Date.now()}`

    // mocksReady flips AFTER this goto, not right after mockBoardroomApi resolves:
    // mockBoardroomApi only registers page.route handlers, it doesn't wait for the
    // preloaded window's own pre-mock fetches (fired at Electron launch, against the
    // still-unmocked page) to finish rejecting — those console messages can land a
    // few ms after route registration, which is still "before this test's page load"
    // in every way that matters. Gating on the goto instead of on mockBoardroomApi's
    // resolution ties the cutover to a real event boundary (the old, unmocked
    // document is replaced by the new, mocked one) instead of a wall-clock race.
    await page.goto(`${dashboardUrl}#/card/${scrollCards[0].id}`, { waitUntil: 'domcontentloaded' })
    mocksReady = true
    await expect(page.getByRole('heading', { name: scrollCards[0].headline })).toBeVisible()
    const initial = await readState(page)
    expect(initial.scrollY).toBe(0)
    expect(initial.scrollHeight).toBeGreaterThan(1200)

    const targetA = await safeScrollTarget(page)
    expect(targetA).toBeGreaterThan(250)
    await page.evaluate(top => window.scrollTo(0, top), targetA)
    const scrolledA = await readState(page)
    expect(Math.round(scrolledA.scrollY)).toBe(targetA)

    await page.locator(`a[href="#/card/${scrollCards[1].id}"]`).click()
    await waitForCardHash(page, scrollCards[1].id)
    await expect(page.getByRole('heading', { name: scrollCards[1].headline })).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    const savedA = await storedSessionScrollTop(page, scrollCards[0])
    expect(savedA).toBe(Math.round(scrolledA.scrollY))
    await page.screenshot({ path: '/tmp/boardroom-e2e-menubar-b-top.png', fullPage: false })

    await page.locator(`a[href="#/card/${scrollCards[2].id}"]`).click()
    await waitForCardHash(page, scrollCards[2].id)
    await expect(page.getByRole('heading', { name: scrollCards[2].headline })).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    expect(await storedSessionScrollTop(page, scrollCards[0])).toBe(savedA)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: scrollCards[2].headline })).toBeVisible()

    await page.locator(`a[href="#/card/${scrollCards[0].id}"]`).click()
    await waitForCardHash(page, scrollCards[0].id)
    await expect(page.getByRole('heading', { name: scrollCards[0].headline })).toBeVisible()
    const restoredA = await reachableScrollTop(page, savedA ?? -1)
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(restoredA)
    expect(restoredA).toBeGreaterThan(250)
    await page.screenshot({ path: '/tmp/boardroom-e2e-menubar-a-restored.png', fullPage: false })

    expect(logs).toEqual([])
  } finally {
    await app?.close()
  }
})
