# UI Refresh — Enterprise Polish & Dark Mode

_Date: 2026-05-23_
_Source vision: [`docs/vision.md`](../../vision.md)_
_Builds on: [`2026-05-22-lcm-v1-design.md`](2026-05-22-lcm-v1-design.md)_

## Goal

Refresh the LCM web UI so it reads as a polished internal enterprise tool, with first-class dark mode and small power-user affordances (sidebar nav, breadcrumbs, command palette, keyboard shortcuts). Presentation layer only — no API, schema, or business-logic changes.

## Clarifications (locked in 2026-05-23)

| Topic            | Decision                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| Visual direction | Linear / Vercel "sleek" aesthetic — restrained, typography-forward                                                 |
| Palette flavor   | Slate-zinc neutrals + indigo primary (research palette B, tuned)                                                   |
| Theme default    | `system` (prefers-color-scheme) with manual override + `localStorage` persistence                                  |
| Scope ceiling    | Visual polish + dark mode + sidebar nav + breadcrumbs + ⌘K command palette + `?` shortcuts help                    |
| Out of scope     | Accent-color customization UI, server-side theme persistence, multi-language, high-contrast variant beyond WCAG AA |

## Non-goals

- Component library swap (keep shadcn-style + Radix primitives already in use).
- Recharts replacement.
- Touching `apps/api`, Prisma schema, or `packages/shared`.
- Restructuring TanStack routes — only what's inside the route components changes.

---

## Architecture

### Token model

A two-tier color system:

1. **Semantic CSS custom properties** declared on `:root` (light values) and overridden under `html.dark` (dark values). Names match shadcn conventions so the existing utilities (`bg-card`, `text-muted-foreground`, etc.) keep working with no per-component `dark:` variants.
2. **Tailwind v4 `@theme` block** maps `--color-*` names onto the semantic vars so all Tailwind utilities derive from the same source of truth.

```css
/* apps/web/src/styles.css (excerpt — full token list below) */
@import 'tailwindcss';
@import '@fontsource/inter/400.css';
@import '@fontsource/inter/500.css';
@import '@fontsource/inter/600.css';
@import '@fontsource/inter/700.css';
@import '@fontsource/jetbrains-mono/400.css';
@import '@fontsource/jetbrains-mono/600.css';

:root {
  --background: oklch(99% 0.005 257);
  --foreground: oklch(15% 0.02 0);
  --card: oklch(100% 0 0);
  --card-foreground: oklch(15% 0.02 0);
  --popover: oklch(100% 0 0);
  --popover-foreground: oklch(15% 0.02 0);
  --muted: oklch(96% 0.005 257);
  --muted-foreground: oklch(50% 0.02 257);
  --border: oklch(90% 0.01 257);
  --input: oklch(90% 0.01 257);
  --ring: oklch(50% 0.22 262);
  --primary: oklch(50% 0.22 262);
  --primary-foreground: oklch(99% 0.005 257);
  --secondary: oklch(94% 0.01 257);
  --secondary-foreground: oklch(15% 0.02 0);
  --accent: oklch(94% 0.02 250);
  --accent-foreground: oklch(15% 0.02 0);
  --success: oklch(60% 0.18 142);
  --success-foreground: oklch(99% 0.005 257);
  --warning: oklch(70% 0.2 80);
  --warning-foreground: oklch(15% 0.02 0);
  --destructive: oklch(58% 0.22 25);
  --destructive-foreground: oklch(99% 0.005 257);
  --radius: 0.5rem;
}

html.dark {
  --background: oklch(13% 0.01 257);
  --foreground: oklch(96% 0.005 257);
  --card: oklch(18% 0.01 257);
  --card-foreground: oklch(96% 0.005 257);
  --popover: oklch(22% 0.01 257);
  --popover-foreground: oklch(96% 0.005 257);
  --muted: oklch(22% 0.01 257);
  --muted-foreground: oklch(68% 0.02 257);
  --border: oklch(28% 0.01 257);
  --input: oklch(28% 0.01 257);
  --ring: oklch(68% 0.18 262);
  --primary: oklch(68% 0.18 262);
  --primary-foreground: oklch(13% 0.01 257);
  --secondary: oklch(24% 0.01 257);
  --secondary-foreground: oklch(96% 0.005 257);
  --accent: oklch(28% 0.02 250);
  --accent-foreground: oklch(96% 0.005 257);
  --success: oklch(72% 0.12 142);
  --success-foreground: oklch(13% 0.01 257);
  --warning: oklch(78% 0.14 80);
  --warning-foreground: oklch(13% 0.01 257);
  --destructive: oklch(70% 0.18 25);
  --destructive-foreground: oklch(13% 0.01 257);
}

@theme {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-success: var(--success);
  --color-success-foreground: var(--success-foreground);
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --radius: var(--radius);
  --font-sans: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
}
```

