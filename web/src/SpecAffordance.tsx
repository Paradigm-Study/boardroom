import { ListChecks } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Card } from '../../src/shared/card.js'
import { SpecDrawer } from './SpecDrawer.js'
import { buildSpecRecall } from './specRecall.js'

// The "Spec" open affordance for a session: shown only when the project has a
// locked acceptance contract, it opens the read-only cross-compare drawer. A pure
// view over the app shell's card store (threaded down through CardView) — it holds
// no data subscription of its own, so a card switch costs nothing and there is no
// second /events connection or fetch/SSE ordering to race.
export function SpecAffordance({ project, cards }: { project: string; cards: Card[] }) {
  const [open, setOpen] = useState(false)

  const recall = useMemo(() => buildSpecRecall(cards, project), [cards, project])
  if (!recall) return null

  return (
    <>
      <button className="spec-open-btn" onClick={() => setOpen(true)} aria-label="Open the acceptance contract">
        <ListChecks size={13} aria-hidden /> Spec · {recall.metCount}/{recall.total} met
      </button>
      {open && (
        <SpecDrawer
          recall={recall}
          onClose={() => setOpen(false)}
          onOpenCard={id => { window.location.hash = `#/card/${id}`; setOpen(false) }}
        />
      )}
    </>
  )
}
