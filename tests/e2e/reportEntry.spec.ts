import { expect, test } from '@playwright/test'
import { browserCard, browserReport, browserTag, mockBoardroomApi } from './sessionScroll.fixture.js'

test('session stream interleaves a report and a tag with the card, oldest-first, unread + drawer + FIFO count untouched', async ({ page }) => {
  // Seeded ADVERSARIAL order — newest-first in the array AND interleaved with
  // another session's items — so a sort regression in SessionStream (or in the
  // fixture's per-session filtering) actually fails the positional assertions
  // below instead of passing by accident of insertion order.
  const cards = [
    browserCard('other-1', 'Session Two', 'other session gate', '2026-07-03T09:00:00.000Z', { claudeSessionId: 'cc-B' }),
    browserCard('a-gate', 'Session One', 'the gate card', '2026-07-03T08:00:00.000Z', { claudeSessionId: 'cc-A' }),
  ]
  const entries = [
    browserTag('other-tag', 'Session Two', 'stage:clarify:raised', 'other-1', '2026-07-03T09:05:00.000Z', { claudeSessionId: 'cc-B' }),
    browserTag('a-tag', 'Session One', 'stage:clarify:decided', 'a-gate', '2026-07-03T08:10:00.000Z', { claudeSessionId: 'cc-A' }),
    browserReport('a-report', 'Session One', 'investigation findings', '2026-07-03T08:05:00.000Z', { claudeSessionId: 'cc-A' }),
  ]
  await mockBoardroomApi(page, cards, entries)
  await page.goto('/#/session/cc-A')

  const stream = page.getByLabel('Session stream')

  // Positional order: card (08:00) -> report (08:05) -> tag (08:10). Assert both
  // ends plus overall stream children order so a partial-sort bug can't hide.
  const items = stream.locator('.stream-item, .entry-report, .entry-tag')
  await expect(items).toHaveCount(3)
  await expect(items.nth(0)).toHaveClass(/stream-item/)
  await expect(items.nth(0)).toContainText('the gate card')
  await expect(items.nth(1)).toHaveClass(/entry-report/)
  await expect(items.nth(1)).toContainText('investigation findings')
  await expect(items.nth(2)).toHaveClass(/entry-tag/)
  await expect(items.nth(2)).toContainText('clarify · decided')

  // The other session's card, report, and tag never leak into cc-A's stream.
  await expect(stream.locator('.stream-item, .entry-report, .entry-tag')).not.toContainText([
    'other session gate',
  ])
  await expect(stream.locator('.entry-tag')).toHaveCount(1)

  // Unread dot: the report entry starts unread (fresh browser context -> clean
  // localStorage, so readState.isRead('a-report') is false).
  const report = stream.locator('.entry-report')
  await expect(report.locator('.entry-unread-dot')).toBeVisible()

  // Opening the report marks it read and reveals the full-size drawer.
  await report.getByRole('button', { name: 'Open report' }).click()
  const drawer = page.locator('.report-drawer')
  await expect(drawer).toBeVisible()
  await expect(drawer).toContainText('investigation findings')

  // Sidebar's "N waiting" count reflects only the pending card — the report
  // entry (read or unread) never inflates it (tray-separation).
  await expect(page.locator('.side-count')).toHaveText('2 waiting')
})
