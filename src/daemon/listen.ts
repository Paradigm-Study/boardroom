import type { Server } from 'node:http'

// Attach a fatal-error handler to a listening server. Without one, a bind error
// (EADDRINUSE — a stray `npm run dev` or a double-loaded LaunchAgent on :4040) is
// swallowed on macOS/express and surfaces as a throw on Linux/raw-net: either way
// the daemon silently isn't serving. Make it loud and exit cleanly so KeepAlive
// retries from a known state. `onFatal` is injected so tests can observe without
// killing the process.
export function guardListen(
  server: Server,
  port: number,
  onFatal: (message: string) => void = fatal,
): Server {
  server.on('error', (err: NodeJS.ErrnoException) => {
    onFatal(`boardroom daemon failed to bind 127.0.0.1:${port}: ${err.code ?? err.message}`)
  })
  return server
}

function fatal(message: string): never {
  console.error(message)
  process.exit(1)
}
