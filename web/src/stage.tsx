import type { Stage } from '../../src/shared/card.js'

export interface StageMeta {
  label: string
  color: string
  vars: React.CSSProperties
}

function meta(label: string, color: string): StageMeta {
  return { label, color, vars: { '--stage-color': color } as React.CSSProperties }
}

export const STAGE: Record<Stage, StageMeta> = {
  clarify: meta('Clarify', 'var(--clarify)'),
  plan: meta('Plan approval', 'var(--plan)'),
  results: meta('Results review', 'var(--results)'),
}
