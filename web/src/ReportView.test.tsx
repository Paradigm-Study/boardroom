// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReportEntry } from '../../src/shared/entry.js'
import { ReportView } from './ReportView.js'

const { markReadMock } = vi.hoisted(() => ({ markReadMock: vi.fn() }))

vi.mock('./readState.js', () => ({
  markRead: markReadMock,
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function report(overrides: Partial<ReportEntry> = {}): ReportEntry {
  return {
    id: 'e1',
    type: 'report',
    claudeSessionId: 'cc-A',
    session: { agent: 'claude-code', project: 'p', title: 'Spine session' },
    headline: 'investigation findings',
    blocks: [{ id: 'b1', type: 'markdown', text: 'full detail text' }],
    createdAt: '2026-07-07T00:00:00.000Z',
    ...overrides,
  }
}

// ReportView is the main-pane, card-like rendering of a report (#/report/<id>) —
// per the human's direction a report is "additional information", a widget like
// any other, never a separate reading destination. These tests pin the contract:
// headline as the title, the shared BlockView for content, session provenance
// (linked when bound, plain text when not), a quiet "nothing to decide" footer,
// and markRead on mount (same rule as ReportDrawer — arriving here IS reading it).
describe('ReportView', () => {
  it('marks the entry read on mount', () => {
    render(<ReportView entry={report({ id: 'e42' })} />)
    expect(markReadMock).toHaveBeenCalledWith('e42')
  })

  it('renders the headline as the title and the blocks via BlockView', () => {
    render(<ReportView entry={report()} />)
    expect(screen.getByRole('heading', { name: 'investigation findings' })).toBeTruthy()
    expect(screen.getByText('full detail text')).toBeTruthy()
  })

  it('links session provenance to #/session/<claudeSessionId> when bound', () => {
    render(<ReportView entry={report({ claudeSessionId: 'cc-B', session: { agent: 'claude-code', project: 'p', title: 'Bound session' } })} />)
    const link = screen.getByRole('link', { name: 'Bound session' })
    expect(link.getAttribute('href')).toBe('#/session/cc-B')
  })

  it('shows plain (non-linked) provenance text when unbound', () => {
    render(<ReportView entry={report({ claudeSessionId: undefined, session: { agent: 'claude-code', project: 'p', title: 'Unbound session' } })} />)
    expect(screen.getByText('Unbound session')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Unbound session' })).toBeNull()
  })

  it('falls back to "Untitled session" when the session has no title', () => {
    render(<ReportView entry={report({ claudeSessionId: undefined, session: { agent: 'claude-code', project: 'p' } })} />)
    expect(screen.getByText('Untitled session')).toBeTruthy()
  })

  it('shows the quiet "nothing to decide" footer', () => {
    render(<ReportView entry={report()} />)
    expect(screen.getByText('Report — nothing to decide.')).toBeTruthy()
  })
})