Surface elevation in dark mode is communicated by lightness (L\* 13 → 18 → 22 → 28), not by shadow. Light mode uses `shadow-xs` for cards and tightens borders relative to today.

### Theme provider

New module `apps/web/src/components/theme/`:

- `theme-provider.tsx` — React context exposing `{ theme: 'light' | 'dark' | 'system', resolvedTheme: 'light' | 'dark', setTheme }`. Wraps `<AppShell />` at the root route.
- `use-theme.ts` — hook that reads `localStorage.theme` on mount, falls back to `matchMedia('(prefers-color-scheme: dark)')`, and listens for OS-level changes when `theme === 'system'`.
- `theme-toggle.tsx` — header icon button cycling `system → light → dark` (icons: `Monitor`, `Sun`, `Moon`). Tooltip shows the resolved value when in `system` mode.

A small inline script in `apps/web/index.html` runs before React mounts:

```html
<script>
  (function () {
    try {
      var stored = localStorage.getItem('theme');
      var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      var dark = stored === 'dark' || ((!stored || stored === 'system') && prefersDark);
      if (dark) document.documentElement.classList.add('dark');
    } catch (e) {}
  })();
</script>
```

This eliminates flash-of-wrong-theme during the first paint.

---

## Layout & navigation

### App shell

`app-shell.tsx` becomes a two-column layout:

```
┌─────────────────────────────────────────────────────────────┐
│ header (56px)                                                │
│  logo · breadcrumbs                · health · ⌘K · ☼ · ⌥    │
├──────────┬──────────────────────────────────────────────────┤
│ sidebar  │                                                  │
│ (240px / │                                                  │
│  64px)   │            main (max-w-7xl, p-6)                 │
│          │                                                  │
│  ▣ Dash  │                                                  │
│  ⚙ Sett  │                                                  │
│          │                                                  │
└──────────┴──────────────────────────────────────────────────┘
```

- **Header (56px)** — logo + product name, breadcrumb (driven by current route), API health pill, `⌘K` button, theme toggle. Sticky.
- **Sidebar (240px expanded / 64px collapsed)** — Dashboard, Settings, with placeholder for future groups. Collapse state persists in `localStorage.sidebar` (`'expanded' | 'collapsed'`). The hamburger that toggles it lives in the sidebar footer.
- **Main** — `flex-1 min-w-0` so the table can fill width; inner content wraps at `max-w-7xl` for the dashboard table and `max-w-3xl` for forms.

### Breadcrumbs

New `components/layout/breadcrumbs.tsx` consumes TanStack Router's `useMatches()`:

- `/` → `Dashboard`
- `/clusters/$id` → `Dashboard › {cluster.name}` (cluster name resolved from `useQuery(['cluster', id])`; placeholder skeleton while loading)
- `/clusters/new` → `Dashboard › New cluster`
- `/settings` → `Settings`

Separator is a chevron-right icon at `text-muted-foreground/60`.

---

## Components

### New primitives

