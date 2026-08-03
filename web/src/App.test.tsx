// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../../src/shared/card.js'
import { fetchCards, fetchEntries, fetchSessions, subscribeStream } from './api.js'
import { App } from './App.js'
import { fileHash } from './fileView.js'

vi.mock('./api.js', () => ({
  fetchCards: vi.fn(),
  fetchEntries: vi.fn(),
  fetchSessions: vi.fn(),
  subscribeStream: vi.fn(),
  // App polls this on mount; default to connected so no account banner renders in
  // these tests (they assert card/stream behavior, not the connect affordance).
  getAuthStatus: vi.fn(() => Promise.resolve({ connected: true, login: { state: 'idle' } })),
}))

// notify.js reaches for the Notification API / permissions; stub it so App mounts
// cleanly in jsdom and never fires a real notification during the test.
vi.mock('./notify.js', () => ({
  notifyCard: vi.fn(),
  notifyPermission: () => 'granted',
  requestNotify: vi.fn(),
}))

function card(id: string, headline: string, session: Card['session'] = { agent: 'codex', project: 'boardroom' }): Card {
  return {
    id,
    stage: 'clarify',
    session,
    headline,
    blocks: [],
    decisions: [{ id: 'd', prompt: 'Pick one', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
    status: 'pending',
    createdAt: '2026-06-16T12:00:00.000Z',
  }
}

function mockWindowScroll() {
  let scrollY = 0
  let nextScrollY: number | undefined
  const scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
    scrollY = typeof options === 'number' ? y ?? 0 : options?.top ?? 0
  })

  Object.defineProperty(window, 'scrollY', {
    configurable: true,
    get: () => {
      if (nextScrollY !== undefined) {
        const y = nextScrollY
        nextScrollY = undefined
        return y
      }
      return scrollY
    },
  })
  Object.defineProperty(window, 'scrollTo', { configurable: true, value: scrollTo })
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    },
  })
  Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: vi.fn() })

  const lastScrollTop = (): number | undefined => {
    const call = scrollTo.mock.calls.at(-1)
    if (!call) return undefined
    return typeof call[0] === 'number' ? call[1] : call[0]?.top
  }

  return {
    scrollTo,
    setScrollY: (y: number) => { scrollY = y },
    interceptNextScrollY: (y: number) => { nextScrollY = y },
    clearNextScrollY: () => { nextScrollY = undefined },
    lastScrollTop,
  }
}

const scrollStorageKey = 'boardroom.sessionScroll.v1'
const scrollKey = (session: Card['session']): string =>
  `${session.project}\u0000${session.title?.trim() || 'Untitled session'}\u0000${session.agent}`

beforeEach(() => {
  Object.defineProperty(window, 'scrollTo', { configurable: true, value: vi.fn() })
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    },
  })
  Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: vi.fn() })
  // Sessions now poll on every route (feeds the sidebar's status tags) — default to
  // an empty list so a test that doesn't care about sessions isn't forced to mock it.
  vi.mocked(fetchSessions).mockResolvedValue([])
  // Same additive-default reasoning: a test that doesn't care about entries
  // shouldn't be forced to mock fetchEntries.
  vi.mocked(fetchEntries).mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  vi.clearAllMocks()
  window.location.hash = ''
})

