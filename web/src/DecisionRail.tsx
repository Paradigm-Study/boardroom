import type { Card, Decision } from '../../src/shared/card.js'
import { noteMissing, toggleChoice, type DraftAnswer } from './helpers.js'

function DecisionBox({ decision, answer, readonly, focused, onFocus, onChange }: {
  decision: Decision
  answer: DraftAnswer
  readonly: boolean
  focused: boolean
  onFocus(): void
  onChange(a: DraftAnswer): void
}) {
  const needsNote = noteMissing(decision, answer)
  return (
    <div
      onClick={onFocus}
      style={{
        border: focused ? '2px solid #7C5CBF' : '1px solid light-dark(#e3e2dd, #3a3a36)',
        borderRadius: 10, padding: 12, marginBottom: 10,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{decision.prompt}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {decision.options.map(o => {
          const chosen = answer.chosen.includes(o.id)
          return (
            <button
              key={o.id}
              disabled={readonly}
              title={o.detail}
              onClick={e => {
                e.stopPropagation()
                onFocus()
                onChange({ ...answer, chosen: toggleChoice(decision, answer.chosen, o.id) })
              }}
              style={{
                border: chosen ? '2px solid #1D9E75' : '1px solid light-dark(#c9c8c2, #4a4a45)',
                background: chosen ? 'light-dark(#E1F5EE, #0F4437)' : 'transparent',
                color: 'inherit', borderRadius: 8, padding: '6px 10px', fontSize: 13,
              }}
            >
              {o.label}{o.recommended ? ' ✓rec' : ''}
            </button>
          )
        })}
      </div>
      {(answer.chosen.length > 0 || !readonly) && (
        <textarea
          placeholder={needsNote ? 'Note required for this choice…' : 'Optional note'}
          value={answer.note}
          disabled={readonly}
          onChange={e => onChange({ ...answer, note: e.target.value })}
          style={{
            width: '100%', marginTop: 8, fontSize: 13, fontFamily: 'inherit',
            borderRadius: 8, padding: 8, minHeight: 36, resize: 'vertical',
            border: needsNote ? '2px solid #D85A30' : '1px solid light-dark(#c9c8c2, #4a4a45)',
            background: 'transparent', color: 'inherit',
          }}
        />
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
      {card.decisions.map(d => (
        <DecisionBox
          key={d.id}
          decision={d}
          answer={answers[d.id] ?? { chosen: [], note: '' }}
          readonly={readonly}
          focused={focusedDecision === d.id}
          onFocus={() => onFocusDecision(d.id)}
          onChange={a => onChange(d.id, a)}
        />
      ))}
    </div>
  )
}
