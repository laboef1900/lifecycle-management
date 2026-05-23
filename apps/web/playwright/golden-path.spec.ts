import { expect, test } from '@playwright/test';

const API_BASE = 'http://localhost:8090';

const suffix = (): string =>
  `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * Walks the v1 golden path: create cluster → add host → add application,
 * observing that the dashboard, table, and detail chart pick up each change.
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
    await page.goto('/clusters');
    await expect(page.getByRole('heading', { name: 'Clusters', level: 1 })).toBeVisible();

    // Create the cluster from the dashboard.
    await page.getByRole('button', { name: '+ Add cluster' }).click();
    const createDialog = page.getByRole('dialog', { name: 'New cluster' });
    await createDialog.getByRole('textbox', { name: 'Name' }).fill(clusterName);
    await createDialog.getByRole('spinbutton', { name: 'Consumption (GB)' }).fill('1000');
    await createDialog.getByRole('spinbutton', { name: 'Capacity (GB)' }).fill('5000');
    await createDialog.getByRole('button', { name: 'Create cluster' }).click();
    await expect(createDialog).toBeHidden();

    // Row should now appear in the dashboard table with the right utilization.
    const newRow = page.getByRole('row', { name: new RegExp(clusterName) });
    await expect(newRow).toBeVisible();
    await expect(newRow).toContainText('20.0%'); // 1000/5000

    // Open detail page.
    await newRow.getByRole('link', { name: 'Open' }).click();
    await expect(page.getByRole('heading', { name: clusterName, level: 1 })).toBeVisible();

    // Header utilization badge should agree.
    await expect(page.getByText('Current utilization')).toBeVisible();

    // Add a host.
    await page.getByRole('tab', { name: 'Hosts' }).click();
    await page.getByRole('button', { name: 'Add host' }).click();
    const hostDialog = page.getByRole('dialog', { name: 'Add host' });
    await hostDialog.getByRole('textbox', { name: 'Name' }).fill('host-e2e');
    await hostDialog.getByRole('spinbutton', { name: 'Initial memory capacity (GB)' }).fill('2000');
    await hostDialog.getByRole('button', { name: 'Add host' }).click();
    await expect(hostDialog).toBeHidden();
    await expect(page.getByText('1 host providing capacity')).toBeVisible();
    await expect(page.getByRole('cell', { name: '2,000 GB' })).toBeVisible();

    // Add an application.
    await page.getByRole('tab', { name: 'Applications' }).click();
    await page.getByRole('button', { name: 'Add application' }).click();
    const appDialog = page.getByRole('dialog', { name: 'Add application' });
    await appDialog.getByRole('textbox', { name: 'Name' }).fill('app-e2e');
    await appDialog.getByRole('spinbutton', { name: 'Initial memory allocation (GB)' }).fill('400');
    await appDialog.getByRole('button', { name: 'Add application' }).click();
    await expect(appDialog).toBeHidden();
    await expect(page.getByText('1 application consuming capacity')).toBeVisible();
    await expect(page.getByRole('cell', { name: '400 GB' })).toBeVisible();

    // The chart legend stays present after each mutation invalidates the
    // forecast query; that's our marker that the chart re-rendered cleanly.
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

    // Capture the cluster id for cleanup via the dashboard URL.
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
