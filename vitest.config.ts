import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'web/src/**/*.test.ts', 'web/src/**/*.test.tsx', 'tests/**/*.test.ts'],
    testTimeout: 15000,
  },
})
