---
name: LCM — Capacity Command Deck
description: Dark-primary vSphere capacity-forecasting console — steel-led brand, amber reserved for utilization/attention, monospace data, honest gaps.
colors:
  background: '#0e1220'
  foreground: '#e8ecf5'
  card: '#151b2c'
  card-hover: '#1a2136'
  fg-muted: '#8b93a7'
  fg-subtle: '#7c86a0'
  border: '#232b40'
  border-strong: '#314063'
  input: '#10162a'
  accent: '#6ea8ff'
  accent-foreground: '#171c2c'
  steel: '#6ea8ff'
  success: '#3dd68c'
  warning: '#ffc53d'
  destructive: '#ff6b6b'
  chart-consumption: '#c084fc'
typography:
  display:
    fontFamily: 'Space Grotesk, Inter, system-ui, sans-serif'
    fontSize: 'clamp(22px, 2.2vw, 28px)'
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: '-0.025em'
  h1:
    fontFamily: 'Space Grotesk, Inter, system-ui, sans-serif'
    fontSize: '20px'
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: '-0.015em'
  h2:
    fontFamily: 'Space Grotesk, Inter, system-ui, sans-serif'
    fontSize: '16px'
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: '-0.01em'
  body:
    fontFamily: 'Inter, system-ui, sans-serif'
    fontSize: '14px'
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: 'Inter, system-ui, sans-serif'
    fontSize: '10px'
    fontWeight: 500
    letterSpacing: '0.12em'
  numeric:
    fontFamily: 'JetBrains Mono, ui-monospace, monospace'
    fontSize: '14px'
    fontWeight: 500
  numeric-lg:
    fontFamily: 'JetBrains Mono, ui-monospace, monospace'
    fontSize: '20px'
    fontWeight: 500
rounded:
  control: '8px'
  card: '14px'
  modal: '16px'
  pill: '9999px'
spacing:
  card-padding: '14px'
components:
  button-default:
    backgroundColor: '{colors.foreground}'
    textColor: '{colors.background}'
    rounded: '{rounded.control}'
    height: '32px'
    padding: '6px 12px'
  button-accent:
    backgroundColor: '{colors.accent}'
    textColor: '{colors.accent-foreground}'
    rounded: '{rounded.control}'
    height: '32px'
    padding: '6px 12px'
  card:
    backgroundColor: '{colors.card}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.card}'
    padding: '{spacing.card-padding}'
  input:
    backgroundColor: '{colors.background}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.control}'
    height: '32px'
    padding: '4px 10px'
---

# Design System: LCM — Capacity Command Deck

## Overview

**Creative North Star: "The Capacity Command Deck"**

LCM is read the way an operator reads a control deck: a dark, gradient-lit chassis of compartmentalized instrument tiles, each reporting one measured truth. Steel marks the brand and everything interactive; amber is held back for a single job — the utilization signal and anything that needs attention. It is dark-primary by design — a near-black slate backdrop with a fully-designed light sibling in the same hue system — and it treats the numbers as the hero. Data is always set in monospace with tabular figures so a column of capacity values lines up to the digit; chrome recedes so the forecast can speak.

The voice is **quiet and analytical**. This is a reference instrument for a five-person infrastructure team making hardware-purchasing decisions, not a persuasion surface — so it favors restraint over flourish, exactness over emphasis, and honesty over reassurance. Where a value is unknown or a month is a gap, the system shows the gap rather than smoothing it into a confident line; a zero capacity is never painted as "healthy." Trust is earned through accuracy and legibility, and the design's job is to never get in the way of either.

Expression lives in precise details, not decoration: the two-layer steel focus ring on every interactive surface, the taller crit tick that separates severity by shape as well as hue, the single sanctioned glass surface. The implemented token system ships in code as **"Mission Bento"** (`apps/web/src/styles.css`); this document is its design-authority record.

**Key Characteristics:**

- Dark-primary slate chassis, gradient-lit, with a designed light-theme sibling — every choice works in both.
- Steel is the one brand + interaction accent (brand, CTAs, links, focus); amber is reserved for utilization/attention (the meter fill, warn ticks, order deadlines); hero data figures are neutral ink.
- Monospace tabular numerals for all data; Space Grotesk for verdicts and headings; Inter for everything else.
- Compartmentalized "bento" tiles and cards over one soft-shadow elevation; near-flat, honest surfaces.
- One utilization visualization — the linear `BulletMeter` — everywhere.
- Color is never the only signal; honesty about gaps and unknowns is a design rule, not a nicety.

## Colors

