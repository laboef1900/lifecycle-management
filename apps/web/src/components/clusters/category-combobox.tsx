import { useId } from 'react';

import { Input } from '@/components/ui/input';

interface CategoryComboboxProps {
  value: string;
  onChange: (value: string) => void;
  categories: string[];
  error?: string | undefined;
  label?: string;
  /**
   * Defaults to `true` because `category` is `.trim().min(1)` on every item
   * schema in `@lcm/shared`, so every current mount is required. Kept as a prop
   * anyway so this reproduces {@link Field}'s contract in full: there, the
   * marker, `required` and `aria-required` are all derived from one flag, and a
   * future optional-category caller must be able to turn all three off together
   * rather than being stuck with a `*` that lies.
   */
  required?: boolean;
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
  required = true,
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
          `aria-required` below is the channel assistive tech announces from. */}
      <div className="flex items-baseline gap-0.5">
        <label htmlFor={inputId} className="text-sm font-medium">
          {label}
        </label>
        {required ? (
          <span aria-hidden className="text-destructive">
            *
          </span>
        ) : null}
      </div>
      <Input
        id={inputId}
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        aria-required={required ? 'true' : undefined}
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
