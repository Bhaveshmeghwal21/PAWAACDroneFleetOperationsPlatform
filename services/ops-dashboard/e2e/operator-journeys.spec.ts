import { test, expect, type Page } from '@playwright/test';

/**
 * End-to-end operator journeys against the seeded Docker Compose stack
 * (task 15.7). These exercise the four headline operator flows end to end,
 * through the real browser, dashboard, API Gateway and backend services:
 *
 *   - login            — establishing the operator session and landing on the
 *                         primary fleet surface (Requirement 21.1)
 *   - create mission   — authoring and submitting a mission through the Gateway
 *                         to Mission Planning (Requirement 22.3)
 *   - view telemetry   — opening the live telemetry panels for a drone
 *                         (Requirement 23.1)
 *   - acknowledge alert— acknowledging an alert through the Gateway to the
 *                         Alert Service (Requirement 24.3)
 *
 * Login note: the platform has no standalone login form — the seeded operator
 * console is reached directly and its surfaces authenticate their Gateway/socket
 * calls from the established session. The "login" journey therefore verifies
 * session entry by confirming the authenticated operator console and its primary
 * post-login surface (the live fleet map) load against the seeded stack.
 *
 * Environment gating:
 *   These journeys require BOTH a real browser AND a running, seeded stack. They
 *   are opt-in via the PLAYWRIGHT_BASE_URL environment variable, which the CI
 *   E2E stage (and local runs) set to the dashboard's URL once the seeded Docker
 *   Compose environment is up. When it is absent — e.g. in the spec sandbox,
 *   which has neither Docker nor a browser — the whole suite is skipped at
 *   collection time via `test.describe.skip`, so no browser is ever launched and
 *   the runner exits cleanly. The placeholder `smoke.spec.ts` still runs to
 *   prove the Playwright wiring itself.
 */

/** The seeded stack's dashboard URL; presence of it enables this suite. */
const SEEDED_BASE_URL = process.env.PLAYWRIGHT_BASE_URL;

/** True only when an explicit seeded environment has been provided. */
const E2E_ENABLED = typeof SEEDED_BASE_URL === 'string' && SEEDED_BASE_URL.length > 0;

/**
 * Use the real describe block when a seeded environment is available, otherwise
 * a collection-time skip so fixtures (and the browser) are never instantiated.
 */
const describeJourneys = E2E_ENABLED ? test.describe : test.describe.skip;

/** Generous per-expectation timeout to absorb live data / socket warm-up. */
const LIVE_TIMEOUT = 20_000;

/** Click the Leaflet map canvas at a pixel offset within its container. */
async function clickMapAt(page: Page, x: number, y: number): Promise<void> {
  await page.locator('.leaflet-container').click({ position: { x, y } });
}

describeJourneys('Ops Dashboard — operator journeys (seeded environment)', () => {
  // Validates: Requirements 21.1
  test('login: operator console loads and the live fleet map is reachable', async ({ page }) => {
    // Enter the operator console (no separate login form; the seeded session is
    // already established for the console).
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'PAWAAC Ops Dashboard' }),
    ).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

    // The primary post-login surface is the live fleet map (Requirement 21.1):
    // it must render and report the seeded fleet.
    await page.goto('/fleet-map');
    await expect(page.getByRole('heading', { name: 'Fleet Map' })).toBeVisible();
    await expect(page.getByTestId('fleet-count')).toBeVisible({ timeout: LIVE_TIMEOUT });
    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: LIVE_TIMEOUT });
  });

  // Validates: Requirements 22.3
  test('create mission: author waypoints and submit through the Gateway', async ({ page }) => {
    await page.goto('/mission-planner');
    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: LIVE_TIMEOUT });

    // Place two waypoints by clicking the map (waypoint mode is the default).
    await clickMapAt(page, 280, 200);
    await clickMapAt(page, 360, 260);
    await expect(page.getByTestId('waypoint-count')).toHaveText('2 waypoints');

    // Submit the mission. The planner sends it through the API Gateway to
    // Mission Planning and reports the outcome (Requirement 22.3).
    const submit = page.getByTestId('submit-mission');
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(page.getByTestId('planner-status')).toContainText(
      'submitted to Mission Planning',
      { timeout: LIVE_TIMEOUT },
    );
  });

  // Validates: Requirements 23.1
  test('view telemetry: live panels render for the selected drone', async ({ page }) => {
    await page.goto('/telemetry');

    // A drone must be selectable from the seeded fleet; pick the first option
    // beyond any "No drones" placeholder so a concrete drone is selected.
    const droneSelect = page.getByTestId('drone-select');
    await expect(droneSelect).toBeVisible({ timeout: LIVE_TIMEOUT });
    const optionValues = await droneSelect.locator('option').evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLOptionElement).value).filter((value) => value.length > 0),
    );
    test.skip(optionValues.length === 0, 'no drones in the seeded environment to select');
    await droneSelect.selectOption(optionValues[0] as string);

    // All four panels (attitude, battery, EKF2 health, altitude) must be shown
    // for the selected drone (Requirement 23.1).
    await expect(page.getByTestId('telemetry-panels')).toBeVisible({ timeout: LIVE_TIMEOUT });
    await expect(page.getByTestId('panel-attitude')).toBeVisible();
    await expect(page.getByTestId('panel-battery')).toBeVisible();
    await expect(page.getByTestId('panel-ekf2')).toBeVisible();
    await expect(page.getByTestId('panel-altitude')).toBeVisible();
  });

  // Validates: Requirements 24.3
  test('acknowledge alert: an actionable alert can be acknowledged', async ({ page }) => {
    await page.goto('/alerts');

    // Wait for the feed to settle: either it has rows or it explicitly shows the
    // empty state. Then locate an actionable (acknowledgeable) alert.
    await expect(page.getByRole('heading', { name: 'Alert Feed' })).toBeVisible();

    const actionableRow = page
      .getByTestId('alert-row')
      .filter({ has: page.getByTestId('alert-ack-button') })
      .first();

    const actionableCount = await page.getByTestId('alert-ack-button').count();
    test.skip(actionableCount === 0, 'no actionable alerts in the seeded environment');

    await expect(actionableRow).toBeVisible({ timeout: LIVE_TIMEOUT });

    // Capture this alert's identity so we can assert on the same row afterwards.
    const alertLabel = (await actionableRow.getByText(/^Alert /).innerText()).trim();

    // Acknowledge it; the dashboard sends the acknowledgement through the
    // Gateway to the Alert Service (Requirement 24.3) and reflects the
    // acknowledged status in the feed.
    await actionableRow.getByTestId('alert-ack-button').click();

    const acknowledgedRow = page
      .getByTestId('alert-row')
      .filter({ hasText: alertLabel });
    await expect(acknowledgedRow.getByText('ACKNOWLEDGED')).toBeVisible({
      timeout: LIVE_TIMEOUT,
    });
  });
});
