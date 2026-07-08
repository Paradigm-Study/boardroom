// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Card } from '../../src/shared/card.js'
import type { Entry } from '../../src/shared/entry.js'
import type { SessionVM } from './api.js'
import { groupCardsByProjectAndSession, TaskSidebar } from './TaskSidebar.js'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function card(overrides: Partial<Card> & Pick<Card, 'id' | 'headline' | 'createdAt'>): Card {
  return {
    stage: 'plan',
    session: { agent: 'codex', project: '/workspace/product-a', title: 'Checkout sprint' },
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

// N pending cards in one project, each its own session, newest last.
function sessionsInOneProject(project: string, n: number): Card[] {
  return Array.from({ length: n }, (_, i) =>
    card({
      id: `${project}-${i}`,
      headline: `Card ${i}`,
      createdAt: `2026-06-16T12:${String(i).padStart(2, '0')}:00.000Z`,
      session: { agent: 'codex', project, title: `Session ${i}` },
    }),
  )
}

function reportEntry(overrides: Partial<Entry> & Pick<Entry, 'id' | 'createdAt' | 'claudeSessionId'>): Entry {
  return {
    type: 'report',
    session: { agent: 'claude-code', project: 'p' },
    headline: 'investigation findings',
    blocks: [{ id: 'b1', type: 'markdown', text: 'summary' }],
    ...overrides,
  } as Entry
}

function tagEntry(overrides: Partial<Entry> & Pick<Entry, 'id' | 'createdAt' | 'claudeSessionId'>): Entry {
  return {
    type: 'tag',
    session: { agent: 'claude-code', project: 'p' },
    tag: 'stage:plan:decided',
    cardId: 'c1',
    ...overrides,
  } as Entry
}

describe('TaskSidebar session grouping', () => {
  it('groups pending cards by project and then session', () => {
    render(
      <TaskSidebar
        selectedId={null}
        cards={[
          card({ id: 'newer', headline: 'Folder upload plan', createdAt: '2026-06-16T12:05:00.000Z' }),
          card({ id: 'older', headline: 'Canvas upload review', createdAt: '2026-06-16T12:00:00.000Z' }),
          card({
            id: 'other-session',
            headline: 'Notebook review',
            createdAt: '2026-06-16T11:59:00.000Z',
            session: { agent: 'codex', project: '/workspace/product-a', title: 'Notebook sprint' },
          }),
        ]}
      />,
    )

    const project = screen.getByRole('group', { name: /\/workspace\/product-a/ })
    expect(within(project).getByRole('heading', { name: /\/workspace\/product-a/ })).toBeTruthy()

    const checkout = within(project).getByRole('group', { name: 'Checkout sprint' })
    expect(within(checkout).getByRole('heading', { name: 'Checkout sprint' })).toBeTruthy()
    expect(within(checkout).getByText('2 cards')).toBeTruthy()
    expect(within(checkout).getByText('Folder upload plan')).toBeTruthy()
    expect(within(checkout).getByText('Canvas upload review')).toBeTruthy()

    const notebook = within(project).getByRole('group', { name: 'Notebook sprint' })
    expect(within(notebook).getByText('Notebook review')).toBeTruthy()
  })

  it('keeps sessions with the same title separate across projects', () => {
    render(
      <TaskSidebar
        selectedId={null}
        cards={[
          card({ id: 'a', headline: 'Project A card', createdAt: '2026-06-16T12:00:00.000Z' }),
          card({
            id: 'b',
            headline: 'Project B card',
            createdAt: '2026-06-16T12:01:00.000Z',
            session: { agent: 'codex', project: '/workspace/product-b', title: 'Checkout sprint' },
          }),
        ]}
      />,
    )

    expect(screen.getByRole('group', { name: /\/workspace\/product-a/ })).toBeTruthy()
    expect(screen.getByRole('group', { name: /\/workspace\/product-b/ })).toBeTruthy()
    expect(screen.getAllByRole('group', { name: 'Checkout sprint' })).toHaveLength(2)
  })
})

describe('TaskSidebar reconnecting (restart-orphaned) cards', () => {
  const recent = new Date().toISOString()

  it('surfaces a restart-orphaned (boot) un-answered card under Needs you, labelled "reconnecting"', () => {
    render(
      <TaskSidebar
        selectedId={null}
        cards={[
          card({
            id: 'r', headline: 'Was waiting on me', createdAt: recent,
            status: 'orphaned', orphanedReason: 'boot', orphanedAt: recent,
          }),
        ]}
      />,
    )
    // Labelled reconnecting (not "orphaned") and, as the only card, no History section
    // exists — so it must be in Needs you.
    expect(screen.getByText('reconnecting')).toBeTruthy()
    expect(screen.queryByText('orphaned')).toBeNull()
    expect(screen.queryByText('History')).toBeNull()
    expect(screen.getByText('Needs you')).toBeTruthy()
  })

  it('keeps a disconnect-orphaned card in History (labelled "orphaned"), not Needs you', () => {
    render(
      <TaskSidebar
        selectedId={null}
        cards={[
          card({
            id: 'd', headline: 'Agent dropped', createdAt: recent,
            status: 'orphaned', orphanedReason: 'disconnect', orphanedAt: recent,
          }),
        ]}
      />,
    )
    expect(screen.getByText('History')).toBeTruthy()
    expect(screen.getByText('orphaned')).toBeTruthy()
    expect(screen.queryByText('reconnecting')).toBeNull()
  })
})

describe('TaskSidebar session grouping by real session id', () => {
  it('groups by claudeSessionId when present, pseudo-key only for unbound cards', () => {
    const a = card({
      id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    const b = card({
      id: 'b', headline: 'B', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-B',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    const legacy = card({
      id: 'l', headline: 'L', createdAt: '2026-06-16T12:02:00.000Z',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    const groups = groupCardsByProjectAndSession([a, b, legacy])
    // identical project/title/agent, but three distinct groups: cc-A, cc-B, pseudo
    expect(groups.flatMap(p => p.sessions).length).toBe(3)
  })
})

describe('TaskSidebar inbox status tags', () => {
  const vm: SessionVM = {
    sessionId: 'cc-A', machineId: 'm', pid: 1, cwd: '/tmp/p', project: 'p',
    status: 'alive', capturedAt: '2026-07-02T10:00:00.000Z', lastSeenAt: '2026-07-02T12:00:00.000Z',
    sessionStatus: 'needs-decision', pendingCount: 1, cardCount: 1,
  }

  it('shows the sessionStatus chip on a bound session group with a matching VM', () => {
    render(
      <TaskSidebar
        selectedId={null}
        sessions={[vm]}
        cards={[card({
          id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
        })]}
      />,
    )
    expect(screen.getByText('needs-decision')).toBeTruthy()
  })

  it('never shows a status chip on an unbound (legacy pseudo-key) session group', () => {
    render(
      <TaskSidebar
        selectedId={null}
        sessions={[vm]}
        cards={[card({ id: 'l', headline: 'L', createdAt: '2026-06-16T12:00:00.000Z' })]}
      />,
    )
    expect(screen.queryByText('needs-decision')).toBeNull()
  })
})

describe('TaskSidebar folder accordion + session cap', () => {
  it('shows folders expanded by default', () => {
    render(<TaskSidebar selectedId={null} cards={sessionsInOneProject('/workspace/mono', 1)} />)
    expect(screen.getByRole('group', { name: 'Session 0' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /\/workspace\/mono/, expanded: true })).toBeTruthy()
  })

  it('caps a folder at 5 sessions and reveals the rest via View more', () => {
    render(<TaskSidebar selectedId={null} cards={sessionsInOneProject('/workspace/mono', 6)} />)

    // Six distinct sessions exist, but only five render before "View more".
    expect(screen.getAllByRole('group', { name: /^Session \d$/ })).toHaveLength(5)

    fireEvent.click(screen.getByRole('button', { name: /View 1 more/ }))

    expect(screen.getAllByRole('group', { name: /^Session \d$/ })).toHaveLength(6)
    expect(screen.getByRole('button', { name: /Show less/ })).toBeTruthy()
  })

  it('does not show a View more button at exactly the cap', () => {
    render(<TaskSidebar selectedId={null} cards={sessionsInOneProject('/workspace/mono', 5)} />)
    expect(screen.getAllByRole('group', { name: /^Session \d$/ })).toHaveLength(5)
    expect(screen.queryByRole('button', { name: /View .* more/ })).toBeNull()
  })

  it('collapses a folder when its header toggle is clicked', () => {
    render(<TaskSidebar selectedId={null} cards={sessionsInOneProject('/workspace/mono', 1)} />)

    expect(screen.getByRole('group', { name: 'Session 0' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /\/workspace\/mono/, expanded: true }))

    expect(screen.queryByRole('group', { name: 'Session 0' })).toBeNull()
    expect(screen.getByRole('button', { name: /\/workspace\/mono/, expanded: false })).toBeTruthy()
  })

  it('remembers a collapsed folder across remounts', () => {
    const cards = sessionsInOneProject('/workspace/mono', 1)
    const { unmount } = render(<TaskSidebar selectedId={null} cards={cards} />)
    fireEvent.click(screen.getByRole('button', { name: /\/workspace\/mono/, expanded: true }))
    unmount()

    render(<TaskSidebar selectedId={null} cards={cards} />)
    expect(screen.queryByRole('group', { name: 'Session 0' })).toBeNull()
    expect(screen.getByRole('button', { name: /\/workspace\/mono/, expanded: false })).toBeTruthy()
  })
})

describe('TaskSidebar FIFO within session stacks (group order stays recency)', () => {
  it('renders a session\'s own cards oldest-first (FIFO) while the group order stays newest-first', () => {
    // Two sessions in one project: session "New" was created after session "Old" —
    // the PROJECT's session order must stay recency (New's group before Old's).
    // But WITHIN "Old" itself, its two cards must render first-in-at-top (FIFO).
    const oldFirst = card({
      id: 'old-first', headline: 'Old session — first card', createdAt: '2026-06-16T12:00:00.000Z',
      session: { agent: 'codex', project: '/workspace/mono', title: 'Old' },
    })
    const oldSecond = card({
      id: 'old-second', headline: 'Old session — second card', createdAt: '2026-06-16T12:05:00.000Z',
      session: { agent: 'codex', project: '/workspace/mono', title: 'Old' },
    })
    const newCard = card({
      id: 'new', headline: 'New session — only card', createdAt: '2026-06-16T13:00:00.000Z',
      session: { agent: 'codex', project: '/workspace/mono', title: 'New' },
    })

    // Adversarial order: pass cards in a shuffled, non-chronological array.
    render(<TaskSidebar selectedId={null} cards={[oldSecond, newCard, oldFirst]} />)

    const groups = groupCardsByProjectAndSession([oldSecond, newCard, oldFirst])
    // Group-level (session) ordering is UNCHANGED: newest session ("New") first.
    expect(groups[0].sessions.map(s => s.label)).toEqual(['New', 'Old'])

    // Within "Old", the cards are FIFO: first-in ("old-first") at the top.
    const oldSession = groups[0].sessions.find(s => s.label === 'Old')
    expect(oldSession?.cards.map(c => c.id)).toEqual(['old-first', 'old-second'])

    // DOM order agrees: the older card's headline appears before the newer one's
    // within the "Old" session group.
    const oldGroup = screen.getByRole('group', { name: 'Old' })
    const titles = within(oldGroup).getAllByText(/Old session/).map(el => el.textContent)
    expect(titles.indexOf('Old session — first card')).toBeLessThan(titles.indexOf('Old session — second card'))
  })

  it('[REGRESSION] group-level project/session ordering stays newest-first (existing recency test)', () => {
    // Mirrors the existing "groups pending cards by project and then session" test's
    // ordering guarantee — pinned again here alongside the FIFO change so a future
    // edit that accidentally flips group ordering fails loudly in this describe too.
    const groups = groupCardsByProjectAndSession([
      card({ id: 'newer', headline: 'Folder upload plan', createdAt: '2026-06-16T12:05:00.000Z' }),
      card({ id: 'older', headline: 'Canvas upload review', createdAt: '2026-06-16T12:00:00.000Z' }),
    ])
    expect(groups[0].cards.map(c => c.id)).toEqual(['newer', 'older'])
  })
})

describe('TaskSidebar tag chips in bound session bodies', () => {
  it('renders a bound session\'s tags as slim chips in FIFO order', () => {
    const bound = card({
      id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    const tagOld = tagEntry({ id: 't-old', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A', tag: 'stage:clarify:raised', cardId: 'a' })
    const tagNew = tagEntry({ id: 't-new', createdAt: '2026-06-16T12:02:00.000Z', claudeSessionId: 'cc-A', tag: 'stage:plan:decided', cardId: 'a' })

    render(<TaskSidebar selectedId={null} cards={[bound]} entries={[tagNew, tagOld]} />)

    const sessionGroup = screen.getByRole('group', { name: 't' })
    const chips = within(sessionGroup).getAllByText(/·/)
    // FIFO: the older tag chip (raised) appears before the newer one (decided).
    const chipTexts = chips.map(c => c.textContent)
    const idxRaised = chipTexts.findIndex(t => t?.includes('raised'))
    const idxDecided = chipTexts.findIndex(t => t?.includes('decided'))
    expect(idxRaised).toBeGreaterThanOrEqual(0)
    expect(idxDecided).toBeGreaterThanOrEqual(0)
    expect(idxRaised).toBeLessThan(idxDecided)
  })

  it('shows no tag chips for an unbound (legacy pseudo-key) session', () => {
    const legacy = card({ id: 'l', headline: 'L', createdAt: '2026-06-16T12:00:00.000Z', session: { agent: 'x', project: 'p', title: 't' } })
    render(<TaskSidebar selectedId={null} cards={[legacy]} entries={[tagEntry({ id: 't1', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-other' })]} />)
    expect(screen.queryByText(/plan.*decided/i)).toBeNull()
  })
})

describe('TaskSidebar unread report dot (tray-separation guarded)', () => {
  const bound = card({
    id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
    session: { agent: 'x', project: 'p', title: 't' },
  })

  it('shows an unread dot on a session head when it has an unread report entry', () => {
    const report = reportEntry({ id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A' })
    render(<TaskSidebar selectedId={null} cards={[bound]} entries={[report]} />)

    const sessionGroup = screen.getByRole('group', { name: 't' })
    expect(within(sessionGroup).getByLabelText(/unread/i)).toBeTruthy()
  })

  it('never changes the side-count "N waiting" number when a session has unread reports', () => {
    const report = reportEntry({ id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A' })
    const { container, rerender } = render(<TaskSidebar selectedId={null} cards={[bound]} entries={[]} />)
    const sideCount = () => container.querySelector('.side-count')?.textContent
    expect(sideCount()).toBe('1 waiting') // one pending card, queried directly by class

    rerender(<TaskSidebar selectedId={null} cards={[bound]} entries={[report]} />)

    // Adding an unread report (and its dot) must not touch the tray count at all.
    expect(sideCount()).toBe('1 waiting')
  })
})

describe('TaskSidebar stream drawer affordance', () => {
  it('opens the StreamDrawer from a bound session\'s stream affordance, default closed on mount', () => {
    const bound = card({
      id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    render(<TaskSidebar selectedId={null} cards={[bound]} entries={[]} />)

    // Default closed: no stream drawer/dialog present on mount.
    expect(screen.queryByLabelText('Session stream')).toBeNull()

    const sessionGroup = screen.getByRole('group', { name: 't' })
    fireEvent.click(within(sessionGroup).getByRole('button', { name: /stream/i }))

    expect(screen.getByLabelText('Session stream')).toBeTruthy()
  })

  it('closes the StreamDrawer via its close callback', () => {
    const bound = card({
      id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    render(<TaskSidebar selectedId={null} cards={[bound]} entries={[]} />)

    const sessionGroup = screen.getByRole('group', { name: 't' })
    fireEvent.click(within(sessionGroup).getByRole('button', { name: /stream/i }))
    expect(screen.getByLabelText('Session stream')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(screen.queryByLabelText('Session stream')).toBeNull()
  })

  it('does not show the stream affordance on an unbound (legacy pseudo-key) session', () => {
    const legacy = card({ id: 'l', headline: 'L', createdAt: '2026-06-16T12:00:00.000Z', session: { agent: 'x', project: 'p', title: 't' } })
    render(<TaskSidebar selectedId={null} cards={[legacy]} entries={[]} />)
    const sessionGroup = screen.getByRole('group', { name: 't' })
    expect(within(sessionGroup).queryByRole('button', { name: /stream/i })).toBeNull()
  })
})
