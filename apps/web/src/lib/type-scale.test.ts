// @vitest-environment node
// Runs in node (not jsdom) so import.meta.url is a real file:// URL and this
// test can read styles.css off disk; it exercises no DOM. Mirrors the parsing
// approach in use-chart-colors.test.ts / token-contrast.test.ts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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

// The type-scale tokens live in the @theme block, not :root/html.dark — they
// are font-size scale, not a themeable color, so there is exactly one value.
const themeProps = parseCustomProps(ruleBody('@theme'));

describe('type-scale tokens (#243 Part B: adopted by verdict h1, panel title, section headings)', () => {
  it('--text-display is fluid (clamp), not a flat px value, so the long verdict headline never forces extra wrapped lines on narrow viewports', () => {
    const value = themeProps.get('--text-display');
    expect(value).toBe('clamp(22px, 2.2vw, 28px)');
  });

  it('--text-h1 and --text-h2 stay flat (short, fixed-content headings do not need viewport-fluid sizing)', () => {
    expect(themeProps.get('--text-h1')).toBe('20px');
    expect(themeProps.get('--text-h2')).toBe('16px');
  });

  // clamp(22px, 2.2vw, 28px) hits its floor below 1000px viewport width
  // (2.2vw = 22px at 1000px) and its ceiling above ~1273px (2.2vw = 28px) —
  // confirms the documented "22px at 390px, 28px above ~1273px" behavior
  // referenced in the spec amendment and styles.css comment.
  it('the clamp floors at 22px well above mobile width and ceilings above typical desktop width', () => {
    const value = themeProps.get('--text-display')!;
    const match = /^clamp\((\d+)px,\s*([\d.]+)vw,\s*(\d+)px\)$/.exec(value);
    expect(match).not.toBeNull();
    const [, min, vwCoefficient, max] = match!;
    const floorViewport = Number(min) / (Number(vwCoefficient) / 100);
    const ceilingViewport = Number(max) / (Number(vwCoefficient) / 100);
    expect(floorViewport).toBeCloseTo(1000, 0);
    expect(ceilingViewport).toBeCloseTo(1272.7, 0);
    // At a 390px phone viewport, the preferred value (2.2vw) is far below the
    // floor, so clamp() resolves to the 22px minimum — never the 28px max.
    const preferredAt390 = (Number(vwCoefficient) / 100) * 390;
    expect(preferredAt390).toBeLessThan(Number(min));
  });
});
