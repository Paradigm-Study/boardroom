import { createDaemon } from './app.js'
import { loadConfig } from './config.js'
import { guardListen } from './listen.js'
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
