import { AlertCircle, Check, PenLine, Star } from 'lucide-react'
import type { Block } from '../../src/shared/blocks.js'
import type { Card, Decision } from '../../src/shared/card.js'
import { BlockView } from './blocks/BlockView.js'
import { customMissing, noteMissing, OTHER_OPTION_ID, toggleChoice, type DraftAnswer } from './helpers.js'

function offersOther(card: Card, decision: Decision): boolean {
  return card.stage !== 'results' && decision.id !== 'plan_verdict'
}

export function DecisionSection({ card, decision, index, total, blocks, answer, readonly, onChange }: {
  card: Card
  decision: Decision
  index: number
  total: number
  blocks: Block[]
  answer: DraftAnswer
  readonly: boolean
  onChange(a: DraftAnswer): void
}) {
  const needsNote = noteMissing(decision, answer)
  const otherOn = answer.chosen.includes(OTHER_OPTION_ID)
  const answered = answer.chosen.length > 0 && !needsNote && !customMissing(answer)
  return (
    <section className={`dsec${answered ? ' answered' : ''}`}>
      <div className="dsec-label">
        Decision {index + 1} of {total}
        {answered && <Check size={13} strokeWidth={2.5} className="dsec-check" aria-hidden />}
      </div>
      <h2 className="dsec-prompt">{decision.prompt}</h2>

      {blocks.map(b => <BlockView key={b.id} block={b} />)}

      <div className="opts">
        {decision.options.map(o => {
          const on = answer.chosen.includes(o.id)
          return (
            <button
              key={o.id}
              className={`opt${on ? ' on' : ''}`}
              disabled={readonly}
              title={o.detail}
              onClick={() => onChange({ ...answer, chosen: toggleChoice(decision, answer.chosen, o.id) })}
            >
              {on && <Check size={13} strokeWidth={2.5} aria-hidden />}
              {o.label}
              {o.recommended && <Star size={12} className="star" fill="currentColor" aria-hidden />}
            </button>
          )
        })}
        {offersOther(card, decision) && (
          <button
            className={`opt${otherOn ? ' on' : ''}`}
            disabled={readonly}
            title="Answer in your own words"
            onClick={() => onChange({ ...answer, chosen: toggleChoice(decision, answer.chosen, OTHER_OPTION_ID) })}
          >
            <PenLine size={13} aria-hidden />
            Other…
          </button>
        )}
      </div>

      {otherOn && (
        <input
          className="other-input"
          placeholder="Type your own answer…"
          value={answer.custom}
          disabled={readonly}
          autoFocus={!readonly}
          onChange={e => onChange({ ...answer, custom: e.target.value })}
        />
      )}
      {(answer.chosen.length > 0 || !readonly) && (
        <textarea
          className={`note${needsNote ? ' needs' : ''}`}
          placeholder={needsNote ? 'A note is required for this choice…' : 'Optional note for the agent'}
          value={answer.note}
          disabled={readonly}
          onChange={e => onChange({ ...answer, note: e.target.value })}
        />
      )}
      {needsNote && !readonly && (
        <p className="note-hint"><AlertCircle size={12} aria-hidden />This choice goes back to the agent as an instruction — say why.</p>
      )}
      {otherOn && customMissing(answer) && !readonly && (
        <p className="note-hint"><AlertCircle size={12} aria-hidden />Type your answer above.</p>
      )}
    </section>
  )
}
