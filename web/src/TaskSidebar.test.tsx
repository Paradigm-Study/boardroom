// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Card } from '../../src/shared/card.js'
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
