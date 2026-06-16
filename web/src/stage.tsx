import type { Stage } from '../../src/shared/card.js'

export interface StageMeta {
  label: string
  color: string
  role: string // one-line CEO orientation: what this gate asks of you
  guide: string[] // opt-in "how to decide here" posture, collapsed by default
  vars: React.CSSProperties
}

function meta(label: string, color: string, role: string, guide: string[]): StageMeta {
  return { label, color, role, guide, vars: { '--stage-color': color } as React.CSSProperties }
}

export const STAGE: Record<Stage, StageMeta> = {
  clarify: meta('Clarify', 'var(--clarify)',
    'Set the direction so the agent can plan — pick an option, or write your own.',
    [
      "You're scoping, not signing off the final build — answer what unblocks the plan.",
      'No option fits? Use “Other…” to say it in your own words.',
      'A note on any choice gives the agent extra context.',
    ]),
  plan: meta('Plan approval', 'var(--plan)',
    'Approve the approach to proceed — or send it back with changes.',
    [
      'Approving IS agreeing to the plan’s decisions — it’s the submit, not a separate gate.',
      'Each decision is a fork in how it gets built; pick what you want.',
      '“Send back” with a note halts it — the note becomes the agent’s next instruction.',
    ]),
  results: meta('Results review', 'var(--results)',
    'Sign off on what the agent did — trust the proof, flag what’s wrong.',
    [
      'You’re checking intent & safety, not re-running the work — expand a claim only if you doubt it.',
      'The chip is the proof (tests, diff); approve when it holds.',
      'Deny a claim to reject it — your note is the fix instruction the agent gets back.',
    ]),
}
