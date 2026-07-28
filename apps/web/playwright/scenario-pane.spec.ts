import { expect, test, type Page } from '@playwright/test';

/**
 * The Scenario rail (redesigned 2026-07-24): what only a real browser can prove.
 *
 * The unit suite asserts the *structure* — which element the rail renders into
 * at each breakpoint, its classes, focus moves, announcements — because jsdom
 * has no layout. What it cannot show is the thing the redesign is actually
 * about: that the rail is genuinely part of the layout rather than an overlay.
 * "Never covers the content column" is a geometry-and-hit-testing claim, and
 * so are the target size of the sliders and the absence of any glass material.
 * This spec covers exactly that gap.
 *
 * NOT run by CI. `.github/workflows/ci.yml` runs only the OIDC e2e job
 * (`test:e2e:oidc`, its own config); this default `playwright/` suite needs a
 * seeded dev DB and is run locally via `pnpm --filter @lcm/web test:e2e`. Every
 * test here skips cleanly when no clusters are seeded, so it cannot fail a run
 * on an empty database.
 */

const SUB_LG = { width: 900, height: 800 };
const SIDE_BY_SIDE = { width: 1280, height: 800 };

/** The docked rail at `lg`+. Below `lg` this element does not exist at all. */
const DOCKED_RAIL = 'aside:has([data-testid="scenario-pane-body"])';

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
 * Opens the Scenario rail. No animation to wait out — the rail is part of the
 * layout and appears on the next frame (#243 instant-transition rule), which is
 * itself why the old width-polling helper is gone.
 */
async function openScenarioRail(page: Page): Promise<void> {
  const scenarioButton = page.getByTestId('scenario-button');
  const hasScenario = await scenarioButton
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!hasScenario, 'requires a cluster with a metric baseline');

  await scenarioButton.click();
  await expect(page.getByTestId('scenario-pane-body')).toBeVisible();
}

/** What `document.elementFromPoint` lands on at the centre of the panel. */
async function hitTestPanelCentre(
  page: Page,
): Promise<{ insideRail: boolean; insideColumn: boolean }> {
  const panelBox = await page.getByRole('dialog').boundingBox();
  expect(panelBox).not.toBeNull();
  return page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return {
        insideRail: el?.closest('[data-testid="scenario-pane-body"]') !== null,
        insideColumn: el?.closest('[data-testid="panel-content"]') !== null,
      };
    },
    { x: panelBox!.x + panelBox!.width / 2, y: panelBox!.y + panelBox!.height / 2 },
  );
}

test.describe('scenario rail docked beside the content column at lg and up', () => {
  test.use({ viewport: SIDE_BY_SIDE });

  test('is a 340px side column that never overlaps the still-interactive content', async ({
    page,
  }) => {
    await openFirstCluster(page);
    await openScenarioRail(page);

    const railBox = await page.locator(DOCKED_RAIL).boundingBox();
    expect(railBox).not.toBeNull();
    expect(Math.round(railBox!.width)).toBe(340);

    // Side by side, not overlapping: the column ends where the rail begins.
    // This is the whole point of the redesign — the rail is layout, not an
    // overlay, so there is nothing to contain and nothing to make `inert`.
    const columnBox = await page.getByTestId('panel-content').boundingBox();
    expect(columnBox).not.toBeNull();
    expect(Math.round(columnBox!.x + columnBox!.width)).toBeLessThanOrEqual(
      Math.round(railBox!.x) + 2,
    );

    // The containment machinery is gone and must stay gone: a docked rail that
    // covers nothing may never strip the visible half of the panel from the
    // accessibility tree.
    await expect(page.getByTestId('panel-content')).not.toHaveAttribute('inert', '');

    // …and the centre of the panel is live column content, not rail.
    const hit = await hitTestPanelCentre(page);
    expect(hit.insideColumn).toBe(true);
    expect(hit.insideRail).toBe(false);
  });

  test('the rail stays open while a preset is applied — the chart redraws beside it', async ({
    page,
  }) => {
    await openFirstCluster(page);
    await openScenarioRail(page);

    // "Add load" rather than "Lose hosts": this test is about the rail, not
    // about which what-if is picked, and "Lose hosts" is gated off on clusters
    // whose hosts have no recorded capacity — seeded data must not decide
    // whether a rail-behavior test can run.
    await page.getByTestId('scenario-preset-add_vms').click();

    // No Apply step, and no auto-dismiss: nothing is covered, so throwing away
    // the editing context after every change would be pure loss.
    await expect(page.getByTestId('scenario-pane-body')).toBeVisible();
    await expect(page.getByTestId('scenario-summary')).toHaveText(/^Active:/);
    await expect(page.getByTestId('scenario-active-indicator')).toBeVisible();
  });
});

