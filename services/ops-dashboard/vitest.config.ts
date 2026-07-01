import { defineConfig } from 'vitest/config';

/**
 * Unit-test runner for non-UI modules (typed API client, config, WS helpers).
 * Playwright E2E specs live under ./e2e and are intentionally excluded here.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', '.next', 'e2e'],
    environment: 'node',
  },
});
