import { ClipboardCheck, DraftingCompass, MessageCircleQuestion, type LucideIcon } from 'lucide-react'
import type { Stage } from '../../src/shared/card.js'

export interface StageMeta {
  label: string
  Icon: LucideIcon
  vars: React.CSSProperties
}

export const STAGE: Record<Stage, StageMeta> = {
  clarify: {
    label: 'Clarify',
    Icon: MessageCircleQuestion,
    vars: { '--stage-color': 'var(--clarify)', '--stage-soft': 'var(--clarify-soft)', '--stage-ink': 'var(--clarify-ink)' } as React.CSSProperties,
  },
  plan: {
    label: 'Plan approval',
    Icon: DraftingCompass,
    vars: { '--stage-color': 'var(--plan)', '--stage-soft': 'var(--plan-soft)', '--stage-ink': 'var(--plan-ink)' } as React.CSSProperties,
  },
  results: {
    label: 'Results review',
    Icon: ClipboardCheck,
    vars: { '--stage-color': 'var(--results)', '--stage-soft': 'var(--results-soft)', '--stage-ink': 'var(--results-ink)' } as React.CSSProperties,
  },
}
