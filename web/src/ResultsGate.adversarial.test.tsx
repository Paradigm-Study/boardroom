// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../../src/shared/card.js'
import { CardView } from './CardView.js'
import { ResultsChecklist } from './ResultsChecklist.js'
import type { DraftAnswer } from './helpers.js'

vi.mock('./api.js', () => ({
  decideCard: vi.fn(),
  uploadAttachment: vi.fn(),
  // CardView mounts the SpecAffordance (reads cards to recall a locked spec); an
  // empty card list keeps it hidden so these results-gate assertions are unaffected.
  fetchCards: vi.fn(() => Promise.resolve([])),
  subscribeCards: vi.fn(() => () => {}),
}))

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.clearAllMocks()
})

const claim = (id: string, prompt: string): Card['decisions'][number] => ({
  id, prompt,
  options: [{ id: 'approve', label: 'Approve' }, { id: 'revise', label: 'Revise' }, { id: 'reject', label: 'Reject' }],
  noteRequiredOn: ['revise', 'reject'],
})

const baseCard: Card = {
  id: 'results-1',
  stage: 'results',
  session: { agent: 'codex', project: 'boardroom' },
  headline: 'Review results',
  blocks: [],
  decisions: [claim('claim-1', 'The layout bug is fixed')],
  status: 'pending',
  createdAt: '2026-06-16T12:00:00.000Z',
}

// A tiny controlled wrapper so we can observe single-select verdict swaps the way
// the real CardView does — feeding each onChange back into the answers map.
function ControlledChecklist({ card, initial }: { card: Card; initial?: Record<string, DraftAnswer> }) {
  const [answers, setAnswers] = useState<Record<string, DraftAnswer>>(initial ?? {})
  return (
    <ResultsChecklist
      card={card}
      blockById={new Map()}
      answers={answers}
      readonly={false}
      onChange={(id, a) => setAnswers(prev => ({ ...prev, [id]: a }))}
    />
  )
}

describe('ResultsChecklist — adversarial', () => {
  it('renders exactly three verdict buttons per claim and never a row for results_verdict', () => {
    const card: Card = {
      ...baseCard,
      decisions: [
        claim('claim-1', 'The layout bug is fixed'),
        // verdict planted FIRST to catch any ordering/index assumption
        { id: 'results_verdict', prompt: 'Is the session complete?', options: [{ id: 'complete', label: 'Mark complete' }, { id: 'continue', label: 'Keep going' }] },
        claim('claim-2', 'The approval button is visible'),
      ],
    }
    render(<ControlledChecklist card={card} />)

    // 2 real claims -> 2 of each verdict button. The verdict has none.
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Revise' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Reject' })).toHaveLength(2)
    expect(screen.queryByText('Is the session complete?')).toBeNull()
    // The header counts only real claims.
    expect(screen.getByText('Agent claims 2 things done')).toBeTruthy()
  })

  it('single-selects the verdict: Revise then Reject swaps the chosen state and the note label', () => {
    render(<ControlledChecklist card={baseCard} />)

    fireEvent.click(screen.getByRole('button', { name: 'Revise' }))
    expect(screen.getByLabelText('What to revise')).toBeTruthy()
    // revise note label present, reject label absent
    expect(screen.queryByLabelText('Reason for rejection')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    // After the swap the revise note must be GONE (not additive) and reject present.
    expect(screen.getByLabelText('Reason for rejection')).toBeTruthy()
    expect(screen.queryByLabelText('What to revise')).toBeNull()
    // Still exactly one textarea — the verdict didn't accumulate two notes.
    expect(document.querySelectorAll('textarea.note')).toHaveLength(1)
  })

  it('an approved claim still has a note textarea labelled for AT (not placeholder-only)', () => {
    render(
      <ResultsChecklist
        card={baseCard}
        blockById={new Map()}
        answers={{ 'claim-1': { chosen: ['approve'], note: '', custom: '' } }}
        readonly={false}
        onChange={vi.fn()}
      />,
    )
    const ta = screen.getByLabelText('Note for this claim')
    expect(ta.tagName).toBe('TEXTAREA')
    // The accessible name comes from aria-label, NOT a placeholder.
    expect(ta.getAttribute('aria-label')).toBe('Note for this claim')
  })

  it('renders a legacy "changes" verdict (changes->revise rename) without falling through to idle', () => {
    // Existing suite only covers legacy "deny"; "changes" is the untested twin.
    render(
      <ResultsChecklist
        card={baseCard}
        blockById={new Map()}
        answers={{ 'claim-1': { chosen: ['changes'], note: 'tighten the copy', custom: '' } }}
        readonly
        onChange={vi.fn()}
      />,
    )
    // Must surface the stored note AND treat it as the revise verdict (revise label).
    expect(screen.getByDisplayValue('tighten the copy')).toBeTruthy()
    expect(screen.getByLabelText('What to revise')).toBeTruthy()
    expect(screen.getByText('The layout bug is fixed')).toBeTruthy()
  })

  it('does not crash on a results card with ZERO claims (only the verdict)', () => {
    const verdictOnly: Card = {
      ...baseCard,
      decisions: [{ id: 'results_verdict', prompt: 'Is the session complete?', options: [{ id: 'complete', label: 'Mark complete' }, { id: 'continue', label: 'Keep going' }] }],
    }
    render(
      <ResultsChecklist
        card={verdictOnly}
        blockById={new Map()}
        answers={{}}
        readonly={false}
        onChange={vi.fn()}
      />,
    )
    // Pluralization off-by-one: 0 claims -> "0 things", not "0 thing".
    expect(screen.getByText('Agent claims 0 things done')).toBeTruthy()
    expect(screen.getByText('0 of 0 reviewed')).toBeTruthy()
    // No verdict buttons at all (no claim rows).
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull()
  })
})

