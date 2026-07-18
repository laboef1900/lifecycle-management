import { expect, test, type Page } from '@playwright/test';

/**
 * Sub-`lg` Scenario pane: the modal-sheet behaviour that jsdom cannot verify.
 *
 * The unit suite asserts the *attributes* (`inert` on the content column, the
 * pane body's declared width) because jsdom has no layout and does not implement
 * `inert` at all. What it cannot show is the thing the user actually
 * experiences: that the sheet really paints over the whole panel, that the
 * covered column really stops receiving pointer input, and that Escape really
 * hands focus back. This spec covers exactly that gap.
 *
 * NOT run by CI. `.github/workflows/ci.yml` runs only the OIDC e2e job
 * (`test:e2e:oidc`, its own config); this default `playwright/` suite needs a
 * seeded dev DB and is run locally via `pnpm --filter @lcm/web test:e2e`. Every
 * test here skips cleanly when no clusters are seeded, so it cannot fail a run
 * on an empty database.
 */

const SUB_LG = { width: 900, height: 800 };
const SIDE_BY_SIDE = { width: 1280, height: 800 };

/** Opens the first seeded cluster's detail panel, or skips the test. */
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

/**
 * Opens the Scenario pane and waits for the 280ms enter animation to settle.
 * The pane's width is animated, so a bounding box read too early reports a
 * partially-open sheet — poll until it stops growing rather than sleeping.
 */
async function openScenarioPane(page: Page, expectedWidth: number): Promise<void> {
  const scenarioButton = page.getByTestId('scenario-button');
  const hasScenario = await scenarioButton
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!hasScenario, 'requires a cluster with a metric baseline');

  await scenarioButton.click();
  await expect(page.getByTestId('scenario-pane-body')).toBeVisible();
  await expect
    .poll(async () => {
      const box = await page.locator('aside:has([data-testid="scenario-pane-body"])').boundingBox();
      return box === null ? 0 : Math.round(box.width);
    })
    .toBeGreaterThanOrEqual(expectedWidth - 2);
}

test.describe('scenario pane as a modal sheet below lg', () => {
  test.use({ viewport: SUB_LG });

  test('the sheet covers the whole panel and the column stops taking pointer input', async ({
    page,
  }) => {
    await openFirstCluster(page);
    await openScenarioPane(page, SUB_LG.width);

    const panelBox = await page.getByRole('dialog').boundingBox();
    expect(panelBox).not.toBeNull();
    const sheetBox = await page
      .locator('aside:has([data-testid="scenario-pane-body"])')
      .boundingBox();
    expect(sheetBox).not.toBeNull();

    // The sheet spans the panel, not a 340px strip of it — the round-1
    // regression was a narrow pane over a fully `inert` panel, which left most
    // of the column visible on screen but unreachable.
    expect(Math.round(sheetBox!.width)).toBeGreaterThanOrEqual(Math.round(panelBox!.width) - 2);
    expect(Math.round(sheetBox!.x)).toBeLessThanOrEqual(Math.round(panelBox!.x) + 2);

    // The column is contained...
    await expect(page.getByTestId('panel-content')).toHaveAttribute('inert', '');

    // ...and it is genuinely covered: hit-testing the middle of the panel lands
    // inside the pane, never on a control in the column behind it. `inert`
    // alone would not prove this — a transparent or undersized sheet would
    // still carry the attribute.
    const hit = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return {
          insidePane: el?.closest('[data-testid="scenario-pane-body"]') !== null,
          insideColumn: el?.closest('[data-testid="panel-content"]') !== null,
        };
      },
      { x: panelBox!.x + panelBox!.width / 2, y: panelBox!.y + panelBox!.height / 2 },
    );
    expect(hit.insidePane).toBe(true);
    expect(hit.insideColumn).toBe(false);
  });

  test('Escape closes the sheet and returns focus to the Scenario button', async ({ page }) => {
    await openFirstCluster(page);
    await openScenarioPane(page, SUB_LG.width);

    // Opening moves focus into the sheet, so the covered column never holds it.
    await expect(page.getByRole('button', { name: 'Close scenario pane' })).toBeFocused();

    await page.keyboard.press('Escape');

    // The panel itself must survive — the pane swallows the first Escape.
    await expect(page.getByTestId('scenario-pane-body')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toBeVisible();

    // Focus lands back on the trigger rather than on <body>. This is the one
    // jsdom cannot really check: the restore target lives *inside* the column,
    // and `focus()` on an element in an inert subtree is a no-op in a real
    // browser, so restoring before the exit finished would strand focus.
    await expect(page.getByTestId('panel-content')).not.toHaveAttribute('inert', '');
    await expect(page.getByTestId('scenario-button')).toBeFocused();
  });

  test('the close control shows a visible Esc keycap', async ({ page }) => {
    await openFirstCluster(page);
    await openScenarioPane(page, SUB_LG.width);

    // aria-keyshortcuts is not an affordance — no browser renders it — so the
    // keycap has to be on screen for sighted pointer users.
    const close = page.getByRole('button', { name: 'Close scenario pane' });
    await expect(close.locator('kbd')).toBeVisible();
    await expect(close.locator('kbd')).toHaveText('Esc');
  });
});

test.describe('scenario pane beside the content column at lg and up', () => {
  test.use({ viewport: SIDE_BY_SIDE });

  test('the pane is a 340px sibling and the column stays interactive', async ({ page }) => {
    await openFirstCluster(page);
    await openScenarioPane(page, 340);

    const sheetBox = await page
      .locator('aside:has([data-testid="scenario-pane-body"])')
      .boundingBox();
    expect(sheetBox).not.toBeNull();
    expect(Math.round(sheetBox!.width)).toBe(340);

    // Nothing is covered here, so containing the column would strip a fully
    // visible half of the panel from the accessibility tree.
    await expect(page.getByTestId('panel-content')).not.toHaveAttribute('inert', '');

    const columnBox = await page.getByTestId('panel-content').boundingBox();
    expect(columnBox).not.toBeNull();
    // Side by side, not overlapping.
    expect(Math.round(columnBox!.x + columnBox!.width)).toBeLessThanOrEqual(
      Math.round(sheetBox!.x) + 2,
    );
  });
});
