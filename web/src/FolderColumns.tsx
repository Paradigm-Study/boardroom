import { ArrowLeft, ChevronRight, FolderTree } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CapturedSession } from '../../src/shared/session.js'
import { fetchDevice, type DeviceIdentity } from './api.js'
import { abbreviateHome, buildTree, columnsFor, deriveHome, type FolderNode } from './folderTree.js'
import { age } from './helpers.js'

// The Folders view: a Finder-style Miller-column browser over every captured
// session on this machine, grouped by code folder. Read-only — it shows registry
// facts and best-effort pointers (transcript "captured" yes/no), never transcript
// bodies, honoring the capture spec's pointers-not-content boundary.
export function FolderColumns({ sessions, onClose }: { sessions: CapturedSession[] | null; onClose(): void }) {
  // selected = the chain of opened folder paths; sessionId = a selected session.
  const [selected, setSelected] = useState<string[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [device, setDevice] = useState<DeviceIdentity | null>(null)

  // Esc closes — same destination as Back, matching the file viewer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => { fetchDevice().then(setDevice).catch(() => { /* nickname is optional */ }) }, [])

  // Memoize the list so a null→[] coalesce doesn't hand a fresh array to the
  // downstream useMemos on every render.
  const list = useMemo(() => sessions ?? [], [sessions])
  const home = useMemo(() => deriveHome(list.map(s => s.cwd)), [list])
  const tree = useMemo(() => buildTree(list), [list])
  const columns = columnsFor(tree, selected)
  const activeSession = sessionId ? list.find(s => s.sessionId === sessionId) ?? null : null

  // Keep the newly-opened column (or the detail pane) in view after a deep drill,
  // the way Finder scrolls its column browser rightward. Keyed on the stable drill
  // depth + selected id — NOT the derived activeSession object, which gets a fresh
  // identity on every 4s poll and would otherwise yank the browser back to the far
  // right while the user is scrolled left inspecting an earlier column.
  const colsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = colsRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [columns.length, sessionId])

  const openFolder = (columnIndex: number, path: string): void => {
    // Selecting a folder in column i replaces everything drilled below it and
    // clears any session selection (Finder collapses deeper columns).
    setSelected(prev => [...prev.slice(0, columnIndex), path])
    setSessionId(null)
  }
  const openSession = (columnIndex: number, id: string): void => {
    // A session is a leaf: collapse folder columns to the right of where it lives,
    // then show its detail pane.
    setSelected(prev => prev.slice(0, columnIndex))
    setSessionId(id)
  }

  return (
    <div className="folders">
      <header className="folders-bar">
        <button className="viewer-back" onClick={onClose}>
          <ArrowLeft size={15} aria-hidden /> Back
        </button>
        <span className="folders-title">
          <FolderTree size={14} aria-hidden /> Sessions by folder
        </span>
        <span className="folders-sub">
          {tree.total} session{tree.total === 1 ? '' : 's'} · {tree.running} running
          {device ? ` · ${device.deviceLabel}` : ''}
        </span>
      </header>

      {sessions === null ? (
        <p className="folders-msg">Loading sessions…</p>
      ) : list.length === 0 ? (
        <div className="folders-empty">
          <FolderTree size={32} strokeWidth={1.4} aria-hidden />
          <h2>No sessions captured yet</h2>
          <p>When a Claude Code session runs on this machine, its folder appears here.</p>
        </div>
      ) : (
        <div className="folders-cols" ref={colsRef}>
          {columns.map((node, i) => (
            <Column
              key={node.path}
              node={node}
              home={home}
              openFolderPath={selected[i] ?? null}
              selectedSessionId={sessionId}
              onFolder={path => openFolder(i, path)}
              onSession={id => openSession(i, id)}
            />
          ))}
          {activeSession && <SessionDetail session={activeSession} home={home} device={device} />}
        </div>
      )}
    </div>
  )
}

function Column({
  node,
  home,
  openFolderPath,
  selectedSessionId,
  onFolder,
  onSession,
}: {
  node: FolderNode
  home: string
  openFolderPath: string | null   // which child folder is currently drilled into
  selectedSessionId: string | null
  onFolder(path: string): void
  onSession(id: string): void
}) {
  return (
    <div className="fcol">
      <div className="fcol-head" title={node.path}>{abbreviateHome(node.path, home)}</div>
      <div className="fcol-list">
        {node.children.map(child => (
          <button
            key={child.path}
            type="button"
            className={`frow ffolder${openFolderPath === child.path ? ' on' : ''}`}
            onClick={() => onFolder(child.path)}
            title={child.path}
          >
            <span className="frow-name">{child.name}</span>
            <span className="frow-count" title={`${child.running} running of ${child.total} captured`}>
              {child.running > 0 && <i className="frun" aria-hidden />}
              {child.total}
            </span>
            <ChevronRight size={13} className="frow-chev" aria-hidden />
          </button>
        ))}
        {node.sessions.map(session => (
          <button
            key={session.sessionId}
            type="button"
            className={`frow fsession${selectedSessionId === session.sessionId ? ' on' : ''}`}
            onClick={() => onSession(session.sessionId)}
            title={`${session.status} · ${session.sessionId}`}
          >
            <span className={`fdot ${session.status}`} aria-hidden />
            <span className="frow-name mono">{shortId(session.sessionId)}</span>
            {session.entrypoint && <span className="fentry">{session.entrypoint}</span>}
            <span className="frow-age">{session.startedAt ? age(session.startedAt) : ''}</span>
          </button>
        ))}
        {node.children.length === 0 && node.sessions.length === 0 && (
          <p className="fcol-empty">empty</p>
        )}
      </div>
    </div>
  )
}

function SessionDetail({ session, home, device }: {
  session: CapturedSession
  home: string
  device: DeviceIdentity | null
}) {
  const rows: [string, string][] = [
    ['Agent', session.entrypoint ?? '—'],
    ['Kind', session.kind ?? '—'],
    ['PID', session.pid ? String(session.pid) : '—'],
    ['Version', session.claudeVersion ?? '—'],
    ['Started', ago(session.startedAt)],
    ['Last seen', ago(session.lastSeenAt)],
    ['Folder', abbreviateHome(session.cwd, home)],
    ['Device', device?.deviceLabel ?? '—'],
    ['Transcript', session.transcriptPath ? 'captured' : '—'],
    ['Tasks', session.tasksDir ? 'captured' : '—'],
  ]
  return (
    <div className="fcol fdetail">
      <div className="fcol-head mono" title={session.sessionId}>{shortId(session.sessionId)}</div>
      <div className="fdetail-body">
        <span className={`fbadge ${session.status}`}>
          {session.status === 'alive' ? 'running' : 'ended'}
        </span>
        <dl className="fdl">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd title={v}>{v}</dd>
            </div>
          ))}
        </dl>
        <code className="fsid" title="full session id">{session.sessionId}</code>
      </div>
    </div>
  )
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

function ago(iso?: string): string {
  if (!iso) return '—'
  const a = age(iso)
  return a === '' ? '—' : a === 'now' ? 'just now' : `${a} ago`
}
