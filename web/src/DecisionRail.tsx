import { AlertCircle, Check, PenLine, Star } from 'lucide-react'
import type { Card, Decision } from '../../src/shared/card.js'
import { customMissing, noteMissing, OTHER_OPTION_ID, toggleChoice, type DraftAnswer } from './helpers.js'

function offersOther(card: Card, decision: Decision): boolean {
  return card.stage !== 'results' && decision.id !== 'plan_verdict'
}

function DecisionBox({ card, decision, index, answer, readonly, focused, onFocus, onChange }: {
  card: Card
  decision: Decision
  index: number
  answer: DraftAnswer
  readonly: boolean
  focused: boolean
  onFocus(): void
  onChange(a: DraftAnswer): void
}) {
  const needsNote = noteMissing(decision, answer)
  const otherOn = answer.chosen.includes(OTHER_OPTION_ID)
  return (
    <div className={`decision${focused ? ' focused' : ''}`} onClick={onFocus}>
      <span className="decision-num">{String(index + 1).padStart(2, '0')}</span>
      <p className="decision-prompt">{decision.prompt}</p>
      <div className="opts">
        {decision.options.map(o => {
          const on = answer.chosen.includes(o.id)
          return (
            <button
              key={o.id}
              className={`opt${on ? ' on' : ''}`}
              disabled={readonly}
              title={o.detail}
              onClick={e => {
                e.stopPropagation()
                onFocus()
                onChange({ ...answer, chosen: toggleChoice(decision, answer.chosen, o.id) })
              }}
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
            onClick={e => {
              e.stopPropagation()
              onFocus()
              onChange({ ...answer, chosen: toggleChoice(decision, answer.chosen, OTHER_OPTION_ID) })
            }}
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
          onClick={e => e.stopPropagation()}
          onChange={e => onChange({ ...answer, custom: e.target.value })}
        />
      )}
      {(answer.chosen.length > 0 || !readonly) && (
        <textarea
          className={`note${needsNote ? ' needs' : ''}`}
          placeholder={needsNote ? 'A note is required for this choice…' : 'Optional note for the agent'}
          value={answer.note}
          disabled={readonly}
          onClick={e => e.stopPropagation()}
          onChange={e => onChange({ ...answer, note: e.target.value })}
        />
      )}
      {needsNote && !readonly && (
        <p className="note-hint"><AlertCircle size={12} aria-hidden />This choice goes back to the agent as an instruction — say why.</p>
      )}
      {otherOn && customMissing(answer) && !readonly && (
        <p className="note-hint"><AlertCircle size={12} aria-hidden />Type your answer above.</p>
      )}
    </div>
  )
}

export function DecisionRail({ card, answers, readonly, focusedDecision, onFocusDecision, onChange }: {
  card: Card
  answers: Record<string, DraftAnswer>
  readonly: boolean
  focusedDecision: string | null
  onFocusDecision(id: string): void
  onChange(id: string, a: DraftAnswer): void
}) {
  return (
    <div>
      {card.decisions.map((d, i) => (
        <DecisionBox
          key={d.id}
          card={card}
          decision={d}
          index={i}
          answer={answers[d.id] ?? { chosen: [], note: '', custom: '' }}
          readonly={readonly}
          focused={focusedDecision === d.id}
          onFocus={() => onFocusDecision(d.id)}
          onChange={a => onChange(d.id, a)}
        />
      ))}
    </div>
  )
}
