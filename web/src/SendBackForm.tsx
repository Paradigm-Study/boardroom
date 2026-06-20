import type { AttachmentRef } from '../../src/shared/card.js'
import { AttachmentInput } from './AttachmentInput.js'

// The plan "send back" composer: a required note that becomes the agent's next
// instruction, plus optional attachments. Controlled by the parent so the note
// and attachments survive toggling the form open/closed.
export function SendBackForm({ note, attachments, busy, onNoteChange, onUpload, onRemoveAttachment, onCancel, onSend }: {
  note: string
  attachments: AttachmentRef[]
  busy: boolean
  onNoteChange(note: string): void
  onUpload(file: File): Promise<AttachmentRef>
  onRemoveAttachment(id: string): void
  onCancel(): void
  onSend(): void
}) {
  return (
    <div className="sendback">
      <textarea
        className="note needs"
        aria-label="Send-back note"
        placeholder="What should change before you'd approve? (sent back to the agent)"
        value={note}
        autoFocus
        onChange={e => onNoteChange(e.target.value)}
      />
      <AttachmentInput
        label="Attach file to send-back note"
        attachments={attachments}
        readonly={busy}
        onUpload={onUpload}
        onRemove={onRemoveAttachment}
      />
      <div className="sendback-actions">
        <button className="submit ghost" onClick={onCancel}>Cancel</button>
        <button className="submit bad" disabled={!note.trim() || busy} onClick={onSend}>
          Send back
        </button>
      </div>
    </div>
  )
}
