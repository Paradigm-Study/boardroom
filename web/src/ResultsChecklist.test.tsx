// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../../src/shared/card.js'
import { ResultsChecklist } from './ResultsChecklist.js'

const card: Card = {
  id: 'results-1',
  stage: 'results',
  session: { agent: 'codex', project: 'boardroom' },
  headline: 'Review results',
  blocks: [],
  decisions: [{
    id: 'claim-1',
    prompt: 'The layout bug is fixed',
    options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
    noteRequiredOn: ['deny'],
  }],
  status: 'pending',
  createdAt: '2026-06-16T12:00:00.000Z',
}

const twoClaimCard: Card = {
  ...card,
  decisions: [
    card.decisions[0],
    {
      id: 'claim-2',
      prompt: 'The approval button is visible',
      options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
      noteRequiredOn: ['deny'],
    },
  ],
}

afterEach(() => cleanup())

describe('ResultsChecklist', () => {
  it('renders visible approve and deny button text for each claim', () => {
    render(
      <ResultsChecklist
        card={twoClaimCard}
        blockById={new Map()}
        answers={{}}
        readonly={false}
        onChange={vi.fn()}
      />,
    )

    const approveButtons = screen.getAllByRole('button', { name: 'Approve' })
    const denyButtons = screen.getAllByRole('button', { name: 'Deny' })

    expect(approveButtons).toHaveLength(2)
    expect(denyButtons).toHaveLength(2)
    for (const button of [...approveButtons, ...denyButtons]) {
      expect(button.textContent).toContain(button.getAttribute('aria-label'))
    }
  })

  it('offers a file picker button on every claim before a verdict is selected', () => {
    render(
      <ResultsChecklist
        card={twoClaimCard}
        blockById={new Map()}
        answers={{}}
        readonly={false}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getAllByRole('button', { name: /^Attach file to claim / })).toHaveLength(2)
  })

  it('offers file upload on denied claim notes', () => {
    render(
      <ResultsChecklist
        card={card}
        blockById={new Map()}
        answers={{ 'claim-1': { chosen: ['deny'], note: '', custom: '' } }}
        readonly={false}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Attach file to denial note' })).toBeTruthy()
  })
})
