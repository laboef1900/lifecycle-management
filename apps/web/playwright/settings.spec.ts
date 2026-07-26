import { expect, test } from '@playwright/test';

const API_BASE = 'http://localhost:8090';

/**
 * E2E for configurable warn/crit thresholds.
 *
 * Walks the full settings flow:
 *   1. Tenant defaults — save new values on /settings, verify the fleet
 *      console's cluster tile charts expose the new thresholds via their
 *      accessible name.
 *   2. Cluster override — open the Settings tab on the cluster detail panel
 *      (`/clusters/:id`), save an override, verify the cluster's forecast
 *      chart picks up the new percentages, then reset back to inherited.
 *
 * State handling is snapshot/restore, NOT "reset to the seeded 70/90":
 *
 * `tenantSettingsSchema` is a `strictObject` with no partial-update support, so
 * a PUT must carry every field the contract currently has. The previous version
 * of this block hand-listed them, and #316 then added three
 * `forecastUncertainty*` fields — which the list never gained. Every reset PUT
 * had been 400ing silently ever since, so 65/85 leaked into the database and the
 * `toHaveValue('70')` precondition below failed on every subsequent run. One
 * stale payload, two permanently-red tests, and a self-poisoning suite: an
 * interrupted run left state that guaranteed the next one failed too.
 *
 * Round-tripping the whole object fixes that by construction — the payload is
 * whatever the contract currently is, and the GET response carries exactly the
 * writable shape (`tenantSettingsResponseSchema` mirrors `tenantSettingsSchema`).
 * If those two ever diverge, the `strictObject` rejects the extra key loudly
 * instead of leaking again. `beforeEach` then imposes the precondition rather
 * than *asserting* a global seed value, so the suite heals itself after a run
 * that was killed mid-flow.
 */
interface TenantSettingsSnapshot {
  warnThreshold: number;
  critThreshold: number;
  [key: string]: unknown;
}

