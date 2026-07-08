// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../../src/shared/card.js'
import type { Entry } from '../../src/shared/entry.js'
import type { SessionVM } from './api.js'
import { SessionStream } from './SessionStream.js'

vi.mock('./api.js', () => ({
  decideCard: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchCards: vi.fn(() => Promise.resolve([])),
  subscribeCards: vi.fn(() => () => {}),
}))

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.clearAllMocks()
})

function card(overrides: Partial<Card> & Pick<Card, 'id' | 'headline' | 'createdAt'>): Card {
  return {
    stage: 'plan',
    session: { agent: 'codex', project: 'p', title: 'Checkout sprint' },
    blocks: [],
    decisions: [
      {
        id: 'd1',
        prompt: 'Decide?',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      },
    ],
    status: 'pending',
    ...overrides,
  }
}

const vm: SessionVM = {
  sessionId: 'cc-A', machineId: 'm', pid: 1, cwd: '/tmp/p', project: 'p',
  status: 'alive', capturedAt: '2026-07-02T10:00:00.000Z', lastSeenAt: '2026-07-02T12:00:00.000Z',
  sessionStatus: 'needs-decision', pendingCount: 1, cardCount: 2,
}

function reportEntry(overrides: Partial<Entry> & Pick<Entry, 'id' | 'createdAt'>): Entry {
  return {
    type: 'report',
    claudeSessionId: 'cc-A',
    session: { agent: 'claude-code', project: 'p' },
    headline: 'investigation findings',
    blocks: [{ id: 'b1', type: 'markdown', text: 'summary' }],
    ...overrides,
  } as Entry
}

function tagEntry(overrides: Partial<Entry> & Pick<Entry, 'id' | 'createdAt'>): Entry {
  return {
    type: 'tag',
    claudeSessionId: 'cc-A',
    session: { agent: 'claude-code', project: 'p' },
    tag: 'stage:plan:decided',
    cardId: 'c1',
    ...overrides,
  } as Entry
}

describe('SessionStream', () => {
  it('renders the session header with status tag and cards oldest-first', () => {
    const older = card({ id: 'old', claudeSessionId: 'cc-A', createdAt: '2026-07-02T10:00:00.000Z', headline: 'first gate' })
    const newer = card({ id: 'new', claudeSessionId: 'cc-A', createdAt: '2026-07-02T11:00:00.000Z', headline: 'second gate' })
    render(<SessionStream session={vm} cards={[newer, older]} entries={[]} />)
    expect(screen.getByText('needs-decision')).toBeTruthy()
    // CardView renders each headline as an <h1> (see CardHeader.tsx), so — per the
    // brief's fallback — assert DOM order via the .stream-item wrapper order instead
    // of heading level.
    const headlines = screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)
    expect(headlines.indexOf('first gate')).toBeLessThan(headlines.indexOf('second gate'))
  })

  it('shows an empty state when the session has no cards yet', () => {
    render(<SessionStream session={vm} cards={[]} entries={[]} />)
    expect(screen.getByText('No cards from this session yet.')).toBeTruthy()
  })

  it('interleaves a report entry between two cards by createdAt ASC', () => {
    const older = card({ id: 'old', claudeSessionId: 'cc-A', createdAt: '2026-07-02T10:00:00.000Z', headline: 'first gate' })
    const newer = card({ id: 'new', claudeSessionId: 'cc-A', createdAt: '2026-07-02T12:00:00.000Z', headline: 'second gate' })
    const report = reportEntry({ id: 'e1', createdAt: '2026-07-02T11:00:00.000Z', headline: 'midway findings' })
    render(<SessionStream session={vm} cards={[newer, older]} entries={[report]} />)

    const headlines = screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)
    expect(headlines.indexOf('first gate')).toBeLessThan(headlines.indexOf('second gate'))

    const stream = screen.getByLabelText('Session stream')
    const order = [...stream.querySelectorAll('.stream-item, .entry-report, .entry-tag')]
    const idxOld = order.findIndex(el => el.textContent?.includes('first gate'))
    const idxReport = order.findIndex(el => el.textContent?.includes('midway findings'))
    const idxNew = order.findIndex(el => el.textContent?.includes('second gate'))
    expect(idxOld).toBeLessThan(idxReport)
    expect(idxReport).toBeLessThan(idxNew)
  })

  it('renders a tag entry as a slim row with a "stage · event" label linking to the card', () => {
    const tag = tagEntry({ id: 't1', createdAt: '2026-07-02T10:30:00.000Z', tag: 'stage:plan:decided', cardId: 'c-plan' })
    render(<SessionStream session={vm} cards={[]} entries={[tag]} />)

    const link = screen.getByRole('link', { name: /plan.*decided/i })
    expect(link.getAttribute('href')).toBe('#/card/c-plan')
    expect(link.closest('.entry-tag')).toBeTruthy()
  })
})
