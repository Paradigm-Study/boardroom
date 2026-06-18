import { Check, ChevronDown, ChevronRight, Circle, CircleCheck, CircleX, ListChecks, X } from 'lucide-react'
import { useState } from 'react'
import type { Block } from '../../src/shared/blocks.js'
import type { AttachmentRef, Card, Decision } from '../../src/shared/card.js'
import { AttachmentInput } from './AttachmentInput.js'
import { BlockView } from './blocks/BlockView.js'
import { evidenceChip } from './evidenceChip.js'
import { customMissing, noteMissing, type DraftAnswer } from './helpers.js'

function complete(d: Decision, a: DraftAnswer): boolean {
  return a.chosen.length > 0 && !noteMissing(d, a) && !customMissing(a)
}

function ClaimRow({ decision, index, blocks, answer, readonly, onChange, onUploadAttachment }: {
  decision: Decision
  index: number
  blocks: Block[]
  answer: DraftAnswer
  readonly: boolean
  onChange(a: DraftAnswer): void
  onUploadAttachment?(decisionId: string, field: string, file: File): Promise<AttachmentRef>
}) {
  const [open, setOpen] = useState(false)
  const verdict = answer.chosen[0]
  const denied = verdict === 'deny'
  // Proof first (tests/diff/graph), the agent's prose explanation last — so the
  // chip and the expanded view lead with what verifies the claim, not an essay.
  const ordered = [...blocks].sort((a, b) => (a.type === 'markdown' ? 1 : 0) - (b.type === 'markdown' ? 1 : 0))
  const chip = evidenceChip(ordered)
  const Icon = verdict === 'approve' ? CircleCheck : denied ? CircleX : Circle
  const iconClass = verdict === 'approve' ? 'ok' : denied ? 'bad' : 'idle'
  const noteAttachments = answer.attachments?.filter(a => a.field === 'note') ?? []

  async function upload(file: File): Promise<AttachmentRef> {
    if (!onUploadAttachment) throw new Error('Upload is not available')
    const attachment = await onUploadAttachment(decision.id, 'note', file)
    onChange({ ...answer, attachments: [...(answer.attachments ?? []), attachment] })
    return attachment
  }

  function removeAttachment(id: string): void {
    onChange({ ...answer, attachments: (answer.attachments ?? []).filter(a => a.id !== id) })
  }

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
          >
            <Check size={15} strokeWidth={2.4} aria-hidden />
            <span>Approve</span>
          </button>
          <button
            className={`vbtn deny${denied ? ' on' : ''}`}
            disabled={readonly}
            onClick={() => onChange({ ...answer, chosen: ['deny'] })}
            aria-label="Deny"
          >
            <X size={15} strokeWidth={2.4} aria-hidden />
            <span>Deny</span>
          </button>
        </span>
      </div>

      {open && ordered.length > 0 && (
        <div className="claim-evidence">
          {ordered.map(b => <BlockView key={b.id} block={b} forceOpen />)}
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
      {(!readonly || noteAttachments.length > 0) && (
        <AttachmentInput
          label={denied ? 'Attach file to denial note' : `Attach file to claim ${index + 1}`}
          attachments={noteAttachments}
          readonly={readonly}
          onUpload={upload}
          onRemove={removeAttachment}
        />
      )}
    </div>
  )
}

export function ResultsChecklist({ card, blockById, answers, readonly, onChange, onUploadAttachment }: {
  card: Card
  blockById: Map<string, Block>
  answers: Record<string, DraftAnswer>
  readonly: boolean
  onChange(id: string, a: DraftAnswer): void
  onUploadAttachment?(decisionId: string, field: string, file: File): Promise<AttachmentRef>
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

      {card.decisions.map((d, index) => (
        <ClaimRow
          key={d.id}
          decision={d}
          index={index}
          blocks={(d.blockRefs ?? []).map(id => blockById.get(id)).filter(b => b !== undefined)}
          answer={answers[d.id] ?? { chosen: [], note: '', custom: '' }}
          readonly={readonly}
          onChange={a => onChange(d.id, a)}
          onUploadAttachment={onUploadAttachment}
        />
      ))}
    </div>
  )
}
