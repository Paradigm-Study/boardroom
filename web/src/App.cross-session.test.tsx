// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../../src/shared/card.js'
import { fetchCards, fetchEntries, fetchSessions, subscribeStream } from './api.js'
import { App } from './App.js'

// CHARACTERIZATION TESTS for the dashboard's gate selection across sessions.
//   [BEHAVIOR] = the actual, possibly-surprising rule
//   [CORRECT]  = a guardrail that holds (no content is mixed between cards)
//
// The user's report ("a session's gate is getting another session's content") most
// literally describes the daemon reattach layer (queue.cross-session.test.ts). These
// tests isolate what the DASHBOARD actually does: on root it auto-opens the single
// most-recent PENDING card across ALL sessions, with no notion of a "current" session
// to scope to — but it renders each card's OWN content faithfully (no mixing here).

vi.mock('./api.js', () => ({ fetchCards: vi.fn(), fetchEntries: vi.fn(), fetchSessions: vi.fn(), subscribeStream: vi.fn(), getAuthStatus: vi.fn(() => Promise.resolve({ connected: true, login: { state: 'idle' } })) }))
vi.mock('./notify.js', () => ({
  notifyCard: vi.fn(),
  notifyPermission: () => 'granted',
  requestNotify: vi.fn(),
}))

function gate(id: string, headline: string, session: Card['session'], createdAt: string): Card {
  return {
    id, stage: 'clarify', session, headline, blocks: [],
    decisions: [{ id: 'd', prompt: `${headline} — pick one`, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
    status: 'pending', createdAt,
  }
}

beforeEach(() => {
  Object.defineProperty(window, 'scrollTo', { configurable: true, value: vi.fn() })
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true, value: (cb: FrameRequestCallback) => { cb(0); return 1 },
  })
  Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: vi.fn() })
  window.location.hash = ''
  // Sessions now poll on every route (feeds the sidebar's status tags) — default to
  // an empty list so a test that doesn't care about sessions isn't forced to mock it.
  vi.mocked(fetchSessions).mockResolvedValue([])
  // Same additive-default reasoning: a test that doesn't care about entries
  // shouldn't be forced to mock fetchEntries.
  vi.mocked(fetchEntries).mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  window.location.hash = ''
})

describe('dashboard gate selection across sessions', () => {
  const older = gate('A', 'Session A decision', { agent: 'claude-code', project: 'repo-one', title: 'Session A' }, '2026-06-30T10:00:00.000Z')
  const newer = gate('B', 'Session B decision', { agent: 'codex', project: 'repo-two', title: 'Session B' }, '2026-06-30T11:00:00.000Z')

  it('[BEHAVIOR] on root, auto-opens the most-recent pending card across ALL sessions — not a current session\'s', async () => {
    vi.mocked(fetchCards).mockResolvedValue([older, newer])
    vi.mocked(subscribeStream).mockImplementation(() => () => {})

    render(<App />)

    // The newest pending card (B) is auto-opened, although A and B belong to different
    // sessions/projects and nothing said B was the "current" one.
    expect(await screen.findByRole('heading', { level: 1, name: 'Session B decision' })).toBeTruthy()
    // It lands on B's hash, confirming the pending[0]-by-createdAt selection.
    await waitFor(() => expect(window.location.hash).toBe('#/card/B'))
  })

  it('[CORRECT] the opened card shows ITS OWN content — the dashboard does not mix sessions', async () => {
    vi.mocked(fetchCards).mockResolvedValue([older, newer])
    vi.mocked(subscribeStream).mockImplementation(() => () => {})

    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'Session B decision' })

    // B's own decision prompt renders; A's headline is NOT shown as the open card.
    expect(screen.getByText('Session B decision — pick one')).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1, name: 'Session A decision' })).toBeNull()
  })

  it('[CORRECT] deep-linking to a specific session\'s card shows exactly that card', async () => {
    vi.mocked(fetchCards).mockResolvedValue([older, newer])
    vi.mocked(subscribeStream).mockImplementation(() => () => {})
    window.location.hash = '#/card/A'

    render(<App />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Session A decision' })).toBeTruthy()
    expect(screen.getByText('Session A decision — pick one')).toBeTruthy()
  })
})

