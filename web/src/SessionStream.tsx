import type { Card } from '../../src/shared/card.js'
import type { Entry } from '../../src/shared/entry.js'
import type { SessionVM } from './api.js'
import { CardView } from './CardView.js'
import { ReportEntryView } from './ReportEntryView.js'
import { STAGE } from './stage.js'
import { parseTag } from './tagLabel.js'

function TagRow({ entry }: { entry: Extract<Entry, { type: 'tag' }> }) {
  const { stage, label } = parseTag(entry.tag)
  const color = stage ? STAGE[stage].color : 'var(--ink-3)'
  return (
    <div className="entry-tag" style={{ '--stage-color': color } as React.CSSProperties}>
      <a href={`#/card/${entry.cardId}`}>{label}</a>
    </div>
  )
}

type StreamItem =
  | { kind: 'card'; at: string; card: Card }
  | { kind: Entry['type']; at: string; entry: Entry }

// One session's scrollable stream: gates AND entries (reports, tags) in chronological
// order — the spine view treats a report or a stage tag as a stream citizen, not a
// second surface bolted on. Sorts oldest-first itself (rather than trusting the
// caller's order) so the stream reads top-to-bottom as the session unfolded
// regardless of how `cards`/`entries` were fetched.
export function SessionStream({ session, cards, entries }: { session: SessionVM | null; cards: Card[]; entries: Entry[] }) {
  const ordered = [...cards].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const items: StreamItem[] = [
    ...cards.map(c => ({ kind: 'card' as const, at: c.createdAt, card: c })),
    ...entries.map(e => ({ kind: e.type, at: e.createdAt, entry: e })),
  ].sort((a, b) => a.at.localeCompare(b.at))

  return (
    <section className="session-stream" aria-label="Session stream">
      <header className="stream-head">
        <div>
          <span className="canvas-label">Session</span>
          <h2>{session?.project ?? ordered[0]?.session.project ?? 'Unknown session'}</h2>
          <p className="stream-sub">{ordered[0]?.session.title?.trim() || session?.cwd || ''}</p>
        </div>
        {session && <span className={`stream-status stream-status-${session.sessionStatus}`}>{session.sessionStatus}</span>}
      </header>
      {items.length === 0 && <p className="side-empty">No cards from this session yet.</p>}
      {items.map(item => {
        if (item.kind === 'card') {
          return (
            <div className="stream-item" key={item.card.id}>
              <CardView card={item.card} cards={ordered} />
            </div>
          )
        }
        const { entry } = item
        return entry.type === 'report'
          ? <ReportEntryView key={entry.id} entry={entry} />
          : <TagRow key={entry.id} entry={entry} />
      })}
    </section>
  )
}
