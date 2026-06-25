import { ArrowRight, Check, ClipboardCopy } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Block } from '../../src/shared/blocks.js'
import { PLAN_VERDICT_ID, RESULTS_VERDICT_ID, SPEC_VERDICT_ID, type AttachmentRef, type Card, type ResultsVerdict } from '../../src/shared/card.js'
import { decideCard, uploadAttachment } from './api.js'
import { AttachmentInput } from './AttachmentInput.js'
import { BlockView } from './blocks/BlockView.js'
import { CardHeader } from './CardHeader.js'
import { prepareCardWorkspace } from './cardWorkspace.js'
import { DecisionSection } from './Decision.js'
import { clearDrafts } from './drafts.js'
import { answersComplete, attachmentsForField, claimNotesValid, decisionAnswered, emptyDraft, toApiAnswers, withAttachment, withoutAttachment, type DraftAnswer } from './helpers.js'
import { ResultsChecklist } from './ResultsChecklist.js'
import { SendBackForm } from './SendBackForm.js'
import { STAGE } from './stage.js'
import { useCardAnswers } from './useCardAnswers.js'

function QuestionContext({ index, decisionId, blocks }: {
  index: number
  decisionId: string
  blocks: Block[]
}) {
  return (
    <aside className="question-context" aria-label={`Decision ${index + 1} context`}>
      <div className="question-context-head">
        <div>
          <span className="canvas-label">Question context</span>
          <h3>Decision {index + 1}</h3>
        </div>
        <span className="canvas-count">{blocks.length} block{blocks.length === 1 ? '' : 's'}</span>
      </div>

      {blocks.length > 0
        ? blocks.map(b => <BlockView key={b.id} block={b} anchorScope={decisionId} highlighted />)
        : <p className="context-empty">No question-local context.</p>}
    </aside>
  )
}

// The one submit bar behind all three flows (clarify / plan / results): a progress
// label and the primary action, with an optional leading slot (the plan's "Send
// back…" button) and a variant class.
function SubmitBar({ state, label, ready, busy, onSubmit, className, leading }: {
  state: string
  label: string
  ready: boolean
  busy: boolean
  onSubmit(): void
  className?: string
  leading?: ReactNode
}) {
  return (
    <div className={className ? `submit-bar ${className}` : 'submit-bar'}>
      {leading}
      <span className="submit-state">{state}</span>
      <button className="submit" disabled={!ready || busy} onClick={onSubmit}>
        {label}
        <ArrowRight size={16} aria-hidden />
      </button>
    </div>
  )
}

// The results gate's footer. Unlike the binary clarify/plan submit, the human
// always gets a free-text add-on (rides on the verdict's own note/attachments)
// and an EXPLICIT completion choice: "Mark complete" (gated on every claim being
// reviewed) or "Keep going" (the send-back analog — the agent acts on the notes
// and re-submits). Either way the per-claim votes and the add-on are sent.
function ResultsFinish({ note, attachments, reviewed, total, orphaned, busy, completeReady, continueReady, onNoteChange, onUpload, onRemoveAttachment, onComplete, onContinue }: {
  note: string
  attachments: AttachmentRef[]
  reviewed: number
  total: number
  orphaned: boolean
  busy: boolean
  completeReady: boolean
  continueReady: boolean
  onNoteChange(note: string): void
  onUpload(file: File): Promise<AttachmentRef>
  onRemoveAttachment(id: string): void
  onComplete(): void
  onContinue(): void
}) {
  return (
    <div className="results-finish">
      <textarea
        className="note addon"
        aria-label="Add instructions for the agent"
        placeholder="Add anything for the agent (optional) — sent whether or not you mark complete"
        value={note}
        disabled={busy}
        onChange={e => onNoteChange(e.target.value)}
      />
      <AttachmentInput
        label="Attach file to your add-on"
        attachments={attachments}
        readonly={busy}
        onUpload={onUpload}
        onRemove={onRemoveAttachment}
      />
      <div className="submit-bar results-submit">
        <span className="submit-state">{reviewed}/{total} reviewed</span>
        <button className="submit ghost" disabled={!continueReady || busy} onClick={onContinue}>Keep going</button>
        <button className="submit" disabled={!completeReady || busy} onClick={onComplete}>
          {orphaned ? 'Mark complete (agent offline)' : 'Mark complete'}
          <ArrowRight size={16} aria-hidden />
        </button>
      </div>
    </div>
  )
}

