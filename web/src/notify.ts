import type { Card } from '../../src/shared/card.js'

const STAGE_LABEL: Record<Card['stage'], string> = {
  clarify: 'Needs scoping',
  plan: 'Plan to approve',
  spec: 'Spec to lock',
  results: 'Results to review',
}

const supported = (): boolean => typeof Notification !== 'undefined'

export function notifyPermission(): NotificationPermission {
  return supported() ? Notification.permission : 'denied'
}

export async function requestNotify(): Promise<NotificationPermission> {
  if (!supported()) return 'denied'
  return Notification.requestPermission()
}

// Browser-side popup for a newly pending card. Unlike the daemon's
// terminal-notifier, the Web Notifications API lets us set a real boardroom
// icon. Clicking focuses the tab and opens the card.
export function notifyCard(card: Card): void {
  if (!supported() || Notification.permission !== 'granted') return
  const n = new Notification(`boardroom · ${STAGE_LABEL[card.stage] ?? card.stage}`, {
    body: card.headline,
    icon: '/notif-icon.png',
    tag: card.id,
  })
  n.onclick = () => {
    window.focus()
    window.location.hash = `#/card/${card.id}`
    n.close()
  }
}
