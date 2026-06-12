import { createDaemon } from './app.js'
import { loadConfig } from './config.js'
import { startNotifications } from './notify.js'

const config = loadConfig()
const { app, queue, orphanedOnBoot } = createDaemon(config)

app.listen(config.port, '127.0.0.1', () => {
  console.log(`boardroom daemon on http://127.0.0.1:${config.port}`)
  console.log(`  MCP endpoint: http://127.0.0.1:${config.port}/mcp`)
  if (orphanedOnBoot > 0) console.log(`  recovered ${orphanedOnBoot} pending card(s) as orphaned`)
})

startNotifications(queue, config)
