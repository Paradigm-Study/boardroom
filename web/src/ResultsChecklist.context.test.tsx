// @vitest-environment jsdom
// The claim context accordion: each claim row grows a full-width toggle line that
// previews the claim's story as differentiated segments (Ask / Did / Proof) and
// expands into the panel telling that story in order — the criterion being
// answered, the agent's own notes, then the verifying artifacts.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Block } from '../../src/shared/blocks.js'
import type { Card } from '../../src/shared/card.js'
import { ResultsChecklist } from './ResultsChecklist.js'

afterEach(cleanup)

const criterion = { id: 'cr1', behavior: 'tokens are secure', good: 'httpOnly cookie only', bad: 'token in localStorage', tracesTo: 'token_storage' }

const noteBlock: Block = { id: 'c1/note', type: 'markdown', text: 'Moved the token into an httpOnly cookie.' }
const proofBlock: Block = { id: 'c1/run', type: 'evidence', command: 'npm test', output: 'ok', exitCode: 0 }

function resultsCard(overrides: Partial<Card>): Card {
  return {
    id: 'results-1',
    stage: 'results',
    session: { agent: 'codex', project: 'boardroom', title: 'Results QA' },
    headline: 'Review completed work',
    blocks: [],
    decisions: [],
    status: 'pending',
    createdAt: '2026-07-14T12:00:00.000Z',
    ...overrides,
  }
}

const claim = (id: string, extra: Partial<Card['decisions'][number]> = {}): Card['decisions'][number] => ({
  id, prompt: `claim ${id}`,
  options: [{ id: 'approve', label: 'Approve' }, { id: 'revise', label: 'Revise' }, { id: 'reject', label: 'Reject' }],
  noteRequiredOn: ['revise', 'reject'],
  ...extra,
})

function renderChecklist(card: Card) {
  const blockById = new Map(card.blocks.map(b => [b.id, b]))
  return render(
    <ResultsChecklist card={card} blockById={blockById} answers={{}} readonly={false} onChange={() => {}} />,
  )
}

describe('claim context toggle line', () => {
  it('previews Ask / Did / Proof as separate segments', () => {
    renderChecklist(resultsCard({
      blocks: [noteBlock, proofBlock],
      criteria: [criterion],
      decisions: [claim('c1', { criterionId: 'cr1', blockRefs: ['c1/note', 'c1/run'] })],
    }))
    const toggle = screen.getByLabelText(/Show context/)
    expect(within(toggle).getByText('Context')).toBeTruthy()
    expect(within(toggle).getByText('tokens are secure')).toBeTruthy()
    expect(within(toggle).getByText('1 note')).toBeTruthy()
    expect(within(toggle).getByText('npm test · exit 0')).toBeTruthy()
  })

  it('renders for a criterion-only claim (no evidence blocks) and omits absent segments', () => {
    renderChecklist(resultsCard({
      criteria: [criterion],
      decisions: [claim('c1', { criterionId: 'cr1' })],
    }))
    const toggle = screen.getByLabelText(/Show context/)
    expect(within(toggle).getByText('tokens are secure')).toBeTruthy()
    expect(within(toggle).queryByText(/note/)).toBeNull()
  })

  it('renders nothing for a claim with neither criterion nor blocks', () => {
    renderChecklist(resultsCard({ decisions: [claim('c1')] }))
    expect(screen.queryByLabelText(/Show context/)).toBeNull()
  })
})

describe('claim context panel', () => {
  it('opens to Ask → Did → Proof in that order, with the criterion standards under Ask', () => {
    renderChecklist(resultsCard({
      blocks: [noteBlock, proofBlock],
      criteria: [criterion],
      decisions: [claim('c1', { criterionId: 'cr1', blockRefs: ['c1/note', 'c1/run'] })],
    }))
    fireEvent.click(screen.getByLabelText(/Show context/))

    const labels = document.querySelectorAll('.ctx-label')
    expect([...labels].map(l => l.textContent)).toEqual(['Ask', 'Did', 'Proof'])

    // Ask carries the full standard: behavior + the good/bad rails.
    expect(screen.getByText('httpOnly cookie only')).toBeTruthy()
    expect(screen.getByText('token in localStorage')).toBeTruthy()
    // Did is the agent's markdown notes, not a restatement of the claim row.
    expect(screen.getByText('Moved the token into an httpOnly cookie.')).toBeTruthy()
    // Proof holds the non-markdown artifacts (also previewed in the toggle line).
    expect(screen.getAllByText(/npm test/).length).toBeGreaterThanOrEqual(2)

    fireEvent.click(screen.getByLabelText(/Hide context/))
    expect(document.querySelectorAll('.ctx-label').length).toBe(0)
  })

  it('splits notes into Did and artifacts into Proof — notes never render under Proof', () => {
    renderChecklist(resultsCard({
      blocks: [noteBlock, proofBlock],
      decisions: [claim('c1', { blockRefs: ['c1/note', 'c1/run'] })],
    }))
    fireEvent.click(screen.getByLabelText(/Show context/))

    const sections = [...document.querySelectorAll('.ctx-section')]
    expect(sections.length).toBe(2)
    const [didSection, proofSection] = sections
    expect(didSection.querySelector('.ctx-label')?.textContent).toBe('Did')
    expect(within(didSection as HTMLElement).getByText('Moved the token into an httpOnly cookie.')).toBeTruthy()
    expect(proofSection.querySelector('.ctx-label')?.textContent).toBe('Proof')
    expect(within(proofSection as HTMLElement).queryByText('Moved the token into an httpOnly cookie.')).toBeNull()
  })

  it('skips the Ask section when the claim has no criterion', () => {
    renderChecklist(resultsCard({
      blocks: [proofBlock],
      decisions: [claim('c1', { blockRefs: ['c1/run'] })],
    }))
    fireEvent.click(screen.getByLabelText(/Show context/))
    expect([...document.querySelectorAll('.ctx-label')].map(l => l.textContent)).toEqual(['Proof'])
  })
})
