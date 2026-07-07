import type { Card } from '../../src/shared/card.js'
import type { SessionVM } from './api.js'
import { CardView } from './CardView.js'

// One session's scrollable stream: gates in chronological order. The spine view —
// cards are entries in the session, not free-floating inbox items. Sorts oldest-first
// itself (rather than trusting the caller's order) so the stream reads top-to-bottom
// as the session unfolded regardless of how `cards` was fetched.
export function SessionStream({ session, cards }: { session: SessionVM | null; cards: Card[] }) {
  const ordered = [...cards].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
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
      {ordered.length === 0 && <p className="side-empty">No cards from this session yet.</p>}
      {ordered.map(c => (
        <div className="stream-item" key={c.id}>
          <CardView card={c} cards={ordered} />
        </div>
      ))}
    </section>
  )
}
