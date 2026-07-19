import { expect, test } from '@playwright/test';

const API_BASE = 'http://localhost:8090';

const suffix = (): string =>
  `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * #243 Part B: host rows now fold Replace/History/Resize/Decommission/Delete
 * behind a "More actions" overflow menu, keeping only Edit and Transition
 * inline (hosts-tab.tsx). The jsdom suite (hosts-tab.test.tsx) covers the
 * structure and classes; this proves the real Radix interaction — keyboard
 * open, visible text menu items, and that Delete's existing confirmation
 * step still gates the destructive action from its new home in the menu.
 *
 * Creates and tears down its own cluster/host, like golden-path.spec.ts, so
 * it runs unconditionally in CI rather than skipping on an empty database.
 */
test('host row overflow menu opens via keyboard; its destructive item still confirms', async ({
  page,
  request,
}) => {
  const clusterName = `CL-E2E-ROWACT-${suffix()}`;
  let clusterId: string | null = null;

  try {
    await page.goto('/settings');
    await page.getByRole('button', { name: '+ Add cluster' }).click();
    const createDialog = page.getByRole('dialog', { name: 'New cluster' });
    await createDialog.getByRole('textbox', { name: 'Name' }).fill(clusterName);
    await createDialog.getByRole('spinbutton', { name: 'Consumption (GB)' }).fill('1000');
    await createDialog.getByRole('spinbutton', { name: 'Capacity (GB)' }).fill('5000');
    await createDialog.getByRole('button', { name: 'Create cluster' }).click();
    await expect(createDialog).toBeHidden();

    await page.goto('/');
    await page.getByRole('link', { name: clusterName }).click();
    await expect(page).toHaveURL(/\/clusters\/[^/]+$/);
    const match = /\/clusters\/([^/?#]+)/.exec(page.url());
    clusterId = match?.[1] ?? null;

    const panel = page.locator('.cluster-panel');
    await panel.getByRole('tab', { name: 'Hosts' }).click();
    await panel.getByRole('button', { name: 'Add host' }).click();
    const hostDialog = page.getByRole('dialog', { name: 'Add host' });
    await hostDialog.getByRole('textbox', { name: 'Name' }).fill('host-row-actions');
    await hostDialog.getByRole('spinbutton', { name: 'Initial memory capacity (GB)' }).fill('1000');
    await hostDialog.getByRole('button', { name: 'Add host' }).click();
    await expect(hostDialog).toBeHidden();

    const row = page.getByRole('row', { name: /host-row-actions/ });
    await expect(row).toBeVisible();

    // Edit and Transition stay directly reachable — no menu needed.
    await expect(row.getByRole('button', { name: 'Edit' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Transition…' })).toBeVisible();

    // Everything else opens behind the kebab, reachable by keyboard alone.
    const trigger = row.getByRole('button', { name: 'More actions' });
    await trigger.focus();
    await page.keyboard.press('Enter');

    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /View history/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Resize/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Decommission/ })).toBeVisible();
    const deleteItem = menu.getByRole('menuitem', { name: /Delete/ });
    await expect(deleteItem).toBeVisible();

    // Activating Delete from the menu must still land on the existing
    // confirmation dialog, not delete outright.
    await deleteItem.click();
    const confirmDialog = page.getByRole('dialog', { name: /delete host-row-actions/i });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirmDialog).toBeHidden();

    // Cancelled, not deleted — the row survives.
    await expect(row).toBeVisible();
  } finally {
    if (clusterId) {
      const deleteResp = await request.delete(`${API_BASE}/api/clusters/${clusterId}`);
      expect(deleteResp.status()).toBe(204);
    }
  }
});
