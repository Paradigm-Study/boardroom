import { X } from 'lucide-react'
import type { Card } from '../../src/shared/card.js'
import type { Entry } from '../../src/shared/entry.js'
import type { SessionVM } from './api.js'
import { SessionStream } from './SessionStream.js'

// The sidebar's per-session "stream" affordance opens this — SpecDrawer's
// slide-in-from-the-right chrome (fixed, right-anchored, own close button) wrapping
// the SAME SessionStream the #/session/<id> route renders, so a session's full
// card+report+tag history is one click away from wherever it's mentioned in the
// sidebar without leaving the current view. Default closed: TaskSidebar only
// mounts this when the human clicks the affordance.
export function StreamDrawer({ session, cards, entries, onClose }: {
  session: SessionVM | null
  cards: Card[]
  entries: Entry[]
  onClose: () => void
}) {
  return (
    <aside className="stream-drawer" aria-label="Session stream drawer">
      <header className="spec-drawer-head">
        <div>
          <span className="canvas-label">Stream</span>
        </div>
        <button className="spec-drawer-close" aria-label="Close session stream" onClick={onClose}>
          <X size={16} aria-hidden />
        </button>
      </header>

      <div className="stream-drawer-body">
        <SessionStream session={session} cards={cards} entries={entries} />
      </div>
    </aside>
  )
}
