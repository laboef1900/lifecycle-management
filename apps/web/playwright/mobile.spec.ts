import { expect, test } from '@playwright/test';

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
    // Below the 1100px breakpoint the panel is 100vw (spec §5, styles.css
    // `.cluster-panel`), not the desktop 58vw side panel.
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

    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  });
});
