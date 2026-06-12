import notifier from 'node-notifier'
import type { Card } from '../shared/card.js'
import type { Config } from './config.js'
import type { Queue } from './queue.js'

function cardUrl(port: number, id: string): string {
  return `http://127.0.0.1:${port}/#/card/${id}`
}

export function startNotifications(queue: Queue, config: Config): void {
  if (!config.notifications) return

  const seen = new Set<string>()
  queue.on('card', (card: Card) => {
    if (card.status !== 'pending' || seen.has(card.id)) return
    seen.add(card.id)
    notifier.notify({
      title: `boardroom · ${card.stage} · ${card.session.project}`,
      message: card.headline,
      open: cardUrl(config.port, card.id),
      timeout: 10,
    })
  })

  setInterval(() => {
    const n = queue.pendingCount()
    if (n === 0) return
    notifier.notify({
      title: 'boardroom',
      message: `${n} decision${n === 1 ? '' : 's'} waiting for you`,
      open: `http://127.0.0.1:${config.port}/`,
      timeout: 10,
    })
  }, config.remindEveryMinutes * 60_000).unref()
}