A restrained slate-and-steel palette: near-monochrome blue-gray surfaces carry the interface, steel marks brand and interaction, amber is held back for the utilization signal and anything needing attention, and status hues appear only as semantic roles. Every token is a light/dark pair (dark is primary); the values below read **dark / light**.

### Primary

- **Interface Steel** (`--accent` = `--steel`, #6ea8ff / #2f6bd8): The brand **and** interaction accent — the brand mark, primary CTAs (`Button` accent variant), links, tabs, selected states, and the focus ring (`--ring`). Under the cool-brand decision (2026-07-23), `--accent` is unified in value with `--steel`: one calm, analytical hue carries both identity and every actionable affordance.

### Secondary

- **Signal Amber** (`--warning` + `--meter-gradient`, #ffc53d / #865c0c·#8f6400): The one attention/utilization color. It fills the `BulletMeter` (utilization level), marks the warn threshold and its ticks, and lights the order-by deadline in the fleet verdict when an order is actually due. Deliberately **not** the brand — amber means "look here," never "this is us."

### Tertiary

- **Forecast Violet** (`--chart-consumption`, #c084fc / #7c3aed): The forecast consumption / scenario line on charts, and only that. Deliberately split out of amber (2026-07-18) because amber's double duty as the warn-threshold color made the usage line and the warn hairline the identical hex in dark theme.

### Neutral

- **Deep Slate** (`--background`, #0e1220 / #f4f6fa): The page chassis. In dark it carries a subtle radial gradient (`--surface-backdrop`); in light it is flat.
- **Slate Surface** (`--card`, #151b2c / #ffffff): Cards, tiles, popovers. Dark cards carry a faint vertical gradient (`--surface-card`).
- **Ink** (`--foreground`, #e8ecf5 / #171c2c): Primary text and the default (non-accent) button fill.
- **Muted Ink** (`--fg-muted`, #8b93a7 / #5a6478): Secondary text, captions, descriptions.
- **Subtle Ink** (`--fg-subtle`, #7c86a0 / #66708c): Uppercase micro-labels, placeholders, empty-state copy. Tuned to clear the AA 4.5:1 floor on both surfaces.
- **Hairline** (`--border` #232b40 / #dce2ee; `--border-strong` #314063 / #c2cce0): 1px separators and control outlines; the strong step for hover and emphasis.

### Status (semantic roles only)

- **Jade** (`--success`, #3dd68c / #176b45): Healthy / covered / additive events.
- **Warn Amber** (`--warning`, #ffc53d / #865c0c): The warn threshold and warn badges. Now fully distinct from the steel brand accent in **both** themes (the former dark-theme collision is resolved).
- **Coral** (`--destructive`, #ff6b6b / #c0343c): Critical / over-limit / consuming events / destructive actions.

### Named Rules

**The Steel-Brand Rule.** Steel is the single brand + CTA + interaction accent (`--accent` unified with `--steel`). One calm hue carries identity and every actionable affordance; never introduce a second brand color.

**The Amber-Is-Attention Rule.** Amber appears in exactly three places — the `BulletMeter` fill, the warn/crit threshold ticks, and the order-by deadline emphasis when an order is due. It never brands, never CTAs, never decorates. If amber is on screen, something needs looking at. `--accent` (steel) and `--warning` (amber) are distinct in both themes; never re-alias them.

**The Data-Is-Ink Rule.** Hero data figures — utilization %, headroom, cluster runway — are neutral `--foreground` ink, not an accent color. Color is reserved for status and attention; the numbers stay quiet so a scan reads level and health, not decoration.

**The Violet Usage-Line Rule.** The forecast consumption/scenario line is `--chart-consumption` violet, never amber. Don't repoint it at `--accent` — amber is already the warn hairline on the same chart.

**The Semantic-Token-Only Rule.** Status is expressed through `--success` / `--warning` / `--destructive` / `--accent` / `--steel` via `Badge`, `BulletMeter`, `RunwayPill`, `KpiTile`. Never hardcode raw palette classes (`bg-emerald-100` etc.) — none remain in the codebase.

## Typography

**Display Font:** Space Grotesk (with Inter, system-ui fallback)
**Body Font:** Inter (with system-ui fallback)
**Mono / Data Font:** JetBrains Mono (with ui-monospace fallback)

**Character:** Space Grotesk gives verdicts and headings a tight, engineered confidence; Inter keeps body and UI text neutral and highly legible; JetBrains Mono makes every number a first-class, aligned data point. All three are self-hosted via `@fontsource`.

### Hierarchy

- **Display** (Space Grotesk 600, `clamp(22px, 2.2vw, 28px)`, 1.1, -0.025em): The fleet verdict headline and page H1s. Fluid, because the verdict is long cluster-dependent prose, not a fixed title.
- **H1** (Space Grotesk 600, 20px, 1.2, -0.015em): Section and panel titles.
- **H2** (Space Grotesk 600, 16px, 1.3, -0.01em): Sub-section headings.
- **Body** (Inter 400, 14px, 1.5): Default reading text.
- **Caption** (Inter 500, 11px, 1.3): Supporting notes under values.
- **Label** (Inter 500, 10px, 0.12em, uppercase): Micro-labels above tiles and fields.
- **Numeric** (JetBrains Mono 500, 14px; large 20px): All data values, always `tabular-nums`.
- **Code** (JetBrains Mono, 12px): Inline identifiers, keys, fingerprints.

### Named Rules

**The Mono Numerals Rule.** Every data numeral is JetBrains Mono with `tabular-nums` — capacity, percentages, runway, dates in tables. Numbers must align digit-to-digit down a column; never set data in the sans face.

**The Display-for-Verdict Rule.** Space Grotesk is reserved for verdict text and headings. Body and UI copy stay in Inter; don't reach for the display face to add emphasis.

## Layout

A single sticky topbar (brand, ⌘K search trigger, Settings, theme toggle, user menu) — there is no sidebar. Content is organized as a "bento" of cards and instrument tiles: the fleet console leads with a verdict + instrument row, then a grid of cluster tiles. Cluster detail is a **fullscreen takeover panel** (`role="dialog"`, `.cluster-panel`, 100vw) over the console, not a separate route — it opens and closes **instantly** (no slide-in; frequent user-triggered transitions get no motion).

Breakpoints are pinned to px in the `@theme` block (`--breakpoint-sm/md/lg/xl/2xl` = 640/768/1024/1280/1536) so Tailwind utilities and JS `matchMedia` queries stay in lockstep at any browser font size. Any new JS media query must use the same px value as the utility it pairs with. Card internal padding is a consistent `14px` (`p-3.5`); tiles group by measured truth, one value per tile.

## Elevation & Depth

A near-flat system: surfaces rest on **one soft card shadow** and gain depth from a gradient-lit chassis rather than heavy elevation. Dark theme lights the backdrop with a top radial gradient (`--surface-backdrop`) and cards with a faint vertical gradient (`--surface-card`); light theme is flat. Cards lift on hover (`--shadow-card` → `--shadow-card-hover`, 200ms). Modals and the one glass surface use `--overlay-shadow`.

### Shadow Vocabulary

- **Card at rest** (`--shadow-card`): every `Card`, tile, and KPI.
- **Card hover** (`--shadow-card-hover`): interactive cards on hover only.
- **Overlay** (`--overlay-shadow`): dialogs, popovers, and the scenario glass card.

### Named Rules

**The Flat-Surface Rule.** Surfaces are near-flat and honest. Depth comes from soft shadow + the lit gradient chassis, never from stacked heavy shadows.

**The One-Glass Rule.** Exactly one glass (backdrop-blur) surface per view — the scenario controls card (`.scenario-card`, #243), on the floating-controls layer only. Never a page/pane surface, never glass-on-glass. It ships a near-opaque fallback that passes AA on its own (for no-`backdrop-filter` and `prefers-reduced-transparency`) and a mandatory 1px border. Otherwise `backdrop-blur` is reserved for modal scrims; never animate a blur radius.

## Shapes

Three corner radii and one pill: **8px** for controls (`--radius`: buttons, inputs, small chips), **14px** for cards and tiles (`--radius-card`), **16px** for modals (`--radius-modal`), and full-round (`rounded-full`) for badges and status dots. Borders are 1px hairlines (`--border`), stepping to `--border-strong` on hover/emphasis. Interactive controls press with a subtle `active:scale-[0.98]`.

### Named Rules

**The Three-Radius Rule.** 8 / 14 / 16 and pill — that's the whole vocabulary. Don't invent intermediate radii; match the element's role (control / card / modal / badge).

## Components

### Buttons

- **Shape:** 8px radius (`--radius`); height 32px default (`h-8`), 28px `sm`, 36px `lg`. Press feedback `active:scale-[0.98]`, 150ms ease-out transitions.
- **Default:** Ink fill, background-colored text (`bg-foreground text-background`) with a card shadow; hover drops to 90% opacity.
- **Accent:** Steel fill (`bg-accent text-accent-foreground`; `--accent` is steel under cool-brand) for the primary CTA.
- **Destructive:** Coral fill for irreversible actions.
- **Outline / Ghost:** hairline or transparent; hover fills with `card-hover`.
- **Link:** amber text, underline on hover.
- **Chip:** transparent, hairline-bordered mono uppercase micro-label control (pair `variant="chip"` + `size="chip"`) that reads as a label until hovered.

### Badges & Chips

- **Shape:** pill (`rounded-full`), 1px border, 12px text, `px-2.5 py-0.5`.
- **Variants:** default (muted), accent (amber-soft wash + amber text), outline, success, warning, danger — status variants use a `/10` tinted background, `/30` border, and the solid semantic text color.
- **Optional dot:** a leading status dot with a `color-mix` halo; carries the same semantic hue as the variant.

### Cards / Containers

- **Corner:** 14px (`--radius-card`).
- **Background:** `--card` (dark cards gradient-lit via `--surface-card`).
- **Shadow:** `--shadow-card` at rest → `--shadow-card-hover` on interactive cards.
- **Border:** 1px `--border`.
- **Internal padding:** 14px (`p-3.5`) across header / content / footer.

### Inputs / Fields

- **Style:** 32px tall (`h-8`), 8px radius, 1px `--input` border, `--background` fill, 14px text.
- **Hover:** border steps to `--border-strong`.
- **Focus:** the global two-layer steel ring (not a per-field style).
- **Placeholder:** `--fg-subtle`.

### Navigation

- **Topbar:** single sticky bar — brand mark + wordmark, ⌘K command-palette trigger, Settings link, theme toggle, user menu. No sidebar. Links and interactive affordances use steel, not amber.

### BulletMeter (signature)

The one utilization visualization everywhere (the radial gauge is retired). A linear track (`h-2`, `rounded-full`, `bg-muted`) with an amber gradient fill (`--meter-gradient`) plus a soft amber glow, and two threshold ticks: a **warn** tick (`bg-warning`, protrudes 2px) and a taller **crit** tick (`bg-destructive`, protrudes 4px). Each tick carries a 1px halo in the card surface color so it survives any fill beneath it — essential in dark theme, where warn amber and the fill share a hex. Crit is taller than warn so **shape, not hue alone, separates severity** (WCAG 1.4.1). Rendered `role="img"` with a generated accessible label.

### KpiTile (signature)

A `Card` with a left-border status accent (`ok` none / `unknown` neutral / `attention` steel / `warn` amber / `crit` coral), an uppercase micro-label, and a large mono `tabular-nums` value (neutral **ink**, per the Data-Is-Ink rule) with optional caption. The `unknown` state is a deliberately neutral border — visibly not healthy-green and not alarm-red — a legible gap rather than a reassuring lie.

### RunwayPill

A `Badge` whose variant is derived in one shared place (`deriveRunwayTone`): `danger` when already over crit / <3mo, `warning` when over warn / <12mo, `accent` when clear, `outline` "Unknown — no capacity" when capacity is missing. The single source of the warn/crit runway cutoffs so the dense-table pill and the KPI-strip tile never drift.

## Do's and Don'ts

### Do:

- **Do** design every change for **both** light and dark themes; the light theme is a designed sibling, not an afterthought.
- **Do** set all data numerals in JetBrains Mono with `tabular-nums`.
- **Do** use the linear `BulletMeter` for utilization, everywhere.
- **Do** pair color with text, icon, or shape — color is never the only signal (the crit tick is _taller_, not just redder).
- **Do** route status through semantic tokens (`--success` / `--warning` / `--destructive` / `--accent` / `--steel`).
- **Do** keep steel for brand/CTA/interaction and amber strictly for utilization/attention (meter, warn ticks, order deadlines); keep hero data figures neutral ink.
- **Do** show gaps and unknowns honestly (neutral `unknown` states; no interpolated lines; no zero-as-healthy).

### Don't:

- **Don't** use glassmorphism beyond the single sanctioned scenario controls card; never glass-on-glass, never a page/pane glass surface.
- **Don't** bring back the radial `UtilizationGauge` or any second utilization visualization.
- **Don't** hardcode raw palette classes (`bg-emerald-100`, `text-amber-500`, …) — semantic tokens only.
- **Don't** re-alias `--accent` (steel) onto `--warning` (amber), or brand anything amber — that resurrects the collision this design removed.
- **Don't** repoint the forecast consumption line off `--chart-consumption` violet onto amber.
- **Don't** animate blur radius, or add slide-in motion to the cluster panel (transform/opacity only; frequent user-triggered transitions get none).
- **Don't** invent new radii, colors, or fonts outside the tokens in `styles.css`.
