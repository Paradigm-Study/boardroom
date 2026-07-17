import { createDaemon } from './app.js'
import { loadConfig } from './config.js'
import { guardListen } from './listen.js'
import { startMenubar } from './menubar.js'
import { startAutoOpen, startNotifications } from './notify.js'
import { installSignalHandlers } from './shutdown.js'

process.umask(0o077)
const config = loadConfig()
const { app, queue, store, capturer, orphanedOnBoot, meshForwarder } = createDaemon(config)

const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`boardroom daemon on http://127.0.0.1:${config.port}`)
  console.log(`  MCP endpoint: http://127.0.0.1:${config.port}/mcp`)
  if (orphanedOnBoot > 0) console.log(`  recovered ${orphanedOnBoot} pending card(s) as orphaned`)
})
guardListen(server, config.port)

// Mesh forwarding (mesh-v0, default-off): only attaches when config.json "mesh"
// {url,token,person} or BOARDROOM_MESH_URL/TOKEN/PERSON env is present. With no
// mesh config, createMeshForwarder returns undefined and nothing subscribes —
// the daemon behaves byte-identically to before. Created BEFORE the signal
// handlers so the drain can stop it and flush its in-flight relay POSTs.
if (meshForwarder) console.log(`  mesh forwarding live for "${meshForwarder.mesh.person}" → ${meshForwarder.mesh.url}`)

// Bind the daemon to clean process signals: a redeploy SIGTERMs us (launchctl
// kickstart) and KeepAlive respawns. Drain the server + close the store cleanly so
// the restart is deterministic, and guard against an uncaught throw crashing the
// process mid-decision. This cannot save an in-flight hanging call (the waiter dies
// with the process) — the agent recovers the human's REAL decision by re-issuing
// the identical call (findReattachable revives the orphaned card). Never inferred.
// The capturer is stopped first in the drain so its watcher can't write post-close.
// quiesce first PARKS every live gate (parkAllLive resolves its hanging call with a
// STOP sentinel — a clean sever the agent understands, not a raw dropped socket),
// then orphans any remaining still-pending gate as 'boot'. Both leave the card
// "reconnecting" (never 'disconnect'), so a redeploy-during-a-gate is reattachable.
// The mesh forwarder rides along so shutdown can stop + flush its outbox.
installSignalHandlers({
  server, store, capturer,
  quiesce: () => { queue.parkAllLive(); store.orphanAllPending() },
  meshForwarder,
})

startNotifications(queue, config)
startAutoOpen(queue, config)

// Bind the menu-bar app's life to the daemon's: ensure the tray app is up on every
// (re)start so one reboot revives both. Default-on; set BOARDROOM_NO_MENUBAR for
// local `npm run dev` so it doesn't pop the tray.
startMenubar()
