import { expect, test } from '@playwright/test';

const API_BASE = 'http://localhost:8090';

const suffix = (): string =>
  `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

test.describe('mobile layout at 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('topbar renders directly — no nav drawer', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.removeItem('theme');
      } catch {
        // ignore
      }
    });

    await page.goto('/');

    // Mission-bento redesign (spec §2/§3): the sidebar, breadcrumbs, and
    // mobile nav drawer are removed in favor of a single topbar. The
    // "Primary navigation" landmark (the Settings nav inside the topbar,
    // see components/layout/app-shell.tsx) is visible immediately — no
    // hamburger/sheet gate needed at any viewport.
    await expect(page.getByLabel('Primary navigation')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Primary navigation' })).toHaveCount(0);
  });

  test('cluster tiles stack 1-up and tapping a tile navigates to detail', async ({ page }) => {
    await page.goto('/');

    const tiles = page.locator('a[href^="/clusters/"]');
    // `.count()` doesn't auto-wait for the async clusters/forecast queries to
    // resolve, so check for a rendered tile (with a real timeout) before
    // deciding whether to skip — otherwise this races the console's loading
    // skeleton and skips even when clusters are seeded.
    const hasTiles = await tiles
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!hasTiles, 'requires seeded clusters');
    const count = await tiles.count();

    const first = tiles.first();
    const firstBox = await first.boundingBox();
    expect(firstBox).not.toBeNull();
    // 1-up grid (spec §4.4: col-span-12 below the 820px breakpoint) — the
    // tile spans essentially the full viewport width.
    expect(firstBox!.width).toBeGreaterThan(340);

    if (count > 1) {
      const secondBox = await tiles.nth(1).boundingBox();
      expect(secondBox).not.toBeNull();
      // Stacked, not side-by-side: same left edge, lower top edge.
      expect(Math.round(secondBox!.x)).toBe(Math.round(firstBox!.x));
      expect(secondBox!.y).toBeGreaterThan(firstBox!.y);
    }

    const href = await first.getAttribute('href');
    expect(href).toMatch(/^\/clusters\/[^/]+$/);

    await first.click();
    await expect(page).toHaveURL(/\/clusters\/[^/]+$/);
  });

  test('detail panel opens at full viewport width with its KPI strip', async ({ page }) => {
    await page.goto('/');

    const tiles = page.locator('a[href^="/clusters/"]');
    const hasTiles = await tiles
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!hasTiles, 'requires seeded clusters');
    await tiles.first().click();

    const panel = page.getByRole('dialog');
    await expect(panel).toBeVisible();
    const panelBox = await panel.boundingBox();
    expect(panelBox).not.toBeNull();
    // The panel is a fullscreen takeover: 100vw at every width (spec §5,
    // styles.css `.cluster-panel`), so on this ~390px viewport it fills it.
    expect(Math.round(panelBox!.width)).toBeGreaterThanOrEqual(388);
    expect(Math.round(panelBox!.width)).toBeLessThanOrEqual(390);

    const kpiStrip = page.getByTestId('kpi-strip');
    await expect(kpiStrip.getByText('Current utilization')).toBeVisible();
    await expect(kpiStrip.getByText('Headroom', { exact: true })).toBeVisible();
    await expect(kpiStrip.getByText('Runway', { exact: true })).toBeVisible();
  });

  test('settings reachable via the topbar link', async ({ page }) => {
    await page.goto('/');

    const settingsLink = page.getByRole('link', { name: 'Settings' }).first();
    await expect(settingsLink).toBeVisible();
    await settingsLink.click();

    // #293: the topbar link points at the default sub-route directly.
    await expect(page).toHaveURL(/\/settings\/forecasting$/);
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  });

  test('hosts table keeps the Actions column reachable when scrolled (#243 Part B)', async ({
    page,
    request,
  }) => {
    // Self-contained (own cluster + host) rather than relying on seeded data,
    // since the Lifecycle gantt column's min-w-[230px] only overflows the
    // 390px viewport once a host row actually exists.
    const clusterName = `CL-E2E-STICKY-${suffix()}`;
    let clusterId: string | null = null;

    try {
      // #293: the Add-cluster panel lives on the Inventory sub-route now, not
      // bare `/settings` (which redirects to Forecasting by default).
      await page.goto('/settings/inventory');
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
      await hostDialog.getByRole('textbox', { name: 'Name' }).fill('host-mobile-sticky');
      await hostDialog
        .getByRole('spinbutton', { name: 'Initial memory capacity (GB)' })
        .fill('1000');
      await hostDialog.getByRole('button', { name: 'Add host' }).click();
      await expect(hostDialog).toBeHidden();

      const row = page.getByRole('row', { name: /host-mobile-sticky/ });
      await expect(row).toBeVisible();
      const moreButton = row.getByRole('button', { name: 'More actions' });

      // Scroll the table's own overflow-auto wrapper (ui/table.tsx) to its
      // horizontal max — without the sticky column this would carry the
      // Actions cell off the left edge of the 390px viewport with it.
      const table = panel.locator('table').first();
      await table.evaluate((el) => {
        const scrollParent = el.parentElement;
        if (scrollParent) scrollParent.scrollLeft = scrollParent.scrollWidth;
      });

      const box = await moreButton.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    } finally {
      if (clusterId) {
        const deleteResp = await request.delete(`${API_BASE}/api/clusters/${clusterId}`);
        expect(deleteResp.status()).toBe(204);
      }
    }
  });
});
