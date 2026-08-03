import type { Stage } from '../../src/shared/card.js'
import { STAGE } from './stage.js'

const STAGE_IDS = new Set<string>(Object.keys(STAGE))

function isStage(id: string): id is Stage {
  return STAGE_IDS.has(id)
}

// A tag's payload is `stage:<stage>:<event>` (e.g. 'stage:plan:decided') — split it
// into the stage (for STAGE's label + color) and a "stage · event" label. Anything
// that doesn't match the shape still renders (the raw tag string), so a future/
// unknown tag format degrades gracefully instead of vanishing. Shared by
// SessionStream's tag rows and the sidebar's tag chips so the parsing/labeling
// rule lives in exactly one place.
export function parseTag(tag: string): { stage: Stage | null; label: string } {
  const match = /^stage:([a-z]+):([a-z]+)$/.exec(tag)
  if (!match) return { stage: null, label: tag }
  const [, stageId, event] = match
  const stage = isStage(stageId) ? stageId : null
  return { stage, label: `${stage ? STAGE[stage].label.toLowerCase() : stageId} · ${event}` }
}
