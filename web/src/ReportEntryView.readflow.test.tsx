// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReportEntry } from '../../src/shared/entry.js'
import { ReportEntryView } from './ReportEntryView.js'

// NO readState mock (unlike ReportEntryView.test.tsx): these pin the real
// localStorage-backed read flow — the dot must react to markRead (fired by the
// drawer's mount effect) without any parent re-render doing the work.

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.useRealTimers()
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

describe('ReportEntryView read flow (real readState)', () => {
  it('clears the unread dot the moment the drawer opens, not only after close', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-07T00:05:00.000Z'))
    const { container } = render(<ReportEntryView entry={report()} />)
    expect(container.querySelector('.entry-unread-dot')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /open report/i }))

    // Drawer is open (not yet closed) — the dot must already be gone.
    expect(screen.getByLabelText('Report')).toBeTruthy()
    expect(container.querySelector('.entry-unread-dot')).toBeFalsy()
  })

  it('shows no dot for a report older than the read TTL (age-implies-read), even if never marked', () => {
    // 15 days after createdAt — past readState's 14-day TTL. The sidebar already
    // applies this rule; the stream surface must agree or old reports re-light here.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'))
    const { container } = render(<ReportEntryView entry={report()} />)
    expect(container.querySelector('.entry-unread-dot')).toBeFalsy()
  })
})
