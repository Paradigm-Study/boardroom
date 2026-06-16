import { ArrowRight, BookOpen, Bot, ClipboardCopy, FileText, FolderGit2, Moon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Card } from '../../src/shared/card.js'
import { decideCard } from './api.js'
import { BlockView } from './blocks/BlockView.js'
import { DecisionSection } from './Decision.js'
import { clearDrafts, loadDrafts, saveDrafts } from './drafts.js'
import { answersComplete, customMissing, noteMissing, toApiAnswers, type DraftAnswer } from './helpers.js'
import { ResultsChecklist } from './ResultsChecklist.js'
import { STAGE } from './stage.js'

export function CardView({ card }: { card: Card }) {
  const meta = STAGE[card.stage]
  const orphaned = card.status === 'orphaned'
  const readonly = card.status === 'decided'

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
        }]
      }),
    )
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pickupSummary, setPickupSummary] = useState<string | null>(null)
  const [sendingBack, setSendingBack] = useState(false)
  const [sendBackNote, setSendBackNote] = useState('')

  // Plan approval is NOT a separate gate — it's the act of submitting your
  // agreement to the plan's decisions. The auto-appended verdict is driven by
  // the submit bar, never shown as a row to answer.
  const planMode = card.stage === 'plan'
  const choiceDecisions = card.decisions.filter(d => !(planMode && d.id === 'plan_verdict'))

  // Persist every keystroke/click so an arriving card, a status change, or a
  // page reload never loses in-progress work. Skip once the card is settled.
  useEffect(() => {
    if (!readonly && !pickupSummary) saveDrafts(card.id, answers)
  }, [card.id, answers, readonly, pickupSummary])

  const { background, blockById } = useMemo(() => {
    const linked = new Set(card.decisions.flatMap(d => d.blockRefs ?? []))
    return {
      background: card.blocks.filter(b => !linked.has(b.id)),
      blockById: new Map(card.blocks.map(b => [b.id, b])),
    }
  }, [card])

  async function submit(planVerdict?: 'approve' | 'revise'): Promise<void> {
    setBusy(true)
    setError(null)
    const payload = planVerdict
      ? { ...answers, plan_verdict: { chosen: [planVerdict], note: planVerdict === 'revise' ? sendBackNote : '', custom: '' } }
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

  return (
    <div className="card-col" style={meta.vars}>
      <div className="card-head">
        <span className="stage-tag">{meta.label}</span>
        <h1 className="card-headline">{card.headline}</h1>
        <div className="card-meta">
          <span><Bot size={14} aria-hidden />{card.session.agent}</span>
          <span><FolderGit2 size={14} aria-hidden />{card.session.project}</span>
          {card.session.title && <span>{card.session.title}</span>}
          {card.planRef && <span><FileText size={14} aria-hidden /><code>{card.planRef}</code></span>}
          {card.status !== 'pending' && <span className={`status-chip ${card.status}`}>{card.status}</span>}
        </div>
        {orphaned && !pickupSummary && (
          <div className="banner">
            <Moon size={16} aria-hidden />
            <span>The agent's connection dropped (often the Mac sleeping). Decide anyway — it's delivered automatically when the agent reconnects, or copy the summary to paste in by hand.</span>
          </div>
        )}
      </div>

      {background.length > 0 && card.stage !== 'results' && (
        <details className="bg-fold">
          <summary><BookOpen size={13} aria-hidden />Background · {background.length} block{background.length === 1 ? '' : 's'}</summary>
          <div className="bg-body">
            {background.map(b => <BlockView key={b.id} block={b} />)}
          </div>
        </details>
      )}

      {card.stage === 'results'
        ? (
          <ResultsChecklist
            card={card}
            blockById={blockById}
            answers={answers}
            readonly={readonly || busy}
            onChange={(id, a) => setAnswers(prev => ({ ...prev, [id]: a }))}
          />
        )
        : choiceDecisions.map((d, i) => (
          <DecisionSection
            key={d.id}
            card={card}
            decision={d}
            index={i}
            total={choiceDecisions.length}
            blocks={(d.blockRefs ?? []).map(id => blockById.get(id)).filter(b => b !== undefined)}
            answer={answers[d.id] ?? { chosen: [], note: '', custom: '' }}
            readonly={readonly || busy}
            onChange={a => setAnswers(prev => ({ ...prev, [d.id]: a }))}
          />
        ))}

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
