import { useId } from 'react';

import { Input } from '@/components/ui/input';

interface CategoryComboboxProps {
  value: string;
  onChange: (value: string) => void;
  categories: string[];
  error?: string | undefined;
  label?: string;
}

/**
 * A category control that is both a dropdown of existing categories and a
 * free-text field — pick an existing label or type a brand-new one. Built on
 * the native `<input list>` + `<datalist>` pairing so it matches the styling of
 * the other form fields (same {@link Input} component and {@link Field} layout).
 *
 * The aria contract is {@link Field}'s, deliberately reproduced rather than
 * reused: `Field` renders its own `<Input>` and cannot host the `list`/
 * `<datalist>` pairing this control exists for.
 */
export function CategoryCombobox({
  value,
  onChange,
  categories,
  error,
  label = 'Category',
}: CategoryComboboxProps): React.JSX.Element {
  const inputId = useId();
  const listId = useId();
  const errorId = `${inputId}-error`;
  return (
    <div className="space-y-1.5">
      {/* The marker is a sibling of `<label>`, not a child: label queries read
          the label element's raw text content, which does not skip `aria-hidden`
          descendants the way accessible-name computation does — nesting it would
          rename this field to "Category *" for every `getByLabelText`. The glyph
          itself, not only its colour, carries "required" (WCAG 1.4.1); the
          `aria-required` below is the channel assistive tech announces from.
          Category is `min(1)` in `@lcm/shared` on every item schema, so it is
          required on all three dialogs that mount this. */}
      <div className="flex items-baseline gap-0.5">
        <label htmlFor={inputId} className="text-sm font-medium">
          {label}
        </label>
        <span aria-hidden className="text-destructive">
          *
        </span>
      </div>
      <Input
        id={inputId}
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        aria-required="true"
        aria-invalid={error ? 'true' : undefined}
        // Without this the message below was visible but not programmatically
        // associated: a screen-reader user moving through the form heard the
        // field, not the reason it was rejected. `aria-invalid` alone announces
        // "invalid" and nothing more.
        aria-describedby={error ? errorId : undefined}
        placeholder="Pick or type a category"
        autoComplete="off"
      />
      <datalist id={listId}>
        {categories.map((category) => (
          <option key={category} value={category} />
        ))}
      </datalist>
      {error ? (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