- **`components/ui/card.tsx`** — `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`. `bg-card border border-border rounded-lg shadow-xs` in light, no shadow in dark. Replaces inline `rounded-lg border bg-card p-4` strings across `forecast-chart.tsx`, `utilization-panel.tsx`, `cluster-table.tsx`, the empty state, and detail-page sections.
- **`components/ui/tooltip.tsx`** — wraps `@radix-ui/react-tooltip`. Used by theme toggle, breadcrumb truncation, and any future use.
- **`components/ui/kbd.tsx`** — `<kbd>` styled as a small key cap (`px-1.5 py-0.5 rounded border border-border bg-muted text-[10px] font-mono`). Used in the command palette item rows and the shortcuts dialog.

### Updated primitives

- **`badge.tsx`** — variant colors switch from raw Tailwind palette (`bg-emerald-100 text-emerald-900` etc.) to theme tokens with alpha modifiers: `bg-success/15 text-success border-success/30`. Same for `warning` and `danger`/`destructive`. Default and `secondary` already use tokens — unchanged. Adds an optional `dot` boolean that prefixes a 6px filled circle in the same hue.
- **`button.tsx`** — only change is the focus ring: `focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background` (was `ring-offset` against an implicit background).
- **`utilization-badge.tsx`** — keeps the 0.7/0.9 thresholds, but now passes `dot` to `Badge` so the status reads via shape as well as color.

### Charts

New `apps/web/src/lib/use-chart-colors.ts`:

```ts
export interface ChartColors {
  consumption: string;
  capacity: string;
  grid: string;
  axis: string;
  tooltipBg: string;
  tooltipBorder: string;
  event: Record<EventCategory, string>;
}

export function useChartColors(): ChartColors {
  const { resolvedTheme } = useTheme();
  return useMemo(() => readChartTokens(), [resolvedTheme]);
}
```

`readChartTokens()` calls `getComputedStyle(document.documentElement)` once and returns a struct of resolved CSS variables. The `useMemo` dependency on `resolvedTheme` ensures it re-runs whenever the user toggles modes — at that point `html.dark` has already been mutated by the theme provider's effect, so the computed styles reflect the new palette. `forecast-chart.tsx`, `sparkline.tsx`, and `utilization-panel.tsx` consume this hook and drop their hardcoded `oklch(...)` strings.

Event-category colors get dark-mode variants:

| Category          | Light                 | Dark                  |
| ----------------- | --------------------- | --------------------- |
| `growth`          | `oklch(60% 0.15 50)`  | `oklch(75% 0.12 50)`  |
| `hardware_change` | `oklch(55% 0.18 145)` | `oklch(72% 0.13 145)` |
| `openshift`       | `oklch(55% 0.20 290)` | `oklch(72% 0.15 290)` |
| `note`            | `oklch(55% 0.02 260)` | `oklch(70% 0.02 260)` |

### Typography & icons

- `--font-sans: 'Inter'`, `--font-mono: 'JetBrains Mono'` — self-hosted via `@fontsource/inter` and `@fontsource/jetbrains-mono` (no runtime CDN dependency for an internal app).
- Body 14px / line-height 1.5, captions 12px, h1 24px / h2 18px / h3 16px. h1/h2 use `font-semibold tracking-tight`.
- `tabular-nums` cells in the cluster table get `font-mono` for column alignment.
- Lucide icon sizing: 16px in buttons/badges, 20px inline in lists/tables, 24px in sidebar nav.

### Micro-interactions

`transition-colors duration-150 ease-out` on interactive elements. `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background` everywhere keyboard focus matters. Table rows: `hover:bg-muted/50`. No bounces, no scale animations, no parallax.

---

## Command palette & shortcuts

### Dependency

Add `cmdk` (~5 KB gzipped). Same library shadcn uses; small and well-maintained.

### Palette content

`components/command/command-palette.tsx` — mounted at the root, listens globally for `⌘K` / `Ctrl+K`. Backed by Radix Dialog so `Esc` closes it for free.

