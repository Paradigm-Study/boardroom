import { ArrowRight, BookOpen, Bot, ClipboardCopy, FileText, FolderGit2, Unplug } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Card } from '../../src/shared/card.js'
import { decideCard, offlineAnswerCard } from './api.js'
import { BlockView } from './blocks/BlockView.js'
import { DecisionSection } from './Decision.js'
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
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [offlineSummary, setOfflineSummary] = useState<string | null>(null)

  const meta = STAGE[card.stage]
  const readonly = card.status === 'decided' || (card.status === 'orphaned' && !!card.answers)

  const { background, blockById } = useMemo(() => {
    const linked = new Set(card.decisions.flatMap(d => d.blockRefs ?? []))
    return {
      background: card.blocks.filter(b => !linked.has(b.id)),
      blockById: new Map(card.blocks.map(b => [b.id, b])),
    }
  }, [card])

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
  const answeredCount = card.decisions.filter(d => (answers[d.id]?.chosen.length ?? 0) > 0).length

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
        {card.status === 'orphaned' && !card.answers && !offlineSummary && (
          <div className="banner">
            <Unplug size={16} aria-hidden />
            <span>The agent that asked this is gone. You can still answer — you'll get a summary to paste into the session yourself.</span>
          </div>
        )}
      </div>

      {background.length > 0 && (
        <details className="bg-fold" open>
          <summary><BookOpen size={13} aria-hidden />Background · {background.length} block{background.length === 1 ? '' : 's'}</summary>
          <div className="bg-body">
            {background.map(b => <BlockView key={b.id} block={b} />)}
          </div>
        </details>
      )}

      {card.decisions.map((d, i) => (
        <DecisionSection
          key={d.id}
          card={card}
          decision={d}
          index={i}
          total={card.decisions.length}
          blocks={(d.blockRefs ?? []).map(id => blockById.get(id)).filter(b => b !== undefined)}
          answer={answers[d.id] ?? { chosen: [], note: '', custom: '' }}
          readonly={readonly || busy}
          onChange={a => setAnswers(prev => ({ ...prev, [d.id]: a }))}
        />
      ))}

      {!readonly && !offlineSummary && (
        <div className="submit-bar">
          <span className="submit-state">{answeredCount}/{card.decisions.length} answered</span>
          <button className="submit" disabled={!ready || busy} onClick={() => void submit()}>
            {card.status === 'pending' ? 'Submit decisions' : 'Record offline answer'}
            <ArrowRight size={16} aria-hidden />
          </button>
        </div>
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
  )
}
