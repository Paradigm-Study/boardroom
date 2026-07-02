// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Card } from '../../src/shared/card.js'
import { SpecAffordance } from './SpecAffordance.js'

afterEach(cleanup)

// A locked spec card for a project (mirrors specRecall.test.ts fixtures).
function lockedSpec(project: string, id = `spec-${project}`): Card {
  const crit = (cid: string, behavior: string) =>
    ({ id: cid, behavior, good: 'g', bad: 'b', tracesTo: 'd1' })
  return {
    id, stage: 'spec',
    session: { agent: 'claude-code', project },
    headline: 'definition of done',
    blocks: [{ id: 'spec_contract', type: 'acceptance', goal: 'ship safely', criteria: [crit('cr1', 'a'), crit('cr2', 'b')] }],
    criteria: [crit('cr1', 'a'), crit('cr2', 'b')],
    decisions: [
      { id: 'crit:cr1', prompt: 'a', criterionId: 'cr1', options: [{ id: 'keep', label: 'Keep' }] },
      { id: 'crit:cr2', prompt: 'b', criterionId: 'cr2', options: [{ id: 'keep', label: 'Keep' }] },
      { id: 'spec_verdict', prompt: 'Lock?', options: [{ id: 'lock', label: 'Lock' }, { id: 'revise', label: 'Revise' }] },
    ],
    status: 'decided', createdAt: '2026-06-26T00:00:00.000Z', decidedAt: '2026-06-26T00:01:00.000Z',
    answers: {
      'crit:cr1': { chosen: ['keep'] },
      'crit:cr2': { chosen: ['keep'] },
      spec_verdict: { chosen: ['lock'] },
    },
  }
}

describe('SpecAffordance (pure view over the app card store)', () => {
  it('renders the met-count button when the project has a locked spec', () => {
    render(<SpecAffordance project="demo" cards={[lockedSpec('demo')]} />)
    expect(screen.getByRole('button', { name: /acceptance contract/i }).textContent).toContain('0/2 met')
  })

  it('renders nothing when only ANOTHER project has a locked spec (no cross-project bleed)', () => {
    const { container } = render(<SpecAffordance project="demo" cards={[lockedSpec('other-project')]} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing with no cards at all', () => {
    const { container } = render(<SpecAffordance project="demo" cards={[]} />)
    expect(container.innerHTML).toBe('')
  })

  it('opens the drawer on click and closes it again', () => {
    render(<SpecAffordance project="demo" cards={[lockedSpec('demo')]} />)
    fireEvent.click(screen.getByRole('button', { name: /acceptance contract/i }))
    expect(screen.getByLabelText('Spec contract')).toBeTruthy()
    expect(screen.getByText(/ship safely/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(screen.queryByLabelText('Spec contract')).toBeNull()
  })
})
