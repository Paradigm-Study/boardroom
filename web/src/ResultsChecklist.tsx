import { Check, ChevronDown, ChevronRight, Circle, CircleCheck, CircleX, ListChecks, X } from 'lucide-react'
import { useState } from 'react'
import type { Block } from '../../src/shared/blocks.js'
import type { Card, Decision } from '../../src/shared/card.js'
import { BlockView } from './blocks/BlockView.js'
import { evidenceChip } from './evidenceChip.js'
import { customMissing, noteMissing, type DraftAnswer } from './helpers.js'

function complete(d: Decision, a: DraftAnswer): boolean {
  return a.chosen.length > 0 && !noteMissing(d, a) && !customMissing(a)
}

function ClaimRow({ decision, blocks, answer, readonly, onChange }: {
  decision: Decision
  blocks: Block[]
  answer: DraftAnswer
  readonly: boolean
  onChange(a: DraftAnswer): void
}) {
  const [open, setOpen] = useState(false)
  const verdict = answer.chosen[0]
  const denied = verdict === 'deny'
  const chip = evidenceChip(blocks)
  const Icon = verdict === 'approve' ? CircleCheck : denied ? CircleX : Circle
  const iconClass = verdict === 'approve' ? 'ok' : denied ? 'bad' : 'idle'

  return (
    <div className={`claim${verdict ? ' decided' : ''}`}>
      <div className="claim-row">
        <Icon size={18} className={`claim-icon ${iconClass}`} aria-hidden />
        <span className="claim-text">{decision.prompt}</span>
        {chip && <span className="claim-chip">{chip}</span>}
        {blocks.length > 0 && (
          <button className="claim-expand" onClick={() => setOpen(o => !o)} aria-label={open ? 'Hide evidence' : 'Show evidence'}>
            {open ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
          </button>
        )}
        <span className="verdicts">
          <button
            className={`vbtn approve${verdict === 'approve' ? ' on' : ''}`}
            disabled={readonly}
            onClick={() => onChange({ ...answer, chosen: ['approve'] })}
            aria-label="Approve"
          ><Check size={15} strokeWidth={2.4} aria-hidden /></button>
          <button
            className={`vbtn deny${denied ? ' on' : ''}`}
            disabled={readonly}
            onClick={() => onChange({ ...answer, chosen: ['deny'] })}
            aria-label="Deny"
          ><X size={15} strokeWidth={2.4} aria-hidden /></button>
        </span>
      </div>

      {open && blocks.length > 0 && (
        <div className="claim-evidence">
          {blocks.map(b => <BlockView key={b.id} block={b} forceOpen />)}
        </div>
      )}

      {denied && (
        <textarea
          className={`note${noteMissing(decision, answer) ? ' needs' : ''}`}
          placeholder="Why deny? — this note becomes the agent's next instruction"
          value={answer.note}
          disabled={readonly}
          autoFocus={!readonly}
          onChange={e => onChange({ ...answer, note: e.target.value })}
        />
      )}
    </div>
  )
}

export function ResultsChecklist({ card, blockById, answers, readonly, onChange }: {
  card: Card
  blockById: Map<string, Block>
  answers: Record<string, DraftAnswer>
  readonly: boolean
  onChange(id: string, a: DraftAnswer): void
}) {
  const reviewed = card.decisions.filter(d => {
    const a = answers[d.id]
    return a && complete(d, a)
  }).length

  function approveAll(): void {
    for (const d of card.decisions) {
      onChange(d.id, { ...(answers[d.id] ?? { chosen: [], note: '', custom: '' }), chosen: ['approve'] })
    }
  }

  return (
    <div className="results">
      <div className="results-head">
        <ListChecks size={15} aria-hidden />
        <span className="results-title">Agent claims {card.decisions.length} thing{card.decisions.length === 1 ? '' : 's'} done</span>
        <span className="results-progress">{reviewed} of {card.decisions.length} reviewed</span>
        <span style={{ flex: 1 }} />
        {!readonly && reviewed < card.decisions.length && (
          <button className="approve-all" onClick={approveAll}>Approve all</button>
        )}
      </div>

      {card.decisions.map(d => (
        <ClaimRow
          key={d.id}
          decision={d}
          blocks={(d.blockRefs ?? []).map(id => blockById.get(id)).filter(b => b !== undefined)}
          answer={answers[d.id] ?? { chosen: [], note: '', custom: '' }}
          readonly={readonly}
          onChange={a => onChange(d.id, a)}
        />
      ))}
    </div>
  )
}
