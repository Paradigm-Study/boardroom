// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReportEntry } from '../../src/shared/entry.js'
import { ReportEntryView } from './ReportEntryView.js'

const { markReadMock, isReadMock } = vi.hoisted(() => ({
  markReadMock: vi.fn(),
  isReadMock: vi.fn(),
}))

vi.mock('./readState.js', () => ({
  markRead: markReadMock,
  isRead: isReadMock,
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
    session: { agent: 'claude-code', project: 'p' },
    headline: 'investigation findings',
    blocks: [{ id: 'b1', type: 'markdown', text: 'summary text' }],
    createdAt: '2026-07-07T00:00:00.000Z',
    ...overrides,
  }
}

describe('ReportEntryView', () => {
  it('shows the headline and renders blocks via BlockView', () => {
    isReadMock.mockReturnValue(true)
    render(<ReportEntryView entry={report()} />)
    expect(screen.getByText('investigation findings')).toBeTruthy()
    // BlockView renders markdown blocks inside a `.prose` node.
    expect(screen.getByText('summary text')).toBeTruthy()
  })

  it('shows an unread dot when the entry is unread', () => {
    isReadMock.mockReturnValue(false)
    const { container } = render(<ReportEntryView entry={report()} />)
    expect(container.querySelector('.entry-unread-dot')).toBeTruthy()
  })

  it('hides the unread dot once the entry is read', () => {
    isReadMock.mockReturnValue(true)
    const { container } = render(<ReportEntryView entry={report()} />)
    expect(container.querySelector('.entry-unread-dot')).toBeFalsy()
  })

  it('opens the drawer and marks read when "Open report" is clicked', () => {
    isReadMock.mockReturnValue(false)
    render(<ReportEntryView entry={report({ id: 'e2' })} />)

    fireEvent.click(screen.getByRole('button', { name: /open report/i }))

    expect(markReadMock).toHaveBeenCalledWith('e2')
    expect(screen.getByLabelText('Report')).toBeTruthy() // ReportDrawer aria-label
  })

  it('closes the drawer', () => {
    isReadMock.mockReturnValue(false)
    render(<ReportEntryView entry={report({ id: 'e3' })} />)

    fireEvent.click(screen.getByRole('button', { name: /open report/i }))
    expect(screen.getByLabelText('Report')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(screen.queryByLabelText('Report')).toBeFalsy()
  })
})
