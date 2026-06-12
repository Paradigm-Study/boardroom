import { useMemo, useState } from 'react'
import type { Card } from '../../src/shared/card.js'
import { decideCard, offlineAnswerCard } from './api.js'
import { BlockView } from './blocks/BlockView.js'
import { DecisionRail } from './DecisionRail.js'
import { answersComplete, toApiAnswers, type DraftAnswer } from './helpers.js'

export function CardView({ card }: { card: Card }) {
  const [answers, setAnswers] = useState<Record<string, DraftAnswer>>(() =>
    Object.fromEntries(
      card.decisions.map(d => {
        const saved = card.answers?.[d.id]
        return [d.id, { chosen: saved?.chosen ?? [], note: saved?.note ?? '' }]
      }),
    ),
  )
  const [focusedDecision, setFocusedDecision] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [offlineSummary, setOfflineSummary] = useState<string | null>(null)

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
    <div>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 19, margin: '0 0 4px' }}>{card.headline}</h1>
        <div style={{ fontSize: 12, opacity: 0.6 }}>
          {card.stage} · {card.session.agent} · {card.session.project}
          {card.planRef && <> · <code>{card.planRef}</code></>}
          {card.status !== 'pending' && <strong> · {card.status}</strong>}
        </div>
        {card.status === 'orphaned' && !card.answers && !offlineSummary && (
          <p style={{ fontSize: 13, background: 'light-dark(#FAEEDA, #4a3a14)', padding: '8px 12px', borderRadius: 8 }}>
            The agent that asked this is gone. You can still answer — you'll get a summary to copy into the session yourself.
          </p>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 20, alignItems: 'start' }}>
        <div>
          {card.blocks.length === 0 && <p style={{ opacity: 0.5, fontSize: 13 }}>No visuals attached.</p>}
          {card.blocks.map(b => (
            <BlockView
              key={b.id}
              block={b}
              highlighted={highlightedBlocks.has(b.id)}
              onClick={() => focusBlock(b.id)}
            />
          ))}
        </div>

        <div style={{ position: 'sticky', top: 20 }}>
          <DecisionRail
            card={card}
            answers={answers}
            readonly={readonly || busy}
            focusedDecision={focusedDecision}
            onFocusDecision={setFocusedDecision}
            onChange={(id, a) => setAnswers(prev => ({ ...prev, [id]: a }))}
          />

          {!readonly && !offlineSummary && (
            <button
              disabled={!ready || busy}
              onClick={() => void submit()}
              style={{
                width: '100%', padding: '10px 0', fontSize: 14, fontWeight: 600,
                borderRadius: 10, border: 'none', color: '#fff',
                background: ready ? '#1D9E75' : 'light-dark(#c9c8c2, #4a4a45)',
              }}
            >
              {card.status === 'pending' ? 'Submit decisions' : 'Record offline answer'}
            </button>
          )}

          {error && <p style={{ color: '#D85A30', fontSize: 13 }}>{error}</p>}

          {offlineSummary && (
            <div>
              <p style={{ fontSize: 13, fontWeight: 600 }}>Copy this into the agent session:</p>
              <textarea readOnly value={offlineSummary} style={{ width: '100%', minHeight: 120, fontSize: 12, fontFamily: 'ui-monospace, monospace', borderRadius: 8, padding: 8 }} />
              <button onClick={() => void navigator.clipboard.writeText(offlineSummary)} style={{ marginTop: 6, padding: '6px 12px', borderRadius: 8 }}>
                Copy to clipboard
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
