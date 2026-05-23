# Apple-like Polish — Design Spec

_Date: 2026-05-23_
_Source vision: [`docs/vision.md`](../../vision.md)_
_Builds on: [`2026-05-23-ui-refresh-enterprise-dark-mode-design.md`](2026-05-23-ui-refresh-enterprise-dark-mode-design.md)_

## Goal

Lean the already-shipped Linear/Vercel-sleek UI further toward the look and feel of a native macOS app (Linear / Notion desktop). Polish-only: heavier corners, frosted translucent navigation chrome, soft layered shadows, a subtle window-like background gradient, refined Kbd key-caps, accent bar on the active sidebar item, and a macOS-app-style logo treatment. No behavior or structural changes.

## Clarifications (locked in 2026-05-23)

| Topic            | Decision                                                                                                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aesthetic target | macOS app chrome / Linear / Notion desktop apps                                                                                                                                                                                                                                     |
| Scope ceiling    | "Full chrome lift" — surfaces + typography + accents + app-icon refinement                                                                                                                                                                                                          |
| Out of scope     | Structural layout changes, new dependencies, behavior changes, route changes, API/schema touches, additional fonts                                                                                                                                                                  |
| Files touched    | `apps/web/src/styles.css`, `apps/web/src/components/ui/{card,kbd}.tsx`, `apps/web/src/components/layout/{sidebar,app-shell}.tsx`, `apps/web/src/components/command/{command-palette,shortcuts-dialog}.tsx`, `apps/web/src/routes/clusters.$id.tsx`, `apps/web/src/routes/index.tsx` |

## Non-goals

- New fonts (Inter + JetBrains Mono stay).
- New dependencies.
- Touching `apps/api`, Prisma, `packages/shared`, Docker.
- Restructuring TanStack routes.
- Changing the palette beyond adding a shadow token and a gradient stop.
- Adding tooltips, motion variants, or animations beyond what's already there.

---

## Architecture

### Token additions

`apps/web/src/styles.css` gains four new entries inside the existing system:

```css
:root {
  /* ...existing tokens unchanged... */
  --radius-card: 0.75rem; /* Cards (12px) */
  --radius-modal: 1rem; /* Dialogs + palette (16px) */
  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.04), 0 4px 12px rgba(0, 0, 0, 0.04);
  --bg-gradient-bottom: oklch(97% 0.005 257); /* Subtle 2% darker than --background */
}

html.dark {
  /* ...existing tokens unchanged... */
  --shadow-card: none; /* Dark mode uses surface elevation, not shadow */
  --bg-gradient-bottom: oklch(11% 0.01 257); /* Subtle 2% darker than dark --background */
}

@theme {
  /* ...existing entries unchanged... */
  --radius-card: var(--radius-card);
  --radius-modal: var(--radius-modal);
  --shadow-card: var(--shadow-card);
}
```

The body background switches from flat `--background` to a top-to-bottom gradient using both tokens:

```css
body {
  background: linear-gradient(180deg, var(--background) 0%, var(--bg-gradient-bottom) 100%);
  background-attachment: fixed;
  /* ...existing font-family + features unchanged... */
}
```

`background-attachment: fixed` ensures the gradient anchors to the viewport, not the scroll position — so the window-like material feel doesn't drift on long pages.

### Card primitive

`apps/web/src/components/ui/card.tsx` — only the base `Card` component changes (sub-parts unchanged):

```tsx
export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-xl border border-border bg-card text-card-foreground shadow-[var(--shadow-card)]',
        className,
      )}
      {...props}
    />
  ),
);
```

The `dark:shadow-none` modifier is unnecessary because `--shadow-card` already resolves to `none` in dark mode via the token redefinition.

### Kbd refinement

`apps/web/src/components/ui/kbd.tsx`:

```tsx
export function Kbd({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement>): React.JSX.Element {
  return (
    <kbd
      className={cn(
        'inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-md',
        'border border-border bg-gradient-to-b from-muted to-muted/60',
        'px-1.5 font-mono text-[11px] font-medium text-muted-foreground',
        'shadow-[inset_0_-1px_0_rgba(0,0,0,0.06)] dark:shadow-[inset_0_-1px_0_rgba(255,255,255,0.04)]',
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}
```

Chunkier (`h-5` → `h-6`, `min-w-[1.25rem]` → `min-w-[1.5rem]`), 11px text instead of 10px, vertical gradient surface, and a subtle inset shadow at the bottom edge to give a key-cap feel. Dark mode flips the inset shadow direction to a light highlight.

### Sidebar — frosted + active accent bar

`apps/web/src/components/layout/sidebar.tsx`:

- `<aside>` outer classes: `bg-card` → `bg-card/60 backdrop-blur-xl` (border stays solid).
- Active nav item gets a 3px-wide primary-color accent on its left edge. Implementation: change the active class string from `bg-muted text-foreground` to `bg-muted text-foreground shadow-[inset_3px_0_0_0_var(--primary)]`. Using an `inset` `box-shadow` rather than `border-l-[3px]` avoids changing the item's box geometry (no padding shift) and is invisible on non-active items.
- Collapsed mode: same treatment, accent still anchors to the left edge.

### App shell — frosted header + app-icon treatment

`apps/web/src/components/layout/app-shell.tsx`:

Header outer class change: `bg-card/95 backdrop-blur` → `bg-card/70 backdrop-blur-xl`. The increased transparency reveals the body gradient through the chrome.

Logo wrapping changes:

```tsx
<Link to="/" className="flex items-center gap-2.5 font-semibold">
  <span
    aria-hidden
    className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/70 shadow-[var(--shadow-card)]"
  >
    <Activity className="h-4 w-4 text-primary-foreground" />
  </span>
  <span className="hidden sm:inline">Capacity Forecast</span>
</Link>
```

A 28×28 rounded-square tile with a soft primary-color gradient holds the existing `Activity` icon — visual nod to a macOS app icon, no new asset.

### Command palette + shortcuts dialog

`apps/web/src/components/command/command-palette.tsx`:

- `Dialog.Content` class string: `rounded-lg` → `rounded-2xl`, `shadow-xl` stays, increase `max-w-[640px]` → `max-w-[680px]`.

`apps/web/src/components/command/shortcuts-dialog.tsx`:

- `Dialog.Content` class: `rounded-lg` → `rounded-2xl`.

Backdrop styling unchanged (already `bg-background/70 backdrop-blur-sm`).

### Typography & section eyebrows

The detail page (`apps/web/src/routes/clusters.$id.tsx`) and the dashboard (`apps/web/src/routes/index.tsx`) bump their `h1` size and add eyebrow text on sub-sections:

- Page `h1`: `text-2xl` → `text-[1.625rem]` (26px), `tracking-tight` unchanged, `font-semibold` unchanged.
- Sub-section headings on the detail page (currently `<h2 className="text-lg font-semibold">Capacity forecast</h2>`) get a small eyebrow above:
  ```tsx
  <div className="space-y-1">
    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      Forecast
    </p>
    <h2 className="text-lg font-semibold">Capacity forecast</h2>
  </div>
  ```
  This eyebrow applies **only** to the "Capacity forecast" sub-section. The page `h1` keeps its existing structure (title + small muted line below) — no eyebrow there. Other sub-sections (Tabs heading, "Monthly utilization" CardTitle) stay as they are.

Body, table cells, badges, and tooltips are unchanged.

### Table row hover

`apps/web/src/components/clusters/cluster-table.tsx`:

- `hover:bg-muted/50` → `hover:bg-muted/60`. One-line tweak.

---

## File map

**Modified:**