describe('CardView results gate — adversarial', () => {
  const twoClaimResults: Card = {
    ...baseCard,
    id: 'results-cv',
    decisions: [
      claim('claim-1', 'Claim one'),
      claim('claim-2', 'Claim two'),
      { id: 'results_verdict', prompt: 'Is the session complete?', options: [{ id: 'complete', label: 'Mark complete' }, { id: 'continue', label: 'Keep going' }] },
    ],
  }

  it('renders the always-on add-on box and ONE derived finish button (no separate Mark complete)', () => {
    render(<CardView card={twoClaimResults} />)

    const addon = screen.getByLabelText('Add instructions for the agent')
    expect(addon.tagName).toBe('TEXTAREA')
    // Exactly one finish button — nothing reviewed yet, so it derives "Keep going" and is enabled.
    expect(document.querySelectorAll('.results-submit button.submit')).toHaveLength(1)
    const finish = screen.getByRole('button', { name: 'Keep going' }) as HTMLButtonElement
    expect(finish.disabled).toBe(false)
    // The human never picks "Mark complete" — it only appears once the state earns it.
    expect(screen.queryByRole('button', { name: 'Mark complete' })).toBeNull()
  })

  it('the single button reads Keep going until EVERY claim is approved, then flips to Mark complete', async () => {
    render(<CardView card={twoClaimResults} />)

    expect(screen.getByRole('button', { name: 'Keep going' })).toBeTruthy()

    // Review exactly one of two claims — still mid-flight, so still "Keep going".
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0])
    expect(screen.getByText('1/2 reviewed')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Keep going' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Mark complete' })).toBeNull()

    // Approve the second; the derived label flips to Mark complete and is enabled.
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[1])
    const complete = await screen.findByRole('button', { name: 'Mark complete' }) as HTMLButtonElement
    expect(complete.disabled).toBe(false)
    expect(screen.queryByRole('button', { name: 'Keep going' })).toBeNull()
  })

  it('stays Keep going and DISABLED when a reviewed claim is Revise without a note (note-required gate)', async () => {
    render(<CardView card={twoClaimResults} />)

    // Approve claim 1, Revise claim 2 but leave the required note empty.
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0])
    fireEvent.click(screen.getAllByRole('button', { name: 'Revise' })[1])

    // The revise claim has a verdict but no note, so it does NOT count as reviewed.
    expect(screen.getByText('1/2 reviewed')).toBeTruthy()
    // A revise keeps the verdict at "continue" (never "complete"), and the missing
    // required note disables the single button.
    const keepGoing = screen.getByRole('button', { name: 'Keep going' }) as HTMLButtonElement
    expect(keepGoing.disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Mark complete' })).toBeNull()

    // Provide the note -> the button unlocks, still "Keep going" (a revise is not done).
    fireEvent.change(screen.getByLabelText('What to revise'), { target: { value: 'shorten it' } })
    await waitFor(() => expect(keepGoing.disabled).toBe(false))
    expect(screen.queryByRole('button', { name: 'Mark complete' })).toBeNull()
  })

  it('stays Keep going when all claims are approved but the human added an instruction note', async () => {
    render(<CardView card={twoClaimResults} />)

    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))
    // All approved -> would be "Mark complete"...
    expect(await screen.findByRole('button', { name: 'Mark complete' })).toBeTruthy()

    // ...but typing an add-on instruction means there is work left -> back to "Keep going".
    fireEvent.change(screen.getByLabelText('Add instructions for the agent'), { target: { value: 'also add a test' } })
    expect(await screen.findByRole('button', { name: 'Keep going' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Mark complete' })).toBeNull()
  })
})