test.describe('scenario rail stacked inline below lg', () => {
  test.use({ viewport: SUB_LG });

  test('renders inside the content column instead of docking, and covers nothing', async ({
    page,
  }) => {
    await openFirstCluster(page);
    await openScenarioRail(page);

    // There is no aside below `lg` — the single rail instance renders inline in
    // the content flow, under the chart it edits.
    await expect(page.locator(DOCKED_RAIL)).toHaveCount(0);

    const body = page.getByTestId('scenario-pane-body');
    const railBox = await body.boundingBox();
    const columnBox = await page.getByTestId('panel-content').boundingBox();
    expect(railBox).not.toBeNull();
    expect(columnBox).not.toBeNull();

    // Contained by the column, horizontally and vertically — an overlay would
    // sit outside it (the old sheet spanned the whole 100vw panel).
    expect(railBox!.x).toBeGreaterThanOrEqual(columnBox!.x - 1);
    expect(railBox!.x + railBox!.width).toBeLessThanOrEqual(columnBox!.x + columnBox!.width + 1);

    // The scrim + `inert` containment the old modal sheet needed is gone.
    await expect(page.getByTestId('panel-content')).not.toHaveAttribute('inert', '');
    const hit = await hitTestPanelCentre(page);
    expect(hit.insideColumn).toBe(true);
  });

  test('Escape closes the rail and returns focus to the Scenario button', async ({ page }) => {
    await openFirstCluster(page);
    await openScenarioRail(page);

    // Opening moves focus into the rail.
    await expect(page.getByRole('button', { name: 'Close scenario pane' })).toBeFocused();

    await page.keyboard.press('Escape');

    // The panel itself must survive — the rail swallows the first Escape.
    await expect(page.getByTestId('scenario-pane-body')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByTestId('scenario-button')).toBeFocused();
  });

  test('the close control shows a visible Esc keycap', async ({ page }) => {
    await openFirstCluster(page);
    await openScenarioRail(page);

    // aria-keyshortcuts is not an affordance — no browser renders it — so the
    // keycap has to be on screen for sighted pointer users.
    const close = page.getByRole('button', { name: 'Close scenario pane' });
    await expect(close.locator('kbd')).toBeVisible();
    await expect(close.locator('kbd')).toHaveText('Esc');
  });
});

/**
 * The material guards that replaced the `.scenario-card` glass pair. The old
 * tests pinned the 70%-fill/near-opaque-fallback boundary at 1023/1024px; the
 * No-Glass Rule means the assertion is now simply that no blur exists anywhere
 * on the rail, at either side of that same boundary.
 */