- `apps/web/src/styles.css` — 4 new tokens + body gradient
- `apps/web/src/components/ui/card.tsx` — `rounded-xl` + `shadow-[var(--shadow-card)]`
- `apps/web/src/components/ui/kbd.tsx` — chunkier, gradient surface, inset shadow
- `apps/web/src/components/layout/sidebar.tsx` — frosted bg, accent bar on active item
- `apps/web/src/components/layout/app-shell.tsx` — more-transparent header, app-icon tile
- `apps/web/src/components/command/command-palette.tsx` — `rounded-2xl`, larger max-width
- `apps/web/src/components/command/shortcuts-dialog.tsx` — `rounded-2xl`
- `apps/web/src/routes/index.tsx` — h1 26px
- `apps/web/src/routes/clusters.$id.tsx` — h1 26px, eyebrow above "Capacity forecast"
- `apps/web/src/components/clusters/cluster-table.tsx` — hover tweak

**Untouched:** all tests, all API code, all `packages/shared`, all routing, ThemeProvider, KeyboardShortcuts, useChartColors, Recharts components, Toaster, Tooltip, Badge, Button, all dialog content beyond the wrapper class.

---

## Testing

- **Existing tests** (19 unit + 1 Playwright e2e) all pass unchanged. The Playwright theme-cycle assertion is unaffected — `html.dark` toggling logic is untouched. Cluster-table test still finds rows; chart tests unaffected; theme-provider tests unaffected; palette test unaffected (the rounded-2xl class change doesn't break the placeholder-text selector).
- **No new tests required.** The changes are purely visual; behavior contracts are unchanged. A snapshot test would be too brittle for this kind of polish.
- **Manual visual check:** run `pnpm --filter @lcm/web dev`, walk the dashboard, detail page, command palette, and shortcuts dialog in both light and dark modes. Confirm no FOUC, no layout shift on theme toggle, no missing utilities (Tailwind v4 generates the new `--shadow-card`/`--radius-*` utilities once they're declared in `@theme`).

Verification commands:

```bash
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web test
pnpm --filter @lcm/web build
```

All must exit zero.

---

## Risks & mitigations

| Risk                                                                                         | Mitigation                                                                                                                 |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Frosted sidebar+header looks dirty if the body bg gradient isn't subtle enough               | Cap the gradient delta at ~2% L\* — barely perceptible flat-on-flat, only reads under the backdrop blur                    |
| Inset accent bar on sidebar items overflows when the item is rendered in collapsed mode      | `box-shadow inset` doesn't change box geometry; in collapsed mode the accent reads as a 3px stripe down the icon container |
| `--shadow-card: none` in dark mode means the Tailwind utility resolves to `box-shadow: none` | Verified — this is the desired behavior; dark mode separation comes from surface lightness, not shadow                     |
| Body gradient `background-attachment: fixed` could perform poorly on long scroll pages       | Two-stop linear gradient is GPU-cheap; tested on similar setups with no impact                                             |
| App-icon tile crowds the breadcrumb at narrow widths                                         | The breadcrumb is `hidden md:block` already; tile is the same height as the header logo text, no overflow                  |
| Heavier radii on dialogs may clip the cmdk input border-bottom unexpectedly                  | `Command.Input` is in its own row above `Command.List`; the rounded corners only affect the outer container                |

---

## Acceptance criteria

1. Cards render with 12px corners and the new soft layered shadow in light mode; no shadow in dark mode (surface elevation takes over).
2. Sidebar and header read as frosted/translucent — the body gradient is visible through them in both modes.
3. Active sidebar item shows a 3px primary-color accent bar on its left edge in both expanded and collapsed states.
4. Logo is wrapped in a small gradient-filled rounded-square tile.
5. Kbd chips render with chunkier dimensions, a subtle vertical gradient, and an inset depth shadow that flips polarity between light and dark.
6. Command palette + shortcuts dialog have 16px corners; palette `max-w` bumped to 680px.
7. Page `h1` reads at 26px; the "Capacity forecast" section has a small uppercase eyebrow above it.
8. Table row hover background is `bg-muted/60`.
9. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` all pass on the web workspace.
10. No changes outside `apps/web/**` and the design doc itself.
