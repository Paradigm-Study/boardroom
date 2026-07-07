// Types for the dependency-free CommonJS tray-render module (trayRender.js), so the
// vitest suite and tsc see a typed contract. Dev-only — electron-builder ships the .js.

export type ConnState = 'connecting' | 'connected' | 'lost'

export interface TrayItem {
  id: string
  stage: string
  headline: string
  project: string
  claudeSessionId?: string
}

// Deliberately LOOSER than the daemon's TrayVM (src/daemon/trayView.ts): stage is a
// plain string so the tray stays forward-compatible with a daemon that adds a stage.
// tests/trayRender.test.ts feeds a daemon-built TrayVM through trayView(), which is
// the compile-time check that the two shapes stay assignable.
export interface TrayVM {
  total: number
  byStage: Record<string, number>
  items: TrayItem[]
}

export interface TrayRender {
  title: string
  tooltip: string
  statusLine: string
}

export const STAGE_LABEL: Record<string, string>
export const STAGE_SHORT: Record<string, string>
export const STAGE_ORDER: string[]

export function orderedStages(byStage: Record<string, number>): string[]
export function splitFrames(buffer: string): { frames: string[]; rest: string }
export function parseFrame(frameText: string): { event: string; data: string } | null
export function stageSummary(byStage: Record<string, number>): string
export function trayView(state: { connState: ConnState; vm: TrayVM | null }): TrayRender
export function reconcileNotifications(
  priorSeen: string[] | null | undefined,
  items: { id: string }[],
): { seen: string[]; toNotify: { id: string }[] }
