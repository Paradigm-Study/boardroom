import { expect, test } from '@playwright/test'
import { browserCard, mockBoardroomApi } from './sessionScroll.fixture.js'

test('session stream shows one session\'s cards oldest-first with its status tag', async ({ page }) => {
  const cards = [
    browserCard('s1-old', 'Session One', 'first gate', '2026-07-02T10:00:00.000Z', { claudeSessionId: 'cc-A' }),
    browserCard('s1-new', 'Session One', 'second gate', '2026-07-02T11:00:00.000Z', { claudeSessionId: 'cc-A' }),
    browserCard('s2', 'Session Two', 'other session gate', '2026-07-02T10:30:00.000Z', { claudeSessionId: 'cc-B' }),
  ]
  await mockBoardroomApi(page, cards)
  await page.goto('/#/session/cc-A')

  const stream = page.getByLabel('Session stream')
  await expect(stream.locator('.stream-item')).toHaveCount(2)
  await expect(stream.locator('.stream-status')).toHaveText('needs-decision')
  const first = stream.locator('.stream-item').first()
  await expect(first).toContainText('first gate')
  await expect(stream.locator('.stream-item')).not.toContainText(['other session gate'])
})
