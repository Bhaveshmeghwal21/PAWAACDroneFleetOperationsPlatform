import { defineConfig } from 'vitest/config';

/**
 * Unit-test runner for the shared-types package. Tests exercise the runtime
 * constant sets (canonical enum tuples) and their type-guards directly against
 * the TypeScript sources under ./src.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
  },
});
