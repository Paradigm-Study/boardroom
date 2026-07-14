// Pure file-classification + viewer-route helpers, shared by FileViewer, the
// attachment chips, the markdown link interception, and App's router. Kept free
// of React/DOM so it is trivially unit-tested.

export type FileKind = 'image' | 'pdf' | 'html' | 'markdown' | 'text' | 'other'

// Extension → kind, the fallback when there is no (or only a generic) mime type.
const EXT_KIND: Record<string, FileKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  svg: 'image', bmp: 'image', avif: 'image', ico: 'image',
  pdf: 'pdf',
  html: 'html', htm: 'html', xhtml: 'html',
  md: 'markdown', markdown: 'markdown',
  txt: 'text', log: 'text', json: 'text', csv: 'text', tsv: 'text',
  yml: 'text', yaml: 'text', xml: 'text', toml: 'text', ini: 'text', env: 'text',
  js: 'text', jsx: 'text', ts: 'text', tsx: 'text', mjs: 'text', cjs: 'text',
  css: 'text', scss: 'text', sh: 'text', bash: 'text', zsh: 'text', sql: 'text',
  py: 'text', rb: 'text', go: 'text', rs: 'text', java: 'text', kt: 'text',
  c: 'text', h: 'text', cc: 'text', cpp: 'text', hpp: 'text', php: 'text',
}

// Strip any query/hash, then take the last path segment. The one home for this
// (FileViewer's title and the markdown-link label both reuse it) so they agree.
export function basename(urlOrName?: string): string | undefined {
  if (!urlOrName) return undefined
  return urlOrName.split(/[?#]/)[0].split('/').pop() || undefined
}

export function extensionOf(name?: string): string | undefined {
  const base = basename(name) ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return undefined // no extension, or a dotfile (".gitignore")
  return base.slice(dot + 1).toLowerCase() || undefined // "file." → no extension
}

export function fileKind({ mime, name }: { mime?: string; name?: string }): FileKind {
  const m = mime?.toLowerCase().split(';')[0].trim()
  // A specific mime wins; a generic octet-stream is treated as "unknown" so the
  // extension can speak instead.
  if (m && m !== 'application/octet-stream') {
    if (m.startsWith('image/')) return 'image'
    if (m === 'application/pdf') return 'pdf'
    if (m === 'text/html' || m === 'application/xhtml+xml') return 'html'
    if (m === 'text/markdown') return 'markdown'
    if (m.startsWith('text/') || m === 'application/json' || m === 'application/xml') return 'text'
    return 'other'
  }
  const ext = extensionOf(name)
  return (ext ? EXT_KIND[ext] : undefined) ?? 'other'
}

// Daemon-served attachment URLs (no extension, mime known only server-side) are
// always viewable; anything else is viewable when its extension maps to a kind.
// ANCHORED (^…$): an unanchored test would also match the substring inside an
// agent-authored external link like "https://evil.com/api/cards/x/attachments/y",
// classifying it as a trusted same-origin attachment and fetching it in-app.
const ATTACHMENT_URL = /^\/api\/cards\/[^/]+\/attachments\/[^/]+$/

// A relative href resolves against the dashboard's own origin; an absolute one
// (any scheme, or a protocol-relative //host) is cross-origin. Agent prose is
// untrusted, so only relative links may open in the in-app viewer (which fetches
// text/md and embeds html/images) — an absolute URL opens in a new tab instead.
function isRelativeHref(href: string): boolean {
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:|^\/\//.test(href)
}

export function viewableHref(href: string): boolean {
  if (!isRelativeHref(href)) return false
  if (ATTACHMENT_URL.test(href)) return true
  return fileKind({ name: href }) !== 'other'
}

// ── Routing ────────────────────────────────────────────────────────────────
// Hash routes: "#/card/<id>" for a card, "#/file?u=&n=&m=" for the viewer.

export type Route =
  | { kind: 'root' }
  | { kind: 'card'; id: string }
  | { kind: 'file'; url: string; name?: string; mime?: string }
  | { kind: 'folders' }
  // A real Claude Code session's stream view (#/session/<claudeSessionId>) — the
  // spine view, cards in chronological order within that one session.
  | { kind: 'session'; id: string }
  // A single report entry's main-pane view (#/report/<entryId>) — a report renders
  // as a first-class widget in the normal content area, not a separate drawer.
  | { kind: 'report'; id: string }
  // An in-page block anchor (#block-…, from a decision's Evidence links): a scroll
  // within the open card, NOT a route change. Without this kind it would parse as
  // root and the auto-open would yank the view to a different card.
  | { kind: 'anchor'; id: string }

export function fileHash(file: { url: string; name?: string; mime?: string }): string {
  const q = new URLSearchParams({ u: file.url })
  if (file.name) q.set('n', file.name)
  if (file.mime) q.set('m', file.mime)
  return `#/file?${q.toString()}`
}

// parseHash runs during App render, so a URIError from a hand-mangled hash
// (e.g. "#/session/%E0%A4%A") would blank the whole dashboard — fall back to the
// raw segment instead; an undecodable id simply matches no session.
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export function parseHash(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (raw.startsWith('/file?')) {
    const q = new URLSearchParams(raw.slice('/file?'.length))
    const url = q.get('u')
    if (url) {
      return {
        kind: 'file',
        url,
        ...(q.get('n') ? { name: q.get('n') as string } : {}),
        ...(q.get('m') ? { mime: q.get('m') as string } : {}),
      }
    }
  }
  if (raw.replace(/\/$/, '') === '/folders') return { kind: 'folders' }
  const session = /^\/session\/(.+)$/.exec(raw)
  if (session) return { kind: 'session', id: safeDecode(session[1]) }
  const report = /^\/report\/(.+)$/.exec(raw)
  if (report) return { kind: 'report', id: safeDecode(report[1]) }
  const card = /^\/card\/(.+)$/.exec(raw)
  if (card) return { kind: 'card', id: card[1] }
  if (raw.startsWith('block-')) return { kind: 'anchor', id: raw }
  return { kind: 'root' }
}
