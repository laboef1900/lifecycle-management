import { expect, test } from '@playwright/test';

const API_BASE = 'http://localhost:8090';

/**
 * E2E for configurable warn/crit thresholds.
 *
 * Walks the full settings flow:
 *   1. Tenant defaults — save new values on /settings, verify the fleet
 *      capacity chart shows the new percent labels.
 *   2. Cluster override — open the Settings tab on cluster detail, save an
 *      override, verify the cluster's forecast chart picks up the new
 *      percentages, then reset back to inherited.
 *
 * `afterEach` resets tenant defaults to 70/90 so subsequent runs are
 * deterministic, even if a test bails mid-flow.
 */
test.describe('configurable thresholds', () => {
  test.afterEach(async ({ request }) => {
    await request.put(`${API_BASE}/api/settings/tenant`, {
      data: { warnThreshold: 0.7, critThreshold: 0.9 },
    });
  });

  test('saves tenant thresholds and chart labels reflect new values', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();

    const warn = page.getByLabel('Warn %');
    const crit = page.getByLabel('Crit %');
    await expect(warn).toHaveValue('70');
    await expect(crit).toHaveValue('90');

    await warn.fill('65');
    await crit.fill('85');

    // Submit and wait for the PUT to land before navigating away — otherwise
    // we can race the fleet chart's cached thresholds.
    const putPromise = page.waitForResponse(
      (r) => r.url().endsWith('/api/settings/tenant') && r.request().method() === 'PUT',
    );
    await page.getByRole('button', { name: /^save$/i }).click();
    const putResp = await putPromise;
    expect(putResp.ok()).toBe(true);
    await expect(page.getByText(/source: saved tenant settings/i)).toBeVisible();

    // Navigate to overview where the fleet capacity chart renders the
    // updated Warn / Crit reference-line labels.
    await page.goto('/');
    await expect(page.getByText('Warn 65%').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Crit 85%').first()).toBeVisible();
  });

  test('cluster override flips chart labels and source pill', async ({ page, request }) => {
    // Pick the first existing cluster (relies on seeded data).
    const clustersRes = await request.get(`${API_BASE}/api/clusters`);
    const clusters = (await clustersRes.json()) as Array<{ id: string }>;
    test.skip(clusters.length === 0, 'requires seeded clusters');
    const clusterId = clusters[0]!.id;

    // Make sure the cluster starts on default thresholds (some prior run
    // might have left an override behind). Best-effort — the DELETE
    // endpoint returns the (now-reset) settings even when no override
    // existed.
    await request.delete(`${API_BASE}/api/clusters/${clusterId}/settings`);

    await page.goto(`/clusters/${clusterId}`);
    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.getByText(/inherited from tenant defaults/i)).toBeVisible();

    await page.getByLabel('Warn %').fill('60');
    await page.getByLabel('Crit %').fill('85');

    const savePromise = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/clusters/${clusterId}/settings`) && r.request().method() === 'PUT',
    );
    await page.getByRole('button', { name: /save override/i }).click();
    const saveResp = await savePromise;
    expect(saveResp.ok()).toBe(true);
    await expect(page.getByText(/cluster override/i)).toBeVisible();

    // The cluster forecast query is cached with a 5-minute stale time and
    // the save mutation only patches `cluster-settings` — the forecast won't
    // refetch on its own. Reload to force a fresh fetch so the chart picks
    // up the new effectiveThresholds.
    await page.reload();
    await expect(page.getByText('Warn 60%').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Crit 85%').first()).toBeVisible();

    // Reset back to inherited.
    await page.getByRole('tab', { name: 'Settings' }).click();
    const resetPromise = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/clusters/${clusterId}/settings`) &&
        r.request().method() === 'DELETE',
    );
    await page.getByRole('button', { name: /reset to inherited/i }).click();
    const resetResp = await resetPromise;
    expect(resetResp.ok()).toBe(true);
    await expect(page.getByText(/inherited from tenant defaults/i)).toBeVisible();
  });
});
