import { expect, test, type Page } from '@playwright/test'
import {
  mockBoardroomApi,
  reachableScrollTop,
  safeScrollTarget,
  scrollCards,
  storedSessionScrollTop,
} from './sessionScroll.fixture.js'

async function readState(page: Page): Promise<{ h1: string | undefined; scrollHeight: number; scrollY: number; url: string }> {
  return page.evaluate(() => ({
    h1: document.querySelector('h1')?.textContent ?? undefined,
    scrollHeight: document.documentElement.scrollHeight,
    scrollY: window.scrollY,
    url: location.href,
  }))
}

async function waitForCardHash(page: Page, id: string): Promise<void> {
  await page.waitForFunction(expected => location.hash === `#/card/${expected}`, id)
}

test('browser dashboard restores a session scroll position after route switch and reload', async ({ page }) => {
  const logs: string[] = []
  page.on('console', msg => {
    if (msg.type() === 'warning' || msg.type() === 'error') logs.push(`${msg.type()}: ${msg.text()}`)
  })
  page.on('pageerror', err => logs.push(`pageerror: ${err.message}`))
  await mockBoardroomApi(page)

  await page.goto(`/#/card/${scrollCards[0].id}`, { waitUntil: 'domcontentloaded' })
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
  await page.screenshot({ path: '/tmp/boardroom-e2e-browser-b-top.png', fullPage: false })

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
  await page.screenshot({ path: '/tmp/boardroom-e2e-browser-a-restored.png', fullPage: false })

  expect(logs).toEqual([])
})
