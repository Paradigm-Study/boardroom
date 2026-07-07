import { ArrowRight, Check, ClipboardCopy } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Block } from '../../src/shared/blocks.js'
import { PLAN_VERDICT_ID, RESULTS_VERDICT_ID, SPEC_VERDICT_ID, type AttachmentRef, type Card, type ResultsVerdict } from '../../src/shared/card.js'
import { decideCard, uploadAttachment } from './api.js'
import { AttachmentInput } from './AttachmentInput.js'
import { BlockView } from './blocks/BlockView.js'
import { CardHeader } from './CardHeader.js'
import { prepareCardWorkspace } from './cardWorkspace.js'
import { DecisionSection } from './Decision.js'
import { clearDrafts } from './drafts.js'
import { answersComplete, attachmentsForField, claimNotesValid, decisionAnswered, deriveResultsVerdict, emptyDraft, toApiAnswers, withAttachment, withoutAttachment, type DraftAnswer } from './helpers.js'
import { ResultsChecklist } from './ResultsChecklist.js'
import { SendBackForm } from './SendBackForm.js'
import { SpecAffordance } from './SpecAffordance.js'
import { STAGE } from './stage.js'
import { useCardAnswers } from './useCardAnswers.js'

const CLIPBOARD_WRITE_TIMEOUT_MS = 750

async function writeClipboardText(text: string): Promise<boolean> {
  const clipboard = navigator.clipboard
  if (clipboard?.writeText) {
    let timeout: number | undefined
    try {
      await Promise.race([
        clipboard.writeText(text),
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(() => reject(new Error('clipboard write timed out')), CLIPBOARD_WRITE_TIMEOUT_MS)
        }),
      ])
      return true
    } catch {
      // Fall through to the selected-text copy path below.
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout)
    }
  }

  if (typeof document.execCommand !== 'function') return false

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.append(textarea)
  textarea.focus()
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
  }
}

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

// A non-decision context region — the blocks of an explain/report section, or a decide
// section's extra (non-linked) blocks. Reuses the global-context chrome so a legacy
// card's single global section (title "Global context") renders byte-identically.
function ContextSection({ title, blocks }: { title: string; blocks: Block[] }) {
  return (
    <section className="global-context" aria-label="Global card context">
      <div className="global-context-head">
        <span className="canvas-label">{title}</span>
        <span className="canvas-count">{blocks.length} block{blocks.length === 1 ? '' : 's'}</span>
      </div>
      {blocks.map(b => <BlockView key={b.id} block={b} />)}
    </section>
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
// always gets a free-text add-on (rides on the verdict's own note/attachments),
// and ONE submit button whose verdict the per-claim states DERIVE — the human
// never picks complete vs continue. It reads "Mark complete" only when every
// claim is approved with no add-on; any reject/revise, unreviewed claim, or
// add-on flips it to "Keep going" (the send-back analog — the agent acts and
// re-submits). Either way the per-claim votes and the add-on are sent.
function ResultsFinish({ note, attachments, reviewed, total, orphaned, busy, verdict, ready, onNoteChange, onUpload, onRemoveAttachment, onSubmit }: {
  note: string
  attachments: AttachmentRef[]
  reviewed: number
  total: number
  orphaned: boolean
  busy: boolean
  verdict: ResultsVerdict
  ready: boolean
  onNoteChange(note: string): void
  onUpload(file: File): Promise<AttachmentRef>
  onRemoveAttachment(id: string): void
  onSubmit(): void
}) {
  const label = verdict === 'complete' ? 'Mark complete' : 'Keep going'
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
        <button className="submit" disabled={!ready || busy} onClick={onSubmit}>
          {orphaned ? `${label} (agent offline)` : label}
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
    if (await writeClipboardText(summary)) {
      setCopied(true)
      if (resetCopiedTimer.current !== null) window.clearTimeout(resetCopiedTimer.current)
      resetCopiedTimer.current = window.setTimeout(() => {
        setCopied(false)
        resetCopiedTimer.current = null
      }, 2000)
    } else {
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

// `cards` is the app shell's full card store, threaded down for read-models that
// span the whole session (the spec-recall drawer) — optional so an isolated mount
// (tests, storybook-style use) renders the card alone.
export function CardView({ card, cards = [] }: { card: Card; cards?: Card[] }) {
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
            // Like the note, attachments belong to the send-back only: an abandoned
            // revise draft must not ride along on an approve/lock verdict.
            ...(verb === 'revise' && sendBackAttachments.length ? { attachments: sendBackAttachments } : {}),
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

  // ONE finish button: the per-claim states + add-on DERIVE the verdict, so the
  // human never picks complete vs continue. Readiness follows the derived verdict —
  // complete needs every claim reviewed; continue only needs voted claims noted.
  const resultsVerdict = deriveResultsVerdict(choiceDecisions, answers, verdictDraft)
  const resultsReady = resultsVerdict === 'complete'
    ? answersComplete(choiceDecisions, answers)
    : claimNotesValid(choiceDecisions, answers)

  return (
    <div className="card-col" style={meta.vars}>
      <CardHeader card={card} workspace={workspace} readonly={readonly} pickupSummary={pickupSummary} />

      {/* Recall the session's locked acceptance contract and cross-compare it
          against results, any time — renders nothing until a spec is locked. */}
      <SpecAffordance project={card.session.project} cards={cards} />

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
                verdict={resultsVerdict}
                ready={resultsReady}
                onNoteChange={note => patchVerdict(d => ({ ...d, note }))}
                onUpload={async file => {
                  const attachment = await uploadFor(RESULTS_VERDICT_ID, 'note', file)
                  patchVerdict(d => withAttachment(d, attachment))
                  return attachment
                }}
                onRemoveAttachment={id => patchVerdict(d => withoutAttachment(d, id))}
                onSubmit={() => void submitResults(resultsVerdict)}
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
                <p className="sheet-source">
                  {card.claudeSessionId
                    ? <a href={`#/session/${encodeURIComponent(card.claudeSessionId)}`}>{card.session.title?.trim() || 'Untitled session'}</a>
                    : (card.session.title?.trim() || 'Untitled session')}
                </p>
              </div>
              <span className="dock-status">{card.status}</span>
            </div>

            {workspace.sections.map(section =>
              section.kind === 'decide'
                ? (
                  <Fragment key={section.id}>
                    {section.title && (
                      <div className="section-head"><span className="canvas-label">{section.title}</span></div>
                    )}
                    {section.rows.map(({ decision: d, index: i, blocks: questionBlocks }) => (
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
                    ))}
                    {section.blocks.length > 0 && (
                      <ContextSection title={section.title ?? 'Global context'} blocks={section.blocks} />
                    )}
                  </Fragment>
                )
                : (
                  <Fragment key={section.id}>
                    {section.blocks.length > 0 && (
                      <ContextSection title={section.title ?? 'Global context'} blocks={section.blocks} />
                    )}
                  </Fragment>
                ),
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