// Reconnect surfacing: App's auto-open and title badge key off needsHuman(), so a
// daemon restart that turns the attended gate into a boot-orphan keeps it on every
// "needs the human" surface — auto-open, sidebar Needs-you, tray — consistently.
function bootOrphan(id: string, headline: string, session: Card['session'], createdAt: string): Card {
  return {
    ...gate(id, headline, session, createdAt),
    status: 'orphaned',
    orphanedReason: 'boot',
    orphanedAt: new Date().toISOString(), // recent → within the 24h reattach window
  }
}

// Sidebar grouping: with the session spine, TWO Claude Code sessions that happen to
// share project/title/agent are DISTINCT sessions (claudeSessionId is the real key).
// The legacy pseudo-key (project+title+agent) is a fallback used ONLY for cards that
// predate the spine (no claudeSessionId) — those still merge as before.
describe('dashboard sidebar grouping by real session id', () => {
  it('[FLIPPED] two sessions with identical project/title/agent but distinct claudeSessionIds render as TWO sidebar groups', async () => {
    const a = gate('A', 'Session A decision', { agent: 'claude-code', project: 'repo-one', title: 'Same Title' }, '2026-06-30T10:00:00.000Z')
    const b = gate('B', 'Session B decision', { agent: 'claude-code', project: 'repo-one', title: 'Same Title' }, '2026-06-30T11:00:00.000Z')
    const boundA = { ...a, claudeSessionId: 'cc-A' }
    const boundB = { ...b, claudeSessionId: 'cc-B' }
    vi.mocked(fetchCards).mockResolvedValue([boundA, boundB])
    vi.mocked(subscribeStream).mockImplementation(() => () => {})

    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'Session B decision' })

    // Same project/title/agent, but bound to two different real sessions — the
    // sidebar must show two distinct session groups, not collapse them into one.
    expect(screen.getAllByRole('group', { name: 'Same Title' })).toHaveLength(2)
  })

  it('[LEGACY] two unbound (no claudeSessionId) card sets with identical pseudo-keys still merge into ONE group', async () => {
    const a = gate('A', 'Session A decision', { agent: 'claude-code', project: 'repo-one', title: 'Same Title' }, '2026-06-30T10:00:00.000Z')
    const b = gate('B', 'Session B decision', { agent: 'claude-code', project: 'repo-one', title: 'Same Title' }, '2026-06-30T11:00:00.000Z')
    vi.mocked(fetchCards).mockResolvedValue([a, b])
    vi.mocked(subscribeStream).mockImplementation(() => () => {})

    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'Session B decision' })

    // Pre-spine behavior preserved: with no claudeSessionId on either card, the
    // pseudo-key (project+title+agent) merges them into a single sidebar group.
    expect(screen.getAllByRole('group', { name: 'Same Title' })).toHaveLength(1)
  })
})

