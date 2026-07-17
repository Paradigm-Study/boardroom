import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The daemon the dev server proxies API/SSE traffic to. Overridable so the e2e
// suite can point it at a dead port and stay hermetic — without this, a developer's
// live daemon on :4040 leaks real cards/notifications into test runs.
const daemon = process.env.BOARDROOM_PROXY_TARGET ?? 'http://127.0.0.1:4040'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': daemon,
      '/events': daemon,
    },
  },
})
