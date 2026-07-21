import { expect, test } from '@playwright/test';

/**
 * End-to-end coverage for the bulk date-shift flow (#256 / #261), which shipped
 * with React Testing Library unit tests only — RTL renders no CSS, so nothing
 * had ever exercised the flow against a real server in a real browser, nor been
 * looked at in either theme (#264).
 *
 * Two tests:
 *  1. The golden path — select every entry, preview old → new, apply, and see
 *     the shifted dates land in the table and the store (verified via the API).
 *  2. The two blocking alert states — out-of-range and collision — which are the
 *     `text-destructive` surfaces the issue specifically wanted eyeballed.
 *
 * Both capture light + dark screenshots of the selection bar and the dialog into
 * the (gitignored) `test-results/` output dir, so the visual surfaces the issue
 * flags — the steel selection bar, the scrolling preview list with a truncating
 * name, the arrow, the mono/tabular new date, and the destructive alerts — have
 * durable artifacts to review in both themes.
 *
 * Setup is API-driven for speed and volume; the UI drives the actual flow.
 * Each test cleans up its own cluster so the dev DB stays tidy.
 */

const API_BASE = 'http://localhost:8090';
const MEMORY_METRIC = 'memory_gb';

const suffix = (): string =>
  `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

test.describe('bulk-shift dates', () => {
  test('selects every entry, previews old → new, applies, and reflects the shift', async ({
    page,
    request,
  }, testInfo) => {
    const clusterName = `CL-BULK-${suffix()}`;
    let clusterId: string | null = null;

    // Default theme = system, so `emulateMedia({ colorScheme })` drives the
    // light/dark screenshots without a reload that would close the dialog.
    await page.addInitScript(() => {
      try {
        localStorage.removeItem('theme');
      } catch {
        // localStorage may be unavailable in some contexts; ignore.
      }
    });

    try {
      const createResp = await request.post(`${API_BASE}/api/clusters`, {
        data: {
          name: clusterName,
          baselineDate: '2026-01-01',
          baselines: [
            { metricTypeKey: MEMORY_METRIC, baselineConsumption: 1000, baselineCapacity: 5000 },
          ],
        },
      });
      expect(createResp.status()).toBe(201);
      clusterId = (await createResp.json()).id as string;

      // 12 events on distinct days of one month → a 12-row preview that scrolls
      // the max-h-64 list, with a deliberately long first name to exercise the
      // row's `truncate`. Days are unique so no old date equals any new date
      // after the +1-month shift (keeps every date assertion unambiguous).
      const longName =
        'Extremely-Long-Event-Name-That-Must-Truncate-In-The-Preview-Row-Without-Wrapping-Or-Breaking-Layout';
      const events = Array.from({ length: 12 }, (_, i) => ({
        kind: 'event' as const,
        name: i === 0 ? longName : `evt-${String(i).padStart(2, '0')}-${suffix()}`,
        category: 'General',
        effectiveDate: `2026-06-${String(i + 2).padStart(2, '0')}`,
        metricTypeKey: MEMORY_METRIC,
        consumptionDelta: 100,
      }));
      for (const event of events) {
        const resp = await request.post(`${API_BASE}/api/clusters/${clusterId}/items`, {
          data: event,
        });
        expect(resp.status()).toBe(201);
      }

      await page.goto('/');
      await page.getByRole('link', { name: clusterName }).click();
      const panel = page.locator('.cluster-panel');
      await panel.getByRole('tab', { name: 'Apps & Events' }).click();

      // Select every entry via the header checkbox.
      await panel.getByRole('checkbox', { name: 'Select all apps and events' }).check();
      await expect(panel.getByText('12 selected')).toBeVisible();

      // Selection action bar (surface 1) in both themes.
      const selectionBar = panel.getByText('12 selected').locator('..');
      await page.emulateMedia({ colorScheme: 'light' });
      await expect(page.locator('html')).not.toHaveClass(/dark/);
      await selectionBar.screenshot({ path: testInfo.outputPath('selection-bar-light.png') });
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(page.locator('html')).toHaveClass(/dark/);
      await selectionBar.screenshot({ path: testInfo.outputPath('selection-bar-dark.png') });

      // Open the shift dialog (defaults to Later / 1 / Months).
      await panel.getByRole('button', { name: 'Shift dates…' }).click();
      const dialog = page.getByRole('dialog', { name: /Shift dates for 12 entries/ });
      await expect(dialog).toBeVisible();

      // Preview shows old → new for the long-named first entry: 2026-06-02
      // (line-through) → 2026-07-02. Both strings are unique across the list.
      await expect(dialog.getByText('2026-06-02')).toBeVisible();
      await expect(dialog.getByText('2026-07-02')).toBeVisible();
      await expect(dialog.getByRole('listitem')).toHaveCount(12);
      await expect(dialog.getByText(longName)).toBeVisible();

      // Regression guard for the grid-overflow bug (#264): a long, unbroken name
      // must truncate, not blow the dialog's grid column past its own width and
      // shove the old→new dates off the right edge. `toBeVisible()` alone does
      // not catch it — the dates stay "visible" in the 1280px viewport while
      // sitting outside the 576px dialog. Assert the new date's right edge is
      // within the dialog's right edge instead.
      const dialogBox = await dialog.boundingBox();
      const newDateBox = await dialog.getByText('2026-07-02').boundingBox();
      expect(dialogBox).not.toBeNull();
      expect(newDateBox).not.toBeNull();
      if (dialogBox && newDateBox) {
        expect(newDateBox.x + newDateBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width);
      }

      // The dialog (surfaces 2 + 4: preview list, truncating name, arrow, mono
      // new date; and the header) in both themes.
      await page.emulateMedia({ colorScheme: 'dark' });
      await dialog.screenshot({ path: testInfo.outputPath('dialog-dark.png') });
      await page.emulateMedia({ colorScheme: 'light' });
      await dialog.screenshot({ path: testInfo.outputPath('dialog-light.png') });

      // Apply.
      await dialog.getByRole('button', { name: 'Shift 12 entries' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText('Shifted 12 entries by 1 months')).toBeVisible();

      // The table now shows the shifted date for the long-named entry…
      await expect(panel.getByRole('cell', { name: '2026-07-02' })).toBeVisible();
      await expect(panel.getByRole('cell', { name: '2026-06-02' })).toHaveCount(0);

      // …and the store agrees (format-independent proof the shift persisted).
      const after = await request.get(`${API_BASE}/api/clusters/${clusterId}/items?limit=100`);
      const afterDates = ((await after.json()).items as { effectiveDate: string }[])
        .map((i) => i.effectiveDate)
        .sort();
      expect(afterDates).toEqual(
        Array.from({ length: 12 }, (_, i) => `2026-07-${String(i + 2).padStart(2, '0')}`),
      );
    } finally {
      if (clusterId) {
        const del = await request.delete(`${API_BASE}/api/clusters/${clusterId}`);
        expect(del.status()).toBe(204);
      }
    }
  });

  test('surfaces the out-of-range and collision alerts (both destructive states)', async ({
    page,
    request,
  }, testInfo) => {
    const clusterName = `CL-BULK-ALERT-${suffix()}`;
    let clusterId: string | null = null;

    await page.addInitScript(() => {
      try {
        localStorage.removeItem('theme');
      } catch {
        // ignore
      }
    });

    try {
      const createResp = await request.post(`${API_BASE}/api/clusters`, {
        data: {
          name: clusterName,
          baselineDate: '2026-01-01',
          baselines: [
            { metricTypeKey: MEMORY_METRIC, baselineConsumption: 1000, baselineCapacity: 5000 },
          ],
        },
      });
      expect(createResp.status()).toBe(201);
      clusterId = (await createResp.json()).id as string;

      // An event at the far edge of the supported range (max is 2999-12-31): a
      // +1-month shift lands in year 3000 → "out of range".
      const boundary = await request.post(`${API_BASE}/api/clusters/${clusterId}/items`, {
        data: {
          kind: 'event',
          name: 'evt-boundary',
          category: 'General',
          effectiveDate: '2999-12-15',
          metricTypeKey: MEMORY_METRIC,
          consumptionDelta: 50,
        },
      });
      expect(boundary.status()).toBe(201);

      // An application whose two allocation dates (Jan 30 + Jan 31) both clamp to
      // Feb 28 under a +1-month shift → they collide on the same day.
      const collide = await request.post(`${API_BASE}/api/clusters/${clusterId}/items`, {
        data: {
          kind: 'application',
          name: 'app-collision',
          category: 'General',
          effectiveDate: '2026-01-30',
          allocations: [
            { metricTypeKey: MEMORY_METRIC, effectiveFrom: '2026-01-30', amount: 100 },
            { metricTypeKey: MEMORY_METRIC, effectiveFrom: '2026-01-31', amount: 120 },
          ],
        },
      });
      expect(collide.status()).toBe(201);

      await page.goto('/');
      await page.getByRole('link', { name: clusterName }).click();
      const panel = page.locator('.cluster-panel');
      await panel.getByRole('tab', { name: 'Apps & Events' }).click();

      await panel.getByRole('checkbox', { name: 'Select all apps and events' }).check();
      await expect(panel.getByText('2 selected')).toBeVisible();
      await panel.getByRole('button', { name: 'Shift dates…' }).click();
      const dialog = page.getByRole('dialog', { name: /Shift dates for 2 entries/ });
      await expect(dialog).toBeVisible();

      // Both destructive alerts (surface 3) render at the default +1-month shift.
      await expect(dialog.getByText(/lands outside the supported date range/)).toBeVisible();
      await expect(
        dialog.getByText(/put two of its allocation dates on the same day/),
      ).toBeVisible();
      // Apply is blocked while any row is flagged.
      await expect(dialog.getByRole('button', { name: /^Shift 2 entries$/ })).toBeDisabled();

      await page.emulateMedia({ colorScheme: 'dark' });
      await expect(page.locator('html')).toHaveClass(/dark/);
      await dialog.screenshot({ path: testInfo.outputPath('alerts-dark.png') });
      await page.emulateMedia({ colorScheme: 'light' });
      await expect(page.locator('html')).not.toHaveClass(/dark/);
      await dialog.screenshot({ path: testInfo.outputPath('alerts-light.png') });
    } finally {
      if (clusterId) {
        const del = await request.delete(`${API_BASE}/api/clusters/${clusterId}`);
        expect(del.status()).toBe(204);
      }
    }
  });
});
