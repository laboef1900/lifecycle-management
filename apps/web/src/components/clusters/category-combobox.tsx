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
  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={inputId}
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? 'true' : undefined}
        placeholder="Pick or type a category"
        autoComplete="off"
      />
      <datalist id={listId}>
        {categories.map((category) => (
          <option key={category} value={category} />
        ))}
      </datalist>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
