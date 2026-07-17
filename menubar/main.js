// boardroom menu-bar app — a thin Electron tray shell around the dashboard the
// daemon already serves. The daemon (LaunchAgent) owns all state; this renders it
// and shows the tray's own state (connecting / pending+counts / offline) in the bar.
const { app, Menu, nativeImage, Notification, shell } = require('electron')
const { menubar } = require('menubar')
const path = require('node:path')
const {
  STAGE_LABEL,
  orderedStages,
  splitFrames,
  parseFrame,
  trayView,
  reconcileNotifications,
} = require('./trayRender')

const PORT = process.env.BOARDROOM_PORT || '4140'
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

function openCard(id) {
  mb.showWindow()
  // Pass the id as DATA (JSON.stringify), never by string interpolation: ids are
  // daemon-minted UUIDs today, but this is an execute-in-privileged-renderer sink —
  // a quote in a future id shape must not become code.
  mb.window?.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`#/card/${id}`)}`).catch(() => {})
}

// Reliable native notifications live HERE (a real app bundle), not in the
// headless daemon — Electron's Notification integrates with macOS permissions,
// whereas the daemon's vendored terminal-notifier silently no-ops when the OS
// suppresses it. Driven off the tray view-model's items[] (see reconcileNotifications);
// each item carries { id, stage, headline, project }.
function notifyNew(item) {
  if (!Notification.isSupported()) { console.log('[notify] unsupported'); return }
  console.log('[notify]', item.stage, '·', item.headline)
  const n = new Notification({
    title: `boardroom · ${STAGE_LABEL[item.stage] ?? item.stage}`,
    subtitle: item.project,
    body: item.headline,
    silent: false,
  })
  n.on('click', () => openCard(item.id))
  n.show()
}

// ---- live tray state over the daemon's /events SSE stream (no poll, no deps) ------
// Electron's main process has fetch + ReadableStream + TextDecoder but no EventSource,
// so we read the daemon's existing /events stream by hand. The daemon precomputes a
// 'tray' view-model frame (snapshot on connect + on every card transition); the SPA in
// the window ignores 'tray' frames. This replaces the old 4s poll: one transport,
// near-instant updates, and a true connection signal for the badge.
const MAX_BUFFER = 1_000_000 // bound the accumulator so a stuck/garbage stream can't grow unbounded

let connState = 'connecting' // 'connecting' (never up) | 'connected' | 'lost' (was up, daemon gone)
let hasEverConnected = false
let latestVM = null
let seenIds = null // null until the first frame seeds the notification set (suppresses the reconnect burst)
let lastTitle = null
let backoff = 1000

function render() {
  if (!mb.tray) return
  const { title, tooltip } = trayView({ connState, vm: latestVM })
  if (title !== lastTitle) { mb.tray.setTitle(title); lastTitle = title }
  mb.tray.setToolTip(tooltip)
}

function onTrayFrame(vm) {
  hasEverConnected = true
  connState = 'connected'
  backoff = 1000
  latestVM = vm
  const { seen, toNotify } = reconcileNotifications(seenIds, vm.items || [])
  seenIds = seen
  for (const item of toNotify) notifyNew(item)
  render()
}

// While (re)connecting, show 'connecting…' if we've never been up, else 'offline' —
// so the badge distinguishes "starting up" from "lost the daemon".
function markDown() {
  connState = hasEverConnected ? 'lost' : 'connecting'
  render()
}

// The daemon writes a ':hb' comment every 25s. If NOTHING arrives for this long the
// socket is presumed wedged (daemon event loop stuck, half-open socket after
// sleep/wake) — without a watchdog, reader.read() pends forever and the tray shows a
// stale 'connected' badge indefinitely.
const STALL_TIMEOUT_MS = 60_000

async function streamOnce() {
  const controller = new AbortController()
  let watchdog = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE}/events`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    })
    if (!res.ok || !res.body) throw new Error(`/events HTTP ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      clearTimeout(watchdog)
      watchdog = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS)
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > MAX_BUFFER) buffer = '' // drop a pathological un-terminated buffer
      const { frames, rest } = splitFrames(buffer)
      buffer = rest
      for (const frame of frames) {
        const evt = parseFrame(frame)
        if (!evt || evt.event !== 'tray') continue
        // A throw in the main process kills the whole tray, so isolate the parse.
        try { onTrayFrame(JSON.parse(evt.data)) }
        catch (err) { console.warn('[events] skipping malformed tray frame:', err.message) }
      }
    }
  } finally {
    clearTimeout(watchdog)
  }
}

// Reconnect loop with capped backoff. A daemon restart drops the stream; on reconnect
// the snapshot frame restores the correct state (including "reconnecting" cards).
async function connectTray() {
  for (;;) {
    markDown()
    try {
      await streamOnce()
    } catch (err) {
      console.log('[events] disconnected:', err.message)
    }
    markDown()
    await new Promise(resolve => setTimeout(resolve, backoff))
    backoff = Math.min(backoff * 2, 15_000)
  }
}

const reload = () => mb.window?.webContents.reloadIgnoringCache()

// The daemon has no hot reload, so every redeploy briefly drops the server and
// rebuilds the dashboard under fresh asset hashes. This window is preloaded once
// and then lives for days, so without help it strands itself on a now-dead page
// (the blank-window bug) or a stale bundle. Soft-reload whenever it's hidden so
// the next open reflects the currently-deployed dashboard. Doing it on hide (not
// show) means no visible flash and no race with openCard's hash navigation, and a
// plain reload() revalidates via ETag — an unchanged dashboard costs only 304s.
mb.on('after-hide', () => {
  const wc = mb.window?.webContents
  if (wc && !wc.isDestroyed() && !wc.isLoadingMainFrame()) wc.reload()
})

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

// The right-click menu doubles as a status panel: a live header line, then per-stage
// counts when pending, then the action rows.
function buildMenuTemplate() {
  const { statusLine } = trayView({ connState, vm: latestVM })
  const items = [{ label: statusLine, enabled: false }]
  if (connState === 'connected' && latestVM && latestVM.total > 0) {
    const byStage = latestVM.byStage || {}
    for (const stage of orderedStages(byStage)) {
      const n = byStage[stage]
      if (n > 0) items.push({ label: `   ${n} · ${STAGE_LABEL[stage] ?? stage}`, enabled: false })
    }
  }
  items.push(
    { type: 'separator' },
    { label: 'Open boardroom', click: () => mb.showWindow() },
    { label: 'Reload', accelerator: 'Cmd+R', click: reload },
    { label: 'Open in browser', click: () => void shell.openExternal(`${BASE}/`) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  )
  return items
}

// Everything a WINDOW (not the app) needs wired: menubar can destroy and recreate
// the BrowserWindow (e.g. after a close), and a recreated window that misses these
// loses the navigation guard, the blank-window retry, and Cmd+R — so this runs for
// the preloaded window at 'ready' AND for every later recreation.
function wireWindow(contents) {
  if (!contents) return

  guardNavigation(contents)

  // If a load fails outright — almost always the daemon being down mid-restart —
  // retry shortly instead of leaving the window blank forever. KeepAlive revives
  // the daemon within seconds, so a bounded retry recovers on its own.
  contents.on('did-fail-load', (_e, errorCode, _desc, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return // -3 = ERR_ABORTED (a superseded navigation)
    setTimeout(() => {
      const wc = mb.window?.webContents
      if (wc && !wc.isDestroyed()) wc.reload()
    }, 1500)
  })

  // Cmd/Ctrl+R reloads the embedded dashboard (a frameless window has no menu
  // bar, so wire it by hand) — the escape hatch for a stale cached bundle.
  contents.on('before-input-event', (_e, input) => {
    if ((input.meta || input.control) && input.key.toLowerCase() === 'r') reload()
  })
}

mb.on('ready', () => {
  mb.tray.setTitle('')
  void connectTray()

  wireWindow(mb.window?.webContents)

  mb.tray.on('right-click', () => {
    mb.tray.popUpContextMenu(Menu.buildFromTemplate(buildMenuTemplate()))
  })
})

// menubar re-creates the BrowserWindow if the old one was closed/destroyed; the
// fresh window must get the same per-window wiring or it runs unguarded.
mb.on('after-create-window', () => {
  wireWindow(mb.window?.webContents)
})

// A menu-bar utility shouldn't keep a Dock icon or quit-on-close semantics.
app.dock?.hide()
