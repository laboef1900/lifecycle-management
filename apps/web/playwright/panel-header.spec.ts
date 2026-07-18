import { expect, test, type Page } from '@playwright/test';

/**
 * #243 cluster-panel header + entrance behavior that jsdom cannot verify:
 * real focus order, focus return to the trigger tile, the instant (no
 * transform) entrance, and the Esc chain over the new anatomy.
 *
 * NOT run by CI (see scenario-pane.spec.ts header note) — local suite against
 * the seeded dev stack; every test skips cleanly on an empty database.
 */

async function openFirstCluster(page: Page): Promise<void> {
  await page.goto('/');
  const tiles = page.locator('a[href^="/clusters/"]');
  const hasTiles = await tiles
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!hasTiles, 'requires seeded clusters');
  await tiles.first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test('back control: link semantics, accessible name, first in focus order, focused on open', async ({
  page,
}) => {
  await openFirstCluster(page);

  const back = page.getByTestId('panel-back-link');
  // A real link (deep links + middle-click), named for its destination.
  await expect(back).toHaveRole('link');
  await expect(back).toHaveAccessibleName('Back to clusters');
  await expect(back).toHaveAttribute('href', '/');
  // ≥24×24 CSS px target (WCAG 2.2 SC 2.5.8).
  const box = await back.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(24);
  expect(box!.height).toBeGreaterThanOrEqual(24);

  // Focus moves to the back link on open, and it precedes the h1 in DOM order.
  await expect(back).toBeFocused();
  const precedesHeading = await page.evaluate(() => {
    const link = document.querySelector('[data-testid="panel-back-link"]');
    const h1 = document.querySelector('.cluster-panel h1');
    return Boolean(
      link && h1 && link.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
  expect(precedesHeading).toBe(true);
});

test('panel entrance is instant: no transform on the dialog, ever', async ({ page }) => {
  await page.goto('/');
  const tiles = page.locator('a[href^="/clusters/"]');
  const hasTiles = await tiles
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!hasTiles, 'requires seeded clusters');
  await tiles.first().click();

  // Sampled immediately after the route renders the dialog: the retired
  // slide-in would report an in-flight translateX matrix here.
  const transform = await page.getByRole('dialog').evaluate((el) => getComputedStyle(el).transform);
  expect(transform).toBe('none');
});

test('closing the panel returns focus to the trigger tile, immediately', async ({ page }) => {
  await page.goto('/');
  const tiles = page.locator('a[href^="/clusters/"]');
  const hasTiles = await tiles
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!hasTiles, 'requires seeded clusters');

  const firstTile = tiles.first();
  await firstTile.focus();
  await firstTile.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(firstTile).toBeFocused();
});

test('Esc chain over the new header: pane first, panel second', async ({ page }) => {
  await openFirstCluster(page);

  const scenarioButton = page.getByTestId('scenario-button');
  const hasScenario = await scenarioButton
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!hasScenario, 'requires a cluster with a metric baseline');

  await scenarioButton.click();
  await expect(page.getByTestId('scenario-pane-body')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('scenario-pane-body')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL('/');
});

test('recommendation chip: role=status wrapper in the title row; no eyebrow; clamped description', async ({
  page,
}) => {
  await openFirstCluster(page);

  const kpiVisible = await page
    .getByTestId('kpi-strip')
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!kpiVisible, 'requires a cluster with a metric baseline');

  const chip = page.getByTestId('recommendation-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveRole('status');

  // The "Cluster" eyebrow is deleted (#243 item 6).
  const panel = page.locator('.cluster-panel');
  await expect(panel.getByText('Cluster', { exact: true })).toHaveCount(0);

  // Line 2 description, clamped to a single line when present.
  const description = panel.locator('header p.line-clamp-1');
  if ((await description.count()) > 0) {
    const descBox = await description.boundingBox();
    const lineHeight = await description.evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).lineHeight),
    );
    expect(descBox!.height).toBeLessThanOrEqual(lineHeight * 1.5);
  }
});