// Shown when a decision was recorded while the agent was offline: the summary is
// claimed automatically on reconnect, or the human can copy it to paste by hand.
function OfflinePickup({ summary }: { summary: string }) {
  const [copied, setCopied] = useState(false)
  const resetCopiedTimer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (resetCopiedTimer.current !== null) window.clearTimeout(resetCopiedTimer.current)
    }
  }, [])

  async function copySummary(): Promise<void> {
    try {
      await navigator.clipboard.writeText(summary)
      setCopied(true)
      if (resetCopiedTimer.current !== null) window.clearTimeout(resetCopiedTimer.current)
      resetCopiedTimer.current = window.setTimeout(() => {
        setCopied(false)
        resetCopiedTimer.current = null
      }, 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="offline-out">
      <p id="offline-pickup-label" style={{ fontSize: 13, fontWeight: 600, margin: '0 0 7px' }}>Recorded. The agent claims this automatically when it reconnects — or paste it in by hand:</p>
      <textarea readOnly aria-labelledby="offline-pickup-label" value={summary} />
      <button className="copy-btn" aria-live="polite" onClick={() => void copySummary()}>
        {copied ? <Check size={14} aria-hidden /> : <ClipboardCopy size={14} aria-hidden />}
        {copied ? 'Copied' : 'Copy to clipboard'}
      </button>
    </div>
  )
}

export function CardView({ card }: { card: Card }) {
  const meta = STAGE[card.stage]
  const orphaned = card.status === 'orphaned'
  const readonly = card.status === 'decided'

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pickupSummary, setPickupSummary] = useState<string | null>(null)
  const [sendingBack, setSendingBack] = useState(false)
  const [sendBackNote, setSendBackNote] = useState('')
  const [sendBackAttachments, setSendBackAttachments] = useState<AttachmentRef[]>([])

  const [answers, setAnswers] = useCardAnswers(card, readonly, pickupSummary)

  // Plan approval and spec lock are NOT separate gates — each is the act of
  // submitting your agreement (the auto-appended verdict is driven by the submit
  // bar, never shown as a row to answer). Both share one "verdict gate" shape:
  // an approve-style primary action plus a "send back" (revise) path. Clarify has
  // no verdict gate; results has its own finish bar.
  const verdictGate =
    card.stage === 'plan'
      ? { id: PLAN_VERDICT_ID, approve: 'approve', approveLabel: orphaned ? 'Approve (agent offline)' : 'Approve plan & proceed', readyState: 'agreed on all', progressWord: 'agreed' }
      : card.stage === 'spec'
        ? { id: SPEC_VERDICT_ID, approve: 'lock', approveLabel: orphaned ? 'Lock spec (agent offline)' : 'Lock spec', readyState: 'all criteria set', progressWord: 'set' }
        : null
  const resultsMode = card.stage === 'results'
  const workspace = useMemo(() => prepareCardWorkspace(card), [card])
  const choiceDecisions = workspace.choiceDecisions
  const blockById = workspace.blockById
  const globalBlocks = workspace.globalBlocks

  async function uploadFor(answerId: string, field: string, file: File): Promise<AttachmentRef> {
    return uploadAttachment(card.id, answerId, field, file)
  }

  async function commit(payload: Record<string, DraftAnswer>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const { delivered, summary } = await decideCard(card.id, toApiAnswers(payload))
      clearDrafts(card.id)
      if (!delivered) setPickupSummary(summary)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // Stamp the verdict gate's chosen verb (approve/lock, or revise on send-back) and
  // submit. No verb / no gate → a plain clarify submit of just the answers.
  async function submitVerdict(verb?: string): Promise<void> {
    await commit(verdictGate && verb
      ? {
          ...answers,
          [verdictGate.id]: {
            chosen: [verb],
            note: verb === 'revise' ? sendBackNote : '',
            custom: '',
            ...(sendBackAttachments.length ? { attachments: sendBackAttachments } : {}),
          },
        }
      : answers)
  }

  // Results gate: the verdict's note/attachments are the card-level add-on, kept
  // in the answers map like any other draft; we only stamp the chosen verdict here.
  async function submitResults(verdict: ResultsVerdict): Promise<void> {
    await commit({ ...answers, [RESULTS_VERDICT_ID]: { ...verdictDraft, chosen: [verdict] } })
  }

  const ready = answersComplete(choiceDecisions, answers)
  const answeredCount = choiceDecisions.filter(d => decisionAnswered(d, answers[d.id])).length

  // The results verdict's own draft carries the card-level add-on note/attachments;
  // read it once and route every edit through patchVerdict instead of re-deriving
  // `answers[RESULTS_VERDICT_ID] ?? emptyDraft()` at each call site.
  const verdictDraft = answers[RESULTS_VERDICT_ID] ?? emptyDraft()
  const patchVerdict = (fn: (d: DraftAnswer) => DraftAnswer): void =>
    setAnswers(prev => ({ ...prev, [RESULTS_VERDICT_ID]: fn(prev[RESULTS_VERDICT_ID] ?? emptyDraft()) }))

  return (
    <div className="card-col" style={meta.vars}>
      <CardHeader card={card} workspace={workspace} readonly={readonly} pickupSummary={pickupSummary} />

      {resultsMode
        ? (
          <>
            <ResultsChecklist
              card={card}
              blockById={blockById}
              answers={answers}
              readonly={readonly || busy}
              onChange={(id, a) => setAnswers(prev => ({ ...prev, [id]: a }))}
              onUploadAttachment={uploadFor}
            />
            {!readonly && !pickupSummary && (
              <ResultsFinish
                note={verdictDraft.note}
                attachments={attachmentsForField(verdictDraft, 'note')}
                reviewed={answeredCount}
                total={choiceDecisions.length}
                orphaned={orphaned}
                busy={busy}
                completeReady={answersComplete(choiceDecisions, answers)}
                continueReady={claimNotesValid(choiceDecisions, answers)}
                onNoteChange={note => patchVerdict(d => ({ ...d, note }))}
                onUpload={async file => {
                  const attachment = await uploadFor(RESULTS_VERDICT_ID, 'note', file)
                  patchVerdict(d => withAttachment(d, attachment))
                  return attachment
                }}
                onRemoveAttachment={id => patchVerdict(d => withoutAttachment(d, id))}
                onComplete={() => void submitResults('complete')}
                onContinue={() => void submitResults('continue')}
              />
            )}
          </>
        )
        : (
          <section className="decision-sheet" aria-label="Decision sheet">
            <div className="sheet-head">
              <div>
                <span className="canvas-label">Decision sheet</span>
                <h2>{ready ? 'Ready to submit' : `${answeredCount}/${choiceDecisions.length} done`}</h2>
                <p className="sheet-source">{card.session.title?.trim() || 'Untitled session'}</p>
              </div>
              <span className="dock-status">{card.status}</span>
            </div>

            {choiceDecisions.map((d, i) => {
              const questionBlocks = workspace.linkedBlocksFor(d.id)
              return (
                <div className="decision-row" key={d.id}>
                  <DecisionSection
                    card={card}
                    decision={d}
                    index={i}
                    total={choiceDecisions.length}
                    blocks={questionBlocks}
                    answer={answers[d.id] ?? emptyDraft()}
                    readonly={readonly || busy}
                    onChange={a => setAnswers(prev => ({ ...prev, [d.id]: a }))}
                    onUploadAttachment={uploadFor}
                  />
                  <QuestionContext index={i} decisionId={d.id} blocks={questionBlocks} />
                </div>
              )
            })}

            {globalBlocks.length > 0 && (
              <section className="global-context" aria-label="Global card context">
                <div className="global-context-head">
                  <span className="canvas-label">Global context</span>
                  <span className="canvas-count">{globalBlocks.length} block{globalBlocks.length === 1 ? '' : 's'}</span>
                </div>
                {globalBlocks.map(b => <BlockView key={b.id} block={b} />)}
              </section>
            )}

            {!readonly && !pickupSummary && verdictGate && (
              sendingBack
                ? (
                  <div className="submit-bar">
                    <SendBackForm
                      note={sendBackNote}
                      attachments={sendBackAttachments}
                      busy={busy}
                      onNoteChange={setSendBackNote}
                      onUpload={async file => {
                        const attachment = await uploadFor(verdictGate.id, 'note', file)
                        setSendBackAttachments(prev => [...prev, attachment])
                        return attachment
                      }}
                      onRemoveAttachment={id => setSendBackAttachments(prev => prev.filter(a => a.id !== id))}
                      onCancel={() => setSendingBack(false)}
                      onSend={() => void submitVerdict('revise')}
                    />
                  </div>
                )
                : (
                  <SubmitBar
                    leading={<button className="submit ghost" onClick={() => setSendingBack(true)}>Send back…</button>}
                    state={ready ? verdictGate.readyState : `${answeredCount}/${choiceDecisions.length} ${verdictGate.progressWord}`}
                    label={verdictGate.approveLabel}
                    ready={ready}
                    busy={busy}
                    onSubmit={() => void submitVerdict(verdictGate.approve)}
                  />
                )
            )}

            {!readonly && !pickupSummary && !verdictGate && (
              <SubmitBar
                state={`${answeredCount}/${choiceDecisions.length} answered`}
                label={orphaned ? 'Submit (agent offline)' : 'Submit decisions'}
                ready={ready}
                busy={busy}
                onSubmit={() => void submitVerdict()}
              />
            )}
          </section>
        )}

      {error && <p className="error-text">{error}</p>}

      {pickupSummary && <OfflinePickup summary={pickupSummary} />}
    </div>
  )
}
