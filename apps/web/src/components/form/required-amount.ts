/**
 * Operator-facing message for a required numeric field left blank.
 *
 * Deliberately not Zod's own text: a blank field makes the shared schemas say
 * "Invalid input: expected number, received NaN", which describes the bug rather
 * than the fix.
 */
export const REQUIRED_AMOUNT_MESSAGE = 'Enter a value';

/**
 * Parse a **required** numeric form field into a value the `@lcm/shared` schemas
 * can judge, returning `NaN` when the field is blank or unparseable.
 *
 * @ai-warning Do NOT replace this with `Number(raw)`. `Number('')` is `0`, and
 * every amount contract in `@lcm/shared` (`positiveAmount`) is `nonnegative`, so
 * a blank capacity/allocation/baseline field parses *clean* and posts a real,
 * stored zero. That is the one number this product must never invent on the
 * operator's behalf — `cluster-panel.tsx` calls a 0-width bar "the '0% used,
 * healthy' lie", and `MetricStateResponse.utilization` is nullable precisely so
 * an unknown capacity can never render as maximum headroom. The browser's
 * `required` bubble used to hide the coercion; the forms now set `noValidate`
 * (so the app's own `Field` errors are what the operator actually sees), which
 * means the emptiness check has to live here.
 *
 * `NaN` is the return value rather than `null` so the **existing** contract does
 * the rejecting — `z.number()` refuses `NaN`, and `positiveAmount` is
 * additionally `.finite()` — instead of a parallel validation layer. The issue
 * lands on the field's own schema path, so a dialog's existing issue→field
 * mapping already routes it; swap the message for {@link REQUIRED_AMOUNT_MESSAGE}
 * at the call site by testing `Number.isNaN` on the parsed value.
 */
export function parseRequiredAmount(raw: string): number {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? Number.NaN : Number(trimmed);
}
