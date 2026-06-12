import { Layers, PanelLeft } from 'lucide-react'
import { statusLabel, type SessionEntry } from './sessions.js'

export function SessionRail({ sessions, selected }: {
  sessions: SessionEntry[]
  selected: string | null
}) {
  return (
    <aside className="srail">
      <div className="srail-label"><PanelLeft size={13} aria-hidden />Sessions</div>
      <a href="#/" className={`sess all${selected === null ? ' on' : ''}`}>
        <Layers size={15} aria-hidden style={{ flexShrink: 0 }} />
        <span className="sess-main">
          <span className="sess-name">All sessions</span>
        </span>
      </a>
      {sessions.map(s => (
        <a
          key={s.project}
          href={`#/s/${encodeURIComponent(s.project)}`}
          className={`sess${selected === s.project ? ' on' : ''}`}
          title={s.title ?? s.project}
        >
          <span className={`dot ${s.status}`} />
          <span className="sess-main">
            <span className="sess-name">{s.project}</span>
            <span className="sess-status">{statusLabel(s)}</span>
          </span>
          {s.pending > 0 && <span className="sess-badge">{s.pending}</span>}
        </a>
      ))}
    </aside>
  )
}
