// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../../src/shared/card.js'
import { decideCard } from './api.js'
import { CardView } from './CardView.js'

vi.mock('./api.js', () => ({
  decideCard: vi.fn(),
  uploadAttachment: vi.fn(),
}))

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.clearAllMocks()
})

const pendingPlan: Card = {
  id: 'plan-1',
  stage: 'plan',
  session: { agent: 'codex', project: 'boardroom', title: 'Plan QA' },
  headline: 'Fix plan submit layout',
  blocks: [
    {
      id: 'choice',
      type: 'options_compare',
      title: 'Submit layout choice',
      options: [
        { label: 'Fix shared submit CSS', pros: ['Keeps actions visible'], cons: [], recommended: true },
        { label: 'Leave it', pros: [], cons: ['Proceed button can be pushed offscreen'] },
      ],
    },
    {
      id: 'global',
      type: 'markdown',
      title: 'Global constraints',
      text: 'Applies to the whole card.',
    },
  ],
  decisions: [
    {
      id: 'scope',
      prompt: 'Proceed with the submit layout fix?',
      blockRefs: ['choice'],
      options: [
        { id: 'approve', label: 'Approve fix scope', recommended: true },
        { id: 'revise', label: 'Revise' },
      ],
    },
    {
      id: 'plan_verdict',
      prompt: 'Verdict on this plan',
      options: [
        { id: 'approve', label: 'Approve plan', recommended: true },
        { id: 'revise', label: 'Revise' },
      ],
      noteRequiredOn: ['revise'],
    },
  ],
  status: 'pending',
  createdAt: '2026-06-16T12:00:00.000Z',
}

const pendingClarify: Card = {
  ...pendingPlan,
  id: 'clarify-1',
  stage: 'clarify',
  headline: 'Pick a detail option',
  decisions: [
    {
      id: 'detail',
      prompt: 'Which detail should the agent use?',
      options: [
        { id: 'a', label: 'Detail A', recommended: true },
        { id: 'b', label: 'Detail B' },
      ],
    },
  ],
}

const pendingResults: Card = {
  ...pendingPlan,
  id: 'results-1',
  stage: 'results',
  headline: 'Review completed work',
  decisions: [
    { id: 'claim-1', prompt: 'Claim one', options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }], noteRequiredOn: ['deny'] },
    { id: 'claim-2', prompt: 'Claim two', options: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }], noteRequiredOn: ['deny'] },
  ],
}

describe('CardView pending plan actions', () => {
  it('shows explicit session provenance for the selected card', () => {
    render(<CardView card={pendingPlan} />)

    const source = screen.getByLabelText('Decision source')
    expect(within(source).getByText('Session')).toBeTruthy()
    expect(within(source).getByText('Plan QA')).toBeTruthy()
    expect(within(source).getByText('Project')).toBeTruthy()
    expect(within(source).getByText('boardroom')).toBeTruthy()
  })

  it('renders both send-back and proceed actions for pending plan cards', () => {
    render(<CardView card={pendingPlan} />)

    expect(screen.getByRole('button', { name: 'Send back…' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve plan & proceed' })).toBeTruthy()
  })

  it('keeps decisions primary and binds linked context to each question', () => {
    render(<CardView card={pendingPlan} />)

    expect(screen.getByLabelText('Decision sheet')).toBeTruthy()
    const questionContext = screen.getByLabelText('Decision 1 context')
    expect(within(questionContext).getByText('Question context')).toBeTruthy()
    expect(within(questionContext).getByText(/Submit layout choice/)).toBeTruthy()
    const globalContext = screen.getByLabelText('Global card context')
    expect(within(globalContext).getByText('Global context')).toBeTruthy()
    expect(within(globalContext).getByText(/Global constraints/)).toBeTruthy()
    expect(screen.queryByLabelText('Visual evidence')).toBeNull()
  })

  it('submits an approved plan verdict after the plan detail decision is selected', async () => {
    vi.mocked(decideCard).mockResolvedValue({ card: { ...pendingPlan, status: 'decided' }, summary: 'ok', delivered: true })
    render(<CardView card={pendingPlan} />)

    fireEvent.click(screen.getByRole('button', { name: 'Approve fix scope' }))
    const approve = screen.getByRole('button', { name: 'Approve plan & proceed' })
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(approve)

    await waitFor(() => expect(decideCard).toHaveBeenCalledWith('plan-1', {
      scope: { chosen: ['approve'] },
      plan_verdict: { chosen: ['approve'] },
    }))
  })

  it('submits detail decisions after an option click', async () => {
    vi.mocked(decideCard).mockResolvedValue({ card: { ...pendingClarify, status: 'decided' }, summary: 'ok', delivered: true })
    render(<CardView card={pendingClarify} />)

    fireEvent.click(screen.getByRole('button', { name: 'Detail A' }))
    const submit = screen.getByRole('button', { name: 'Submit decisions' })
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(submit)

    await waitFor(() => expect(decideCard).toHaveBeenCalledWith('clarify-1', {
      detail: { chosen: ['a'] },
    }))
  })

  it('approve all enables and submits the results review', async () => {
    vi.mocked(decideCard).mockResolvedValue({ card: { ...pendingResults, status: 'decided' }, summary: 'ok', delivered: true })
    render(<CardView card={pendingResults} />)

    const submit = screen.getByRole('button', { name: 'Submit review' })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))

    expect(screen.getByText('2 of 2 reviewed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve all' })).toBeNull()
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(submit)

    await waitFor(() => expect(decideCard).toHaveBeenCalledWith('results-1', {
      'claim-1': { chosen: ['approve'] },
      'claim-2': { chosen: ['approve'] },
    }))
  })

  it('offers file upload on the plan send-back note', () => {
    render(<CardView card={pendingPlan} />)

    fireEvent.click(screen.getByRole('button', { name: 'Send back…' }))

    expect(screen.getByRole('button', { name: 'Attach file to send-back note' })).toBeTruthy()
  })

  it('keeps compact submit-bar overrides after the base submit button rule', () => {
    const css = readFileSync('web/src/styles.css', 'utf8')
    const baseSubmit = css.lastIndexOf('\n.submit {')
    const compactSubmit = css.lastIndexOf('\n.submit-bar .submit {')
    const compactGhost = css.lastIndexOf('\n.submit.ghost {')

    expect(baseSubmit).toBeGreaterThan(-1)
    expect(compactSubmit).toBeGreaterThan(baseSubmit)
    expect(compactGhost).toBeGreaterThan(baseSubmit)
  })

  it('keeps progress visible in the primary decision-sheet submit bar', () => {
    const css = readFileSync('web/src/styles.css', 'utf8')

    expect(css).toContain('.submit-state { font-size: 12.5px;')
    expect(css).not.toContain('.decision-dock .submit-state { display: none; }')
  })

  it('wraps each flowing decision row with a border', () => {
    const css = readFileSync('web/src/styles.css', 'utf8')

    expect(css).toContain('.decision-row {')
    expect(css).toContain('border: 1px solid var(--line);')
    expect(css).toContain('border-radius: var(--r);')
  })
})