test.describe('configurable thresholds', () => {
  let saved: TenantSettingsSnapshot;

  test.beforeEach(async ({ request }) => {
    const current = await request.get(`${API_BASE}/api/settings/tenant`);
    expect(current.ok()).toBe(true);
    saved = (await current.json()) as TenantSettingsSnapshot;

    const seed = await request.put(`${API_BASE}/api/settings/tenant`, {
      data: { ...saved, warnThreshold: 0.7, critThreshold: 0.9 },
    });
    expect(seed.ok()).toBe(true);
  });

  test.afterEach(async ({ request }) => {
    // Restores exactly what was there, including any field this spec has never
    // heard of — the whole point of snapshotting rather than hand-listing.
    const restore = await request.put(`${API_BASE}/api/settings/tenant`, { data: saved });
    expect(restore.ok()).toBe(true);
  });

  test('saves tenant thresholds and fleet tiles reflect new values', async ({ page }) => {
    // #293: thresholds live on the Forecasting sub-route now (bare
    // `/settings` still redirects there, but this is the direct target).
    await page.goto('/settings/forecasting');
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();

    const warn = page.getByLabel('Warn %');
    const crit = page.getByLabel('Crit %');
    await expect(warn).toHaveValue('70');
    await expect(crit).toHaveValue('90');

    await warn.fill('65');
    await crit.fill('85');

    // Submit and wait for the PUT to land before navigating away — otherwise
    // we can race the fleet console's cached thresholds. Scoped to the
    // ForecastThresholdsForm's own <form> for robustness — Categories' own
    // submit on this same Forecasting sub-route is labelled "Add", not
    // "Save", but the Access sub-route's Authentication panel (identically
    // labelled "Save" pre-#293, when all three sections shared one page) no
    // longer renders here at all, having moved to its own route.
    const thresholdsForm = page.locator('form').filter({ has: warn });
    const putPromise = page.waitForResponse(
      (r) => r.url().endsWith('/api/settings/tenant') && r.request().method() === 'PUT',
    );
    await thresholdsForm.getByRole('button', { name: /^save$/i }).click();
    const putResp = await putPromise;
    expect(putResp.ok()).toBe(true);
    // #243 Part B: "Saved tenant settings" dropped the data-model word "tenant".
    await expect(page.getByText(/source: saved settings/i)).toBeVisible();

    // Navigate to the fleet console: each cluster tile's compact forecast
    // chart draws the thresholds as label-less ReferenceLines, so propagation
    // is asserted via the chart's accessible name, which carries the
    // effective warn/crit values (spec §4.4's ClusterTileChart).
    await page.goto('/');
    await expect(
      page
        .getByRole('img', { name: /warn threshold 65 percent.*critical threshold 85 percent/i })
        .first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('cluster override flips chart labels and source pill', async ({ page, request }) => {
    // Pick the first existing cluster (relies on seeded data).
    const clustersRes = await request.get(`${API_BASE}/api/clusters`);
    const { items: clusters } = (await clustersRes.json()) as { items: Array<{ id: string }> };
    test.skip(clusters.length === 0, 'requires seeded clusters');
    const clusterId = clusters[0]!.id;

    // Make sure the cluster starts on default thresholds (some prior run
    // might have left an override behind). Best-effort — the DELETE
    // endpoint returns the (now-reset) settings even when no override
    // existed.
    await request.delete(`${API_BASE}/api/clusters/${clusterId}/settings`);

    await page.goto(`/clusters/${clusterId}`);
    const panel = page.locator('.cluster-panel');
    await panel.getByRole('tab', { name: 'Cluster settings' }).click();
    await expect(page.getByText(/inherited from global defaults/i)).toBeVisible();

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
    // refetch on its own. Reload to force a fresh fetch so the panel's chart
    // picks up the new effectiveThresholds.
    await page.reload();
    await expect(page.getByText('Warn 60%').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Crit 85%').first()).toBeVisible();

    // Reset back to inherited.
    await page.locator('.cluster-panel').getByRole('tab', { name: 'Cluster settings' }).click();
    const resetPromise = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/clusters/${clusterId}/settings`) &&
        r.request().method() === 'DELETE',
    );
    await page.getByRole('button', { name: /reset to inherited/i }).click();
    const resetResp = await resetPromise;
    expect(resetResp.ok()).toBe(true);
    await expect(page.getByText(/inherited from global defaults/i)).toBeVisible();
  });
});

test.describe('cluster identity + baseline edit', () => {
  test('renames cluster — panel header updates immediately', async ({ page, request }) => {
    const clustersRes = await request.get('/api/clusters');
    const { items: clusters } = (await clustersRes.json()) as {
      items: Array<{ id: string; name: string }>;
    };
    test.skip(clusters.length === 0, 'requires seeded clusters');
    const cluster = clusters[0]!;
    const originalName = cluster.name;
    const newName = `${originalName}-renamed`;

    try {
      await page.goto(`/clusters/${cluster.id}`);
      const panel = page.locator('.cluster-panel');
      // The panel header name is the h1 since #243 (the console's verdict h1
      // beneath is inert-hidden while the panel is up).
      await expect(panel.getByRole('heading', { name: originalName, level: 1 })).toBeVisible();

      await panel.getByRole('tab', { name: 'Cluster settings' }).click();

      const nameInput = page.getByLabel('Name');
      await expect(nameInput).toHaveValue(originalName);
      await nameInput.fill(newName);

      const expectedPath = `/api/clusters/${cluster.id}`;
      const putResponse = page.waitForResponse(
        (r) => new URL(r.url()).pathname === expectedPath && r.request().method() === 'PUT',
      );
      // The "Cluster identity" heading lives in the Card's <header>, outside the
      // <form>, so we can't filter by form text. The only button whose accessible
      // name is exactly "Save" (no "override" / "baseline" suffix) is this form's
      // submit, so an unscoped role lookup is unambiguous here.
      await page.getByRole('button', { name: /^save$/i }).click();
      await putResponse;

      await expect(panel.getByRole('heading', { name: newName, level: 1 })).toBeVisible();
    } finally {
      // Restore the cluster name so subsequent runs are deterministic.
      await request.put(`/api/clusters/${cluster.id}`, { data: { name: originalName } });
    }
  });

  test('confirm dialog gates baseline edits', async ({ page, request }) => {
    const clustersRes = await request.get('/api/clusters');
    const { items: clusters } = (await clustersRes.json()) as {
      items: Array<{
        id: string;
        metrics: Array<{
          metricTypeKey: string;
          baselineConsumption: number;
          baselineCapacity: number;
        }>;
      }>;
    };
    test.skip(clusters.length === 0, 'requires seeded clusters');
    const cluster = clusters[0]!;
    const memory = cluster.metrics.find((m) => m.metricTypeKey === 'memory_gb');
    test.skip(!memory, 'requires memory_gb metric');
    const originalConsumption = memory!.baselineConsumption;
    const newConsumption = originalConsumption + 100;

    try {
      await page.goto(`/clusters/${cluster.id}`);
      await page.locator('.cluster-panel').getByRole('tab', { name: 'Cluster settings' }).click();

      const consumptionInput = page.getByLabel(/memory.*baseline consumption/i);
      await consumptionInput.fill(String(newConsumption));
      // The trigger carries the confirm's words plus the ellipsis that
      // advertises the extra step, so locators are the ellipsis (trigger) or the
      // dialog scope (confirm) — bare /rewrite baseline/i now matches both.
      const submitTrigger = page.getByRole('button', { name: /rewrite baseline…/i });
      const confirmButton = page
        .getByRole('dialog')
        .getByRole('button', { name: 'Rewrite baseline' });
      await submitTrigger.click();

      await expect(page.getByRole('dialog', { name: /rewrite baseline/i })).toBeVisible();

      // Cancel first — verify no PUT goes out.
      await page.getByRole('button', { name: /cancel/i }).click();
      await expect(page.getByRole('dialog', { name: /rewrite baseline/i })).not.toBeVisible();

      // Now confirm.
      await submitTrigger.click();
      await expect(page.getByRole('dialog', { name: /rewrite baseline/i })).toBeVisible();

      const expectedPath = `/api/clusters/${cluster.id}`;
      const putResponse = page.waitForResponse(
        (r) => new URL(r.url()).pathname === expectedPath && r.request().method() === 'PUT',
      );
      await confirmButton.click();
      await putResponse;

      // Dialog closes.
      await expect(page.getByRole('dialog', { name: /rewrite baseline/i })).not.toBeVisible();

      // Verify server now reports the new value.
      const updated = await request.get(`/api/clusters/${cluster.id}`);
      const updatedBody = (await updated.json()) as {
        metrics: Array<{ metricTypeKey: string; baselineConsumption: number }>;
      };
      const updatedMemory = updatedBody.metrics.find((m) => m.metricTypeKey === 'memory_gb');
      expect(updatedMemory?.baselineConsumption).toBeCloseTo(newConsumption);
    } finally {
      // Restore the original baselines so subsequent runs are deterministic.
      await request.put(`/api/clusters/${cluster.id}`, {
        data: {
          baselines: cluster.metrics.map((m) => ({
            metricTypeKey: m.metricTypeKey,
            baselineConsumption: m.baselineConsumption,
            baselineCapacity: m.baselineCapacity,
          })),
        },
      });
    }
  });
});

test.describe('cluster lifecycle', () => {
  test('archive then unarchive a cluster', async ({ page, request }) => {
    // Create a throwaway cluster so we don't mess with seeded data.
    const suffix = Date.now().toString(36);
    const name = `CL-LIFECYCLE-${suffix}`;
    const createRes = await request.post('/api/clusters', {
      data: {
        name,
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
        ],
      },
    });
    const { id } = (await createRes.json()) as { id: string };

    try {
      // Archive via UI (the panel's Settings tab).
      await page.goto(`/clusters/${id}`);
      const panel = page.locator('.cluster-panel');
      await panel.getByRole('tab', { name: 'Cluster settings' }).click();
      await page.getByRole('button', { name: /^archive$/i }).click();
      const archiveResponse = page.waitForResponse(
        (r) => r.url().endsWith(`/api/clusters/${id}/archive`) && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: /^archive cluster$/i }).click();
      await archiveResponse;

      // Panel header now shows the Archived badge.
      await expect(page.getByText(/^Archived \d{4}-\d{2}-\d{2}$/)).toBeVisible();

      // Cluster is hidden from the fleet console by default.
      await page.goto('/');
      await expect(page.getByRole('link', { name: new RegExp(name) })).toHaveCount(0);

      // The archived toggle lives in the Filter popover (#243): open it and
      // check the "Show archived (N)" item to reveal the cluster's tile.
      await page.getByTestId('fleet-filter-button').click();
      await page.getByRole('checkbox', { name: /show archived/i }).check();
      // The issue #243 verification list: the toggle announces the resulting
      // mixed view in words on the console's polite status region.
      await expect(page.getByTestId('fleet-filter-announcement')).toHaveText(
        /including \d+ archived/,
      );
      await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible();

      // Unarchive via UI.
      await page.goto(`/clusters/${id}`);
      await panel.getByRole('tab', { name: 'Cluster settings' }).click();
      await page.getByRole('button', { name: /^unarchive$/i }).click();
      const unarchiveResponse = page.waitForResponse(
        (r) => r.url().endsWith(`/api/clusters/${id}/unarchive`) && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: /^unarchive cluster$/i }).click();
      await unarchiveResponse;

      // Cluster reappears in the default fleet console (toggle resets on
      // navigation — showArchived is local component state).
      await page.goto('/');
      await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible();
    } finally {
      // Clean up the throwaway cluster.
      await request.delete(`/api/clusters/${id}`);
    }
  });

  test('delete permanently removes the cluster', async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const name = `CL-DELETE-${suffix}`;
    const createRes = await request.post('/api/clusters', {
      data: {
        name,
        baselineDate: '2026-05-01',
        baselines: [
          { metricTypeKey: 'memory_gb', baselineConsumption: 100, baselineCapacity: 1000 },
        ],
      },
    });
    const { id } = (await createRes.json()) as { id: string };

    await page.goto(`/clusters/${id}`);
    const panel = page.locator('.cluster-panel');
    await panel.getByRole('tab', { name: 'Cluster settings' }).click();
    await page.getByRole('button', { name: /^delete$/i }).click();

    // `ClusterLifecycleCard` passes `confirmPhrase={clusterName}`, so the
    // confirm button stays disabled until the cluster's own name is typed —
    // friction proportional to an irreversible, whole-cluster delete. This spec
    // predates that gate and clicked straight through, which is why it failed
    // with "element is not enabled" rather than anything about deletion.
    const confirm = page.getByRole('button', { name: /delete forever/i });
    await expect(confirm).toBeDisabled();
    await page.getByLabel(`Type ${name} to confirm`).fill(name);
    await expect(confirm).toBeEnabled();

    const deleteResponse = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === `/api/clusters/${id}` && r.request().method() === 'DELETE',
    );
    await confirm.click();
    await deleteResponse;

    // The lifecycle card now navigates to `/` (spec §5.6), not `/clusters`.
    await expect(page).toHaveURL('/');

    // Cluster gone from default and showArchived lists (#243: the archived
    // toggle is a checkbox inside the Filter popover).
    await expect(page.getByRole('link', { name: new RegExp(name) })).toHaveCount(0);
    await page.getByTestId('fleet-filter-button').click();
    await page.getByRole('checkbox', { name: /show archived/i }).check();
    await expect(page.getByRole('link', { name: new RegExp(name) })).toHaveCount(0);

    // API confirms 404.
    const getRes = await request.get(`/api/clusters/${id}`);
    expect(getRes.status()).toBe(404);
  });
});
