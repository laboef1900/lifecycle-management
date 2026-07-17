import { expect, type Page } from '@playwright/test';

/**
 * Asserts the desktop app-shell contains vertical scrolling to `<main>`: the
 * document itself must never scroll (so the topbar stays pinned), and
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
 * Post-mission-bento-redesign: the sidebar/aside is gone. The pinned landmark
 * is now the topbar's `<nav aria-label="Primary navigation">` inside the
 * sticky `<header>` (see `components/layout/app-shell.tsx`) — same
 * "stays put while <main> scrolls" invariant, different element.
 */
export async function assertShellContainsScroll(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 720 }); // wide enough for the desktop topbar
  await expect(page.locator('header nav[aria-label="Primary navigation"]')).toBeVisible();

  const r = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('main')!;
    const nav = document.querySelector<HTMLElement>('header nav[aria-label="Primary navigation"]')!;

    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;top:3000px;left:0;width:1px;height:1px';
    main.appendChild(probe);
    try {
      const navTop = Math.round(nav.getBoundingClientRect().top);
      window.scrollTo(0, 10_000);
      const docScrollY = Math.round(window.scrollY);
      const navMoved = Math.round(nav.getBoundingClientRect().top) - navTop;
      window.scrollTo(0, 0);
      main.scrollTop = 10_000;
      const mainScroll = Math.round(main.scrollTop);
      main.scrollTop = 0;
      return { docScrollY, navMoved, mainScroll };
    } finally {
      probe.remove();
    }
  });

  expect(r.docScrollY, 'the document must not scroll').toBe(0);
  expect(r.navMoved, 'the topbar nav must stay pinned when content overflows').toBe(0);
  expect(
    r.mainScroll,
    '<main> must be the scroll container for overflowing content',
  ).toBeGreaterThan(0);
}
