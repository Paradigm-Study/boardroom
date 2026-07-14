// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('renders a disconnect-orphaned card in History as a muted stage glyph, never reconnecting', () => {
    render(
      <TaskSidebar
        selectedId={null}
        cards={[
          card({
            id: 'd', headline: 'Agent dropped', stage: 'results', createdAt: recent,
            status: 'orphaned', orphanedReason: 'disconnect', orphanedAt: recent,
          }),
        ]}
      />,
    )
    expect(screen.getByText('History')).toBeTruthy()
    // Collapsed to a clickable stage glyph in the history strip — muted (orphaned),
    // the status carried in the accessible name (not by color alone), no dashed ring,
    // and pointedly NOT surfaced as a reconnecting row.
    const glyph = screen.getByRole('link', { name: 'Results review: Agent dropped (orphaned)' })
    expect(glyph.className).toContain('gate-icon')
    expect(glyph.className).toContain('orphaned')
    expect(glyph.getAttribute('href')).toBe('#/card/d')
    expect(screen.queryByText('reconnecting')).toBeNull()
  })
})

describe('TaskSidebar history gate strip', () => {
  it('collapses resolved gates into a wrapping strip of clickable stage glyphs, not full rows', () => {
    render(
      <TaskSidebar
        selectedId={null}
        cards={[
          card({
            id: 'h1', headline: 'Picked storage', stage: 'clarify', status: 'decided',
            createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
            session: { agent: 'x', project: 'p', title: 't' },
          }),
          card({
            id: 'h2', headline: 'Approved plan', stage: 'plan', status: 'decided',
            createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A',
            session: { agent: 'x', project: 'p', title: 't' },
          }),
        ]}
      />,
    )
    // Each resolved gate is a stage-labelled glyph linking to its card…
    const g1 = screen.getByRole('link', { name: 'Clarify: Picked storage' })
    const g2 = screen.getByRole('link', { name: 'Plan approval: Approved plan' })
    expect(g1.className).toContain('gate-icon')
    expect(g1.getAttribute('href')).toBe('#/card/h1')
    expect(g2.getAttribute('href')).toBe('#/card/h2')
    // …and NOT a full Item row — no per-gate status/age meta line survives.
    expect(screen.queryByText('decided')).toBeNull()
    expect(document.querySelector('.titem')).toBeNull()
    expect(document.querySelector('.side-gate-strip')).not.toBeNull()
  })

  it('orders the strip FIFO (oldest gate first), matching the session stream', () => {
    render(
      <TaskSidebar
        selectedId={null}
        cards={[
          card({ id: 'h2', headline: 'second', stage: 'plan', status: 'decided', createdAt: '2026-06-16T12:05:00.000Z', claudeSessionId: 'cc-A', session: { agent: 'x', project: 'p', title: 't' } }),
          card({ id: 'h1', headline: 'first', stage: 'clarify', status: 'decided', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A', session: { agent: 'x', project: 'p', title: 't' } }),
        ]}
      />,
    )
    const strip = document.querySelector('.side-gate-strip')!
    const hrefs = [...strip.querySelectorAll('a')].map(a => a.getAttribute('href'))
    expect(hrefs).toEqual(['#/card/h1', '#/card/h2'])
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

describe('TaskSidebar renders no tag chips (removed as redundant with the gate rows/strip)', () => {
  it('renders NO chips for a bound session\'s tags — they surface in the stream drawer instead', () => {
    const bound = card({
      id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    const tagOld = tagEntry({ id: 't-old', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A', tag: 'stage:clarify:raised', cardId: 'a' })
    const tagNew = tagEntry({ id: 't-new', createdAt: '2026-06-16T12:02:00.000Z', claudeSessionId: 'cc-A', tag: 'stage:plan:decided', cardId: 'a' })

    const { container } = render(<TaskSidebar selectedId={null} cards={[bound]} entries={[tagNew, tagOld]} />)

    // No chips anywhere in the sidebar: the stage info lives in the gate rows/strip.
    expect(container.querySelector('.side-tag-chip')).toBeNull()
    const sessionGroup = screen.getByRole('group', { name: 't' })
    expect(within(sessionGroup).queryByText(/clarify.*raised/i)).toBeNull()

    // Not lost, though — the same tags still render inside the session's stream.
    fireEvent.click(within(sessionGroup).getByRole('button', { name: /stream/i }))
    const stream = screen.getByLabelText('Session stream')
    expect(within(stream).getByText(/clarify.*raised/i)).toBeTruthy()
    expect(within(stream).getByText(/plan.*decided/i)).toBeTruthy()
  })

  it('still synthesizes an entry-only group for a foreign tag — head only, chip-free', () => {
    const legacy = card({ id: 'l', headline: 'L', createdAt: '2026-06-16T12:00:00.000Z', session: { agent: 'x', project: 'p', title: 't' } })
    render(<TaskSidebar selectedId={null} cards={[legacy]} entries={[tagEntry({ id: 't1', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-other' })]} />)
    // The tag's own session group still surfaces (its stream stays reachable)…
    const own = screen.getByRole('group', { name: 'Untitled session' })
    expect(own).toBeTruthy()
    // …but renders no chip, there or on the legacy group.
    expect(within(own).queryByText(/plan.*decided/i)).toBeNull()
    expect(within(screen.getByRole('group', { name: 't' })).queryByText(/plan.*decided/i)).toBeNull()
  })
})

describe('TaskSidebar unread report dot (tray-separation guarded)', () => {
  const bound = card({
    id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
    session: { agent: 'x', project: 'p', title: 't' },
  })

  // Pin "now" close to the fixtures' createdAt so age-implies-read (readState's
  // READ_TTL_MS) doesn't treat these fixed-date reports as implicitly read —
  // these tests are about the unread-dot mechanism, not entry age.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:05:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows an unread dot on a session head when it has an unread report entry', () => {
    const report = reportEntry({ id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A' })
    render(<TaskSidebar selectedId={null} cards={[bound]} entries={[report]} />)

    const sessionGroup = screen.getByRole('group', { name: 't' })
    // Scoped to the session HEAD specifically: the report's own sidebar row (this
    // task) also carries an unread dot, so an unscoped query would now match twice.
    const head = sessionGroup.querySelector('.side-session-head') as HTMLElement
    expect(within(head).getByLabelText(/unread/i)).toBeTruthy()
  })

  it('never changes the side-count "N waiting" number when a session has unread reports, while side-unread-count shows separately', () => {
    const report = reportEntry({ id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A' })
    const { container, rerender } = render(<TaskSidebar selectedId={null} cards={[bound]} entries={[]} />)
    const sideCount = () => container.querySelector('.side-count')?.textContent
    const sideUnreadCount = () => container.querySelector('.side-unread-count')?.textContent
    expect(sideCount()).toBe('1 waiting') // one pending card, queried directly by class
    expect(sideUnreadCount()).toBeUndefined() // no unread reports yet — element absent, not empty

    rerender(<TaskSidebar selectedId={null} cards={[bound]} entries={[report]} />)

    // Adding an unread report (and its dot) must not touch the tray count at all —
    // it appears as a SEPARATE element instead (HARD constraint: byte-unchanged).
    expect(sideCount()).toBe('1 waiting')
    expect(sideUnreadCount()).toBe('1 unread')

    // The report also renders its own sidebar ROW (this task's feature) — still
    // without moving the tray count needle. Extended per the task's HARD constraint.
    expect(container.querySelector('.side-report-row')).not.toBeNull()
    expect(sideCount()).toBe('1 waiting')
  })
})

describe('TaskSidebar side-unread-count aggregate', () => {
  it('is absent when there are no unread reports', () => {
    const bound = card({
      id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    const { container } = render(<TaskSidebar selectedId={null} cards={[bound]} entries={[]} />)
    expect(container.querySelector('.side-unread-count')).toBeNull()
  })

  it('aggregates unread reports across multiple sessions', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:05:00.000Z'))
    const bound1 = card({
      id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
      session: { agent: 'x', project: 'p', title: 'session A' },
    })
    const bound2 = card({
      id: 'b', headline: 'B', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-B',
      session: { agent: 'x', project: 'p', title: 'session B' },
    })
    const r1 = reportEntry({ id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A' })
    const r2 = reportEntry({ id: 'r2', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-B' })
    const { container } = render(<TaskSidebar selectedId={null} cards={[bound1, bound2]} entries={[r1, r2]} />)
    expect(container.querySelector('.side-unread-count')?.textContent).toBe('2 unread')
    vi.useRealTimers()
  })

  it('does not count a report older than the read TTL (age-implies-read)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-01T12:00:00.000Z')) // 15 days after createdAt below
    const bound = card({
      id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    const oldReport = reportEntry({ id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A' })
    const { container } = render(<TaskSidebar selectedId={null} cards={[bound]} entries={[oldReport]} />)
    expect(container.querySelector('.side-unread-count')).toBeNull()
    vi.useRealTimers()
  })
})

describe('TaskSidebar entry-only sessions (no cards) still surface', () => {
  // The unread badge counts EVERY report entry, so every report must have a
  // surface: a session that has entries but no cards yet (e.g. present_report
  // fired before the session's first gate) gets its own sidebar group — dot,
  // stream affordance and (when bound) session link — instead of being counted
  // by the badge while rendered nowhere and unclearable.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:05:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('surfaces a BOUND report whose session has no cards, with an unread dot and openable stream', () => {
    const report = reportEntry({
      id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-lonely',
      headline: 'pre-gate findings',
      session: { agent: 'claude-code', project: 'p', title: 'Lonely session' },
    })

    const { container } = render(<TaskSidebar selectedId={null} cards={[]} entries={[report]} />)

    // Badge and surface must agree: 1 unread AND a visible group with the dot.
    expect(container.querySelector('.side-unread-count')?.textContent).toBe('1 unread')
    const sessionGroup = screen.getByRole('group', { name: 'Lonely session' })
    // Scoped to the session head: the report's own sidebar row (this task) ALSO
    // shows 'pre-gate findings' + an unread dot, so an unscoped query would match twice.
    const head = sessionGroup.querySelector('.side-session-head') as HTMLElement
    expect(within(head).getByLabelText(/unread/i)).toBeTruthy()

    // The stream affordance opens the drawer showing the report — the read path exists.
    fireEvent.click(within(sessionGroup).getByRole('button', { name: /stream/i }))
    const stream = screen.getByLabelText('Session stream')
    expect(within(stream).getByText('pre-gate findings')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /open report/i }))
    expect(container.querySelector('.side-unread-count')).toBeNull() // read → badge clears
  })

  it('links a bound entry-only group to its #/session/<id> stream view', () => {
    const report = reportEntry({
      id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-lonely',
      session: { agent: 'claude-code', project: 'p', title: 'Lonely session' },
    })
    render(<TaskSidebar selectedId={null} cards={[]} entries={[report]} />)
    const sessionGroup = screen.getByRole('group', { name: 'Lonely session' })
    const link = within(sessionGroup).getByRole('link', { name: 'Lonely session' })
    expect(link.getAttribute('href')).toBe('#/session/cc-lonely')
  })

  it('surfaces an UNBOUND report with no matching legacy card under its project', () => {
    const report = reportEntry({
      id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: undefined,
      headline: 'orphan unbound findings',
      session: { agent: 'claude-code', project: 'p', title: 'Legacy run' },
    })
    render(<TaskSidebar selectedId={null} cards={[]} entries={[report]} />)

    const sessionGroup = screen.getByRole('group', { name: 'Legacy run' })
    fireEvent.click(within(sessionGroup).getByRole('button', { name: /stream/i }))
    // Scoped to the drawer: the report's own sidebar row (this task) also shows the
    // headline, so an unscoped query would now match twice.
    expect(within(screen.getByLabelText('Session stream')).getByText('orphan unbound findings')).toBeTruthy()
  })

  it('does NOT duplicate a session that already has cards (entry joins the card group)', () => {
    const bound = card({
      id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    const report = reportEntry({ id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A' })
    render(<TaskSidebar selectedId={null} cards={[bound]} entries={[report]} />)
    expect(screen.getAllByRole('group', { name: 't' })).toHaveLength(1)
  })

  it('merges an entry-only session into an existing project group instead of duplicating the project', () => {
    const historyCard = card({
      id: 'h', headline: 'H', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-H', status: 'decided',
      session: { agent: 'x', project: 'p', title: 'Done session' },
    })
    const report = reportEntry({
      id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-lonely',
      session: { agent: 'claude-code', project: 'p', title: 'Lonely session' },
    })
    const { container } = render(<TaskSidebar selectedId={null} cards={[historyCard]} entries={[report]} />)

    // One project folder holding both the card session and the entry-only session.
    const projects = [...container.querySelectorAll('.side-project')]
    expect(projects).toHaveLength(1)
    expect(within(projects[0] as HTMLElement).getByRole('group', { name: 'Done session' })).toBeTruthy()
    expect(within(projects[0] as HTMLElement).getByRole('group', { name: 'Lonely session' })).toBeTruthy()
  })
})

describe('TaskSidebar unread aggregate reactivity', () => {
  // markRead fires inside the ReportDrawer (a grandchild); the sidebar's aggregate
  // count reads localStorage — without a readState subscription it would stay
  // stale until some unrelated re-render.
  it('clears the sidebar unread count the moment the report is opened from a stream drawer', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:05:00.000Z'))
    const bound = card({
      id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    const r1 = reportEntry({ id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A' })
    const { container } = render(<TaskSidebar selectedId={null} cards={[bound]} entries={[r1]} />)
    expect(container.querySelector('.side-unread-count')?.textContent).toBe('1 unread')

    fireEvent.click(within(screen.getByRole('group', { name: 't' })).getByRole('button', { name: /stream/i }))
    fireEvent.click(screen.getByRole('button', { name: /open report/i }))

    expect(container.querySelector('.side-unread-count')).toBeNull()
    vi.useRealTimers()
  })
})

describe('TaskSidebar age-implies-read (no false re-lighting)', () => {
  it('does not show an unread dot for a report older than the read TTL, even unread', () => {
    const bound = card({
      id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    // 15 days after the report's createdAt — past readState's 14-day TTL.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-01T12:00:00.000Z'))
    const oldReport = reportEntry({ id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A' })
    render(<TaskSidebar selectedId={null} cards={[bound]} entries={[oldReport]} />)

    const sessionGroup = screen.getByRole('group', { name: 't' })
    expect(within(sessionGroup).queryByLabelText(/unread/i)).toBeNull()
    vi.useRealTimers()
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

  it('shows the stream affordance on an unbound (legacy pseudo-key) session too — SessionStream accepts session={null}', () => {
    const legacy = card({ id: 'l', headline: 'L', createdAt: '2026-06-16T12:00:00.000Z', session: { agent: 'x', project: 'p', title: 't' } })
    render(<TaskSidebar selectedId={null} cards={[legacy]} entries={[]} />)
    const sessionGroup = screen.getByRole('group', { name: 't' })
    expect(within(sessionGroup).queryByRole('button', { name: /stream/i })).toBeTruthy()
  })

  // The drawer is a fixed right-anchored overlay — two of them just stack. Opening
  // a stream anywhere must close whichever stream was open before, across projects
  // AND across the pending/history sections (state must live in TaskSidebar, not
  // per ProjectSection instance).
  it('keeps at most one StreamDrawer open when streams are opened in two different sessions', () => {
    const a = card({
      id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
      session: { agent: 'x', project: 'p1', title: 'tA' },
    })
    const b = card({
      id: 'b', headline: 'B', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-B',
      session: { agent: 'x', project: 'p2', title: 'tB' },
    })
    render(<TaskSidebar selectedId={null} cards={[a, b]} entries={[]} />)

    fireEvent.click(within(screen.getByRole('group', { name: 'tA' })).getByRole('button', { name: /stream/i }))
    fireEvent.click(within(screen.getByRole('group', { name: 'tB' })).getByRole('button', { name: /stream/i }))

    expect(screen.getAllByLabelText('Session stream')).toHaveLength(1)
    expect(within(screen.getByLabelText('Session stream')).getByText('B')).toBeTruthy()
  })

  it('keeps at most one StreamDrawer open for the SAME session split across pending and history', () => {
    const pendingCard = card({
      id: 'p1', headline: 'Pending gate', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    const decidedCard = card({
      id: 'd1', headline: 'Decided gate', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A', status: 'decided',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    render(<TaskSidebar selectedId={null} cards={[pendingCard, decidedCard]} entries={[]} />)

    // The session appears once under Needs-you and once under History.
    const groups = screen.getAllByRole('group', { name: 't' })
    expect(groups).toHaveLength(2)
    fireEvent.click(within(groups[0]).getByRole('button', { name: /stream/i }))
    fireEvent.click(within(groups[1]).getByRole('button', { name: /stream/i }))

    expect(screen.getAllByLabelText('Session stream')).toHaveLength(1)
  })

  // The drawer promises "the SAME SessionStream the #/session/<id> route renders"
  // (StreamDrawer.tsx) — the FULL session, not the subset of cards that happens to
  // sit in the section the affordance was clicked in.
  it('shows the full session stream — history cards included — when opened from the pending section', () => {
    const pendingCard = card({
      id: 'p1', headline: 'Pending gate', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    const decidedCard = card({
      id: 'd1', headline: 'Decided gate', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A', status: 'decided',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    render(<TaskSidebar selectedId={null} cards={[pendingCard, decidedCard]} entries={[]} />)

    // Open the stream from the PENDING section's group (rendered first).
    const groups = screen.getAllByRole('group', { name: 't' })
    fireEvent.click(within(groups[0]).getByRole('button', { name: /stream/i }))

    const stream = screen.getByLabelText('Session stream')
    expect(within(stream).getByText('Pending gate')).toBeTruthy()
    expect(within(stream).getByText('Decided gate')).toBeTruthy()
  })
})

describe('TaskSidebar unbound entries (no claudeSessionId) surface under their project', () => {
  // Mirrors groupCardsByProjectAndSession's pseudo-key: an unbound entry joins the
  // session group sharing its (project, title, agent) triple, exactly like an
  // unbound CARD already does — the Global Constraint says an unbound report
  // "renders under its project, outside any session stream."
  const legacy = card({
    id: 'l', headline: 'L', createdAt: '2026-06-16T12:00:00.000Z',
    session: { agent: 'x', project: 'p', title: 't' },
  })

  // Pin "now" close to the fixtures' createdAt so age-implies-read doesn't treat
  // these fixed-date reports as implicitly read (these tests are about grouping,
  // not entry age).
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:05:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders an unbound report under its (project, title, agent) session group with an unread dot', () => {
    const report = reportEntry({
      id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: undefined,
      session: { agent: 'x', project: 'p', title: 't' },
    })

    render(<TaskSidebar selectedId={null} cards={[legacy]} entries={[report]} />)

    const sessionGroup = screen.getByRole('group', { name: 't' })
    // Scoped to the session head: the report's own sidebar row (this task) also
    // carries an unread dot, so an unscoped query would now match twice.
    const head = sessionGroup.querySelector('.side-session-head') as HTMLElement
    expect(within(head).getByLabelText(/unread/i)).toBeTruthy()
  })

  it('renders no chip for an unbound tag — it joins its (project, title, agent) group\'s stream instead', () => {
    const tag = tagEntry({
      id: 't1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: undefined, tag: 'stage:plan:decided', cardId: 'l',
      session: { agent: 'x', project: 'p', title: 't' },
    })

    render(<TaskSidebar selectedId={null} cards={[legacy]} entries={[tag]} />)

    // Chip-free in the sidebar (the pseudo-key grouping still routes the tag)…
    const sessionGroup = screen.getByRole('group', { name: 't' })
    expect(within(sessionGroup).queryByText(/plan.*decided/i)).toBeNull()
    // …and the tag still renders inside that group's stream drawer.
    fireEvent.click(within(sessionGroup).getByRole('button', { name: /stream/i }))
    expect(within(screen.getByLabelText('Session stream')).getByText(/plan.*decided/i)).toBeTruthy()
  })

  it('opens the StreamDrawer for an unbound group and shows the report inside it', () => {
    const report = reportEntry({
      id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: undefined, headline: 'unbound findings',
      session: { agent: 'x', project: 'p', title: 't' },
    })

    render(<TaskSidebar selectedId={null} cards={[legacy]} entries={[report]} />)

    const sessionGroup = screen.getByRole('group', { name: 't' })
    fireEvent.click(within(sessionGroup).getByRole('button', { name: /stream/i }))

    const stream = screen.getByLabelText('Session stream')
    // Scoped to the drawer: the report's own sidebar row (this task) also shows the
    // headline, so an unscoped query would now match twice.
    expect(within(stream).getByText('unbound findings')).toBeTruthy()
  })
})

describe('TaskSidebar report rows (reports render as first-class rows, not tucked away)', () => {
  // Rows are appended AFTER a session's card rendering (the Item list in Needs-you,
  // the GateStrip icon strip in History) rather than truly interleaved by FIFO
  // timestamp — History's GateStrip is a compact icon row, not a list of "items"
  // reports could interleave into, so one append rule keeps both sections uniform.
  it('renders a report row under its session, linking to #/report/<id>', () => {
    const bound = card({
      id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    const report = reportEntry({ id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A', headline: 'row headline' })
    render(<TaskSidebar selectedId={null} cards={[bound]} entries={[report]} />)

    const sessionGroup = screen.getByRole('group', { name: 't' })
    const link = within(sessionGroup).getByRole('link', { name: /row headline/ })
    expect(link.getAttribute('href')).toBe('#/report/r1')
    expect(link.className).toContain('side-report-row')
  })

  it('shows an unread dot on the row itself when the report is unread', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-16T12:05:00.000Z'))
    const bound = card({
      id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    const report = reportEntry({ id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A' })
    render(<TaskSidebar selectedId={null} cards={[bound]} entries={[report]} />)

    const sessionGroup = screen.getByRole('group', { name: 't' })
    const row = within(sessionGroup).getByRole('link', { name: /investigation findings/ })
    expect(within(row).getByLabelText(/unread/i)).toBeTruthy()
    vi.useRealTimers()
  })

  it('shows no dot on the row once the report is read', () => {
    const bound = card({
      id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    const report = reportEntry({ id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A' })
    localStorage.setItem('boardroom.readEntries.v1', JSON.stringify({ r1: Date.now() }))
    render(<TaskSidebar selectedId={null} cards={[bound]} entries={[report]} />)

    const sessionGroup = screen.getByRole('group', { name: 't' })
    const row = within(sessionGroup).getByRole('link', { name: /investigation findings/ })
    expect(within(row).queryByLabelText(/unread/i)).toBeNull()
  })

  it('lists a session\'s report rows FIFO (oldest first), matching the stream order', () => {
    const bound = card({
      id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    const r1 = reportEntry({ id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A', headline: 'first report' })
    const r2 = reportEntry({ id: 'r2', createdAt: '2026-06-16T12:02:00.000Z', claudeSessionId: 'cc-A', headline: 'second report' })
    // Adversarial order: pass entries newest-first.
    render(<TaskSidebar selectedId={null} cards={[bound]} entries={[r2, r1]} />)

    const sessionGroup = screen.getByRole('group', { name: 't' })
    const rows = within(sessionGroup).getAllByRole('link').filter(a => a.classList.contains('side-report-row'))
    expect(rows.map(a => a.textContent)).toEqual(['first report', 'second report'])
  })

  it('renders report rows in the History section too, alongside the resolved-gate strip', () => {
    const decided = card({
      id: 'h', headline: 'H', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A', status: 'decided',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    const report = reportEntry({ id: 'r1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A', headline: 'history findings' })
    render(<TaskSidebar selectedId={null} cards={[decided]} entries={[report]} />)

    const sessionGroup = screen.getByRole('group', { name: 't' })
    expect(document.querySelector('.side-gate-strip')).not.toBeNull() // the resolved gate strip is still there…
    expect(within(sessionGroup).getByRole('link', { name: /history findings/ })).toBeTruthy() // …alongside the report row
  })

  it('never renders a row for a tag entry — tag chips stay removed from the sidebar, per existing behavior', () => {
    const bound = card({
      id: 'a', headline: 'A', createdAt: '2026-06-16T12:00:00.000Z', claudeSessionId: 'cc-A',
      session: { agent: 'x', project: 'p', title: 't' },
    })
    const tag = tagEntry({ id: 't1', createdAt: '2026-06-16T12:01:00.000Z', claudeSessionId: 'cc-A', tag: 'stage:plan:decided', cardId: 'a' })
    const { container } = render(<TaskSidebar selectedId={null} cards={[bound]} entries={[tag]} />)
    expect(container.querySelector('.side-report-row')).toBeNull()
  })
})
