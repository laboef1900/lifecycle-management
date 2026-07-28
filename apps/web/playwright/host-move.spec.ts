import { expect, test } from '@playwright/test';

const API_BASE = 'http://localhost:8090';

const suffix = (): string =>
  `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/** `'2026-07-23'` → `'2026-08'`: always strictly after any commission date this
 * month, whatever day the suite happens to run on, satisfying the server's
 * `moveDate must be after the start of the current cluster membership` check. */
function nextMonthValue(): string {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * #309 review follow-up: the RTL/Vitest suite for `HostMoveDialog` cannot open
 * the Radix `Select` nested inside the Dialog in jsdom (a pre-existing
 * focus-scope recursion — see the comment above `describe('filterMoveDestinations')`
 * in `host-move-dialog.test.tsx`), so its unit coverage only exercises the
 * single-auto-selected-destination path plus the filter as a pure function. A
 * real browser has no such recursion, so this proves the actual selection
 * wiring: opening the Select and explicitly picking a destination other than
 * whichever one loaded pre-selected, not just accepting the default.
 *
 * Creates its own source cluster plus two eligible destination clusters and a
 * host, then tears all three clusters down via the API — same self-contained
 * pattern as golden-path.spec.ts. Which candidate the `<Select>` auto-selects
 * depends on the full cluster list's alphabetical order (`GET /api/clusters`'s
 * `orderBy: { name: 'asc' }`), which includes whatever else is seeded in this
 * environment — so the test reads the actual pre-selected value at runtime
 * rather than assuming it is either of the two clusters created here.
 */
test('moving a host to an explicitly-chosen (non-default) destination cluster', async ({
  page,
  request,
}) => {
  const id = suffix();
  const sourceName = `CL-E2E-MOVESRC-${id}`;
  const destAName = `CL-E2E-MOVEA-${id}`;
  const destBName = `CL-E2E-MOVEB-${id}`;
  const hostName = 'host-move-e2e';

  let sourceClusterId: string | null = null;
  let destAClusterId: string | null = null;
  let destBClusterId: string | null = null;

  try {
    await page.goto('/settings/inventory');
    for (const clusterName of [sourceName, destAName, destBName]) {
      await page.getByRole('button', { name: '+ Add cluster' }).click();
      const createDialog = page.getByRole('dialog', { name: 'New cluster' });
      await createDialog.getByRole('textbox', { name: 'Name' }).fill(clusterName);
      await createDialog.getByRole('spinbutton', { name: 'Consumption (GB)' }).fill('1000');
      await createDialog.getByRole('spinbutton', { name: 'Capacity (GB)' }).fill('5000');
      await createDialog.getByRole('button', { name: 'Create cluster' }).click();
      await expect(createDialog).toBeHidden();
    }

    await page.goto('/');
    const destATile = page.getByRole('link', { name: destAName });
    const destBTile = page.getByRole('link', { name: destBName });
    await expect(destATile).toBeVisible();
    await expect(destBTile).toBeVisible();
    destAClusterId = await destATile.getAttribute('data-cluster-id');
    destBClusterId = await destBTile.getAttribute('data-cluster-id');

    // Open the source cluster's panel and add the host that will be moved.
    await page.getByRole('link', { name: sourceName }).click();
    await expect(page).toHaveURL(/\/clusters\/[^/]+$/);
    const sourceMatch = /\/clusters\/([^/?#]+)/.exec(page.url());
    sourceClusterId = sourceMatch?.[1] ?? null;

    const panel = page.locator('.cluster-panel');
    await panel.getByRole('tab', { name: 'Hosts' }).click();
    await panel.getByRole('button', { name: 'Add host' }).click();
    const hostDialog = page.getByRole('dialog', { name: 'Add host' });
    await hostDialog.getByRole('textbox', { name: 'Name' }).fill(hostName);
    await hostDialog.getByRole('spinbutton', { name: 'Initial memory capacity (GB)' }).fill('100');
    await hostDialog.getByRole('button', { name: 'Add host' }).click();
    await expect(hostDialog).toBeHidden();

    // Open the row's overflow menu and start the move.
    const row = page.getByRole('row', { name: new RegExp(hostName) });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'More actions' }).click();
    const menu = page.getByRole('menu');
    await menu.getByRole('menuitem', { name: /Move/ }).click();

    const moveDialog = page.getByRole('dialog', { name: `Move ${hostName}` });
    await expect(moveDialog).toBeVisible();

    // Some destination loads pre-selected (the first eligible cluster in
    // alphabetical order across the whole tenant, not necessarily either
    // cluster created by this test) — capture it, then explicitly open the
    // popover and pick destB instead, proving real selection wiring rather
    // than accepting whatever the default happened to be.
    const destinationTrigger = moveDialog.getByRole('combobox', { name: /destination cluster/i });
    const defaultDestinationText = (await destinationTrigger.textContent())?.trim() ?? '';
    expect(defaultDestinationText).not.toBe(destBName);

    await destinationTrigger.click();
    await page.getByRole('option', { name: destBName, exact: true }).click();
    await expect(destinationTrigger).toContainText(destBName);

    await moveDialog.getByLabel(/effective month/i).fill(nextMonthValue());
    await moveDialog.getByRole('button', { name: /continue/i }).click();

    // The confirmation step must restate the destination actually chosen
    // (destB), not whatever destination was auto-selected by default.
    const confirmDialog = page.getByRole('dialog', { name: 'Confirm move' });
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog.getByText(destBName, { exact: true })).toBeVisible();
    if (defaultDestinationText.length > 0 && defaultDestinationText !== destBName) {
      await expect(
        confirmDialog.getByText(defaultDestinationText, { exact: true }),
      ).not.toBeVisible();
    }

    await confirmDialog.getByRole('button', { name: /move host/i }).click();
    await expect(confirmDialog).toBeHidden();

    // The host moved off the source cluster immediately (membership flips
    // right away; only the forecast attribution is time-scoped to the chosen
    // month) — its row disappears here and the empty state takes over.
    await expect(page.getByText('No hosts yet.')).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(hostName) })).toHaveCount(0);

    // …and appears under destB.
    await page.goto('/');
    await page.getByRole('link', { name: destBName }).click();
    await expect(page).toHaveURL(/\/clusters\/[^/]+$/);
    const destPanel = page.locator('.cluster-panel');
    await destPanel.getByRole('tab', { name: 'Hosts' }).click();
    await expect(destPanel.getByRole('row', { name: new RegExp(hostName) })).toBeVisible();
  } finally {
    for (const clusterId of [sourceClusterId, destAClusterId, destBClusterId]) {
      if (clusterId) {
        const deleteResp = await request.delete(`${API_BASE}/api/clusters/${clusterId}`);
        expect(deleteResp.status()).toBe(204);
      }
    }
  }
});
