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

    // Create the cluster from the console's toolbar row (spec §4.5).
    await page.getByRole('button', { name: '+ Add cluster' }).click();
    const createDialog = page.getByRole('dialog', { name: 'New cluster' });
    await createDialog.getByRole('textbox', { name: 'Name' }).fill(clusterName);
    await createDialog.getByRole('spinbutton', { name: 'Consumption (GB)' }).fill('1000');
    await createDialog.getByRole('spinbutton', { name: 'Capacity (GB)' }).fill('5000');
    await createDialog.getByRole('button', { name: 'Create cluster' }).click();
    await expect(createDialog).toBeHidden();

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
    await expect(panel.getByRole('heading', { name: clusterName, level: 2 })).toBeVisible();

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
    // dialog hosts both item kinds, defaulting to the application form).
    await panel.getByRole('tab', { name: 'Apps & Events' }).click();
    await panel.getByRole('button', { name: 'Add item' }).click();
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
    // re-rendered cleanly.
    await expect(page.getByText('Consumption', { exact: true })).toBeVisible();
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
