import { expect, type Page } from '@playwright/test';

/**
 * Asserts the desktop app-shell contains vertical scrolling to `<main>`: the
 * document itself must never scroll (so the header and sidebar stay pinned), and
 * `<main>` must be the scroll container that clips even its absolutely-positioned
 * descendants.
 *
 * Self-contained: it injects an absolutely-positioned probe far below the fold —
 * the exact shape of the original regression (an `sr-only` caption escaping a
 * `position: static` `<main>`). A correctly-configured shell (`<main>` is
 * `relative` + `overflow-y-auto` inside an `overflow-hidden`, viewport-height
 * wrapper) clips it; a regressed shell lets it stretch the document. Needs no
 * seeded content, so it runs in any auth mode / data state.
 *
 * Assumes the app shell is already rendered (the desktop sidebar is `lg:flex`).
 */
export async function assertShellContainsScroll(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 720 }); // wide enough for the lg sidebar
  await expect(page.locator('aside[aria-label="Primary navigation"]')).toBeVisible();

  const r = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('main')!;
    const sidebar = document.querySelector<HTMLElement>('aside[aria-label="Primary navigation"]')!;

    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;top:3000px;left:0;width:1px;height:1px';
    main.appendChild(probe);
    try {
      const sidebarTop = Math.round(sidebar.getBoundingClientRect().top);
      window.scrollTo(0, 10_000);
      const docScrollY = Math.round(window.scrollY);
      const sidebarMoved = Math.round(sidebar.getBoundingClientRect().top) - sidebarTop;
      window.scrollTo(0, 0);
      main.scrollTop = 10_000;
      const mainScroll = Math.round(main.scrollTop);
      main.scrollTop = 0;
      return { docScrollY, sidebarMoved, mainScroll };
    } finally {
      probe.remove();
    }
  });

  expect(r.docScrollY, 'the document must not scroll').toBe(0);
  expect(r.sidebarMoved, 'the sidebar must stay pinned when content overflows').toBe(0);
  expect(
    r.mainScroll,
    '<main> must be the scroll container for overflowing content',
  ).toBeGreaterThan(0);
}
