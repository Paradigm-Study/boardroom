// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Card } from '../../src/shared/card.js'
import { decideCard, dismissCard, uploadAttachment } from './api.js'
import { CardView } from './CardView.js'

vi.mock('./api.js', () => ({
  decideCard: vi.fn(),
  dismissCard: vi.fn(),
  uploadAttachment: vi.fn(),
  // CardView mounts the SpecAffordance, which reads cards to recall a locked spec.
  // No cards → no spec → the affordance renders nothing, leaving these tests intact.
  fetchCards: vi.fn(() => Promise.resolve([])),
  subscribeCards: vi.fn(() => () => {}),
}))

afterEach(() => {
  vi.useRealTimers()
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

// One block referenced by two decisions — the duplicate-anchor case: an unscoped
// `block-<id>` would appear twice and an Evidence link would jump to the wrong row.
const sharedBlockCard: Card = {
  ...pendingClarify,
  id: 'shared-1',
  blocks: [
    { id: 'shared', type: 'markdown', title: 'Shared evidence', text: 'Referenced by both decisions.' },
    { id: 'global', type: 'markdown', title: 'Global', text: 'whole-card context' },
  ],
  decisions: [
    { id: 'first', prompt: 'First?', blockRefs: ['shared'], options: [{ id: 'a', label: 'A1', recommended: true }, { id: 'b', label: 'B1' }] },
    { id: 'second', prompt: 'Second?', blockRefs: ['shared'], options: [{ id: 'a', label: 'A2', recommended: true }, { id: 'b', label: 'B2' }] },
  ],
}

const resultsClaim = (id: string, prompt: string): Card['decisions'][number] => ({
  id, prompt,
  options: [{ id: 'approve', label: 'Approve' }, { id: 'revise', label: 'Revise' }, { id: 'reject', label: 'Reject' }],
  noteRequiredOn: ['revise', 'reject'],
})

const pendingResults: Card = {
  ...pendingPlan,
  id: 'results-1',
  stage: 'results',
  headline: 'Review completed work',
  decisions: [
    resultsClaim('claim-1', 'Claim one'),
    resultsClaim('claim-2', 'Claim two'),
    { id: 'results_verdict', prompt: 'Is the session complete?', options: [{ id: 'complete', label: 'Mark complete' }, { id: 'continue', label: 'Keep going' }] },
  ],
}

const specCriterion = { id: 'cr1', behavior: 'tokens are secure', good: 'httpOnly cookie only', bad: 'token in localStorage', tracesTo: 'token_storage' }
const pendingSpec: Card = {
  ...pendingPlan,
  id: 'spec-1',
  stage: 'spec',
  headline: 'Definition of done',
  blocks: [
    { id: 'spec_contract', type: 'acceptance', title: 'Acceptance contract', goal: 'ship securely', criteria: [specCriterion] },
    { id: 'crit/cr1', type: 'acceptance', criteria: [specCriterion] },
  ],
  decisions: [
    { id: 'crit:cr1', prompt: 'tokens are secure', criterionId: 'cr1', blockRefs: ['crit/cr1'], options: [{ id: 'keep', label: 'Keep', recommended: true }, { id: 'adjust', label: 'Adjust' }, { id: 'drop', label: 'Drop' }], noteRequiredOn: ['adjust', 'drop'] },
    { id: 'spec_verdict', prompt: 'Lock this acceptance contract?', options: [{ id: 'lock', label: 'Lock spec', recommended: true }, { id: 'revise', label: 'Revise' }], noteRequiredOn: ['revise'] },
  ],
  criteria: [specCriterion],
}

describe('CardHeader session provenance', () => {
  // The sheet-source link is decision-sheet-only, and results cards render the
  // checklist instead of a decision sheet — the header strip is their ONLY
  // provenance surface, so the bound session title must link to the stream there.
  it('links the header session title to #/session/<id> when the card is bound', () => {
    render(<CardView card={{ ...pendingResults, claudeSessionId: 'cc-123' }} />)
    const strip = screen.getByLabelText('Decision source')
    const link = within(strip).getByRole('link', { name: 'Plan QA' })
    expect(link.getAttribute('href')).toBe('#/session/cc-123')
  })

  it('renders a plain, unlinked title for an unbound (legacy) card', () => {
    render(<CardView card={pendingResults} />)
    const strip = screen.getByLabelText('Decision source')
    expect(within(strip).queryByRole('link', { name: 'Plan QA' })).toBeNull()
    expect(within(strip).getByText('Plan QA')).toBeTruthy()
  })
})

describe('CardView pending spec actions', () => {
  it('renders send-back and lock actions, and the criterion as an acceptance block', () => {
    render(<CardView card={pendingSpec} />)

    expect(screen.getByRole('button', { name: 'Send back…' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Lock spec' })).toBeTruthy()
    // the good/bad contract is shown
    expect(screen.getAllByText(/httpOnly cookie only/).length).toBeGreaterThan(0)
  })

  it('locks the spec after each criterion is addressed', async () => {
    vi.mocked(decideCard).mockResolvedValue({ card: { ...pendingSpec, status: 'decided' }, summary: 'ok', delivered: true })
    render(<CardView card={pendingSpec} />)

    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    const lock = screen.getByRole('button', { name: 'Lock spec' })
    await waitFor(() => expect((lock as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(lock)

    await waitFor(() => expect(decideCard).toHaveBeenCalledWith('spec-1', {
      'crit:cr1': { chosen: ['keep'] },
      spec_verdict: { chosen: ['lock'] },
    }))
  })

  it('sends the spec back with a revise note', async () => {
    vi.mocked(decideCard).mockResolvedValue({ card: { ...pendingSpec, status: 'decided' }, summary: 'ok', delivered: true })
    render(<CardView card={pendingSpec} />)

    fireEvent.click(screen.getByRole('button', { name: 'Send back…' }))
    fireEvent.change(screen.getByLabelText('Send-back note'), { target: { value: 'add a performance criterion' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }))

    await waitFor(() => expect(decideCard).toHaveBeenCalledWith('spec-1', expect.objectContaining({
      spec_verdict: { chosen: ['revise'], note: 'add a performance criterion' },
    })))
  })
})

describe('CardView pending plan actions', () => {
  it('shows explicit session provenance for the selected card', () => {
    render(<CardView card={pendingPlan} />)

    const source = screen.getByLabelText('Decision source')
    expect(within(source).getByText('Session')).toBeTruthy()
    expect(within(source).getByText('Plan QA')).toBeTruthy()
    expect(within(source).getByText('Project')).toBeTruthy()
    expect(within(source).getByText('boardroom')).toBeTruthy()
  })

  it('shows the selected card creation time in the source metadata', () => {
    render(<CardView card={pendingPlan} />)

    const source = screen.getByLabelText('Decision source')
    const parts = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).formatToParts(new Date(pendingPlan.createdAt))
    const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(p => p.type === type)?.value ?? ''
    const created = `${part('weekday')} ${part('month')} ${part('day')} ${part('hour')}:${part('minute')} ${part('dayPeriod')}`

    expect(within(source).getByText('Created')).toBeTruthy()
    const value = within(source).getByText(created)
    expect(value).toBeTruthy()
    expect(value.closest('span')?.getAttribute('title')).toContain(part('dayPeriod'))
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

  it('renders the always-on add-on box and ONE derived finish button for a results card', () => {
    render(<CardView card={pendingResults} />)

    expect(screen.getByLabelText('Add instructions for the agent')).toBeTruthy()
    // Nothing reviewed yet, so the single button derives "Keep going" — never a manual pick.
    expect(screen.getByRole('button', { name: 'Keep going' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Mark complete' })).toBeNull()
  })

  it('the derived button becomes "Mark complete" once every claim is approved, and submits a complete verdict', async () => {
    vi.mocked(decideCard).mockResolvedValue({ card: { ...pendingResults, status: 'decided' }, summary: 'ok', delivered: true })
    render(<CardView card={pendingResults} />)

    // Before review it is "Keep going"; approving all claims flips it to an enabled "Mark complete".
    expect(screen.queryByRole('button', { name: 'Mark complete' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))

    const complete = await screen.findByRole('button', { name: 'Mark complete' })
    await waitFor(() => expect((complete as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(complete)

    await waitFor(() => expect(decideCard).toHaveBeenCalledWith('results-1', {
      'claim-1': { chosen: ['approve'] },
      'claim-2': { chosen: ['approve'] },
      results_verdict: { chosen: ['complete'] },
    }))
  })

  it('"Keep going" submits a continue verdict with the add-on riding the global card_addon channel, even with claims unreviewed', async () => {
    vi.mocked(decideCard).mockResolvedValue({ card: { ...pendingResults, status: 'decided' }, summary: 'ok', delivered: true })
    render(<CardView card={pendingResults} />)

    fireEvent.change(screen.getByLabelText('Add instructions for the agent'), { target: { value: 'also bump the version' } })
    const keepGoing = screen.getByRole('button', { name: 'Keep going' })
    await waitFor(() => expect((keepGoing as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(keepGoing)

    await waitFor(() => expect(decideCard).toHaveBeenCalledWith('results-1', expect.objectContaining({
      results_verdict: { chosen: ['continue'] },
      card_addon: { chosen: [], note: 'also bump the version' },
    })))
  })

  it('standing instructions keep the derived button on "Keep going" even with every claim approved', async () => {
    render(<CardView card={pendingResults} />)

    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))
    expect(await screen.findByRole('button', { name: 'Mark complete' })).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Add instructions for the agent'), { target: { value: 'now wire the settings page' } })
    expect(await screen.findByRole('button', { name: 'Keep going' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Mark complete' })).toBeNull()
  })

  it('offers file upload on the plan send-back note', () => {
    render(<CardView card={pendingPlan} />)

    fireEvent.click(screen.getByRole('button', { name: 'Send back…' }))

    expect(screen.getByRole('button', { name: 'Attach file to send-back note' })).toBeTruthy()
  })

  it('labels the send-back note textarea for assistive tech', () => {
    render(<CardView card={pendingPlan} />)

    fireEvent.click(screen.getByRole('button', { name: 'Send back…' }))

    expect(screen.getByLabelText('Send-back note')).toBeTruthy()
  })

  it('labels the offline-pickup textarea once a decision is recorded for offline pickup', async () => {
    vi.mocked(decideCard).mockResolvedValue({ card: { ...pendingClarify, status: 'decided' }, summary: 'paste me', delivered: false })
    render(<CardView card={pendingClarify} />)

    fireEvent.click(screen.getByRole('button', { name: 'Detail A' }))
    const submit = screen.getByRole('button', { name: 'Submit decisions' })
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(submit)

    const textarea = await screen.findByLabelText(/paste it in by hand/)
    expect((textarea as HTMLTextAreaElement).value).toBe('paste me')
  })

  it('confirms inline after copying the offline-pickup summary', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    vi.mocked(decideCard).mockResolvedValue({ card: { ...pendingClarify, status: 'decided' }, summary: 'paste me', delivered: false })
    render(<CardView card={pendingClarify} />)

    fireEvent.click(screen.getByRole('button', { name: 'Detail A' }))
    const submit = screen.getByRole('button', { name: 'Submit decisions' })
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(submit)

    const copy = await screen.findByRole('button', { name: 'Copy to clipboard' })
    fireEvent.click(copy)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('paste me'))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('falls back and confirms when the async clipboard write does not complete', async () => {
    const writeText = vi.fn(() => new Promise<void>(() => {}))
    const execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    vi.mocked(decideCard).mockResolvedValue({ card: { ...pendingClarify, status: 'decided' }, summary: 'paste me', delivered: false })
    render(<CardView card={pendingClarify} />)

    fireEvent.click(screen.getByRole('button', { name: 'Detail A' }))
    const submit = screen.getByRole('button', { name: 'Submit decisions' })
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(submit)

    const copy = await screen.findByRole('button', { name: 'Copy to clipboard' })
    vi.useFakeTimers()
    fireEvent.click(copy)
    await vi.advanceTimersByTimeAsync(800)

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
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

  it('scopes duplicate-block anchors per decision so evidence links never cross rows', () => {
    const { container } = render(<CardView card={sharedBlockCard} />)

    // The shared block is stamped once per referencing decision, with distinct ids.
    expect(container.querySelector('#block-first-shared')).toBeTruthy()
    expect(container.querySelector('#block-second-shared')).toBeTruthy()
    // The old unscoped (colliding) id is gone.
    expect(container.querySelector('#block-shared')).toBeNull()

    // Each decision's Evidence link targets its own scoped anchor.
    const hrefs = Array.from(container.querySelectorAll<HTMLAnchorElement>('.linked-evidence a'))
      .map(a => a.getAttribute('href'))
    expect(hrefs).toContain('#block-first-shared')
    expect(hrefs).toContain('#block-second-shared')
  })

  it('wraps each flowing decision row with a border', () => {
    const css = readFileSync('web/src/styles.css', 'utf8')

    expect(css).toContain('.decision-row {')
    expect(css).toContain('border: 1px solid var(--line);')
    expect(css).toContain('border-radius: var(--r);')
  })
})

// The GLOBAL card add-on: every gate — any stage, current or future — ends with the
// same always-visible input where the human appends instructions to the session
// (text + attachments) alongside whatever they decided above. It rides the reserved
// `card_addon` answer id, is dropped from the payload when empty, and never alters
// the decisions above it.
describe('CardView global add-on on every gate', () => {
  it.each([
    ['clarify', pendingClarify],
    ['plan', pendingPlan],
    ['spec', pendingSpec],
    ['results', pendingResults],
  ] as const)('renders the always-visible add-on box with file attach on a %s card', (_stage, card) => {
    render(<CardView card={card} />)
    expect(screen.getByLabelText('Add instructions for the agent')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Attach file to your add-on' })).toBeTruthy()
  })

  it('clarify: submits card_addon alongside the answers when the add-on has text', async () => {
    vi.mocked(decideCard).mockResolvedValue({ card: { ...pendingClarify, status: 'decided' }, summary: 'ok', delivered: true })
    render(<CardView card={pendingClarify} />)

    fireEvent.click(screen.getByRole('button', { name: 'Detail A' }))
    fireEvent.change(screen.getByLabelText('Add instructions for the agent'), { target: { value: 'also update the README' } })
    const submit = screen.getByRole('button', { name: 'Submit decisions' })
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(submit)

    await waitFor(() => expect(decideCard).toHaveBeenCalledWith('clarify-1', {
      detail: { chosen: ['a'] },
      card_addon: { chosen: [], note: 'also update the README' },
    }))
  })

  it('plan: approve stays approve — the add-on rides card_addon, never the verdict note', async () => {
    vi.mocked(decideCard).mockResolvedValue({ card: { ...pendingPlan, status: 'decided' }, summary: 'ok', delivered: true })
    render(<CardView card={pendingPlan} />)

    fireEvent.click(screen.getByRole('button', { name: 'Approve fix scope' }))
    fireEvent.change(screen.getByLabelText('Add instructions for the agent'), { target: { value: 'approved — but add telemetry' } })
    const approve = screen.getByRole('button', { name: 'Approve plan & proceed' })
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(approve)

    await waitFor(() => expect(decideCard).toHaveBeenCalledWith('plan-1', {
      scope: { chosen: ['approve'] },
      plan_verdict: { chosen: ['approve'] },
      card_addon: { chosen: [], note: 'approved — but add telemetry' },
    }))
  })

  it('spec: lock carries the add-on on card_addon', async () => {
    vi.mocked(decideCard).mockResolvedValue({ card: { ...pendingSpec, status: 'decided' }, summary: 'ok', delivered: true })
    render(<CardView card={pendingSpec} />)

    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    fireEvent.change(screen.getByLabelText('Add instructions for the agent'), { target: { value: 'start with the token module' } })
    const lock = screen.getByRole('button', { name: 'Lock spec' })
    await waitFor(() => expect((lock as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(lock)

    await waitFor(() => expect(decideCard).toHaveBeenCalledWith('spec-1', {
      'crit:cr1': { chosen: ['keep'] },
      spec_verdict: { chosen: ['lock'] },
      card_addon: { chosen: [], note: 'start with the token module' },
    }))
  })

  // An empty add-on never rides: the exact-payload submit tests above (clarify /
  // plan approve / spec lock / mark complete) double as the omit-when-empty guard —
  // none of them list a card_addon key.
  it('the add-on never blocks submitting: readiness ignores it', async () => {
    render(<CardView card={pendingClarify} />)

    fireEvent.click(screen.getByRole('button', { name: 'Detail A' }))
    const submit = screen.getByRole('button', { name: 'Submit decisions' })
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false))
  })

  it('the add-on drafts to localStorage and survives a remount', async () => {
    const first = render(<CardView card={pendingClarify} />)
    fireEvent.change(screen.getByLabelText('Add instructions for the agent'), { target: { value: 'remember me' } })
    first.unmount()

    render(<CardView card={pendingClarify} />)
    expect((screen.getByLabelText('Add instructions for the agent') as HTMLTextAreaElement).value).toBe('remember me')
  })

  it('send-back mode replaces the add-on composer, and the add-on still rides the revise submit', async () => {
    vi.mocked(decideCard).mockResolvedValue({ card: { ...pendingPlan, status: 'decided' }, summary: 'ok', delivered: true })
    render(<CardView card={pendingPlan} />)

    fireEvent.change(screen.getByLabelText('Add instructions for the agent'), { target: { value: 'and add telemetry' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send back…' }))
    // one composer at a time: the send-back form owns the footer while open
    expect(screen.queryByLabelText('Add instructions for the agent')).toBeNull()

    fireEvent.change(screen.getByLabelText('Send-back note'), { target: { value: 'wrong direction' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }))

    await waitFor(() => expect(decideCard).toHaveBeenCalledWith('plan-1', expect.objectContaining({
      plan_verdict: expect.objectContaining({ chosen: ['revise'], note: 'wrong direction' }),
      card_addon: { chosen: [], note: 'and add telemetry' },
    })))
  })

  it('a decided card shows the recorded add-on read-only; no box when there was none', () => {
    const decidedWith: Card = {
      ...pendingClarify,
      status: 'decided',
      answers: { detail: { chosen: ['a'] }, card_addon: { chosen: [], note: 'recorded instructions' } },
      decidedAt: '2026-07-14T00:00:00.000Z',
    }
    const first = render(<CardView card={decidedWith} />)
    const box = screen.getByLabelText('Add instructions for the agent') as HTMLTextAreaElement
    expect(box.value).toBe('recorded instructions')
    expect(box.disabled).toBe(true)
    first.unmount()

    const decidedWithout: Card = { ...decidedWith, answers: { detail: { chosen: ['a'] } } }
    render(<CardView card={decidedWithout} />)
    expect(screen.queryByLabelText('Add instructions for the agent')).toBeNull()
  })

  // A pre-deploy draft kept the results add-on on the verdict draft. It must
  // migrate into the visible add-on box (never ride invisibly), and the verdict
  // is always stamped from a clean draft at submit.
  it('migrates a legacy pre-deploy results draft into the add-on box', () => {
    localStorage.setItem(`boardroom-draft-${pendingResults.id}`, JSON.stringify({
      'claim-1': { chosen: [], note: '', custom: '' },
      'claim-2': { chosen: [], note: '', custom: '' },
      results_verdict: { chosen: [], note: 'typed before the deploy', custom: '' },
    }))
    render(<CardView card={pendingResults} />)
    expect((screen.getByLabelText('Add instructions for the agent') as HTMLTextAreaElement).value).toBe('typed before the deploy')
  })

  it('"Mark complete" stamps a clean verdict even when a stray draft note exists on it', async () => {
    localStorage.setItem(`boardroom-draft-${pendingResults.id}`, JSON.stringify({
      'claim-1': { chosen: [], note: '', custom: '' },
      'claim-2': { chosen: [], note: '', custom: '' },
      results_verdict: { chosen: [], note: 'stray invisible text', custom: '' },
      card_addon: { chosen: [], note: '', custom: '' },
    }))
    vi.mocked(decideCard).mockResolvedValue({ card: { ...pendingResults, status: 'decided' }, summary: 'ok', delivered: true })
    render(<CardView card={pendingResults} />)

    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))
    const complete = await screen.findByRole('button', { name: 'Mark complete' })
    await waitFor(() => expect((complete as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(complete)

    await waitFor(() => expect(decideCard).toHaveBeenCalledWith('results-1', {
      'claim-1': { chosen: ['approve'] },
      'claim-2': { chosen: ['approve'] },
      results_verdict: { chosen: ['complete'] },
    }))
  })

  it('an attachments-only add-on rides the payload and keeps the session going', async () => {
    const ref = { id: 'att-1', name: 'mock.png', size: 5, path: '/tmp/mock.png', field: 'note', uploadedAt: '2026-07-14T00:00:00.000Z' }
    vi.mocked(uploadAttachment).mockResolvedValue(ref)
    vi.mocked(decideCard).mockResolvedValue({ card: { ...pendingResults, status: 'decided' }, summary: 'ok', delivered: true })
    render(<CardView card={pendingResults} />)

    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))
    expect(await screen.findByRole('button', { name: 'Mark complete' })).toBeTruthy()

    const attachField = screen.getByRole('button', { name: 'Attach file to your add-on' }).closest('.attach-field')!
    const input = attachField.querySelector('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(['x'], 'mock.png', { type: 'image/png' })] } })

    // a standing attachment is a standing instruction: the derived verdict flips
    const keepGoing = await screen.findByRole('button', { name: 'Keep going' })
    await waitFor(() => expect((keepGoing as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(keepGoing)

    await waitFor(() => expect(decideCard).toHaveBeenCalledWith('results-1', expect.objectContaining({
      card_addon: { chosen: [], attachments: [ref] },
    })))
  })
})

// The copy-paste fallback is a PERMANENT record: once a card is decided it must be
// reconstructable from the card itself (not just the one-shot post-submit state), so
// switching sessions and returning to the card never loses it. It shows whether or
// not the agent has claimed the decision (delivered) — it is the human's fallback.
describe('CardView offline-pickup box persists as a permanent fallback', () => {
  const decidedClarify: Card = {
    ...pendingClarify,
    status: 'decided',
    answers: { detail: { chosen: ['a'] } },
    decidedAt: '2026-06-16T12:05:00.000Z',
  }

  it('reconstructs the copyable summary on a fresh mount of an undelivered decided card', () => {
    // No submit flow — this is the "navigated away and came back" mount.
    render(<CardView card={decidedClarify} />)

    const box = screen.getByLabelText(/claims this automatically/)
    expect((box as HTMLTextAreaElement).value).toContain('Detail A')
    expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeTruthy()
  })

  it('keeps the box as a fallback even after the agent has claimed it (delivered)', () => {
    render(<CardView card={{ ...decidedClarify, deliveredAt: '2026-06-16T12:06:00.000Z' }} />)

    const box = screen.getByLabelText(/kept here as a fallback/i)
    expect((box as HTMLTextAreaElement).value).toContain('Detail A')
    expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeTruthy()
  })
})

// GOLDEN: these snapshots are recorded against the pre-sections renderer and MUST stay
// green through the sections rewrite — the byte-identical guarantee for every legacy
// (no card.sections) card. If the cardWorkspace/CardView change alters the DOM of a
// flat card, these fail. Icon geometry belongs to lucide-react, not CardView, so each
// <svg> is collapsed to its class list — a routine icon-lib bump must not force a
// baseline rewrite (which would invite a blanket `vitest -u` past a real regression).
function goldenHtml(container: HTMLElement): string {
  return container.innerHTML.replace(
    /<svg\b([^>]*)>[\s\S]*?<\/svg>/g,
    (_match, attrs: string) => `<svg class="${/class="([^"]*)"/.exec(attrs)?.[1] ?? ''}"></svg>`,
  )
}

describe('CardView legacy render stays byte-identical (golden)', () => {
  it('flat clarify card', () => {
    const { container } = render(<CardView card={pendingClarify} />)
    expect(goldenHtml(container)).toMatchSnapshot()
  })

  it('flat plan card', () => {
    const { container } = render(<CardView card={pendingPlan} />)
    expect(goldenHtml(container)).toMatchSnapshot()
  })

  it('flat results card', () => {
    const { container } = render(<CardView card={pendingResults} />)
    expect(goldenHtml(container)).toMatchSnapshot()
  })

  it('plan card with only the verdict decision (zero visible decisions)', () => {
    const planOnlyVerdict: Card = {
      ...pendingPlan,
      id: 'plan-only-verdict',
      blocks: [{ id: 'ph', type: 'phases', phases: [{ title: 'Phase 1' }] }],
      decisions: [pendingPlan.decisions[1]],
    }
    const { container } = render(<CardView card={planOnlyVerdict} />)
    expect(goldenHtml(container)).toMatchSnapshot()
  })
})

describe('CardView sectioned render', () => {
  const sectioned: Card = {
    id: 'sec-1',
    stage: 'clarify',
    session: { agent: 'cc', project: 'boardroom' },
    headline: 'A mixed card',
    blocks: [
      { id: 'ctx', type: 'markdown', text: 'why this matters' },
      { id: 'q', type: 'markdown', text: 'question context' },
    ],
    decisions: [
      { id: 'd1', prompt: 'Pick?', blockRefs: ['q'], options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    ],
    sections: [
      { id: 'why', kind: 'explain', title: 'Why this matters', blockRefs: ['ctx'] },
      { id: 'decide', kind: 'decide', decisionRefs: ['d1'] },
    ],
    status: 'pending',
    createdAt: '2026-06-27T12:00:00.000Z',
  }

  it('renders a titled explain section, the decide row with its scoped anchor, and the explain block unscoped', () => {
    const { container } = render(<CardView card={sectioned} />)
    expect(screen.getByText('Why this matters')).toBeTruthy()
    // the linked block renders scoped under its decision row
    expect(container.querySelector('#block-d1-q')).toBeTruthy()
    // the explain section block renders unscoped (and is NOT also scoped under a decision)
    expect(container.querySelector('#block-ctx')).toBeTruthy()
    expect(container.querySelector('#block-d1-ctx')).toBeNull()
  })
})

describe('CardView dismiss — retiring a stranded orphaned card', () => {
  const orphaned: Card = {
    ...pendingClarify,
    id: 'orphan-1',
    status: 'orphaned',
    orphanedReason: 'boot',
    orphanedAt: new Date().toISOString(),
  }

  it('offers no dismiss control on a live pending card', () => {
    render(<CardView card={pendingClarify} />)
    expect(screen.queryByRole('button', { name: 'Dismiss card…' })).toBeNull()
  })

  it('dismisses an orphaned card only after the inline confirm', async () => {
    vi.mocked(dismissCard).mockResolvedValue({ ...orphaned, status: 'dismissed' })
    render(<CardView card={orphaned} />)

    // First click reveals the confirm — it does NOT call the API yet.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss card…' }))
    expect(dismissCard).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(dismissCard).toHaveBeenCalledWith('orphan-1'))
  })

  it('applies the dismissed card locally (onDismissed) so the board drops it before the SSE frame', async () => {
    const dismissed = { ...orphaned, status: 'dismissed' as const }
    vi.mocked(dismissCard).mockResolvedValue(dismissed)
    const onDismissed = vi.fn()
    render(<CardView card={orphaned} onDismissed={onDismissed} />)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss card…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    // Optimistic local apply happens with the returned dismissed card, not the SSE echo.
    await waitFor(() => expect(onDismissed).toHaveBeenCalledWith(dismissed))
  })

  it('cancel backs out of the confirm without calling the API', () => {
    render(<CardView card={orphaned} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss card…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Dismiss card…' })).toBeTruthy()   // back to the resting state
    expect(dismissCard).not.toHaveBeenCalled()
  })
})
