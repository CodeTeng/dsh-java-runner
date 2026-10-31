import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Integration cases spawn javac, java, and the JUnit console; 5s is too
    // tight once the whole suite runs on a shared or busy host.
    testTimeout: 30_000,
  },
})
