import { ArrowLeft, ShieldAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { basename, fileKind } from './fileView.js'

// The in-app file viewer: opens over the dashboard so the menu-bar window is
// never stranded on a file. Renders by type; HTML is shown in a fully sandboxed
// (scripts-off) frame with an explicit "this is a static preview" notice.
export function FileViewer({ url, name, mime, onClose }: {
  url: string
  name?: string
  mime?: string
  onClose(): void
}) {
  const displayName = name ?? basename(url) ?? 'file'
  const kind = fileKind({ mime, name: name ?? url })

  // Esc is the universal "get me back" — same destination as the Back button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="viewer">
      <header className="viewer-bar">
        <button className="viewer-back" onClick={onClose}>
          <ArrowLeft size={15} aria-hidden /> Back
        </button>
        <span className="viewer-name" title={displayName}>{displayName}</span>
        <a className="viewer-open" href={url} target="_blank" rel="noreferrer">Open in new tab</a>
      </header>
      <div className="viewer-body">
        <ViewerBody kind={kind} url={url} name={displayName} />
      </div>
    </div>
  )
}

function ViewerBody({ kind, url, name }: { kind: ReturnType<typeof fileKind>; url: string; name: string }) {
  const [zoom, setZoom] = useState(false)
  switch (kind) {
    case 'image':
      return (
        <img
          className={`viewer-img${zoom ? ' zoom' : ''}`}
          src={url}
          alt={name}
          onClick={() => setZoom(z => !z)}
          title={zoom ? 'Click to fit' : 'Click for actual size'}
        />
      )
    case 'pdf':
      return <iframe className="viewer-pdf" src={url} title={name} />
    case 'html':
      return (
        <>
          <div className="viewer-note">
            <ShieldAlert size={13} aria-hidden />
            Static preview — interactive content is disabled.
          </div>
          {/* Empty sandbox = most restrictive: no scripts, no forms, no top-level
              navigation. These files come from agents/disk, so never run them. */}
          <iframe className="viewer-html" src={url} title={name} sandbox="" />
        </>
      )
    case 'markdown':
    case 'text':
      return <TextBody url={url} markdown={kind === 'markdown'} />
    default:
      return (
        <div className="viewer-other">
          <p>No inline preview for this file type.</p>
          <a className="viewer-download" href={url} download>Download {name}</a>
        </div>
      )
  }
}

function TextBody({ url, markdown }: { url: string; markdown: boolean }) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // Timeout so a slow/unresponsive (possibly agent-authored) URL surfaces an
        // error instead of an eternal "Loading…" spinner with no recovery.
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const text = await res.text()
        if (!cancelled) setContent(text)
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error && e.name === 'TimeoutError' ? 'Timed out loading the file.' : e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [url])

  if (error) return <p className="viewer-error">Couldn't load file: {error}</p>
  if (content === null) return <p className="viewer-loading">Loading…</p>
  if (markdown) {
    return <div className="viewer-md prose"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div>
  }
  return <pre className="viewer-text">{content}</pre>
}
