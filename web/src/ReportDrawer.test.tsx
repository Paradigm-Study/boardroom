// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReportEntry } from '../../src/shared/entry.js'
import { ReportDrawer } from './ReportDrawer.js'

const { markReadMock } = vi.hoisted(() => ({ markReadMock: vi.fn() }))

vi.mock('./readState.js', () => ({
  markRead: markReadMock,
  isRead: vi.fn(() => false),
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
    blocks: [{ id: 'b1', type: 'markdown', text: 'full detail text' }],
    createdAt: '2026-07-07T00:00:00.000Z',
    ...overrides,
  }
}

describe('ReportDrawer', () => {
  it('marks the entry read on open (mount)', () => {
    render(<ReportDrawer entry={report({ id: 'e42' })} onClose={() => {}} />)
    expect(markReadMock).toHaveBeenCalledWith('e42')
  })

  it('renders the headline and full blocks', () => {
    render(<ReportDrawer entry={report()} onClose={() => {}} />)
    expect(screen.getByText('investigation findings')).toBeTruthy()
    expect(screen.getByText('full detail text')).toBeTruthy()
  })

  it('calls onClose when closed', () => {
    const onClose = vi.fn()
    render(<ReportDrawer entry={report()} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalled()
  })
})
