import { File, Image, Paperclip, X } from 'lucide-react'
import { useRef, useState } from 'react'
import type { AttachmentRef } from '../../src/shared/card.js'
import { fileHash } from './fileView.js'

export function AttachmentInput({
  label,
  attachments,
  readonly,
  onUpload,
  onRemove,
}: {
  label: string
  attachments: AttachmentRef[]
  readonly: boolean
  onUpload(file: globalThis.File): Promise<AttachmentRef>
  onRemove(id: string): void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function upload(files: FileList | null): Promise<void> {
    if (!files?.length) return
    setBusy(true)
    setError(null)
    try {
      for (const file of Array.from(files)) await onUpload(file)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="attach-field">
      {!readonly && (
        <>
          <input
            ref={inputRef}
            className="attach-input"
            type="file"
            multiple
            onChange={e => void upload(e.target.files)}
          />
          <button
            type="button"
            className="attach-btn"
            aria-label={label}
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            <Paperclip size={13} aria-hidden />
            {busy ? 'Uploading' : 'Attach'}
          </button>
        </>
      )}
      {attachments.length > 0 && (
        <div className="attach-list">
          {attachments.map(a => {
            const url = a.url
            const image = a.mime?.startsWith('image/') && url
            const preview = image
              ? <img src={url} alt="" />
              : a.mime?.startsWith('image/')
                ? <Image size={13} aria-hidden />
                : <File size={13} aria-hidden />
            return (
              <span key={a.id} className={`attach-chip${image ? ' image' : ''}`}>
                {/* Once it has a url the chip is a link into the in-app viewer —
                    open it without ever navigating the window off the dashboard. */}
                {url ? (
                  <button
                    type="button"
                    className="attach-open"
                    aria-label={`View ${a.name}`}
                    onClick={() => { window.location.hash = fileHash({ url, name: a.name, mime: a.mime }) }}
                  >
                    {preview}
                    <span className="attach-name">{a.name}</span>
                  </button>
                ) : (
                  <>
                    {preview}
                    <span className="attach-name">{a.name}</span>
                  </>
                )}
                {!readonly && (
                  <button type="button" aria-label={`Remove ${a.name}`} onClick={() => onRemove(a.id)}>
                    <X size={12} aria-hidden />
                  </button>
                )}
              </span>
            )
          })}
        </div>
      )}
      {error && <p className="attach-error">{error}</p>}
    </div>
  )
}
