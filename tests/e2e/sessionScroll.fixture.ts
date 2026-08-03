import type { Page } from '@playwright/test'

const repeated = Array.from(
  { length: 32 },
  (_, i) => `Paragraph ${i + 1}: scroll QA content keeps the decision flow tall enough to prove route-level scroll restoration.`,
).join('\n\n')

export interface BrowserCard {
  id: string
  stage: 'clarify'
  session: { agent: string; project: string; title: string }
  headline: string
  blocks: Array<{ id: string; type: 'markdown'; title: string; text: string }>
  decisions: Array<{
    id: string
    prompt: string
    blockRefs: string[]
    options: Array<{ id: string; label: string; recommended?: boolean }>
  }>
  status: 'pending'
  createdAt: string
  claudeSessionId?: string
}

export interface BrowserReportEntry {
  id: string
  type: 'report'
  claudeSessionId?: string
  session: { agent: string; project: string; title: string }
  headline: string
  blocks: Array<{ id: string; type: 'markdown'; title: string; text: string }>
  createdAt: string
}

export interface BrowserTagEntry {
  id: string
  type: 'tag'
  claudeSessionId?: string
  session: { agent: string; project: string; title: string }
  tag: string
  cardId: string
  createdAt: string
}

export type BrowserEntry = BrowserReportEntry | BrowserTagEntry

export const scrollCards: BrowserCard[] = [
  browserCard('scroll-a', 'Session A', 'Session A scroll memory card', '2026-06-30T06:00:00.000Z'),
  browserCard('scroll-b', 'Session B', 'Session B starts at top', '2026-06-30T05:59:00.000Z'),
  browserCard('scroll-c', 'Session C', 'Session C keeps A in memory', '2026-06-30T05:58:00.000Z'),
]

export const sessionScrollStorageKey = 'boardroom.sessionScroll.v1'

export function sessionScrollKey(card: BrowserCard): string {
  return `${card.session.project}\u0000${card.session.title?.trim() || 'Untitled session'}\u0000${card.session.agent}`
}

export async function storedSessionScrollTop(page: Page, card: BrowserCard): Promise<number | undefined> {
  const key = sessionScrollKey(card)
  return page.evaluate(([storageKey, sessionKey]) => {
    const parsed = JSON.parse(window.sessionStorage.getItem(storageKey) ?? '{}') as Record<string, { top?: unknown }>
    const top = parsed[sessionKey]?.top
    return typeof top === 'number' ? top : undefined
  }, [sessionScrollStorageKey, key] as const)
}

export async function reachableScrollTop(page: Page, savedTop: number): Promise<number> {
  return page.evaluate(top => {
    const maxTop = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    return Math.round(Math.min(top, maxTop))
  }, savedTop)
}

export async function safeScrollTarget(page: Page): Promise<number> {
  return page.evaluate(() => {
    const maxTop = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    return Math.round(Math.min(420, Math.max(0, maxTop - 80)))
  })
}

export function browserCard(
  id: string,
  title: string,
  headline: string,
  createdAt: string,
  overrides: Partial<Pick<BrowserCard, 'claudeSessionId'>> = {},
): BrowserCard {
  return {
    id,
    stage: 'clarify',
    session: { agent: 'playwright-qa', project: 'scroll-memory-qa', title },
    headline,
    blocks: [
      { id: 'ctx', type: 'markdown', title: `${title} context`, text: repeated },
      { id: 'global', type: 'markdown', title: 'Global notes', text: repeated },
    ],
    decisions: [{
      id: 'd',
      prompt: `Decision for ${title}`,
      blockRefs: ['ctx'],
      options: [{ id: 'a', label: 'Option A', recommended: true }, { id: 'b', label: 'Option B' }],
    }],
    status: 'pending',
    createdAt,
    ...overrides,
  }
}

export function browserReport(
  id: string,
  title: string,
  headline: string,
  createdAt: string,
  overrides: Partial<Pick<BrowserReportEntry, 'claudeSessionId'>> = {},
): BrowserReportEntry {
  return {
    id,
    type: 'report',
    session: { agent: 'playwright-qa', project: 'scroll-memory-qa', title },
    headline,
    blocks: [
      { id: 'summary', type: 'markdown', title: `${title} report`, text: repeated },
    ],
    createdAt,
    ...overrides,
  }
}

export function browserTag(
  id: string,
  title: string,
  tag: string,
  cardId: string,
  createdAt: string,
  overrides: Partial<Pick<BrowserTagEntry, 'claudeSessionId'>> = {},
): BrowserTagEntry {
  return {
    id,
    type: 'tag',
    session: { agent: 'playwright-qa', project: 'scroll-memory-qa', title },
    tag,
    cardId,
    createdAt,
    ...overrides,
  }
}

export async function mockBoardroomApi(page: Page, cards: BrowserCard[] = scrollCards, entries: BrowserEntry[] = []): Promise<void> {
  await page.addInitScript(() => {
    window.EventSource = class {
      onopen: ((event: Event) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null

      constructor() {
        window.setTimeout(() => this.onopen?.(new Event('open')), 0)
      }

      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void {}
    } as unknown as typeof EventSource
  })
  await page.route('**/api/cards', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(cards),
  }))
  // Derive one SessionVM per distinct claudeSessionId among the mocked cards — the
  // dashboard polls this on every route (4s cadence on the session/folders routes)
  // to feed the sidebar's status chips and the stream view's header. Cards without
  // a claudeSessionId (legacy, unbound) contribute no session row.
  const boundIds = [...new Set(cards.map(c => c.claudeSessionId).filter((id): id is string => Boolean(id)))]
  const sessionVMs = boundIds.map(id => {
    const ownCards = cards.filter(c => c.claudeSessionId === id)
    return {
      sessionId: id,
      machineId: 'qa-machine',
      pid: 1,
      cwd: `/tmp/${id}`,
      project: ownCards[0].session.project,
      status: 'alive' as const,
      capturedAt: '2026-07-02T10:00:00.000Z',
      lastSeenAt: '2026-07-02T12:00:00.000Z',
      sessionStatus: 'needs-decision' as const,
      pendingCount: ownCards.filter(c => c.status === 'pending').length,
      cardCount: ownCards.length,
    }
  })
  await page.route('**/api/sessions', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(sessionVMs),
  }))
  await page.route('**/api/device', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ machineId: 'qa-machine', deviceLabel: 'QA Mac' }),
  }))
  // Report/tag stream: derived from the `entries` param (default [] — existing
  // callers that don't pass entries keep getting a harmlessly empty feed rather
  // than hitting the (nonexistent, in this hermetic run) daemon port). Route both
  // the global and per-session variants — mirrors how /api/sessions is mocked
  // above. The per-session route filters by claudeSessionId, matching the real
  // daemon's GET /api/sessions/:id/entries handler.
  await page.route('**/api/entries', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(entries),
  }))
  await page.route('**/api/sessions/*/entries', route => {
    const url = new URL(route.request().url())
    const sessionId = url.pathname.split('/').at(-2)
    const ownEntries = entries.filter(e => e.claudeSessionId === sessionId)
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(ownEntries),
    })
  })
}
