// Pure folder-tree model for the "sessions by code folder" Finder column view.
// Kept free of React/DOM so the rooting/aggregation logic is trivially unit-tested.
// Input is the captured-session list (GET /api/sessions); output is a path tree the
// Miller-column UI walks. Counts include EVERY captured session (alive + ended) per
// the design decision, with `running` carried alongside as a secondary accent.
import type { CapturedSession } from '../../src/shared/session.js'

export interface FolderNode {
  name: string                // path segment for display (basename); '' only for the filesystem root
  path: string                // absolute path — the stable key the UI selects on
  children: FolderNode[]      // subfolders, sorted alphabetically (case-insensitive)
  sessions: CapturedSession[] // sessions whose cwd === path, sorted alive-first then most-recent
  total: number               // sessions at or under this node (the badge)
  running: number             // alive sessions at or under this node
}

// Normalize a cwd to a comparable absolute path: drop a trailing slash (except the
// filesystem root itself). The daemon validates cwds as absolute, so we assume POSIX.
function normalize(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.replace(/\/+$/, '') : p
}

function parentPath(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? '/' : p.slice(0, idx)
}

function basename(p: string): string {
  if (p === '/') return '/'
  return p.slice(p.lastIndexOf('/') + 1)
}

function makeNode(path: string): FolderNode {
  return { name: basename(path), path, children: [], sessions: [], total: 0, running: 0 }
}

// Deepest path prefix shared by every input, compared SEGMENT-by-segment (so
// "/a/bb" and "/a/bc" share "/a", never "/a/b"). Empty input → filesystem root.
export function commonAncestor(paths: string[]): string {
  if (paths.length === 0) return '/'
  const split = paths.map(p => normalize(p).split('/'))
  const first = split[0]
  let i = 0
  while (i < first.length && split.every(s => s[i] === first[i])) i++
  const joined = first.slice(0, i).join('/')
  return joined === '' ? '/' : joined
}

// Build the folder tree rooted at the common ancestor of all session cwds. When the
// common ancestor is itself a session's cwd (all sessions share one folder, or one
// nests inside another), back off one level so that shared folder renders as its own
// clickable column entry rather than as loose sessions sitting at the root header.
export function buildTree(sessions: CapturedSession[]): FolderNode {
  const cwds = sessions.map(s => normalize(s.cwd))
  let rootPath = commonAncestor(cwds)
  if (cwds.includes(rootPath)) rootPath = parentPath(rootPath)
  const root = makeNode(rootPath)

  for (const session of sessions) {
    const cwd = normalize(session.cwd)
    const rest = rootPath === '/' ? cwd.slice(1) : cwd.slice(rootPath.length + 1)
    let node = root
    let acc = rootPath
    for (const seg of rest ? rest.split('/') : []) {
      if (!seg) continue
      acc = acc === '/' ? '/' + seg : acc + '/' + seg
      let next = node.children.find(c => c.path === acc)
      if (!next) {
        next = makeNode(acc)
        node.children.push(next)
      }
      node = next
    }
    node.sessions.push(session)
  }

  finalize(root)
  return root
}

// Post-order: aggregate counts from the leaves up, then sort folders and sessions.
function finalize(node: FolderNode): void {
  let total = node.sessions.length
  let running = node.sessions.filter(s => s.status === 'alive').length
  for (const c of node.children) {
    finalize(c)
    total += c.total
    running += c.running
  }
  node.total = total
  node.running = running
  node.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  // Alive first, then most-recently-seen, then sessionId for a stable order.
  node.sessions.sort((a, b) =>
    Number(b.status === 'alive') - Number(a.status === 'alive') ||
    b.lastSeenAt.localeCompare(a.lastSeenAt) ||
    a.sessionId.localeCompare(b.sessionId),
  )
}

// The Miller-column model for a drill path: the root's contents form column 0, and
// each selected folder (by absolute path) contributes the next column. The walk
// stops at the first selection that no longer resolves (e.g. after a re-root), so a
// stale selection degrades to a shorter, valid set of columns rather than throwing.
export function columnsFor(root: FolderNode, selectedPath: string[]): FolderNode[] {
  const cols = [root]
  let node = root
  for (const p of selectedPath) {
    const next = node.children.find(c => c.path === p)
    if (!next) break
    cols.push(next)
    node = next
  }
  return cols
}

// Best-effort home directory for display abbreviation, inferred from the session
// paths themselves (the browser has no os.homedir()). Matches a leading
// /Users/<name> or /home/<name>; returns '' when nothing home-shaped is present.
export function deriveHome(paths: string[]): string {
  for (const p of paths) {
    const m = /^(\/(?:Users|home)\/[^/]+)(?:\/|$)/.exec(p)
    if (m) return m[1]
  }
  return ''
}

// Replace a leading home prefix with '~'. Anchored on a full segment boundary so a
// sibling like /Users/mentor is never abbreviated against home /Users/me.
export function abbreviateHome(path: string, home: string): string {
  if (!home) return path
  if (path === home) return '~'
  if (path.startsWith(home + '/')) return '~' + path.slice(home.length)
  return path
}
