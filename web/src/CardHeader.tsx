import { Bot, FileText, FolderGit2, Layers3, Moon, PanelRight, Workflow } from 'lucide-react'
import type { Card } from '../../src/shared/card.js'
import type { CardWorkspace } from './cardWorkspace.js'
import { STAGE } from './stage.js'

// The card's identity strip: stage tag + headline, the session/project/agent/plan
// provenance, the offline banner, and (while live) the cockpit stats and the
// stage role + "how to decide here" guide.
export function CardHeader({ card, workspace, readonly, pickupSummary }: {
  card: Card
  workspace: CardWorkspace
  readonly: boolean
  pickupSummary: string | null
}) {
  const meta = STAGE[card.stage]
  const orphaned = card.status === 'orphaned'
  const sessionTitle = card.session.title?.trim() || 'Untitled session'
  const choiceDecisions = workspace.choiceDecisions

  return (
    <div className="card-head">
      <div className="head-kicker">
        <span className="stage-tag">{meta.label}</span>
        {card.status !== 'pending' && <span className={`status-chip ${card.status}`}>{card.status}</span>}
      </div>
      <h1 className="card-headline">{card.headline}</h1>
      <div className="source-strip" aria-label="Decision source">
        <span>
          <span className="source-label">Session</span>
          <strong>{sessionTitle}</strong>
        </span>
        <span>
          <FolderGit2 size={14} aria-hidden />
          <span className="source-label">Project</span>
          <strong>{card.session.project}</strong>
        </span>
        <span>
          <Bot size={14} aria-hidden />
          <span className="source-label">Agent</span>
          <strong>{card.session.agent}</strong>
        </span>
        {card.planRef && (
          <span>
            <FileText size={14} aria-hidden />
            <span className="source-label">Plan</span>
            <code>{card.planRef}</code>
          </span>
        )}
      </div>
      {orphaned && !pickupSummary && (
        <div className="banner">
          <Moon size={16} aria-hidden />
          <span>The agent's connection dropped (often the Mac sleeping). Decide anyway — it's delivered automatically when the agent reconnects, or copy the summary to paste in by hand.</span>
        </div>
      )}
      {!readonly && (
        <>
          <div className="cockpit-stats">
            <span><PanelRight size={13} aria-hidden />{choiceDecisions.length} decision{choiceDecisions.length === 1 ? '' : 's'}</span>
            <span><Workflow size={13} aria-hidden />{workspace.visualSummary.linkedBlocks} linked visual{workspace.visualSummary.linkedBlocks === 1 ? '' : 's'}</span>
            <span><Layers3 size={13} aria-hidden />{workspace.visualSummary.totalBlocks} block{workspace.visualSummary.totalBlocks === 1 ? '' : 's'}</span>
          </div>
          <p className="stage-role">{meta.role}</p>
          <details className="stage-guide">
            <summary>How to decide here</summary>
            <ul>{meta.guide.map((g, i) => <li key={i}>{g}</li>)}</ul>
          </details>
        </>
      )}
    </div>
  )
}
