import { ArrowRight, Bot, ClipboardCopy, FileText, FolderGit2, ListChecks, Unplug } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Card } from '../../src/shared/card.js'
import { decideCard, offlineAnswerCard } from './api.js'
import { BlockView } from './blocks/BlockView.js'
import { DecisionRail } from './DecisionRail.js'
import { answersComplete, toApiAnswers, type DraftAnswer } from './helpers.js'
import { STAGE } from './stage.js'

export function CardView({ card }: { card: Card }) {
  const [answers, setAnswers] = useState<Record<string, DraftAnswer>>(() =>
    Object.fromEntries(
      card.decisions.map(d => {
        const saved = card.answers?.[d.id]
        return [d.id, { chosen: saved?.chosen ?? [], note: saved?.note ?? '', custom: saved?.custom ?? '' }]
      }),
    ),
  )
  const [focusedDecision, setFocusedDecision] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [offlineSummary, setOfflineSummary] = useState<string | null>(null)

  const meta = STAGE[card.stage]
  const readonly = card.status === 'decided' || (card.status === 'orphaned' && !!card.answers)
  const highlightedBlocks = useMemo(() => {
    const d = card.decisions.find(d => d.id === focusedDecision)
    return new Set(d?.blockRefs ?? [])
  }, [card, focusedDecision])

  function focusBlock(blockId: string): void {
    const linked = card.decisions.find(d => (d.blockRefs ?? []).includes(blockId))
    if (linked) setFocusedDecision(linked.id)
  }

  async function submit(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      if (card.status === 'pending') {
        await decideCard(card.id, toApiAnswers(answers))
      } else {
        const { summary } = await offlineAnswerCard(card.id, toApiAnswers(answers))
        setOfflineSummary(summary)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const ready = answersComplete(card.decisions, answers)

  return (
    <div className="fade-in" style={meta.vars}>
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
        {card.status === 'orphaned' && !card.answers && !offlineSummary && (
          <div className="banner">
            <Unplug size={16} aria-hidden />
            <span>The agent that asked this is gone. You can still answer — you'll get a summary to paste into the session yourself.</span>
          </div>
        )}
      </div>

      <div className="card-grid">
        <div>
          {card.blocks.length === 0 && <p style={{ color: 'var(--ink-3)', fontSize: 13 }}>No visuals attached.</p>}
          {card.blocks.map(b => (
            <BlockView
              key={b.id}
              block={b}
              highlighted={highlightedBlocks.has(b.id)}
              onClick={() => focusBlock(b.id)}
            />
          ))}
        </div>

        <div className="rail">
          <div className="rail-head">
            <ListChecks size={14} aria-hidden />
            Decisions <span className="count">({card.decisions.length})</span>
          </div>
          <DecisionRail
            card={card}
            answers={answers}
            readonly={readonly || busy}
            focusedDecision={focusedDecision}
            onFocusDecision={setFocusedDecision}
            onChange={(id, a) => setAnswers(prev => ({ ...prev, [id]: a }))}
          />

          {!readonly && !offlineSummary && (
            <>
              <button className="submit" disabled={!ready || busy} onClick={() => void submit()}>
                {card.status === 'pending' ? 'Submit decisions' : 'Record offline answer'}
                <ArrowRight size={16} aria-hidden />
              </button>
              {!ready && <p className="submit-hint">Answer every decision to submit</p>}
              {ready && card.status === 'pending' && <p className="submit-hint">The agent resumes the moment you submit</p>}
            </>
          )}

          {error && <p className="error-text">{error}</p>}

          {offlineSummary && (
            <div className="offline-out">
              <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 7px' }}>Paste this into the agent session:</p>
              <textarea readOnly value={offlineSummary} />
              <button className="copy-btn" onClick={() => void navigator.clipboard.writeText(offlineSummary)}>
                <ClipboardCopy size={14} aria-hidden />
                Copy to clipboard
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
