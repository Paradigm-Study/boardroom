import { ArrowRight, BookOpen, Bot, ClipboardCopy, FileText, FolderGit2, Moon } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Card } from '../../src/shared/card.js'
import { decideCard } from './api.js'
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
  const [pickupSummary, setPickupSummary] = useState<string | null>(null)

  const meta = STAGE[card.stage]
  const orphaned = card.status === 'orphaned'
  const readonly = card.status === 'decided'

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
      const { delivered, summary } = await decideCard(card.id, toApiAnswers(answers))
      if (!delivered) setPickupSummary(summary)
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
        {orphaned && !pickupSummary && (
          <div className="banner">
            <Moon size={16} aria-hidden />
            <span>The agent's connection dropped (often the Mac sleeping). Decide anyway — it's delivered automatically when the agent reconnects, or copy the summary to paste in by hand.</span>
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

      {!readonly && !pickupSummary && (
        <div className="submit-bar">
          <span className="submit-state">{answeredCount}/{card.decisions.length} answered</span>
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