test.describe('no-glass rule at the lg boundary', () => {
  for (const width of [1023, 1024]) {
    test(`the rail carries no backdrop-filter at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openFirstCluster(page);
      await openScenarioRail(page);

      const blurred = await page.getByTestId('scenario-pane-body').evaluate((el) => {
        // Walk up from the rail body: neither it nor its container may be glass.
        const filters: string[] = [];
        for (let node: Element | null = el; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          // The unprefixed property is empty in Safari/older WebKit, which only
          // exposes the prefixed one; read both through getPropertyValue so the
          // prefixed name doesn't need a DOM lib cast.
          const filter =
            style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter') || 'none';
          filters.push(filter);
          if (node.classList.contains('cluster-panel')) break;
        }
        return filters.filter((f) => f !== 'none');
      });
      expect(blurred).toEqual([]);
    });
  }
});

/**
 * Live tuning. The sliders are the redesign's headline: dragging redraws the
 * forecast with no Apply step, and the rail stays put while it happens.
 */
test.describe('live slider tuning', () => {
  test.use({ viewport: SIDE_BY_SIDE });

  test('a keyboard slider step re-runs the forecast and updates the header indicator', async ({
    page,
  }) => {
    await openFirstCluster(page);
    await openScenarioRail(page);

    // Driven by "Add load", deliberately, not "Lose hosts". `deriveBlockedPresets`
    // gates "Lose hosts" off whenever no host has a recorded capacity — which is
    // true of every vSphere-synced cluster — so keying this test on it made the
    // run depend on the seed. The earlier shape (`test.skip(await
    // preset.isDisabled(), …)`) was worse than a seed dependency: a one-shot read
    // against a state that arrives asynchronously, so the step could go
    // permanently green without ever pressing a key. "Add load" is never blocked
    // (it can always move a future month), so the precondition is structural.
    const preset = page.getByTestId('scenario-preset-add_vms');
    await expect(preset).toHaveAttribute('aria-disabled', 'false');
    await preset.click();
    const slider = page.getByLabel('VM count');
    await expect(slider).toBeVisible();
    await expect(slider).toBeEnabled();

    const before = await page.getByTestId('scenario-active-indicator').textContent();

    // Keyboard-operable for free, which is half the reason this is a native
    // range input rather than a div with a drag handler.
    await slider.focus();
    await page.keyboard.press('ArrowRight');

    // The VM count is what moved, so the indicator's own text must change.
    await expect(page.getByTestId('scenario-active-indicator')).not.toHaveText(before ?? '');
    await expect(page.getByTestId('scenario-active-indicator')).toHaveText(/GB VMs/);
    // No Apply was clicked and the rail never closed.
    await expect(page.getByTestId('scenario-pane-body')).toBeVisible();
  });

  test('the slider hit area clears the WCAG 2.2 AA 24px target-size floor', async ({ page }) => {
    await openFirstCluster(page);
    await openScenarioRail(page);

    await page.getByTestId('scenario-preset-add_vms').click();
    const slider = page.getByLabel('VM count');
    await expect(slider).toBeVisible();

    // SC 2.5.8. The visible track is 8px; the input's box is padded out to 24
    // so the pointer target is not the hairline (see .range-slider in
    // styles.css — putting a height back on the input silently breaks this).
    const box = await slider.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(24);
  });
});

/**
 * Scenario forecast fetch failure (#243 Part B item 1). Forces the failure
 * deterministically via `page.route` rather than relying on seeded data ever
 * producing one, since the unit suite already covers the logic — what only a
 * real browser proves is that a failed POST doesn't leave the header
 * indicator and the chart telling two different stories.
 */
test.describe('scenario forecast fetch failure', () => {
  test.use({ viewport: SIDE_BY_SIDE });

  test('clears the header indicator, surfaces a retryable inline error over the baseline chart, and corrects the announcement', async ({
    page,
  }) => {
    await openFirstCluster(page);
    await openScenarioRail(page);

    await page.route(/\/api\/clusters\/[^/]+\/forecast\/scenario/, (route) =>
      route.fulfill({ status: 500, json: { message: 'boom' } }),
    );
    // "Add load" is applicable to every cluster; "Lose hosts" is gated off when
    // no host has a recorded capacity, which would make this failure-path test
    // depend on seeded data it deliberately does not rely on.
    await page.getByTestId('scenario-preset-add_vms').click();

    // The header no longer claims a hypothetical forecast is on screen…
    await expect(page.getByTestId('scenario-active-indicator')).toHaveCount(0);
    await expect(page.getByTestId('scenario-button')).toHaveAccessibleName('Scenario');
    // …the correction is announced instead of "Scenario active: …"…
    await expect(page.getByTestId('panel-live-region')).toHaveText(
      'Scenario could not be computed — showing baseline.',
    );
    // …and an inline, retryable error sits over the still-baseline chart, which
    // is visible beside the rail rather than behind it.
    const retry = page.getByRole('button', { name: 'Retry' });
    await expect(page.getByText(/scenario could not be computed/i).last()).toBeVisible();
    await expect(retry).toBeVisible();

    // Retrying with the route now unmocked (falls through to the real API)
    // succeeds, clears the error, and restores the header indicator.
    await page.unroute(/\/api\/clusters\/[^/]+\/forecast\/scenario/);
    await retry.click();
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(page.getByTestId('scenario-active-indicator')).toBeVisible();
  });
});

/**
 * #323 — the compound stack, in a real browser.
 *
 * Self-contained on purpose. Two of the three presets are gated by
 * `deriveBlockedPresets` on the reference seed (its hosts carry no recorded
 * capacity, so `lose_hosts` cannot move the forecast), which would make a
 * compound built on seeded data conditional — and a conditionally-skipped
 * assertion in a suite that now gates promotion to `main` (#334) is exactly the
 * vacuous coverage the `forbid-skipped-reporter` exists to catch. So this creates
 * its own cluster with a capacity-bearing host, making both `lose_hosts` and
 * `add_vms` unconditionally available, and tears it down via the API — the same
 * pattern as golden-path.spec.ts and host-move.spec.ts.
 *
 * What only a browser shows: that two tuning rows genuinely coexist inside the
 * fixed-width rail with the second still operable rather than clipped away.
 */
test.describe('compound scenario stack (#323)', () => {
  test.use({ viewport: SIDE_BY_SIDE });

  test('stacks two what-ifs, keeps both rows operable, and removes them one at a time', async ({
    page,
    request,
  }) => {
    const clusterName = `CL-E2E-STACK-${Date.now().toString(36)}`;
    let clusterId: string | null = null;

    try {
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
      clusterId = /\/clusters\/([^/?#]+)/.exec(page.url())?.[1] ?? null;

      // A host with RECORDED capacity is what makes `lose_hosts` applicable —
      // without it the preset is (correctly) gated and there is no second step.
      const panel = page.locator('.cluster-panel');
      await panel.getByRole('tab', { name: 'Hosts' }).click();
      await panel.getByRole('button', { name: 'Add host' }).click();
      const hostDialog = page.getByRole('dialog', { name: 'Add host' });
      await hostDialog.getByRole('textbox', { name: 'Name' }).fill('stack-host');
      await hostDialog
        .getByRole('spinbutton', { name: 'Initial memory capacity (GB)' })
        .fill('512');
      await hostDialog.getByRole('button', { name: 'Add host' }).click();
      await expect(hostDialog).toBeHidden();

      await openScenarioRail(page);

      // Both presets are live on this cluster — no conditional path.
      const lose = page.getByTestId('scenario-preset-lose_hosts');
      const add = page.getByTestId('scenario-preset-add_vms');
      await expect(lose).toHaveAttribute('aria-disabled', 'false');
      await expect(add).toHaveAttribute('aria-disabled', 'false');

      await lose.click();
      await add.click();

      // Two rows coexist — the thing the single-scenario rail could not do.
      await expect(page.getByTestId('scenario-step-lose_hosts')).toBeVisible();
      await expect(page.getByTestId('scenario-step-add_vms')).toBeVisible();
      await expect(lose).toHaveAttribute('aria-pressed', 'true');
      await expect(add).toHaveAttribute('aria-pressed', 'true');

      // Rows render in canonical order (lose → add), matching the server's fold.
      const rows = page.locator('[data-testid^="scenario-step-"]:not([data-testid*="remove"])');
      await expect(rows).toHaveCount(2);
      expect(
        await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid'))),
      ).toEqual(['scenario-step-lose_hosts', 'scenario-step-add_vms']);

      // Both the summary and the closed-rail indicator name the WHOLE compound.
      await expect(page.getByTestId('scenario-summary')).toContainText('+');
      await expect(page.getByTestId('scenario-active-indicator')).toContainText('+');

      // The SECOND row's slider is genuinely reachable and operable — not clipped
      // out of the fixed-width rail.
      const second = page.getByTestId('scenario-step-add_vms').getByLabel('VM count');
      await second.scrollIntoViewIfNeeded();
      await expect(second).toBeVisible();
      await second.focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.getByTestId('scenario-total')).toContainText('GB added');

      // Removing one step leaves the other active — not a drop to baseline.
      await page.getByTestId('scenario-step-remove-lose_hosts').click();
      await expect(page.getByTestId('scenario-step-lose_hosts')).toHaveCount(0);
      await expect(page.getByTestId('scenario-step-add_vms')).toBeVisible();
      await expect(page.getByTestId('scenario-active-indicator')).toBeVisible();

      // Removing the last one restores the baseline: the indicator is the only cue
      // a closed rail leaves behind, so it must go.
      await page.getByTestId('scenario-step-remove-add_vms').click();
      await expect(page.getByTestId('scenario-summary')).toHaveCount(0);
      await expect(page.getByTestId('scenario-active-indicator')).toHaveCount(0);
    } finally {
      if (clusterId) {
        await request.delete(`http://localhost:8090/api/clusters/${clusterId}`);
      }
    }
  });
});
