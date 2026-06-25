// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapturedSession } from '../../src/shared/session.js'
import { FolderColumns } from './FolderColumns.js'

// The view fetches the device nickname on mount; stub it so it never touches the
// network and resolves predictably.
vi.mock('./api.js', () => ({
  fetchDevice: vi.fn().mockResolvedValue({ machineId: 'm1', deviceLabel: 'studio-mac' }),
}))

afterEach(cleanup)

function ses(cwd: string, status: 'alive' | 'ended', id: string, extra: Partial<CapturedSession> = {}): CapturedSession {
  return {
    sessionId: id,
    machineId: 'm1',
    pid: 1,
    cwd,
    project: cwd.split('/').pop() || cwd,
    status,
    capturedAt: '2026-06-23T00:00:00.000Z',
    lastSeenAt: '2026-06-23T00:00:00.000Z',
    ...extra,
  }
}

const sessions = [
  ses('/Users/me/Desktop/Playground/boardroom', 'alive', 'alpha123-aaaa', { pid: 4242, entrypoint: 'cli' }),
  ses('/Users/me/Desktop/Playground/boardroom', 'ended', 'bravo456-bbbb'),
  ses('/Users/me/Desktop/clawbench', 'alive', 'charlie7-cccc'),
]

describe('FolderColumns', () => {
  it('shows a loading state until sessions arrive', () => {
    render(<FolderColumns sessions={null} onClose={() => {}} />)
    expect(screen.getByText('Loading sessions…')).toBeTruthy()
  })

  it('shows an empty state when no sessions are captured', async () => {
    render(<FolderColumns sessions={[]} onClose={() => {}} />)
    expect(await screen.findByText('No sessions captured yet')).toBeTruthy()
  })

  it('drills through folder columns and opens a session detail pane', async () => {
    render(<FolderColumns sessions={sessions} onClose={() => {}} />)

    // Column 0: the two top-level folders under the common ancestor, with counts.
    expect(await screen.findByText('Playground')).toBeTruthy()
    expect(screen.getByText('clawbench')).toBeTruthy()
    // Header summarizes totals across all folders.
    expect(screen.getByText(/3 sessions · 2 running/)).toBeTruthy()

    // Drill: Playground → boardroom → its two sessions (alive sorts before ended).
    fireEvent.click(screen.getByText('Playground'))
    fireEvent.click(await screen.findByText('boardroom'))
    expect(await screen.findByText('alpha123')).toBeTruthy()
    expect(screen.getByText('bravo456')).toBeTruthy()

    // Select the alive session → detail pane shows its facts.
    fireEvent.click(screen.getByText('alpha123'))
    expect(await screen.findByText('running', { selector: '.fbadge' })).toBeTruthy()
    expect(screen.getByText('4242')).toBeTruthy()        // pid
  })

  it('fires onClose when Escape is pressed', async () => {
    const onClose = vi.fn()
    render(<FolderColumns sessions={sessions} onClose={onClose} />)
    await screen.findByText('Playground')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
