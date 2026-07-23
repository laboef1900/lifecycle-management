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

test('clicking the back link closes the panel — the primary pointer leave path', async ({
  page,
}) => {
  // The unit suite mocks TanStack Link, so real click->navigate through the
  // Radix TooltipTrigger asChild wrapper (a genuine prop-merge surface) is
  // only provable here.
  await openFirstCluster(page);

  await page.getByTestId('panel-back-link').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL('/');
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

  // Deterministic tripwire (#243 review): a single computed-style sample
  // taken after the click could race a reintroduced 280ms slide-in — motion
  // resets the inline transform to `none` at rest, so a late sample passes.
  // Instead, install an observer BEFORE the dialog can mount that samples the
  // dialog's computed transform every animation frame from the instant it
  // appears; any enter animation must show a non-`none` matrix in the first
  // frames, no matter how slow the test runner round-trips.
  await page.evaluate(() => {
    const w = window as unknown as { __panelTransforms?: string[] };
    w.__panelTransforms = [];
    const sample = (el: Element): void => {
      w.__panelTransforms?.push(getComputedStyle(el).transform);
      // ~30 frames ≈ 500ms at 60Hz — comfortably spans the retired 280ms.
      if ((w.__panelTransforms?.length ?? 0) < 30) requestAnimationFrame(() => sample(el));
    };
    const observer = new MutationObserver(() => {
      const dialog = document.querySelector('[role="dialog"].cluster-panel');
      if (dialog) {
        observer.disconnect();
        sample(dialog);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });

  await tiles.first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.waitForFunction(
    () =>
      ((window as unknown as { __panelTransforms?: string[] }).__panelTransforms?.length ?? 0) >=
      30,
  );

  const transforms = await page.evaluate(
    () => (window as unknown as { __panelTransforms?: string[] }).__panelTransforms ?? [],
  );
  expect(transforms.length).toBeGreaterThanOrEqual(30);
  expect(transforms.every((t) => t === 'none')).toBe(true);
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

test('forecast heading: no "FORECAST" eyebrow above it (#243 Part B item 8)', async ({ page }) => {
  await openFirstCluster(page);

  const headingVisible = await page
    .getByTestId('kpi-strip')
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!headingVisible, 'requires a cluster with a metric baseline');

  // The eyebrow's DOM text was "Forecast" (title case) — the `uppercase` CSS
  // class only changed how it *rendered*, not the text node — so this checks
  // the exact node text a real browser exposes, not a substring of the h2's
  // "Forecast — …" heading (which never matches exactly).
  await expect(page.locator('.cluster-panel').getByText('Forecast', { exact: true })).toHaveCount(
    0,
  );
});

test('unknown-capacity recommendation chip jumps focus to the Hosts tab (#243 Part B item 4)', async ({
  page,
  request,
}) => {
  // Route-mocked rather than relying on a seeded unknown-capacity cluster:
  // deterministic regardless of what the dev DB happens to contain.
  const clustersRes = await request.get('/api/clusters');
  const { items: clusters } = (await clustersRes.json()) as {
    items: Array<{ id: string; metrics: Array<Record<string, unknown>> }>;
  };
  test.skip(clusters.length === 0, 'requires seeded clusters');
  const cluster = clusters[0]!;
  const clusterRes = await request.get(`/api/clusters/${cluster.id}`);
  const clusterBody = (await clusterRes.json()) as {
    metrics: Array<Record<string, unknown>>;
  };
  const unknownCapacityBody = {
    ...clusterBody,
    metrics: clusterBody.metrics.map((m) => ({
      ...m,
      currentCapacity: 0,
      baselineCapacity: 0,
      utilization: null,
    })),
  };

  // Anchored to the end so this never also catches the forecast/settings
  // sub-paths under the same cluster id (golden-path.spec.ts's own route
  // convention).
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  await page.route(new RegExp(`/api/clusters/${cluster.id}$`), (route) =>
    route.fulfill({ json: unknownCapacityBody }),
  );
  await page.goto(`/clusters/${cluster.id}`);
  await expect(page.getByRole('dialog')).toBeVisible();

  const chip = page.getByTestId('recommendation-chip-trigger');
  await expect(chip).toHaveText(/capacity unknown/i);
  // Start on a different tab so the click below is provably what moves it.
  await page.getByRole('tab', { name: /apps/i }).click();
  await expect(page.getByRole('tab', { name: /apps/i })).toHaveAttribute('aria-selected', 'true');

  await chip.click();

  const hostsTab = page.getByRole('tab', { name: 'Hosts' });
  await expect(hostsTab).toHaveAttribute('aria-selected', 'true');
  await expect(hostsTab).toBeFocused();
});
