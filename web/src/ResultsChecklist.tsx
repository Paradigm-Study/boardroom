import { Check, ChevronDown, ChevronRight, Circle, CircleCheck, CircleDot, CircleX, ListChecks, Pencil, X, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import type { Block } from '../../src/shared/blocks.js'
import { RESULTS_VERDICT_ID, type AttachmentRef, type Card, type Decision } from '../../src/shared/card.js'
import { AttachmentInput } from './AttachmentInput.js'
import { BlockView } from './blocks/BlockView.js'
import { evidenceChip } from './evidenceChip.js'
import { attachmentsForField, decisionAnswered, emptyDraft, noteMissing, withAttachment, withoutAttachment, type DraftAnswer } from './helpers.js'

// The visual "kind" of a verdict, decoupled from the raw option id. Buttons are
// rendered from the card's OWN decision.options (never hardcoded), so the UI can
// only ever offer options the card — hence the daemon — actually has. That closes
// the web/daemon version-skew gap: a stale daemon that only knows approve/deny can
// never have a Revise/Reject button shown for it (which it would reject on submit).
type VerdictKind = 'approve' | 'revise' | 'reject'

// Known + legacy option ids -> kind. Cards decided before the deny→reject /
// changes→revise rename stored the old ids; mapping them keeps a historical card
// rendering its verdict + note instead of falling through to the idle branch.
const VERDICT_KIND: Record<string, VerdictKind> = {
  approve: 'approve',
  revise: 'revise', changes: 'revise',
  reject: 'reject', deny: 'reject',
}

// Per-kind visuals + always-on note copy. Approve carries an optional add-on note;
// revise/reject carry the (required) instruction. Distinct aria labels keep each
// textarea announced correctly for assistive tech.
const KIND_UI: Record<VerdictKind, { BtnIcon: LucideIcon; RowIcon: LucideIcon; iconClass: string; aria: string; placeholder: string }> = {
  approve: { BtnIcon: Check, RowIcon: CircleCheck, iconClass: 'ok', aria: 'Note for this claim', placeholder: 'Add a note (optional) — sent to the agent' },
  revise: { BtnIcon: Pencil, RowIcon: CircleDot, iconClass: 'mid', aria: 'What to revise', placeholder: "What should change? — you're on the right track, the agent will apply this" },
  reject: { BtnIcon: X, RowIcon: CircleX, iconClass: 'bad', aria: 'Reason for rejection', placeholder: "Why drop this? — this becomes the agent's next instruction" },
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
  // The selected verdict's kind (legacy ids mapped; unknown -> undefined -> idle).
  const selected = answer.chosen[0]
  const kind = selected ? VERDICT_KIND[selected] : undefined
  const rejected = kind === 'reject'
  const revised = kind === 'revise'
  // Proof first (tests/diff/graph), the agent's prose explanation last — so the
  // chip and the expanded view lead with what verifies the claim, not an essay.
  const ordered = [...blocks].sort((a, b) => (a.type === 'markdown' ? 1 : 0) - (b.type === 'markdown' ? 1 : 0))
  const chip = evidenceChip(ordered)
  const RowIcon = kind ? KIND_UI[kind].RowIcon : Circle
  const iconClass = kind ? KIND_UI[kind].iconClass : 'idle'
  const noteAttachments = attachmentsForField(answer, 'note')
  const noteCopy = kind ? KIND_UI[kind] : undefined
  const attachLabel = rejected ? 'Attach file to rejection note' : revised ? 'Attach file to revision note' : `Attach file to claim ${index + 1}`

  async function upload(file: File): Promise<AttachmentRef> {
    if (!onUploadAttachment) throw new Error('Upload is not available')
    const attachment = await onUploadAttachment(decision.id, 'note', file)
    onChange(withAttachment(answer, attachment))
    return attachment
  }

  function removeAttachment(id: string): void {
    onChange(withoutAttachment(answer, id))
  }

  return (
    <div className={`claim${kind ? ' decided' : ''}`}>
      <div className="claim-row">
        <RowIcon size={18} className={`claim-icon ${iconClass}`} aria-hidden />
        <span className="claim-text">{decision.prompt}</span>
        {chip && <span className="claim-chip">{chip}</span>}
        {blocks.length > 0 && (
          <button className="claim-expand" onClick={() => setOpen(o => !o)} aria-label={open ? 'Hide evidence' : 'Show evidence'}>
            {open ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
          </button>
        )}
        <span className="verdicts">
          {decision.options.map(opt => {
            // Buttons come from the card's own options — the UI can never offer an
            // option the card/daemon lacks. Legacy/unknown ids get a sane fallback.
            const optKind = VERDICT_KIND[opt.id]
            const BtnIcon = optKind === 'approve' ? Check : optKind === 'revise' ? Pencil : optKind === 'reject' ? X : Circle
            return (
              <button
                key={opt.id}
                className={`vbtn ${optKind ?? 'other'}${answer.chosen.includes(opt.id) ? ' on' : ''}`}
                disabled={readonly}
                onClick={() => onChange({ ...answer, chosen: [opt.id] })}
                aria-label={opt.label}
              >
                <BtnIcon size={15} strokeWidth={2.4} aria-hidden />
                <span>{opt.label}</span>
              </button>
            )
          })}
        </span>
      </div>

      {open && ordered.length > 0 && (
        <div className="claim-evidence">
          {ordered.map(b => <BlockView key={b.id} block={b} forceOpen />)}
        </div>
      )}

      {noteCopy && (
        <textarea
          className={`note${noteMissing(decision, answer) ? ' needs' : ''}`}
          aria-label={noteCopy.aria}
          placeholder={noteCopy.placeholder}
          value={answer.note}
          disabled={readonly}
          autoFocus={!readonly && kind !== 'approve'}
          onChange={e => onChange({ ...answer, note: e.target.value })}
        />
      )}
      {(!readonly || noteAttachments.length > 0) && (
        <AttachmentInput
          label={attachLabel}
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
  // The synthetic session verdict lives on the submit bar, not as a claim row.
  const claims = card.decisions.filter(d => d.id !== RESULTS_VERDICT_ID)
  const reviewed = claims.filter(d => decisionAnswered(d, answers[d.id])).length

  function approveAll(): void {
    for (const d of claims) {
      onChange(d.id, { ...(answers[d.id] ?? emptyDraft()), chosen: ['approve'] })
    }
  }

  return (
    <div className="results">
      <div className="results-head">
        <ListChecks size={15} aria-hidden />
        <span className="results-title">Agent claims {claims.length} thing{claims.length === 1 ? '' : 's'} done</span>
        <span className="results-progress">{reviewed} of {claims.length} reviewed</span>
        <span style={{ flex: 1 }} />
        {!readonly && reviewed < claims.length && (
          <button className="approve-all" onClick={approveAll}>Approve all</button>
        )}
      </div>

      {claims.map((d, index) => (
        <ClaimRow
          key={d.id}
          decision={d}
          index={index}
          blocks={(d.blockRefs ?? []).map(id => blockById.get(id)).filter(b => b !== undefined)}
          answer={answers[d.id] ?? emptyDraft()}
          readonly={readonly}
          onChange={a => onChange(d.id, a)}
          onUploadAttachment={onUploadAttachment}
        />
      ))}
    </div>
  )
}
