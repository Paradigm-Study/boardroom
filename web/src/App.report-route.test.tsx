// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../../src/shared/card.js'
import type { ReportEntry } from '../../src/shared/entry.js'
import { fetchCards, fetchEntries, fetchSessions, subscribeStream } from './api.js'
import { App } from './App.js'

// Isolated from App.test.tsx (which has other in-flight edits) so this task's new
// #/report/<id> route coverage doesn't collide with unrelated work-in-progress.
// Mocking conventions mirror App.test.tsx exactly.
vi.mock('./api.js', () => ({
  fetchCards: vi.fn(),
  fetchEntries: vi.fn(),
  fetchSessions: vi.fn(),
  subscribeStream: vi.fn(),
  getAuthStatus: vi.fn(() => Promise.resolve({ connected: true, login: { state: 'idle' } })),
}))

vi.mock('./notify.js', () => ({
  notifyCard: vi.fn(),
  notifyPermission: () => 'granted',
  requestNotify: vi.fn(),
}))

function report(overrides: Partial<ReportEntry> = {}): ReportEntry {
  return {
    id: 'r1',
    type: 'report',
    claudeSessionId: 'cc-A',
    session: { agent: 'claude-code', project: 'p', title: 'Spine session' },
    headline: 'investigation findings',
    blocks: [{ id: 'b1', type: 'markdown', text: 'full report body' }],
    createdAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(fetchCards).mockResolvedValue([])
  vi.mocked(fetchSessions).mockResolvedValue([])
  vi.mocked(subscribeStream).mockImplementation(() => () => {})
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.location.hash = ''
})

describe('App #/report/<id> route', () => {
  it('renders ReportView for a known report entry inside the normal sidebar frame', async () => {
    vi.mocked(fetchEntries).mockResolvedValue([report()])
    window.location.hash = '#/report/r1'

    render(<App />)

    expect(await screen.findByRole('heading', { name: 'investigation findings' })).toBeTruthy()
    expect(screen.getByText('full report body')).toBeTruthy()
    // The normal TaskSidebar frame stays present around the report view.
    expect(screen.getByText('boardroom')).toBeTruthy()
  })

  it('shows "Report not found." for an unknown id once the initial load settles', async () => {
    vi.mocked(fetchEntries).mockResolvedValue([])
    window.location.hash = '#/report/missing'

    render(<App />)

    expect(await screen.findByText('Report not found.')).toBeTruthy()
  })

  it('shows Loading (not "Report not found.") while the initial fetch is in flight — same gate as the card route', () => {
    // initialLoadDone (the loading/not-found gate) flips on the CARDS fetch settling,
    // exactly like the existing "Card not found." test — mirrored here verbatim.
    let resolveFetch!: (cards: Card[]) => void
    vi.mocked(fetchCards).mockReturnValue(new Promise<Card[]>(r => { resolveFetch = r }))
    vi.mocked(fetchEntries).mockResolvedValue([report()])
    window.location.hash = '#/report/r1'

    render(<App />)
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByText('Report not found.')).toBeNull()

    act(() => { resolveFetch([]) })
  })
})
