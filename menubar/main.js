// boardroom menu-bar app — a thin Electron tray shell around the dashboard the
// daemon already serves. The daemon (LaunchAgent) owns all state; this only
// renders it and shows a pending-count badge in the menu bar.
const { app, Menu, nativeImage, Notification, shell } = require('electron')
const { menubar } = require('menubar')
const path = require('node:path')

const PORT = process.env.BOARDROOM_PORT || '4040'
const BASE = `http://127.0.0.1:${PORT}`
const icon = nativeImage.createFromPath(path.join(__dirname, 'iconTemplate.png'))

const mb = menubar({
  index: `${BASE}/`,
  icon,
  tooltip: 'boardroom',
  browserWindow: { width: 960, height: 700, webPreferences: { backgroundThrottling: false } },
  showOnAllWorkspaces: true,
  preloadWindow: true,
})

const STAGE_LABEL = { clarify: 'Needs scoping', plan: 'Plan to approve', results: 'Results to review' }

function openCard(id) {
  mb.showWindow()
  mb.window?.webContents.executeJavaScript(`location.hash = '#/card/${id}'`).catch(() => {})
}

// Reliable native notifications live HERE (a real app bundle), not in the
// headless daemon — Electron's Notification integrates with macOS permissions,
// whereas the daemon's vendored terminal-notifier silently no-ops when the OS
// suppresses it.
function notifyNew(card) {
  if (!Notification.isSupported()) { console.log('[notify] unsupported'); return }
  console.log('[notify]', card.stage, '·', card.headline)
  const n = new Notification({
    title: `boardroom · ${STAGE_LABEL[card.stage] ?? card.stage}`,
    subtitle: card.session?.project,
    body: card.headline,
    silent: false,
  })
  n.on('click', () => openCard(card.id))
  n.show()
}

let lastTitle = ''
let knownPending = null // Set of pending ids; null until first poll (no launch burst)
async function refreshBadge() {
  let title = ''
  let tip = 'boardroom'
  try {
    const res = await fetch(`${BASE}/api/cards?status=pending`, { signal: AbortSignal.timeout(2500) })
    const pending = await res.json()
    const list = Array.isArray(pending) ? pending : []
    const ids = new Set(list.map(c => c.id))
    if (knownPending) {
      for (const c of list) if (!knownPending.has(c.id)) notifyNew(c)
    }
    knownPending = ids
    const n = list.length
    title = n > 0 ? ` ${n}` : ''
    tip = n > 0 ? `boardroom — ${n} waiting on you` : 'boardroom — nothing pending'
  } catch {
    title = ' •'
    tip = 'boardroom — daemon offline (start it and this clears)'
  }
  if (title !== lastTitle && mb.tray) {
    mb.tray.setTitle(title)
    mb.tray.setToolTip(tip)
    lastTitle = title
  }
}

const reload = () => mb.window?.webContents.reloadIgnoringCache()

// The dashboard is a single hash-routed SPA, so it should never make a top-level
// navigation. If one happens anyway (a stray link, a `_blank` from prose or the
// viewer's "Open in new tab"), keep the window planted on the dashboard and hand
// the URL to the real browser — otherwise the frameless window strands itself on
// a page with no way back. Files open in-app via the dashboard's own viewer.
function guardNavigation(contents) {
  if (!contents) return
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith(BASE)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })
}

mb.on('ready', () => {
  mb.tray.setTitle('')
  void refreshBadge()
  setInterval(() => void refreshBadge(), 4000)

  guardNavigation(mb.window?.webContents)

  // Cmd/Ctrl+R reloads the embedded dashboard (a frameless window has no menu
  // bar, so wire it by hand) — the escape hatch for a stale cached bundle.
  mb.window?.webContents.on('before-input-event', (_e, input) => {
    if ((input.meta || input.control) && input.key.toLowerCase() === 'r') reload()
  })

  mb.tray.on('right-click', () => {
    mb.tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: 'Open boardroom', click: () => mb.showWindow() },
      { label: 'Reload', accelerator: 'Cmd+R', click: reload },
      { label: 'Open in browser', click: () => void shell.openExternal(`${BASE}/`) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]))
  })
})

// A menu-bar utility shouldn't keep a Dock icon or quit-on-close semantics.
app.dock?.hide()
