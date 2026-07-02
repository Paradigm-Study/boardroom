// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpecDrawer } from './SpecDrawer.js'
import type { SpecRecall } from './specRecall.js'

afterEach(cleanup)

const recall: SpecRecall = {
  goal: 'ship safely',
  specCardId: 'spec1',
  metCount: 1, total: 2,
  criteria: [
    { id: 'cr1', behavior: 'tokens secure', good: 'httpOnly only', bad: 'localStorage', tracesTo: 'token_storage', status: 'met', claims: [{ claim: 'cookie path verified', vote: 'approve', evidenceRefs: ['c0/e'], resultsCardId: 'r1' }] },
    { id: 'cr2', behavior: 'roles enforced', good: '403 for viewers', bad: 'viewer exports', tracesTo: 'authz', status: 'unmet', claims: [] },
    { id: 'cr3', behavior: 'old criterion', good: 'g', bad: 'b', tracesTo: 'x', status: 'dropped', claims: [] },
  ],
}

describe('SpecDrawer', () => {
  it('shows progress, goal, criteria with met/unmet, and the mapped claims', () => {
    render(<SpecDrawer recall={recall} onClose={() => {}} />)

    expect(screen.getByText(/1\s*\/\s*2/)).toBeTruthy()      // met/total progress
    expect(screen.getByText(/ship safely/)).toBeTruthy()      // goal
    expect(screen.getByText('tokens secure')).toBeTruthy()
    expect(screen.getByText('cookie path verified')).toBeTruthy() // the agent's claim
    expect(screen.getAllByText('met').length).toBeGreaterThan(0)
    expect(screen.getByText('unmet')).toBeTruthy()
  })

  it('shows "no claim yet" for a criterion the agent has not addressed', () => {
    render(<SpecDrawer recall={recall} onClose={() => {}} />)
    const row = screen.getByText('roles enforced').closest('.spec-crit') as HTMLElement
    expect(within(row).getByText(/no claim/i)).toBeTruthy()
  })

  it('renders a dropped criterion as out of scope, not as a contract item', () => {
    render(<SpecDrawer recall={recall} onClose={() => {}} />)
    const row = screen.getByText('old criterion').closest('.spec-crit') as HTMLElement
    expect(within(row).getByText('dropped')).toBeTruthy()
  })

  it('links a claim back to its results card and closes', () => {
    const onOpenCard = vi.fn()
    const onClose = vi.fn()
    render(<SpecDrawer recall={recall} onClose={onClose} onOpenCard={onOpenCard} />)

    fireEvent.click(screen.getByRole('button', { name: /results/i }))
    expect(onOpenCard).toHaveBeenCalledWith('r1')

    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalled()
  })
})
