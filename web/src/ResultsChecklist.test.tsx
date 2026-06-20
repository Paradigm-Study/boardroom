// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../../src/shared/card.js'
import { ResultsChecklist } from './ResultsChecklist.js'

const claim = (id: string, prompt: string): Card['decisions'][number] => ({
  id, prompt,
  options: [{ id: 'approve', label: 'Approve' }, { id: 'revise', label: 'Revise' }, { id: 'reject', label: 'Reject' }],
  noteRequiredOn: ['revise', 'reject'],
})

const card: Card = {
  id: 'results-1',
  stage: 'results',
  session: { agent: 'codex', project: 'boardroom' },
  headline: 'Review results',
  blocks: [],
  decisions: [claim('claim-1', 'The layout bug is fixed')],
  status: 'pending',
  createdAt: '2026-06-16T12:00:00.000Z',
}

const twoClaimCard: Card = {
  ...card,
  decisions: [claim('claim-1', 'The layout bug is fixed'), claim('claim-2', 'The approval button is visible')],
}

// A real results card also carries the synthetic verdict decision; the checklist
// must NOT render it as a claim row (the submit bar drives it).
const cardWithVerdict: Card = {
  ...card,
  decisions: [
    claim('claim-1', 'The layout bug is fixed'),
    { id: 'results_verdict', prompt: 'Is the session complete?', options: [{ id: 'complete', label: 'Mark complete' }, { id: 'continue', label: 'Keep going' }] },
  ],
}

afterEach(() => cleanup())

describe('ResultsChecklist', () => {
  it('renders all three verdict buttons (approve / revise / reject) per claim', () => {
    render(
      <ResultsChecklist
        card={twoClaimCard}
        blockById={new Map()}
        answers={{}}
        readonly={false}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Revise' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Reject' })).toHaveLength(2)
  })

  it('does not render the session verdict as a claim row', () => {
    render(
      <ResultsChecklist
        card={cardWithVerdict}
        blockById={new Map()}
        answers={{}}
        readonly={false}
        onChange={vi.fn()}
      />,
    )

    // Only the one real claim is shown; "Is the session complete?" is not a row.
    expect(screen.getByText('The layout bug is fixed')).toBeTruthy()
    expect(screen.queryByText('Is the session complete?')).toBeNull()
    // Exactly one claim row → exactly one Reject verdict button (the verdict has none).
    expect(screen.getAllByRole('button', { name: 'Reject' })).toHaveLength(1)
  })

  it('shows a note field even on an approved claim (always-on per-claim add-on)', () => {
    render(
      <ResultsChecklist
        card={card}
        blockById={new Map()}
        answers={{ 'claim-1': { chosen: ['approve'], note: '', custom: '' } }}
        readonly={false}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('Note for this claim')).toBeTruthy()
  })

  it('shows a revision note when a claim is marked Revise', () => {
    render(
      <ResultsChecklist
        card={card}
        blockById={new Map()}
        answers={{ 'claim-1': { chosen: ['revise'], note: '', custom: '' } }}
        readonly={false}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('What to revise')).toBeTruthy()
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

  it('offers file upload on rejected claim notes', () => {
    render(
      <ResultsChecklist
        card={card}
        blockById={new Map()}
        answers={{ 'claim-1': { chosen: ['reject'], note: '', custom: '' } }}
        readonly={false}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Attach file to rejection note' })).toBeTruthy()
  })

  it('labels the reject-note textarea for assistive tech (no placeholder-only labeling)', () => {
    render(
      <ResultsChecklist
        card={card}
        blockById={new Map()}
        answers={{ 'claim-1': { chosen: ['reject'], note: '', custom: '' } }}
        readonly={false}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('Reason for rejection')).toBeTruthy()
  })

  it('still surfaces the note on a legacy "deny" verdict (cards decided before the deny→reject rename)', () => {
    render(
      <ResultsChecklist
        card={card}
        blockById={new Map()}
        answers={{ 'claim-1': { chosen: ['deny'], note: 'this was the wrong direction', custom: '' } }}
        readonly
        onChange={vi.fn()}
      />,
    )

    // A historical card stored chosen:['deny']; it must still show its note rather
    // than silently falling through to the idle/unreviewed branch and hiding it.
    expect(screen.getByDisplayValue('this was the wrong direction')).toBeTruthy()
  })
})