describe('dashboard auto-open vs reconnecting gates (restart surfacing)', () => {
  it('auto-open prefers the newest actionable gate, including a boot-orphaned "reconnecting" one', async () => {
    // A (this session) was orphaned by the restart and is NEWER; B (another session)
    // is still pending but older. needsHuman counts both, newest-first picks A.
    const reconnecting = bootOrphan('A', 'Session A (reconnecting)', { agent: 'claude-code', project: 'repo-one', title: 'Session A' }, '2026-06-30T12:00:00.000Z')
    const otherPending = gate('B', 'Session B decision', { agent: 'codex', project: 'repo-two', title: 'Session B' }, '2026-06-30T10:00:00.000Z')
    vi.mocked(fetchCards).mockResolvedValue([reconnecting, otherPending])
    vi.mocked(subscribeStream).mockImplementation(() => () => {})

    render(<App />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Session A (reconnecting)' })).toBeTruthy()
    await waitFor(() => expect(window.location.hash).toBe('#/card/A'))
    expect(screen.queryByRole('heading', { level: 1, name: 'Session B decision' })).toBeNull()
  })

  it('a LONE reconnecting gate is auto-opened — never the empty state while a gate awaits the human', async () => {
    // After a restart with only the attended gate present, needsHuman still counts it,
    // so auto-open lands on it instead of "The table is clear".
    const reconnecting = bootOrphan('A', 'Session A (reconnecting)', { agent: 'claude-code', project: 'repo-one', title: 'Session A' }, '2026-06-30T12:00:00.000Z')
    vi.mocked(fetchCards).mockResolvedValue([reconnecting])
    vi.mocked(subscribeStream).mockImplementation(() => () => {})

    render(<App />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Session A (reconnecting)' })).toBeTruthy()
    await waitFor(() => expect(window.location.hash).toBe('#/card/A'))
    expect(screen.queryByText('The table is clear')).toBeNull()
  })
})

// App fetches entries once and must pass them into TaskSidebar at BOTH call sites
// (the default/root layout and the #/session/<id> layout). Tag chips no longer
// render in the sidebar (redundant with the gate rows/strip), so the wiring is
// guarded via the other thing sidebar entries drive: the unread-report dot.
describe('dashboard passes entries into the sidebar at both routes', () => {
  const bound = gate('A', 'Session A decision', { agent: 'claude-code', project: 'repo-one', title: 'Session A' }, '2026-06-30T10:00:00.000Z')
  const boundCard = { ...bound, claudeSessionId: 'cc-A' }
  // Recent createdAt keeps the report inside readState's age-implies-read TTL, so
  // it counts as unread under these tests' real timers.
  const report = {
    id: 'report-wire-1', type: 'report' as const, claudeSessionId: 'cc-A',
    session: { agent: 'claude-code', project: 'repo-one' },
    headline: 'wiring probe findings', blocks: [{ id: 'b1', type: 'markdown' as const, text: 'body' }],
    createdAt: new Date().toISOString(),
  }

  it('shows the unread-report dot in the sidebar on the root route', async () => {
    vi.mocked(fetchCards).mockResolvedValue([boundCard])
    vi.mocked(fetchEntries).mockResolvedValue([report])
    vi.mocked(subscribeStream).mockImplementation(() => () => {})

    render(<App />)
    await screen.findByRole('heading', { level: 1, name: 'Session A decision' })

    // ≥1, not exactly 1: the sidebar may legitimately mark unread in more than one
    // place (session head dot, per-report row dot) — this test only guards that the
    // entries prop reaches the sidebar at all on this route.
    expect((await screen.findAllByLabelText('Unread report')).length).toBeGreaterThan(0)
  })

  it('shows the unread-report dot in the sidebar on the #/session/<id> route', async () => {
    vi.mocked(fetchCards).mockResolvedValue([boundCard])
    vi.mocked(fetchEntries).mockResolvedValue([report])
    vi.mocked(subscribeStream).mockImplementation(() => () => {})
    window.location.hash = '#/session/cc-A'

    render(<App />)

    // The stream view renders the report too — assert the SIDEBAR's dot
    // specifically via its sidebar-only class, so this targets the sidebar wiring.
    await waitFor(() => expect(document.querySelector('.sidebar .side-unread-dot')).toBeTruthy())
  })
})

// The sidebar's StreamDrawer used to promise "the FULL session, not the section's
// subset"; the drawer is gone and the #/session route is now the only stream
// surface — so THAT promise is pinned here instead: the route renders every one of
// the session's cards, pending and decided alike.
describe('#/session route renders the full session stream', () => {
  it('shows both a pending and a decided gate of the same session', async () => {
    const pendingGate = { ...gate('P', 'Pending gate', { agent: 'claude-code', project: 'repo-one', title: 'Session A' }, '2026-06-30T11:00:00.000Z'), claudeSessionId: 'cc-A' }
    const decidedGate = {
      ...gate('D', 'Decided gate', { agent: 'claude-code', project: 'repo-one', title: 'Session A' }, '2026-06-30T10:00:00.000Z'),
      claudeSessionId: 'cc-A', status: 'decided' as const,
    }
    vi.mocked(fetchCards).mockResolvedValue([pendingGate, decidedGate])
    vi.mocked(subscribeStream).mockImplementation(() => () => {})
    window.location.hash = '#/session/cc-A'

    render(<App />)

    const stream = await screen.findByLabelText('Session stream')
    expect(within(stream).getByText('Pending gate')).toBeTruthy()
    expect(within(stream).getByText('Decided gate')).toBeTruthy()
  })
})