describe('App initial-fetch / SSE race', () => {
  it('keeps a card delivered by SSE before the initial fetch resolves', async () => {
    let resolveFetch!: (cards: Card[]) => void
    vi.mocked(fetchCards).mockReturnValue(new Promise<Card[]>(r => { resolveFetch = r }))
    let onCard: (c: Card) => void = () => {}
    vi.mocked(subscribeStream).mockImplementation(cb => { onCard = cb; return () => {} })

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

describe('App SSE reconnect', () => {
  it('refetches cards and entries when the stream reconnects after a drop', async () => {
    vi.mocked(fetchCards).mockResolvedValue([card('k1', 'Original headline')])
    let onStatus: ((online: boolean) => void) | undefined
    vi.mocked(subscribeStream).mockImplementation((_onCard, _onEntry, statusCb) => {
      onStatus = statusCb
      return () => {}
    })

    render(<App />)
    expect((await screen.findAllByText('Original headline')).length).toBeGreaterThan(0)
    expect(vi.mocked(fetchCards)).toHaveBeenCalledTimes(1)

    // Frames emitted while the tab is disconnected are gone for good — the SSE
    // stream has no replay — so reconnect must refetch, and the refetched copy
    // must REPLACE the stale one (unlike the initial-load merge).
    vi.mocked(fetchCards).mockResolvedValue([{ ...card('k1', 'Decided while offline'), status: 'decided' as const }])
    await act(async () => { onStatus?.(false) })
    await act(async () => { onStatus?.(true) })

    expect(vi.mocked(fetchCards)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetchEntries)).toHaveBeenCalledTimes(2)
    expect((await screen.findAllByText('Decided while offline')).length).toBeGreaterThan(0)
  })

  it('does not refetch on the initial open (no prior drop)', async () => {
    vi.mocked(fetchCards).mockResolvedValue([])
    let onStatus: ((online: boolean) => void) | undefined
    vi.mocked(subscribeStream).mockImplementation((_onCard, _onEntry, statusCb) => {
      onStatus = statusCb
      return () => {}
    })

    render(<App />)
    // EventSource fires 'open' on the very first connect too — that must not
    // double the initial load.
    await act(async () => { onStatus?.(true) })

    expect(vi.mocked(fetchCards)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetchEntries)).toHaveBeenCalledTimes(1)
  })
})

describe('App hides dismissed cards', () => {
  it('a dismissed card never renders on the board', async () => {
    vi.mocked(fetchCards).mockResolvedValue([
      { ...card('gone', 'Retired duplicate'), status: 'dismissed' as const },
      card('live', 'Still needs you'),
    ])
    vi.mocked(subscribeStream).mockImplementation(() => () => {})

    render(<App />)

    expect((await screen.findAllByText('Still needs you')).length).toBeGreaterThan(0)
    expect(screen.queryByText('Retired duplicate')).toBeNull()
  })

  it('a card dismissed live over SSE disappears from the board', async () => {
    vi.mocked(fetchCards).mockResolvedValue([card('c1', 'Reconnecting gate')])
    let onCard: (c: Card) => void = () => {}
    vi.mocked(subscribeStream).mockImplementation(cb => { onCard = cb; return () => {} })

    render(<App />)
    expect((await screen.findAllByText('Reconnecting gate')).length).toBeGreaterThan(0)

    // The daemon dismisses it (e.g. a retired twin) and pushes the terminal status.
    act(() => onCard({ ...card('c1', 'Reconnecting gate'), status: 'dismissed' as const }))
    await waitFor(() => expect(screen.queryByText('Reconnecting gate')).toBeNull())
  })
})

describe('session navigation scroll memory', () => {
  it('starts first-time sessions at top and restores each session on return', async () => {
    const scroll = mockWindowScroll()
    const sessionA = card('session-a', 'Session A decision', { agent: 'codex', project: 'boardroom', title: 'Session A' })
    const sessionB = card('session-b', 'Session B decision', { agent: 'codex', project: 'boardroom', title: 'Session B' })
    const sessionC = card('session-c', 'Session C decision', { agent: 'codex', project: 'boardroom', title: 'Session C' })
    vi.mocked(fetchCards).mockResolvedValue([sessionA, sessionB, sessionC])
    vi.mocked(subscribeStream).mockImplementation(() => () => {})
    window.location.hash = '#/card/session-a'

    render(<App />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Session A decision' })).toBeTruthy()

    scroll.scrollTo.mockClear()
    scroll.setScrollY(640)
    window.addEventListener('hashchange', () => scroll.interceptNextScrollY(375), { once: true })
    act(() => {
      window.location.hash = '#/card/session-b'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    scroll.clearNextScrollY()

    expect(await screen.findByRole('heading', { level: 1, name: 'Session B decision' })).toBeTruthy()
    await waitFor(() => expect(scroll.lastScrollTop()).toBe(0))

    scroll.scrollTo.mockClear()
    scroll.setScrollY(280)
    act(() => {
      window.location.hash = '#/card/session-c'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    expect(await screen.findByRole('heading', { level: 1, name: 'Session C decision' })).toBeTruthy()
    await waitFor(() => expect(scroll.lastScrollTop()).toBe(0))

    scroll.scrollTo.mockClear()
    scroll.setScrollY(120)
    act(() => {
      window.location.hash = '#/card/session-a'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    expect(await screen.findByRole('heading', { level: 1, name: 'Session A decision' })).toBeTruthy()
    await waitFor(() => expect(scroll.lastScrollTop()).toBe(640))
  })

  it('lands the #/session/<id> stream view at the top, not the previous view\'s offset', async () => {
    const scroll = mockWindowScroll()
    const bound = { ...card('k1', 'Bound decision', { agent: 'codex', project: 'boardroom', title: 'Spine session' }), claudeSessionId: 'cc-A' }
    vi.mocked(fetchCards).mockResolvedValue([bound])
    vi.mocked(subscribeStream).mockImplementation(() => () => {})
    window.location.hash = '#/card/k1'

    render(<App />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Bound decision' })).toBeTruthy()

    scroll.scrollTo.mockClear()
    scroll.setScrollY(640) // deep in the card view when the stream link is clicked
    act(() => {
      window.location.hash = '#/session/cc-A'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    expect(await screen.findByLabelText('Session stream')).toBeTruthy()
    await waitFor(() => expect(scroll.lastScrollTop()).toBe(0))
  })

  it('keeps session scroll memory across a dashboard reload in the same window', async () => {
    const scroll = mockWindowScroll()
    const sessionA = card('session-a', 'Session A decision', { agent: 'codex', project: 'boardroom', title: 'Session A' })
    const sessionB = card('session-b', 'Session B decision', { agent: 'codex', project: 'boardroom', title: 'Session B' })
    const sessionC = card('session-c', 'Session C decision', { agent: 'codex', project: 'boardroom', title: 'Session C' })
    vi.mocked(fetchCards).mockResolvedValue([sessionA, sessionB, sessionC])
    vi.mocked(subscribeStream).mockImplementation(() => () => {})
    window.location.hash = '#/card/session-a'

    const first = render(<App />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Session A decision' })).toBeTruthy()
    scroll.scrollTo.mockClear()
    scroll.setScrollY(640)

    act(() => {
      window.location.hash = '#/card/session-b'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(await screen.findByRole('heading', { level: 1, name: 'Session B decision' })).toBeTruthy()
    await waitFor(() => expect(scroll.lastScrollTop()).toBe(0))

    scroll.scrollTo.mockClear()
    scroll.setScrollY(280)
    act(() => {
      window.location.hash = '#/card/session-c'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(await screen.findByRole('heading', { level: 1, name: 'Session C decision' })).toBeTruthy()
    await waitFor(() => expect(scroll.lastScrollTop()).toBe(0))

    first.unmount()
    scroll.scrollTo.mockClear()
    scroll.setScrollY(0)

    render(<App />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Session C decision' })).toBeTruthy()
    act(() => {
      window.location.hash = '#/card/session-a'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    expect(await screen.findByRole('heading', { level: 1, name: 'Session A decision' })).toBeTruthy()
    await waitFor(() => expect(scroll.lastScrollTop()).toBe(640))
  })

  it('a real save preserves OTHER sessions\' stored entries (prune/slice must not drop them)', async () => {
    const scroll = mockWindowScroll()
    const liveSession = { agent: 'codex', project: 'boardroom', title: 'Live session' }
    const preservedSession = { agent: 'codex', project: 'boardroom', title: 'Preserved session' }
    sessionStorage.setItem(scrollStorageKey, JSON.stringify({
      [scrollKey(liveSession)]: { top: 280, updatedAt: Date.now() },
      [scrollKey(preservedSession)]: { top: 640, updatedAt: Date.now() },
    }))
    vi.mocked(fetchCards).mockResolvedValue([card('live', 'Live decision', liveSession)])
    vi.mocked(subscribeStream).mockImplementation(() => () => {})
    window.location.hash = '#/card/live'

    render(<App />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Live decision' })).toBeTruthy()

    // Trigger an ACTUAL save (writeSessionScroll runs its TTL-prune + entry-cap
    // slice) — a hashchange saves the live session's position…
    scroll.setScrollY(97)
    act(() => {
      window.location.hash = '#/card/other'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    await waitFor(() => {
      const stored = JSON.parse(sessionStorage.getItem(scrollStorageKey) ?? '{}') as Record<string, { top: number }>
      expect(stored[scrollKey(liveSession)]?.top).toBe(97)            // …proving the write happened…
      expect(stored[scrollKey(preservedSession)]?.top).toBe(640)      // …without dropping the foreign entry.
    })
  })
})

describe('in-page block anchors (evidence links)', () => {
  it('an anchor hash keeps the open card in place — auto-open must not yank to another card', async () => {
    // 'anchored' is the older card the human deep-linked into; 'newest' is a fresher
    // pending gate auto-open would otherwise prefer.
    const anchored = card('anchored', 'Anchored decision')
    const newest = { ...card('newest', 'Newest decision'), createdAt: '2026-06-17T12:00:00.000Z' }
    vi.mocked(fetchCards).mockResolvedValue([anchored, newest])
    vi.mocked(subscribeStream).mockImplementation(() => () => {})
    window.location.hash = '#/card/anchored'

    render(<App />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Anchored decision' })).toBeTruthy()

    // Click an evidence link: the browser sets an in-page #block-… hash.
    act(() => {
      window.location.hash = '#block-d-b1'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    expect(await screen.findByRole('heading', { level: 1, name: 'Anchored decision' })).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1, name: 'Newest decision' })).toBeNull()
    expect(window.location.hash).toBe('#block-d-b1') // not rewritten to #/card/newest
  })
})

describe('deep-link loading state', () => {
  it('shows Loading (not "Card not found.") while the initial fetch is in flight', async () => {
    let resolveFetch!: (cards: Card[]) => void
    vi.mocked(fetchCards).mockReturnValue(new Promise<Card[]>(r => { resolveFetch = r }))
    vi.mocked(subscribeStream).mockImplementation(() => () => {})
    window.location.hash = '#/card/some-id'

    render(<App />)
    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByText('Card not found.')).toBeNull()

    act(() => { resolveFetch([]) })
    expect(await screen.findByText('Card not found.')).toBeTruthy()
  })
})

describe('file-viewer route', () => {
  it('renders the in-app viewer for a #/file route with a Back affordance', async () => {
    vi.mocked(fetchCards).mockResolvedValue([])
    vi.mocked(subscribeStream).mockImplementation(() => () => {})
    window.location.hash = fileHash({ url: '/api/x/a1', name: 'shot.png', mime: 'image/png' })

    render(<App />)

    expect(await screen.findByAltText('shot.png')).toBeTruthy()
    expect(screen.getByRole('button', { name: /back/i })).toBeTruthy()
  })

  it('returns to the dashboard when Back is clicked', async () => {
    vi.mocked(fetchCards).mockResolvedValue([])
    vi.mocked(subscribeStream).mockImplementation(() => () => {})
    window.location.hash = fileHash({ url: '/api/x/a1', name: 'shot.png', mime: 'image/png' })

    render(<App />)
    await screen.findByAltText('shot.png')

    fireEvent.click(screen.getByRole('button', { name: /back/i }))

    await waitFor(() => expect(screen.queryByAltText('shot.png')).toBeNull())
    expect(window.location.hash).toBe('')
  })
})
