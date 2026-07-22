// @vitest-environment node
// Runs in node (not jsdom) so import.meta.url is a real file:// URL and this
// test can read styles.css off disk; it exercises no DOM. Mirrors the parsing
// approach in use-chart-colors.test.ts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Finding (docs/uiux-audit-2026-07.md, "Light-theme success badge text ~4.4:1
// — just under AA on every OK / In service chip"): `Badge`'s success/warning
// variants (badge.tsx: `text-success bg-success/10` / `text-warning
// bg-warning/10`) render the token at full strength as text, over its own
// 10%-alpha tint composited onto the white --card — not over bare white,
// which is what hid the failure originally (bare-white measurements read
// comfortably higher). This test recomputes the real composited contrast
// from the CSS custom properties directly, so a future token edit that
// reintroduces the violation fails here instead of only showing up in a
// screenshot.
const css = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.]/g, '\\$&');
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(css);
  if (!match?.[1]) throw new Error(`could not find CSS rule for "${selector}"`);
  return match[1];
}

function parseCustomProps(body: string): Map<string, string> {
  const props = new Map<string, string>();
  const re = /(--[\w-]+):\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    props.set(match[1]!, match[2]!.trim());
  }
  return props;
}

const lightProps = parseCustomProps(ruleBody(':root'));
const darkProps = new Map([...lightProps, ...parseCustomProps(ruleBody('html.dark'))]);

function hexRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace('#', '');
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG contrast ratio between two sRGB colors. */
function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

/** Composites `fg` at `alpha` over `bg` (straight alpha, per channel). */
function compositeOver(
  fg: [number, number, number],
  bg: [number, number, number],
  alpha: number,
): [number, number, number] {
  return [
    fg[0] * alpha + bg[0] * (1 - alpha),
    fg[1] * alpha + bg[1] * (1 - alpha),
    fg[2] * alpha + bg[2] * (1 - alpha),
  ];
}

const WHITE: [number, number, number] = [255, 255, 255];
const AA_TEXT_FLOOR = 4.5;

/** `Badge`'s success/warning variants: full-strength text on a 10%-alpha tint of itself. */
function badgeChipContrast(tokenHex: string, backdrop: [number, number, number]): number {
  const fg = hexRgb(tokenHex);
  const compositedBg = compositeOver(fg, backdrop, 0.1);
  return contrastRatio(fg, compositedBg);
}

describe('badge success/warning text meets AA on their real composited background', () => {
  it.each([
    ['--success', 'success'],
    ['--warning', 'warning'],
  ])('light %s clears 4.5:1 against its bg-%s/10 tint over the white --card', (token) => {
    const hex = lightProps.get(token);
    expect(hex).toBeDefined();
    const ratio = badgeChipContrast(hex!, WHITE);
    expect(ratio).toBeGreaterThanOrEqual(AA_TEXT_FLOOR);
  });

  // Dark theme already passed (~5.9:1) and is untouched by this fix — guard
  // against a future edit accidentally regressing it too.
  it.each(['--success', '--warning'])(
    'dark %s still clears 4.5:1 against its own 10%% tint over --card',
    (token) => {
      const hex = darkProps.get(token);
      const cardHex = darkProps.get('--card');
      expect(hex).toBeDefined();
      expect(cardHex).toBeDefined();
      const ratio = badgeChipContrast(hex!, hexRgb(cardHex!));
      expect(ratio).toBeGreaterThanOrEqual(AA_TEXT_FLOOR);
    },
  );
});

// --warning and --accent are deliberately distinct tokens (CLAUDE.md): they
// resolve to the identical hex in dark theme by design (the meter fill is
// amber and warn is also amber), but light theme keeps them as two separate
// values in the same hue family. This --warning contrast fix must not
// collapse that distinction.
describe('--warning stays distinct from --accent in light theme (never re-aliased)', () => {
  it('light --warning and light --accent remain different values', () => {
    expect(lightProps.get('--warning')).not.toBe(lightProps.get('--accent'));
  });

  it('dark --warning and dark --accent remain identical (the recorded, deliberate collision)', () => {
    expect(darkProps.get('--warning')).toBe(darkProps.get('--accent'));
  });
});
