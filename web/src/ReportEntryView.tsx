import { FileText } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import type { ReportEntry } from '../../src/shared/entry.js'
import { BlockView } from './blocks/BlockView.js'
import { ReportDrawer } from './ReportDrawer.js'
import { isImplicitlyRead, isRead, readStateVersion, subscribeReadState } from './readState.js'

// A report's stream summary card: headline + its blocks, glanceable — the same
// SpecAffordance open/close pattern as the spec-recall drawer (default closed,
// "Open report" reveals the full-size ReportDrawer). An unread dot (per readState,
// Task 7) shows until the human opens the drawer, which marks it read.
export function ReportEntryView({ entry }: { entry: ReportEntry }) {
  const [open, setOpen] = useState(false)
  // Subscribe to readState so the drawer's markRead clears the dot immediately
  // (the drawer stays open over a still-lit dot otherwise). Age-implies-read:
  // same rule as the sidebar — an old report must not re-light here.
  useSyncExternalStore(subscribeReadState, readStateVersion)
  const unread = !isImplicitlyRead(entry) && !isRead(entry.id)

  return (
    <div className="entry-report">
      <header className="entry-report-head">
        <FileText size={14} aria-hidden />
        {unread && <span className="entry-unread-dot" aria-label="Unread report" />}
        <h3>{entry.headline}</h3>
      </header>

      <div className="entry-report-body">
        {entry.blocks.map(b => <BlockView key={b.id} block={b} />)}
      </div>

      <button className="entry-report-open" onClick={() => setOpen(true)}>
        Open report
      </button>

      {open && <ReportDrawer entry={entry} onClose={() => setOpen(false)} />}
    </div>
  )
}
