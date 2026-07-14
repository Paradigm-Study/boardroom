import { useEffect } from 'react'
import type { ReportEntry } from '../../src/shared/entry.js'
import { BlockView } from './blocks/BlockView.js'
import { markRead } from './readState.js'

// The main-pane report view (#/report/<id>). Per the human's direction, a report
// is "additional information" — a widget just like any other, NOT a second
// reading destination — so this reuses CardView's own decision-sheet chrome
// (sheet-head + canvas-label) rather than inventing new furniture. Visiting the
// route IS reading the report: same markRead-on-mount rule as ReportDrawer.
export function ReportView({ entry }: { entry: ReportEntry }) {
  useEffect(() => {
    markRead(entry.id)
  }, [entry.id])

  return (
    <div className="card-col report-view">
      <section className="decision-sheet" aria-label="Report">
        <div className="sheet-head">
          <div>
            <span className="canvas-label">Report</span>
            <h2>{entry.headline}</h2>
            <p className="sheet-source">
              {entry.claudeSessionId
                ? <a href={`#/session/${encodeURIComponent(entry.claudeSessionId)}`}>{entry.session.title?.trim() || 'Untitled session'}</a>
                : (entry.session.title?.trim() || 'Untitled session')}
            </p>
          </div>
        </div>

        <div className="entry-report-body">
          {entry.blocks.map(b => <BlockView key={b.id} block={b} />)}
        </div>

        <p className="report-view-footer">Report — nothing to decide.</p>
      </section>
    </div>
  )
}
