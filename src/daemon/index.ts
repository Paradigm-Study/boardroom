import { createDaemon } from './app.js'
import { loadConfig } from './config.js'
import { guardListen } from './listen.js'
import { startMenubar } from './menubar.js'
import { startAutoOpen, startNotifications } from './notify.js'

process.umask(0o077)
const config = loadConfig()
const { app, queue, orphanedOnBoot } = createDaemon(config)

const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`boardroom daemon on http://127.0.0.1:${config.port}`)
  console.log(`  MCP endpoint: http://127.0.0.1:${config.port}/mcp`)
  if (orphanedOnBoot > 0) console.log(`  recovered ${orphanedOnBoot} pending card(s) as orphaned`)
})
guardListen(server, config.port)

startNotifications(queue, config)
startAutoOpen(queue, config)

// Bind the menu-bar app's life to the daemon's: ensure the tray app is up on every
// (re)start so one reboot revives both. Default-on; set BOARDROOM_NO_MENUBAR for
// local `npm run dev` so it doesn't pop the tray.
startMenubar()