Groups, in order:

1. **Navigation** — Dashboard (`g d`), Settings (`g s`)
2. **Clusters** — dynamic from `useQuery(['clusters'])`. Each item: cluster name + memory utilization badge + monospace ID suffix. Selecting it navigates to `/clusters/$id`.
3. **Actions** — `Create cluster` (opens existing `CreateClusterDialog`), `Toggle theme` (cycles `system → light → dark`), `View shortcuts`
4. **Theme** — direct `Light`, `Dark`, `System` choices

The trigger button in the header is a small `kbd`-styled chip showing `⌘K` (or `Ctrl K` on non-Mac, detected via `navigator.platform`).

### Shortcuts dialog

`components/command/shortcuts-dialog.tsx` — opened by `?` (when no input is focused) or via the palette. A small Radix Dialog listing:

- `⌘K` — Command palette
- `?` — This shortcuts list
- `Esc` — Close any modal / drawer
- `g d` — Go to dashboard
- `g s` — Go to settings
- `/` (deferred — not in v1 of this refresh)

A separate `keyboard-shortcuts.tsx` component, mounted at the root next to the command palette, listens for `g` followed by `d`/`s` within 1 second when no input is focused and calls `router.navigate(...)`. It also handles `?` (open shortcuts dialog) and `⌘K` / `Ctrl+K` (open palette) so all global keys live in one file.

---

## Empty / loading / error states

- `empty-state.tsx`: keep the layout; swap `Sparkles` for `Database` (more on-domain); use the new `Card` primitive with `border-dashed`. Keep the "Seed sample data (dev)" affordance unchanged.
- Skeletons: keep their layout-preserving shape; switch from `bg-muted/60` literals to `bg-muted` via the new token (which already gives ~60% lightness contrast against `background` in both modes).
- Error cards: new pattern — `Card` with `border-destructive/40 bg-destructive/5 text-destructive`, replacing the inline divs in `routes/index.tsx`, `routes/clusters.$id.tsx`. Add an `AlertTriangle` icon at 16px.

---

## File map

**New files:**

- `apps/web/src/components/theme/theme-provider.tsx`
- `apps/web/src/components/theme/use-theme.ts`
- `apps/web/src/components/theme/theme-toggle.tsx`
- `apps/web/src/components/command/keyboard-shortcuts.tsx` _(global key handler — colocated with the palette)_
- `apps/web/src/components/layout/sidebar.tsx`
- `apps/web/src/components/layout/breadcrumbs.tsx`
- `apps/web/src/components/command/command-palette.tsx`
- `apps/web/src/components/command/shortcuts-dialog.tsx`
- `apps/web/src/components/ui/card.tsx`
- `apps/web/src/components/ui/tooltip.tsx`
- `apps/web/src/components/ui/kbd.tsx`
- `apps/web/src/lib/use-chart-colors.ts`
- `apps/web/src/__tests__/use-theme.test.ts`
- `apps/web/src/__tests__/command-palette.test.tsx`

**Modified:**

- `apps/web/src/styles.css` — token rewrite + fonts
- `apps/web/index.html` — pre-mount theme script
- `apps/web/package.json` — `cmdk`, `@radix-ui/react-tooltip`, `@fontsource/inter`, `@fontsource/jetbrains-mono`
- `apps/web/src/main.tsx` — wrap with `ThemeProvider` and mount `<CommandPalette />` + `<KeyboardShortcuts />` siblings
- `apps/web/src/components/layout/app-shell.tsx` — sidebar layout, breadcrumb integration, header trim
- `apps/web/src/components/ui/badge.tsx` — token-based variants + `dot`
- `apps/web/src/components/ui/button.tsx` — focus-ring refinement
- `apps/web/src/components/clusters/utilization-badge.tsx` — pass `dot`
- `apps/web/src/components/clusters/forecast-chart.tsx` — `useChartColors()`
- `apps/web/src/components/clusters/sparkline.tsx` — `useChartColors()`
- `apps/web/src/components/clusters/utilization-panel.tsx` — `useChartColors()` + `Card`
- `apps/web/src/components/clusters/cluster-table.tsx` — wrap in `Card`, mono tabular cells
- `apps/web/src/components/clusters/empty-state.tsx` — `Card` + `Database` icon
- `apps/web/src/routes/index.tsx` — error card refactor
- `apps/web/src/routes/clusters.$id.tsx` — error card refactor, breadcrumb-aware page header
- `apps/web/src/routes/clusters.new.tsx`, `apps/web/src/routes/settings.tsx` — wrap content in `Card` where appropriate

