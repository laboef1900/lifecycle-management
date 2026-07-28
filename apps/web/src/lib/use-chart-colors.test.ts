// @vitest-environment node
// Runs in node (not jsdom) so import.meta.url is a real file:// URL and this
// test can read styles.css off disk; it exercises no DOM.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FALLBACK_DARK, FALLBACK_LIGHT, type ChartFallback } from './use-chart-colors';

// The FALLBACK_* tables in use-chart-colors.ts are the resolved copy of the
// `--chart-*` CSS custom properties, used in jsdom/first-render where the
// stylesheet is not applied. Nothing at runtime forces them to agree with
// styles.css, and every chart-consumer test mocks useChartColors — so a token
// change that forgets the fallback (or vice versa) is otherwise invisible. This
// test parses styles.css and asserts the two stay mirrored in both themes.
const css = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8');

/** Grab the declaration body of a top-level rule (`:root { … }` / `html.dark { … }`). */
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
// Dark theme is :root overlaid with html.dark's overrides.
const darkProps = new Map([...lightProps, ...parseCustomProps(ruleBody('html.dark'))]);

/** Resolve a token to its literal, following a single `var(--x)` hop as far as needed. */
function resolve(props: Map<string, string>, name: string): string {
  const seen = new Set<string>();
  let current = name;
  for (;;) {
    if (seen.has(current)) throw new Error(`circular var() resolving ${name}`);
    seen.add(current);
    const value = props.get(current);
    if (value === undefined) throw new Error(`missing CSS token ${current}`);
    const varRef = /^var\((--[\w-]+)\)$/.exec(value);
    if (!varRef?.[1]) return value.toLowerCase();
    current = varRef[1];
  }
}

const ROLE_TOKENS: Record<keyof ChartFallback, string> = {
  consumption: '--chart-consumption',
  capacity: '--chart-capacity',
  grid: '--chart-grid',
  axis: '--chart-axis',
  utilizationOk: '--chart-utilization-ok',
  utilizationWarn: '--chart-utilization-warn',
  utilizationCrit: '--chart-utilization-crit',
  eventAdds: '--chart-event-adds',
  eventConsumes: '--chart-event-consumes',
  band: '--chart-band',
};

describe.each([
  ['light', FALLBACK_LIGHT, lightProps],
  ['dark', FALLBACK_DARK, darkProps],
])('chart color fallbacks mirror the CSS tokens (%s)', (_theme, fallback, props) => {
  it.each(Object.entries(ROLE_TOKENS))('%s mirrors %s', (field, token) => {
    expect(fallback[field as keyof typeof ROLE_TOKENS]).toBe(resolve(props, token));
  });
});

describe('consumption line is distinct from the warn threshold in both themes', () => {
  it('does not collide with the warn color (the bug #224 fixes)', () => {
    expect(FALLBACK_LIGHT.consumption).not.toBe(FALLBACK_LIGHT.utilizationWarn);
    expect(FALLBACK_DARK.consumption).not.toBe(FALLBACK_DARK.utilizationWarn);
  });
});
