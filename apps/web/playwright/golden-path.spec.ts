import { expect, test } from '@playwright/test';

const API_BASE = 'http://localhost:8090';

const suffix = (): string =>
  `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * Walks the v1 golden path on the fleet console (spec §2/§4/§5): create
 * cluster → its tile appears in the grid → open the detail slide-in panel →
 * add host → add application, observing that the panel's KPI strip, tabs, and
 * forecast chart pick up each change.
 *
 * The test cleans up its own cluster via the API at the end so the dev DB
 * stays tidy for subsequent runs.
 */
test('create cluster, add host + application, chart reflects updates', async ({
  page,
  request,
}) => {
  const clusterName = `CL-E2E-${suffix()}`;
  let clusterId: string | null = null;

  try {
    await page.addInitScript(() => {
      try {
        localStorage.removeItem('theme');
      } catch {
        // localStorage may be unavailable in some contexts; ignore.
      }
    });

    await page.goto('/');

    // The fleet console always has exactly one h1 — the verdict headline on
    // the happy path, or an sr-only fallback while loading/empty/errored.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      /^(Fleet runway is|Fleet is healthy|Fleet capacity console)/,
    );

    // Adding a cluster is now a configuration task on the Settings page
    // (#223) — the console no longer has a "+ Add cluster" control. Create it
    // from the Settings "Add cluster" panel, then return to the console.
    await page.goto('/settings');
    await page.getByRole('button', { name: '+ Add cluster' }).click();
    const createDialog = page.getByRole('dialog', { name: 'New cluster' });
    await createDialog.getByRole('textbox', { name: 'Name' }).fill(clusterName);
    await createDialog.getByRole('spinbutton', { name: 'Consumption (GB)' }).fill('1000');
    await createDialog.getByRole('spinbutton', { name: 'Capacity (GB)' }).fill('5000');
    await createDialog.getByRole('button', { name: 'Create cluster' }).click();
    await expect(createDialog).toBeHidden();

    await page.goto('/');

    // The cluster's uniform tile appears in the grid, linking to its detail
    // panel, showing the right utilization (1000/5000 = 20.0%, spec §4.4).
    const tile = page.getByRole('link', { name: clusterName });
    await expect(tile).toBeVisible();
    await expect(tile).toContainText('20.0%');

    // Open the detail slide-in panel via the tile link.
    await tile.click();
    await expect(page).toHaveURL(/\/clusters\/[^/]+$/);

    // The panel is a role=dialog overlay (spec §5) — scope subsequent
    // lookups to its `.cluster-panel` class so a nested host/item dialog
    // (also role=dialog, portalled to document.body) never collides.
    const panel = page.locator('.cluster-panel');
    await expect(panel).toHaveAttribute('role', 'dialog');
    await expect(panel.getByRole('heading', { name: clusterName, level: 1 })).toBeVisible();

    // KPI strip below the header — 4 tiles (utilization, headroom, runway, order-by).
    // Scope to the strip; "Headroom" also appears in the forecast-chart legend.
    const kpiStrip = page.getByTestId('kpi-strip');
    await expect(kpiStrip.getByText('Current utilization')).toBeVisible();
    await expect(kpiStrip.getByText('Headroom', { exact: true })).toBeVisible();
    await expect(kpiStrip.getByText('Runway', { exact: true })).toBeVisible();

    // Add a host via the panel's Hosts tab.
    await panel.getByRole('tab', { name: 'Hosts' }).click();
    await panel.getByRole('button', { name: 'Add host' }).click();
    const hostDialog = page.getByRole('dialog', { name: 'Add host' });
    await hostDialog.getByRole('textbox', { name: 'Name' }).fill('host-e2e');
    await hostDialog.getByRole('spinbutton', { name: 'Initial memory capacity (GB)' }).fill('2000');
    await hostDialog.getByRole('button', { name: 'Add host' }).click();
    await expect(hostDialog).toBeHidden();
    await expect(page.getByText('1 host providing capacity')).toBeVisible();
    await expect(page.getByRole('cell', { name: '2,000 GB' })).toBeVisible();

    // Add an application via the "Apps & Events" tab (a single "Add item"
    // dialog hosts both item kinds, defaulting to the application form; only
    // the header/empty-state button was renamed to "Add app or event" —
    // #243 Part B — the dialog's own title is untouched, out of this batch's
    // scope).
    await panel.getByRole('tab', { name: 'Apps & Events' }).click();
    await panel.getByRole('button', { name: 'Add app or event' }).click();
    const appDialog = page.getByRole('dialog', { name: 'Add item' });
    await appDialog.getByRole('textbox', { name: 'Name' }).fill('app-e2e');
    await appDialog.getByLabel('Category').fill('OpenShift');
    await appDialog.getByRole('spinbutton', { name: 'Initial memory allocation (GB)' }).fill('400');
    await appDialog.getByRole('button', { name: 'Add application' }).click();
    await expect(appDialog).toBeHidden();
    await expect(page.getByText('1 item on the forecast')).toBeVisible();
    await expect(page.getByRole('cell', { name: '400 GB' })).toBeVisible();

    // The panel's forecast-chart legend stays present after each mutation
    // invalidates the forecast query; that's our marker that the chart
    // re-rendered cleanly. #243 Part B split the single "Consumption" entry
    // into "Actual —" / "Forecast ⌁" so the solid/dashed convention reads.
    await expect(page.getByText('Actual —', { exact: true })).toBeVisible();
    await expect(page.getByText('Capacity ceiling')).toBeVisible();

    // Theme toggle round-trip: cycle system → light → dark → system.
    const toggle = page.getByRole('button', { name: /Theme:/ });
    await toggle.click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await toggle.click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await toggle.click();
    // Back to system — html class state depends on the host OS preference,
    // so just assert the aria-label is back to "System".
    await expect(toggle).toHaveAccessibleName(/Theme: System/);

    // Capture the cluster id for cleanup via the panel URL.
    const url = page.url();
    const match = /\/clusters\/([^/?#]+)/.exec(url);
    clusterId = match?.[1] ?? null;
  } finally {
    if (clusterId) {
      const deleteResp = await request.delete(`${API_BASE}/api/clusters/${clusterId}`);
      expect(deleteResp.status()).toBe(204);
    }
  }
});

/**
 * Live usage + sync state on the fleet console (#193).
 *
 * The vSphere collector (#190) and scheduler wiring (#191) are not landed yet,
 * so the real dev stack cannot produce a synced cluster or a usage sample. To
 * exercise the render path in a real browser we intercept exactly the three
 * cluster read endpoints and let everything else (auth, settings) hit the real
 * seeded server. This proves the sync badge + live-usage line render, and — the
 * load-bearing assertion — that a synced cluster with no sample reads "not yet
 * measured", never the "0% used" that would be the most dangerous wrong answer.
 */
test('live usage and sync state render on the fleet console', async ({ page }) => {
  const freshId = 'clfresh00000000000000000';
  const neverId = 'clnever00000000000000000';

  const metric = {
    metricTypeKey: 'memory_gb',
    metricTypeDisplayName: 'Memory',
    unit: 'GB',
    baselineConsumption: 1000,
    baselineCapacity: 5000,
    currentConsumption: 1000,
    currentCapacity: 5000,
    utilization: 0.2,
  };
  const baseCluster = {
    description: null,
    baselineDate: '2026-06-01',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    archivedAt: null,
    metrics: [metric],
    source: 'vsphere' as const,
    lastSyncedAt: '2026-08-01T09:00:00Z',
    externalName: 'Production',
    provisionalHostCount: 0,
  };
  const clusters = {
    items: [
      {
        ...baseCluster,
        id: freshId,
        name: 'CL-Synced-Fresh',
        connection: { id: 'conn1', name: 'vc-prod-zrh', status: 'active', enabled: true },
      },
      {
        ...baseCluster,
        id: neverId,
        name: 'CL-Synced-New',
        provisionalHostCount: 2,
        connection: { id: 'conn1', name: 'vc-prod-zrh', status: 'active', enabled: true },
      },
    ],
    total: 2,
    limit: 100,
    offset: 0,
  };
  const liveUsage = {
    items: [
      {
        state: 'fresh',
        clusterId: freshId,
        connectionName: 'vc-prod-zrh',
        memoryUsedGiB: 1234.5,
        hostsSampled: 8,
        hostsTotal: 8,
        measuredAt: '2026-08-01T11:59:00Z',
        ageSeconds: 120,
      },
      { state: 'never_fetched', clusterId: neverId, connectionName: 'vc-prod-zrh' },
    ],
  };
  const forecast = {
    fromMonth: '2026-07-01',
    toMonth: '2027-06-01',
    months: [
      { month: '2026-07-01', consumption: 1000, capacity: 5000, utilization: 0.2 },
      { month: '2026-08-01', consumption: 1100, capacity: 5000, utilization: 0.22 },
    ],
    events: [],
    hosts: [],
    applications: [],
    effectiveThresholds: { warn: 0.7, crit: 0.9, source: 'system' },
    procurement: { leadTimeWeeks: 13, orderByDate: null, breachMonth: null },
    baselineHistory: [],
  };

  // Most specific last — Playwright checks routes most-recently-added first.
  await page.route(/\/api\/clusters(\?.*)?$/, (route) => route.fulfill({ json: clusters }));
  await page.route(/\/api\/clusters\/[^/]+\/forecast/, (route) =>
    route.fulfill({ json: forecast }),
  );
  await page.route(/\/api\/clusters\/live-usage$/, (route) => route.fulfill({ json: liveUsage }));

  await page.goto('/');

  const freshTile = page.locator('a[data-cluster-id="' + freshId + '"]');
  const newTile = page.locator('a[data-cluster-id="' + neverId + '"]');
  await expect(freshTile).toBeVisible();

  // The synced source badge renders on both tiles.
  await expect(freshTile.getByText('vSphere')).toBeVisible();

  // Fresh reading: an absolute GiB figure + freshness — never a percentage.
  await expect(freshTile.getByText('1,235 GiB')).toBeVisible();

  // The load-bearing assertion: a synced cluster with no sample says so in
  // words, and does NOT fabricate a 0.
  await expect(newTile.getByText('not yet measured')).toBeVisible();
  await expect(newTile).not.toContainText('0 GiB');
  // …and its provisional-host hint is surfaced.
  await expect(newTile.getByText(/HOSTS NEED DATES/)).toBeVisible();
});
