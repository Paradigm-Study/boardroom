import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'web/src/**/*.test.ts', 'web/src/**/*.test.tsx', 'tests/**/*.test.ts'],
    testTimeout: 15000,
    // Rendered dates must not depend on the machine's timezone: the CardView golden
    // snapshots embed Intl.DateTimeFormat output, and CI (ubuntu, UTC) has to see the
    // same bytes a laptop in any timezone records.
    env: { TZ: 'UTC' },
  },
})
