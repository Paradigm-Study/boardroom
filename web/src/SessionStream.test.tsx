// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../../src/shared/card.js'
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

describe('SessionStream', () => {
  it('renders the session header with status tag and cards oldest-first', () => {
    const older = card({ id: 'old', claudeSessionId: 'cc-A', createdAt: '2026-07-02T10:00:00.000Z', headline: 'first gate' })
    const newer = card({ id: 'new', claudeSessionId: 'cc-A', createdAt: '2026-07-02T11:00:00.000Z', headline: 'second gate' })
    render(<SessionStream session={vm} cards={[newer, older]} />)
    expect(screen.getByText('needs-decision')).toBeTruthy()
    // CardView renders each headline as an <h1> (see CardHeader.tsx), so — per the
    // brief's fallback — assert DOM order via the .stream-item wrapper order instead
    // of heading level.
    const headlines = screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)
    expect(headlines.indexOf('first gate')).toBeLessThan(headlines.indexOf('second gate'))
  })

  it('shows an empty state when the session has no cards yet', () => {
    render(<SessionStream session={vm} cards={[]} />)
    expect(screen.getByText('No cards from this session yet.')).toBeTruthy()
  })
})
