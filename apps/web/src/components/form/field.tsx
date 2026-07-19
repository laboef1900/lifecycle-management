import * as React from 'react';

import { Input } from '@/components/ui/input';

interface FieldProps extends React.ComponentProps<typeof Input> {
  label: string;
  error?: string | undefined;
  hint?: string;
}

export const Field = React.forwardRef<HTMLInputElement, FieldProps>(
  (
    {
      label,
      error,
      hint,
      required,
      id: idProp,
      'aria-describedby': describedByProp,
      ...inputProps
    },
    ref,
  ) => {
    const id = idProp ?? `field-${inputProps.name ?? label.toLowerCase().replaceAll(' ', '-')}`;
    const errorId = `${id}-error`;
    const hintId = `${id}-hint`;
    // Compose with whatever the caller already passed — a hint and an error
    // never render at once (below), but a future third describedby source
    // must not clobber this one.
    const describedBy =
      [error ? errorId : null, !error && hint ? hintId : null, describedByProp ?? null]
        .filter((value): value is string => value !== null)
        .join(' ') || undefined;

    return (
      <div className="space-y-1.5">
        {/* The marker is a sibling of `<label>`, not a child of it: `label`
            queries (this app's tests, and `getByLabelText` generally) read the
            label element's raw text content, which does not skip `aria-hidden`
            descendants the way accessible-name computation does — nesting the
            marker inside would silently change every required field's label
            text. The glyph itself (not just its color) carries the meaning, so
            it survives a color-vision deficiency or a forced-colors palette
            (WCAG 1.4.1); `aria-required` below is the channel assistive tech
            actually announces from. */}
        <div className="flex items-baseline gap-0.5">
          <label htmlFor={id} className="text-sm font-medium">
            {label}
          </label>
          {required ? (
            <span aria-hidden className="text-destructive">
              *
            </span>
          ) : null}
        </div>
        <Input
          id={id}
          ref={ref}
          required={required}
          aria-invalid={error ? 'true' : undefined}
          aria-required={required ? 'true' : undefined}
          aria-describedby={describedBy}
          {...inputProps}
        />
        {error ? (
          <p id={errorId} className="text-xs text-destructive">
            {error}
          </p>
        ) : hint ? (
          <p id={hintId} className="text-xs text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </div>
    );
  },
);
Field.displayName = 'Field';

/**
 * Moves focus to the first invalid field inside `formRef` whenever `errors`
 * changes to a state containing at least one message (SC 3.3.1) — call this
 * after a failed submit so the user (sighted or assistive-tech) lands on the
 * field that needs fixing instead of a silently re-rendered form.
 *
 * Depends on the `errors` object reference, not a derived boolean: dialogs
 * call `setErrors({})` then `setErrors(fieldErrors)` inside the same submit
 * handler, which React batches into a single render, so only the final object
 * is ever observed here — but it must be a *new* object each failed submit
 * (as `mapIssuesToFieldErrors` and friends already return) for this to refire
 * when a second, different validation failure follows a first.
 *
 * Relies on `Field` having set `aria-invalid="true"` on the offending control
 * (or a dialog's hand-rolled Select/textarea doing the same) — this hook does
 * not know about individual fields, only the DOM `[aria-invalid="true"]`
 * `Field` already produces.
 */
export function useFocusFirstInvalidField(
  formRef: React.RefObject<HTMLFormElement | null>,
  errors: Record<string, string | undefined>,
): void {
  React.useEffect(() => {
    const hasError = Object.values(errors).some((message) => message !== undefined);
    if (!hasError) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errors, formRef]);
}
