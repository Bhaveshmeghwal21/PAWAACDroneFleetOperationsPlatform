import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for the Ops Dashboard.
 *
 * Two kinds of specs live under ./e2e:
 *   - smoke.spec.ts          — a browserless sanity check of the harness that
 *                              runs in any environment.
 *   - operator-journeys.spec — the full end-to-end flows (login, create mission,
 *                              view telemetry, acknowledge alert) authored in
 *                              task 15.7. They run against a seeded Docker
 *                              Compose stack and are opt-in: the suite enables
 *                              itself only when PLAYWRIGHT_BASE_URL is set, and
 *                              otherwise skips at collection time so no browser
 *                              is launched.
 *
 * `baseURL` defaults to the local container port (3006) and is overridden via
 * PLAYWRIGHT_BASE_URL to point at the seeded environment.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3006',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
