import { X } from 'lucide-react'
import { useEffect } from 'react'
import type { ReportEntry } from '../../src/shared/entry.js'
import { BlockView } from './blocks/BlockView.js'
import { markRead } from './readState.js'

// The full-size report view — SpecDrawer's slide-in-from-the-right pattern, reused
// verbatim (fixed, right-anchored, own z-index) so a report and the spec-recall
// drawer never fight for screen chrome. Renders the SAME blocks as the summary
// card (ReportEntryView), just at full width — no separate "detail" content model.
// Marks the entry read the moment it opens: the human seeing the drawer IS reading it.
export function ReportDrawer({ entry, onClose }: { entry: ReportEntry; onClose: () => void }) {
  useEffect(() => {
    markRead(entry.id)
  }, [entry.id])

  return (
    <aside className="report-drawer" aria-label="Report">
      <header className="spec-drawer-head">
        <div>
          <span className="canvas-label">Report</span>
          <h3>{entry.headline}</h3>
        </div>
        <button className="spec-drawer-close" aria-label="Close report" onClick={onClose}>
          <X size={16} aria-hidden />
        </button>
      </header>

      <div className="report-drawer-body">
        {entry.blocks.map(b => <BlockView key={b.id} block={b} />)}
      </div>
    </aside>
  )
}
