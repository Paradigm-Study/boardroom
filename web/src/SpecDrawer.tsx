import { ArrowUpRight, X } from 'lucide-react'
import type { RecallClaim, RecallCriterion, SpecRecall } from './specRecall.js'

const VOTE_LABEL: Record<RecallClaim['vote'], string> = {
  approve: 'approved', revise: 'revise', reject: 'rejected', pending: 'pending',
}

function Claim({ claim, onOpenCard }: { claim: RecallClaim; onOpenCard?: (cardId: string) => void }) {
  return (
    <div className="spec-claim">
      <span className={`vote ${claim.vote}`}>{VOTE_LABEL[claim.vote]}</span>
      <span className="spec-claim-text">{claim.claim}</span>
      {onOpenCard && (
        <button className="spec-claim-link" onClick={() => onOpenCard(claim.resultsCardId)}>
          results <ArrowUpRight size={11} aria-hidden />
        </button>
      )}
    </div>
  )
}

function CritRow({ c, onOpenCard }: { c: RecallCriterion; onOpenCard?: (cardId: string) => void }) {
  if (c.status === 'dropped') {
    return (
      <div className="spec-crit dropped">
        <span className="crit-behavior">{c.behavior}</span>
        <span className="crit-status dropped">dropped</span>
      </div>
    )
  }
  return (
    <div className={`spec-crit crit crit-${c.status}`}>
      <div className="crit-head">
        <span className="crit-behavior">{c.behavior}</span>
        <span className={`crit-status ${c.status}`}>{c.status}</span>
      </div>
      <div className="crit-good"><span className="crit-mark good" aria-hidden>✓</span>{c.good}</div>
      <div className="crit-bad"><span className="crit-mark bad" aria-hidden>✗</span>{c.bad}</div>
      <div className="crit-trace">
        traces to {c.tracesTo}{c.adjustedNote ? ` · adjusted: ${c.adjustedNote}` : ''}
      </div>
      <div className="spec-claims">
        {c.claims.length === 0
          ? <div className="spec-claim none">no claim yet</div>
          : c.claims.map((cl, i) => <Claim key={i} claim={cl} onOpenCard={onOpenCard} />)}
      </div>
    </div>
  )
}

// The recallable Spec drawer: a read-only, non-binding cross-compare of the locked
// acceptance contract against what the agent has actually claimed. Slides in from
// the right; never blocks; reflects persisted cards only.
export function SpecDrawer({ recall, onClose, onOpenCard }: {
  recall: SpecRecall
  onClose: () => void
  onOpenCard?: (cardId: string) => void
}) {
  const pct = recall.total ? Math.round((recall.metCount / recall.total) * 100) : 0
  return (
    <aside className="spec-drawer" aria-label="Spec contract">
      <header className="spec-drawer-head">
        <div>
          <span className="canvas-label">Spec</span>
          <h3>Acceptance contract</h3>
        </div>
        <button className="spec-drawer-close" aria-label="Close spec" onClick={onClose}>
          <X size={16} aria-hidden />
        </button>
      </header>

      <div className="spec-progress" role="img" aria-label={`${recall.metCount} of ${recall.total} criteria met`}>
        <div className="spec-progress-track"><span className="spec-progress-fill" style={{ width: `${pct}%` }} /></div>
        <span className="spec-progress-label">{recall.metCount} / {recall.total} criteria met</span>
      </div>

      {recall.goal && <div className="spec-goal">{recall.goal}</div>}

      <div className="spec-crit-list">
        {recall.criteria.map(c => <CritRow key={c.id} c={c} onOpenCard={onOpenCard} />)}
      </div>
    </aside>
  )
}
