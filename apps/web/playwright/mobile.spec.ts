import { expect, test } from '@playwright/test';

test.describe('mobile layout at 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('overview page collapses sidebar into a sheet drawer', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.removeItem('theme');
      } catch {
        // ignore
      }
    });

    await page.goto('/');
    // Inline sidebar (aside) must be hidden — it has aria-label="Primary navigation".
    // The Sheet contents share the same label but only render when open, so
    // initially there must be zero matching nodes.
    await expect(page.getByLabel('Primary navigation')).toHaveCount(0);

    // Hamburger button opens navigation.
    const hamburger = page.getByRole('button', { name: 'Open navigation' });
    await expect(hamburger).toBeVisible();
    await hamburger.click();

    const drawer = page.getByRole('dialog', { name: 'Primary navigation' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Overview' })).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Clusters' })).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Settings' })).toBeVisible();
  });

  test('clusters page renders card stack and tapping a card navigates to detail', async ({
    page,
  }) => {
    await page.goto('/clusters');

    // Pick the first card link and confirm it routes to a cluster detail page.
    const card = page.locator('a[href^="/clusters/"]').first();
    await expect(card).toBeVisible();
    const href = await card.getAttribute('href');
    expect(href).toMatch(/^\/clusters\/[a-z0-9]+$/);

    await card.click();
    await expect(page).toHaveURL(/\/clusters\/[a-z0-9]+/);
  });

  test('cluster detail KPI strip renders without clipping', async ({ page }) => {
    await page.goto('/clusters');
    await page.locator('a[href^="/clusters/"]').first().click();

    // KPI strip labels visible — scope to the strip so we don't match the
    // forecast-chart legend's "Headroom" series.
    const kpiStrip = page.getByTestId('kpi-strip');
    await expect(kpiStrip.getByText('Current utilization')).toBeVisible();
    await expect(kpiStrip.getByText('Headroom', { exact: true })).toBeVisible();
    await expect(kpiStrip.getByText('Runway', { exact: true })).toBeVisible();
  });
});
