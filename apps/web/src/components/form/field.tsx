import * as React from 'react';

import { Input } from '@/components/ui/input';

interface FieldProps extends React.ComponentProps<typeof Input> {
  label: string;
  error?: string | undefined;
  hint?: string;
}

export const Field = React.forwardRef<HTMLInputElement, FieldProps>(
  ({ label, error, hint, ...inputProps }, ref) => {
    const id =
      inputProps.id ?? `field-${inputProps.name ?? label.toLowerCase().replaceAll(' ', '-')}`;
    return (
      <div className="space-y-1.5">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <Input id={id} ref={ref} aria-invalid={error ? 'true' : undefined} {...inputProps} />
        {error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : hint ? (
          <p className="text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </div>
    );
  },
);
Field.displayName = 'Field';
