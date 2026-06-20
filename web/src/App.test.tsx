// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../../src/shared/card.js'
import { fetchCards, subscribeCards } from './api.js'
import { App } from './App.js'
import { fileHash } from './fileView.js'

vi.mock('./api.js', () => ({
  fetchCards: vi.fn(),
  subscribeCards: vi.fn(),
}))

// notify.js reaches for the Notification API / permissions; stub it so App mounts
// cleanly in jsdom and never fires a real notification during the test.
vi.mock('./notify.js', () => ({
  notifyCard: vi.fn(),
  notifyPermission: () => 'granted',
  requestNotify: vi.fn(),
}))

function card(id: string, headline: string): Card {
  return {
    id,
    stage: 'clarify',
    session: { agent: 'codex', project: 'boardroom' },
    headline,
    blocks: [],
    decisions: [{ id: 'd', prompt: 'Pick one', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
    status: 'pending',
    createdAt: '2026-06-16T12:00:00.000Z',
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.location.hash = ''
})

describe('App initial-fetch / SSE race', () => {
  it('keeps a card delivered by SSE before the initial fetch resolves', async () => {
    let resolveFetch!: (cards: Card[]) => void
    vi.mocked(fetchCards).mockReturnValue(new Promise<Card[]>(r => { resolveFetch = r }))
    let onCard: (c: Card) => void = () => {}
    vi.mocked(subscribeCards).mockImplementation(cb => { onCard = cb; return () => {} })

    render(<App />)

    // The EventSource delivers a card while the GET /api/cards is still in flight.
    act(() => onCard(card('sse-1', 'Live SSE card')))

    // The initial fetch then resolves WITHOUT that card. A blind replace would
    // wipe it; the merge must keep it.
    await act(async () => { resolveFetch([]) })

    expect((await screen.findAllByText('Live SSE card')).length).toBeGreaterThan(0)
    expect(screen.queryByText('The table is clear')).toBeNull()
  })
})

describe('file-viewer route', () => {
  it('renders the in-app viewer for a #/file route with a Back affordance', async () => {
    vi.mocked(fetchCards).mockResolvedValue([])
    vi.mocked(subscribeCards).mockImplementation(() => () => {})
    window.location.hash = fileHash({ url: '/api/x/a1', name: 'shot.png', mime: 'image/png' })

    render(<App />)

    expect(await screen.findByAltText('shot.png')).toBeTruthy()
    expect(screen.getByRole('button', { name: /back/i })).toBeTruthy()
  })

  it('returns to the dashboard when Back is clicked', async () => {
    vi.mocked(fetchCards).mockResolvedValue([])
    vi.mocked(subscribeCards).mockImplementation(() => () => {})
    window.location.hash = fileHash({ url: '/api/x/a1', name: 'shot.png', mime: 'image/png' })

    render(<App />)
    await screen.findByAltText('shot.png')

    fireEvent.click(screen.getByRole('button', { name: /back/i }))

    await waitFor(() => expect(screen.queryByAltText('shot.png')).toBeNull())
    expect(window.location.hash).toBe('')
  })
})
