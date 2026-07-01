import { test, expect } from '@playwright/test';

/**
 * Placeholder smoke spec to validate the Playwright wiring (config, test
 * discovery, runner). It deliberately avoids the browser/page fixture and a
 * running server so it can execute in any environment.
 *
 * The real end-to-end journeys — login, create mission, view telemetry, and
 * acknowledge an alert against the seeded Docker Compose environment — are
 * authored in task 15.7.
 */
test('playwright harness is configured', () => {
  expect(1 + 1).toBe(2);
});
