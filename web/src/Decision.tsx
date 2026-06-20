import { AlertCircle, Check, CheckSquare, CopyCheck, PenLine, Square, Star } from 'lucide-react'
import type { Block } from '../../src/shared/blocks.js'
import { PLAN_VERDICT_ID, type AttachmentRef, type Card, type Decision } from '../../src/shared/card.js'
import { AttachmentInput } from './AttachmentInput.js'
import { blockAnchorId } from './blocks/BlockView.js'
import { attachmentsForField, customMissing, decisionAnswered, noteMissing, OTHER_OPTION_ID, toggleChoice, withAttachment, withoutAttachment, type DraftAnswer } from './helpers.js'

function offersOther(card: Card, decision: Decision): boolean {
  return card.stage !== 'results' && decision.id !== PLAN_VERDICT_ID
}

export function DecisionSection({ card, decision, index, total, blocks, answer, readonly, onChange, onUploadAttachment }: {
  card: Card
  decision: Decision
  index: number
  total: number
  blocks: Block[]
  answer: DraftAnswer
  readonly: boolean
  onChange(a: DraftAnswer): void
  onUploadAttachment?(decisionId: string, field: string, file: File): Promise<AttachmentRef>
}) {
  const needsNote = noteMissing(decision, answer)
  const otherOn = answer.chosen.includes(OTHER_OPTION_ID)
  const answered = decisionAnswered(decision, answer)
  const recommended = decision.options.find(o => o.recommended)
  const recommendedOn = recommended ? answer.chosen.includes(recommended.id) : false

  function chooseRecommended(): void {
    if (!recommended) return
    const chosen = decision.multi
      ? Array.from(new Set([...answer.chosen.filter(id => id !== OTHER_OPTION_ID), recommended.id]))
      : [recommended.id]
    onChange({ ...answer, chosen, custom: decision.multi ? answer.custom : '' })
  }

  async function upload(field: string, file: File): Promise<AttachmentRef> {
    if (!onUploadAttachment) throw new Error('Upload is not available')
    const attachment = await onUploadAttachment(decision.id, field, file)
    onChange(withAttachment(answer, attachment))
    return attachment
  }

  function removeAttachment(id: string): void {
    onChange(withoutAttachment(answer, id))
  }

  return (
    <section className={`dsec${answered ? ' answered' : ''}`}>
      <div className="dsec-label">
        Decision {index + 1} of {total}
        {answered && <Check size={13} strokeWidth={2.5} className="dsec-check" aria-hidden />}
      </div>
      <div className="dsec-topline">
        <h2 className="dsec-prompt">{decision.prompt}</h2>
        {recommended && !recommendedOn && !readonly && (
          <button
            className="rec-quick"
            onClick={chooseRecommended}
            aria-label={`Use recommended: ${recommended.label}`}
          >
            <Star size={12} fill="currentColor" aria-hidden />
            Use rec
          </button>
        )}
      </div>
      {decision.multi && <p className="multi-hint"><CopyCheck size={12} aria-hidden />Select all that apply</p>}

      {blocks.length > 0 && (
        <div className="linked-evidence">
          <span>Evidence</span>
          {blocks.map(b => (
            <a key={b.id} href={`#${blockAnchorId(b.id, decision.id)}`}>
              {b.title ?? b.type.replace('_', ' ')}
            </a>
          ))}
        </div>
      )}

      <div className="opts">
        {decision.options.map(o => {
          const on = answer.chosen.includes(o.id)
          const Box = decision.multi ? (on ? CheckSquare : Square) : undefined
          return (
            <button
              key={o.id}
              className={`opt${on ? ' on' : ''}`}
              disabled={readonly}
              title={o.detail}
              onClick={() => onChange({ ...answer, chosen: toggleChoice(decision, answer.chosen, o.id) })}
            >
              {Box ? <Box size={14} strokeWidth={2.2} aria-hidden /> : on && <Check size={13} strokeWidth={2.5} aria-hidden />}
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
        <>
          <input
            className="other-input"
            aria-label="Your own answer"
            placeholder="Type your own answer…"
            value={answer.custom}
            disabled={readonly}
            autoFocus={!readonly}
            onChange={e => onChange({ ...answer, custom: e.target.value })}
          />
          <AttachmentInput
            label="Attach file to custom answer"
            attachments={attachmentsForField(answer, 'custom')}
            readonly={readonly}
            onUpload={file => upload('custom', file)}
            onRemove={removeAttachment}
          />
        </>
      )}
      {(answer.chosen.length > 0 || !readonly) && (
        <>
          <textarea
            className={`note${needsNote ? ' needs' : ''}`}
            aria-label="Note for the agent"
            placeholder={needsNote ? 'A note is required for this choice…' : 'Optional note for the agent'}
            value={answer.note}
            disabled={readonly}
            onChange={e => onChange({ ...answer, note: e.target.value })}
          />
          <AttachmentInput
            label="Attach file to note"
            attachments={attachmentsForField(answer, 'note')}
            readonly={readonly}
            onUpload={file => upload('note', file)}
            onRemove={removeAttachment}
          />
        </>
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
