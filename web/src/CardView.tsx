import { ArrowRight, Bot, ClipboardCopy, FileText, FolderGit2, Layers3, Moon, PanelRight, Workflow } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Block } from '../../src/shared/blocks.js'
import type { AttachmentRef, Card } from '../../src/shared/card.js'
import { decideCard, uploadAttachment } from './api.js'
import { AttachmentInput } from './AttachmentInput.js'
import { BlockView } from './blocks/BlockView.js'
import { prepareCardWorkspace } from './cardWorkspace.js'
import { DecisionSection } from './Decision.js'
import { clearDrafts, loadDrafts, saveDrafts } from './drafts.js'
import { answersComplete, customMissing, noteMissing, toApiAnswers, type DraftAnswer } from './helpers.js'
import { ResultsChecklist } from './ResultsChecklist.js'
import { STAGE } from './stage.js'

function QuestionContext({ index, blocks }: {
  index: number
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
        ? blocks.map(b => <BlockView key={b.id} block={b} highlighted />)
        : <p className="context-empty">No question-local context.</p>}
    </aside>
  )
}

export function CardView({ card }: { card: Card }) {
  const meta = STAGE[card.stage]
  const orphaned = card.status === 'orphaned'
  const readonly = card.status === 'decided'
  const sessionTitle = card.session.title?.trim() || 'Untitled session'

  const [answers, setAnswers] = useState<Record<string, DraftAnswer>>(() => {
    const saved = !readonly ? loadDrafts(card.id) : null
    return Object.fromEntries(
      card.decisions.map(d => {
        const draft = saved?.[d.id]
        const final = card.answers?.[d.id]
        return [d.id, {
          chosen: draft?.chosen ?? final?.chosen ?? [],
          note: draft?.note ?? final?.note ?? '',
          custom: draft?.custom ?? final?.custom ?? '',
          attachments: draft?.attachments ?? final?.attachments ?? [],
        }]
      }),
    )
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pickupSummary, setPickupSummary] = useState<string | null>(null)
  const [sendingBack, setSendingBack] = useState(false)
  const [sendBackNote, setSendBackNote] = useState('')
  const [sendBackAttachments, setSendBackAttachments] = useState<AttachmentRef[]>([])

  // Plan approval is NOT a separate gate — it's the act of submitting your
  // agreement to the plan's decisions. The auto-appended verdict is driven by
  // the submit bar, never shown as a row to answer.
  const planMode = card.stage === 'plan'
  const resultsMode = card.stage === 'results'
  const workspace = useMemo(() => prepareCardWorkspace(card), [card])
  const choiceDecisions = workspace.choiceDecisions

  // Persist every keystroke/click so an arriving card, a status change, or a
  // page reload never loses in-progress work. Skip once the card is settled.
  useEffect(() => {
    if (!readonly && !pickupSummary) saveDrafts(card.id, answers)
  }, [card.id, answers, readonly, pickupSummary])

  const blockById = workspace.blockById

  async function uploadFor(answerId: string, field: string, file: File): Promise<AttachmentRef> {
    return uploadAttachment(card.id, answerId, field, file)
  }

  async function submit(planVerdict?: 'approve' | 'revise'): Promise<void> {
    setBusy(true)
    setError(null)
    const payload = planVerdict
      ? {
          ...answers,
          plan_verdict: {
            chosen: [planVerdict],
            note: planVerdict === 'revise' ? sendBackNote : '',
            custom: '',
            ...(sendBackAttachments.length ? { attachments: sendBackAttachments } : {}),
          },
        }
      : answers
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

  const ready = answersComplete(choiceDecisions, answers)
  const answeredCount = choiceDecisions.filter(d => {
    const a = answers[d.id]
    return a && a.chosen.length > 0 && !noteMissing(d, a) && !customMissing(a)
  }).length
  const globalBlocks = workspace.globalBlocks

  return (
    <div className="card-col" style={meta.vars}>
      <div className="card-head">
        <div className="head-kicker">
          <span className="stage-tag">{meta.label}</span>
          {card.status !== 'pending' && <span className={`status-chip ${card.status}`}>{card.status}</span>}
        </div>
        <h1 className="card-headline">{card.headline}</h1>
        <div className="source-strip" aria-label="Decision source">
          <span>
            <span className="source-label">Session</span>
            <strong>{sessionTitle}</strong>
          </span>
          <span>
            <FolderGit2 size={14} aria-hidden />
            <span className="source-label">Project</span>
            <strong>{card.session.project}</strong>
          </span>
          <span>
            <Bot size={14} aria-hidden />
            <span className="source-label">Agent</span>
            <strong>{card.session.agent}</strong>
          </span>
          {card.planRef && (
            <span>
              <FileText size={14} aria-hidden />
              <span className="source-label">Plan</span>
              <code>{card.planRef}</code>
            </span>
          )}
        </div>
        {orphaned && !pickupSummary && (
          <div className="banner">
            <Moon size={16} aria-hidden />
            <span>The agent's connection dropped (often the Mac sleeping). Decide anyway — it's delivered automatically when the agent reconnects, or copy the summary to paste in by hand.</span>
          </div>
        )}
        {!readonly && (
          <>
            <div className="cockpit-stats">
              <span><PanelRight size={13} aria-hidden />{choiceDecisions.length} decision{choiceDecisions.length === 1 ? '' : 's'}</span>
              <span><Workflow size={13} aria-hidden />{workspace.visualSummary.linkedBlocks} linked visual{workspace.visualSummary.linkedBlocks === 1 ? '' : 's'}</span>
              <span><Layers3 size={13} aria-hidden />{workspace.visualSummary.totalBlocks} block{workspace.visualSummary.totalBlocks === 1 ? '' : 's'}</span>
            </div>
            <p className="stage-role">{meta.role}</p>
            <details className="stage-guide">
              <summary>How to decide here</summary>
              <ul>{meta.guide.map((g, i) => <li key={i}>{g}</li>)}</ul>
            </details>
          </>
        )}
      </div>

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
              <div className="submit-bar results-submit">
                <span className="submit-state">{answeredCount}/{choiceDecisions.length} reviewed</span>
                <button className="submit" disabled={!ready || busy} onClick={() => void submit()}>
                  {orphaned ? 'Submit review (agent offline)' : 'Submit review'}
                  <ArrowRight size={16} aria-hidden />
                </button>
              </div>
            )}
          </>
        )
        : (
          <section className="decision-sheet" aria-label="Decision sheet">
            <div className="sheet-head">
              <div>
                <span className="canvas-label">Decision sheet</span>
                <h2>{ready ? 'Ready to submit' : `${answeredCount}/${choiceDecisions.length} done`}</h2>
                <p className="sheet-source">{sessionTitle}</p>
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
                    answer={answers[d.id] ?? { chosen: [], note: '', custom: '' }}
                    readonly={readonly || busy}
                    onChange={a => setAnswers(prev => ({ ...prev, [d.id]: a }))}
                    onUploadAttachment={uploadFor}
                  />
                  <QuestionContext index={i} blocks={questionBlocks} />
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

            {!readonly && !pickupSummary && planMode && (
              <div className="submit-bar">
                {sendingBack ? (
                  <div className="sendback">
                    <textarea
                      className="note needs"
                      placeholder="What should change before you'd approve? (sent back to the agent)"
                      value={sendBackNote}
                      autoFocus
                      onChange={e => setSendBackNote(e.target.value)}
                    />
                    <AttachmentInput
                      label="Attach file to send-back note"
                      attachments={sendBackAttachments}
                      readonly={busy}
                      onUpload={async file => {
                        const attachment = await uploadFor('plan_verdict', 'note', file)
                        setSendBackAttachments(prev => [...prev, attachment])
                        return attachment
                      }}
                      onRemove={id => setSendBackAttachments(prev => prev.filter(a => a.id !== id))}
                    />
                    <div className="sendback-actions">
                      <button className="submit ghost" onClick={() => setSendingBack(false)}>Cancel</button>
                      <button className="submit bad" disabled={!sendBackNote.trim() || busy} onClick={() => void submit('revise')}>
                        Send back
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button className="submit ghost" onClick={() => setSendingBack(true)}>Send back…</button>
                    <span className="submit-state">{ready ? 'agreed on all' : `${answeredCount}/${choiceDecisions.length} agreed`}</span>
                    <button className="submit" disabled={!ready || busy} onClick={() => void submit('approve')}>
                      {orphaned ? 'Approve (agent offline)' : 'Approve plan & proceed'}
                      <ArrowRight size={16} aria-hidden />
                    </button>
                  </>
                )}
              </div>
            )}

            {!readonly && !pickupSummary && !planMode && (
              <div className="submit-bar">
                <span className="submit-state">{answeredCount}/{choiceDecisions.length} answered</span>
                <button className="submit" disabled={!ready || busy} onClick={() => void submit()}>
                  {orphaned ? 'Submit (agent offline)' : 'Submit decisions'}
                  <ArrowRight size={16} aria-hidden />
                </button>
              </div>
            )}
          </section>
        )}

      {error && <p className="error-text">{error}</p>}

      {pickupSummary && (
        <div className="offline-out">
          <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 7px' }}>Recorded. The agent claims this automatically when it reconnects — or paste it in by hand:</p>
          <textarea readOnly value={pickupSummary} />
          <button className="copy-btn" onClick={() => void navigator.clipboard.writeText(pickupSummary)}>
            <ClipboardCopy size={14} aria-hidden />
            Copy to clipboard
          </button>
        </div>
      )}
    </div>
  )
}