**Untouched:**

- `apps/api/**`, `packages/shared/**`, Prisma schema and migrations, `docker/**`, `docker-compose*.yml`, all CI workflows.

---

## Testing

- **Existing unit tests** (`cluster-table.test.tsx`, `create-cluster-dialog.test.tsx`, `forecast-chart.test.tsx`) — add `ThemeProvider` wrapper to the shared test setup so components render with default tokens. No behavior assertions change.
- **New unit tests:**
  - `use-theme.test.ts` — mocks `localStorage` + `matchMedia`, verifies `system → light → dark` cycle, persistence, and OS-preference listener cleanup.
  - `command-palette.test.tsx` — verifies `⌘K` / `Ctrl+K` opens it, items filter on input, selecting a cluster navigates correctly (router mock).
- **Playwright golden-path** (`playwright/golden-path.spec.ts`) — append one block: open theme toggle → click → `html` has class `dark` → click twice more → back to `light`. Default test environment continues to use system preference (light).
- **Manual visual check:** run `pnpm --filter @lcm/web dev`, exercise dashboard + detail page + dialogs in both light and dark, verify chart colors track the theme, and confirm the command palette filters live.

Verification commands:

```bash
pnpm --filter @lcm/web lint
pnpm --filter @lcm/web typecheck
pnpm --filter @lcm/web test
pnpm --filter @lcm/web test:e2e
pnpm --filter @lcm/web build
```

All must pass before merge.

---

## Risks & mitigations

| Risk                                                                              | Mitigation                                                                                                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Chart-color hook re-renders on every theme toggle but Recharts re-mounts heavily  | `useMemo` keyed on `resolvedTheme`; Recharts already runs with `isAnimationActive={false}` so the re-render is one paint       |
| Sidebar collapse layout glitches mid-animation                                    | Persist final state; collapse uses `width` transition only, no overflow-shifts; verified on dashboard + detail in manual check |
| Pre-mount theme script crashes if `localStorage` is disabled                      | Wrapped in `try/catch`; failure mode is "always light," not "broken app"                                                       |
| `cmdk` keyboard handlers conflict with Radix Dialog focus traps                   | Mount palette as its own Radix Dialog; `cmdk` is designed for this pattern                                                     |
| Inter font load delays first paint                                                | `@fontsource` ships with `font-display: swap`; system stack fallback in `--font-sans` is acceptable                            |
| Existing Playwright golden path breaks if selectors depend on prior DOM structure | Audit the spec before changing layout; keep semantic landmarks (`<main>`, `<header>`, role attrs) intact                       |

---

## Acceptance criteria

1. The app renders correctly in both light and dark mode with no flash-of-wrong-theme on initial load.
2. Theme toggle in the header cycles `system → light → dark` and persists the choice; `system` mode tracks OS changes live.
3. Sidebar replaces the top-nav row; breadcrumb in the header reflects current route and cluster name.
4. `⌘K` (or `Ctrl+K`) opens a command palette that filters across navigation, clusters, and actions; `?` opens the shortcuts dialog.
5. Recharts forecast and sparklines use theme-aware colors; no hardcoded `oklch(...)` literals remain in chart files.
6. All status badges (success / warning / destructive) read correctly in both modes.
7. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build` all pass on the web workspace.
8. No changes outside `apps/web/**` and the design doc itself.
