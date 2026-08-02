import { spawn } from 'node:child_process'
import notifier from 'node-notifier'
import type { Card } from '../shared/card.js'
import type { Config } from './config.js'
import type { Queue } from './queue.js'

function cardUrl(port: number, id: string): string {
  return `http://127.0.0.1:${port}/#/card/${id}`
}

// node-notifier shells out to the vendored terminal-notifier and JSON.parses its
// stdout (node-notifier/lib/utils.js → fileCommandJson). On modern macOS the
// daemon's notification is suppressed and terminal-notifier emits output that is
// not a clean JSON value, so JSON.parse throws a SyntaxError that node-notifier
// hands back as the callback's error. That parse failure is expected noise on
// this best-effort surface — the only SyntaxError node-notifier can produce — so
// we swallow it. Genuine failures (e.g. "Notifier not found") are plain Errors
// and stderr warnings arrive as strings; both stay loud and diagnosable.
export function isBenignNotifierNoise(err: unknown): boolean {
  return err instanceof SyntaxError
}

// Best-effort OS notification. node-notifier reports success even when macOS
// suppresses display, so this is unreliable from a launchd daemon — the
// menu-bar app is the dependable notifier. We log real spawn errors (previously
// swallowed) so failures are diagnosable, while ignoring the benign terminal-
// notifier JSON-parse noise that otherwise floods the daemon log.
function notify(opts: notifier.Notification & { open?: string; timeout?: number }): void {
  notifier.notify(opts, err => {
    if (err && !isBenignNotifierNoise(err)) console.error('[notify] failed:', err)
  })
}

// A decided verdict failed its auto-resume push (`claude --resume`): the decision
// is safe and claimable, but nobody is coming to collect it — say so where the
// human can see it instead of a daemon-log line nobody reads. Best-effort like
// every notification here; the dashboard copy-paste summary remains the fallback.
export function notifyResumeFailure(project: string, headline: string, detail: string): void {
  notify({
    title: `boardroom · ${project} · auto-resume failed`,
    message: `"${headline}" was decided but the session could not be resumed (${detail}). Copy the verdict from the dashboard, or have the agent re-issue the call.`,
    timeout: 10,
  })
}

export function startNotifications(queue: Queue, config: Config): void {
  if (!config.notifications) return

  const seen = new Set<string>()
  queue.on('card', (card: Card) => {
    if (card.status !== 'pending' || seen.has(card.id)) return
    seen.add(card.id)
    notify({
      title: `boardroom · ${card.stage} · ${card.session.project}`,
      message: card.headline,
      open: cardUrl(config.port, card.id),
      timeout: 10,
    })
  })

  setInterval(() => {
    const n = queue.pendingCount()
    if (n === 0) return
    notify({
      title: 'boardroom',
      message: `${n} decision${n === 1 ? '' : 's'} waiting for you`,
      open: `http://127.0.0.1:${config.port}/`,
      timeout: 10,
    })
  }, config.remindEveryMinutes * 60_000).unref()
}

// Opt-in: pop the dashboard (default browser) straight to the card the moment a
// decision is needed, so it comes to you instead of you hunting for it. Off by
// default — auto-opening tabs is intrusive unless you asked for it.
export function startAutoOpen(queue: Queue, config: Config): void {
  if (!config.openOnPending) return
  const seen = new Set<string>()
  queue.on('card', (card: Card) => {
    if (card.status !== 'pending' || seen.has(card.id)) return
    seen.add(card.id)
    spawn('open', [cardUrl(config.port, card.id)], { stdio: 'ignore' }).on('error', () => {})
  })
}
