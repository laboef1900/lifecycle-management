import { expect, test } from '@playwright/test';

import { assertShellContainsScroll } from './support/scroll-containment';

// Desktop app-shell (>= lg) must contain vertical scrolling to <main>: the
// document itself must never scroll, so the topbar stays pinned. Regression
// guard for the bug where the shell used `min-h-screen` and <main> only
// carried an implicit overflow, letting the whole document — and the chrome
// with it — scroll. Post-mission-bento-redesign: the pinned landmark is the
// topbar nav (the sidebar/aside is gone — see support/scroll-containment).
test.describe('desktop app-shell scroll containment', () => {
  test('document does not scroll; topbar stays pinned while main scrolls', async ({ page }) => {
    await page.goto('/');
    await assertShellContainsScroll(page);
  });
});

// `/clusters` was the old Clusters-page route; the fleet console merge (spec
// §4) retired it in favor of `/` (the console now covers both former pages).
// The route's `beforeLoad` throws a redirect to `/` — regression guard for
// that contract (spec §2).
test.describe('/clusters redirect', () => {
  test('redirects to / (retired route from the pre-merge Clusters page)', async ({ page }) => {
    await page.goto('/clusters');
    await expect(page).toHaveURL('/');
  });
});

// #243 Part B (Medium): the fleet verdict's instrument row used to draw
// dividers as standalone flex items, which could strand one at the end of a
// wrapped line with nothing after it (verified in the audit at 768px — row
// one ended "FLEET N CLUSTERS · M HOSTS" trailing a dangling rule while the
// remaining instruments wrapped to a second line). Fixed by attaching the
// divider to each instrument (border-l) instead of a separate element — a
// real-layout regression guard, since jsdom (the unit-test environment)
// never performs actual flex-wrap reflow.
test.describe('fleet verdict instrument row at 768px (finding: dangling divider on wrap)', () => {
  test.use({ viewport: { width: 768, height: 900 } });

  test('all instruments stay visible and no standalone divider element renders', async ({
    page,
  }) => {
    await page.goto('/');
    const verdict = page.getByLabel('Fleet verdict');
    await expect(verdict.getByText('Utilization', { exact: true })).toBeVisible();
    await expect(verdict.getByText('Headroom', { exact: true })).toBeVisible();
    await expect(verdict.getByText('Fleet', { exact: true })).toBeVisible();
    await expect(verdict.getByText('Open orders', { exact: true })).toBeVisible();
    await expect(verdict.getByText('Baselines', { exact: true })).toBeVisible();
    // The old standalone separator (a fixed h-8 w-px hairline span) no
    // longer exists as an independent element to strand mid-wrap.
    await expect(verdict.locator('.w-px')).toHaveCount(0);
  });
});
