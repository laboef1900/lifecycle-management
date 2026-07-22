const integerFormat = new Intl.NumberFormat('en-US');

export function formatGb(value: number): string {
  return `${integerFormat.format(Math.round(value))} GB`;
}

export function formatNumber(value: number): string {
  return integerFormat.format(Math.round(value));
}

/**
 * Runway/breach-countdown unit label — lowercase by the majority convention
 * (#243 Part B copy item 2): `RunwayPill` and the fleet verdict headline
 * already say 'mo'; the fleet console tile numeral was the one outlier at
 * 'MO'. Exported alongside {@link formatRunway} for consumers (the tile) that
 * split the numeral and unit across two differently-styled elements rather
 * than needing one combined string.
 */
export const RUNWAY_UNIT = 'mo';

/**
 * Renders a runway/breach countdown as `'N mo'` or, when open-ended (nothing
 * further to project within the horizon), `'N+ mo'` — the one shared source
 * for this quantity's text, so the fleet console tile, `RunwayPill`, and the
 * fleet verdict headline can't drift into separate casings again.
 */
export function formatRunway(value: number, plus = false): string {
  return `${value}${plus ? '+' : ''} ${RUNWAY_UNIT}`;
}

export function todayIso(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
