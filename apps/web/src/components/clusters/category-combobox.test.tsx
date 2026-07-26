import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { CategoryCombobox } from './category-combobox';

/**
 * Drives {@link CategoryCombobox} as a real controlled input so that typing
 * accumulates into `value` the way it does in the dialogs, while still letting
 * the test spy on every `onChange` payload.
 */
function ControlledCombobox({
  categories,
  onChange,
}: {
  categories: string[];
  onChange: (value: string) => void;
}): React.JSX.Element {
  const [value, setValue] = useState('');
  return (
    <CategoryCombobox
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      categories={categories}
    />
  );
}

describe('<CategoryCombobox>', () => {
  it('renders a datalist option for each provided category', () => {
    render(<CategoryCombobox value="" onChange={vi.fn()} categories={['Growth', 'Hardware']} />);

    const options = Array.from(document.querySelectorAll('option')).map((o) => o.value);
    expect(options).toEqual(['Growth', 'Hardware']);
  });

  it('lets you type a brand-new value that is not in the list', async () => {
    const onChange = vi.fn();
    render(<ControlledCombobox categories={['Growth', 'Hardware']} onChange={onChange} />);

    await userEvent.type(screen.getByLabelText('Category'), 'Database');

    expect(onChange).toHaveBeenLastCalledWith('Database');
  });

  it('ties its error to the input, not just next to it', () => {
    render(
      <CategoryCombobox value="" onChange={vi.fn()} categories={[]} error="Category is required" />,
    );

    // The message used to render with no `id` and no `aria-describedby` pointing
    // at it: visible, but a screen-reader user heard "invalid" and never the
    // reason. `aria-invalid` alone cannot carry a sentence.
    const input = screen.getByLabelText('Category');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Category is required');
  });

  it('describes nothing while it is valid', () => {
    render(<CategoryCombobox value="Growth" onChange={vi.fn()} categories={['Growth']} />);

    const input = screen.getByLabelText('Category');
    expect(input).not.toHaveAttribute('aria-invalid');
    // A dangling `aria-describedby` pointing at an unrendered id would make the
    // description silently empty rather than absent.
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(input).toHaveAccessibleDescription('');
  });

  it('announces as required without renaming the field', () => {
    render(<CategoryCombobox value="" onChange={vi.fn()} categories={[]} />);

    // Category is `min(1)` on every item schema in `@lcm/shared`.
    const input = screen.getByLabelText('Category');
    expect(input).toHaveAttribute('aria-required', 'true');
    // The `*` marker sits OUTSIDE the label, so the accessible name stays clean
    // — a marker nested in the label would rename this control "Category *".
    expect(input).toHaveAccessibleName('Category');
  });

  it('keeps a custom label’s accessible name intact', () => {
    render(
      <CategoryCombobox value="" onChange={vi.fn()} categories={[]} label="Growth category" />,
    );

    expect(screen.getByLabelText('Growth category')).toHaveAccessibleName('Growth category');
  });

  it('gives each instance its own error id', () => {
    render(
      <>
        <CategoryCombobox value="" onChange={vi.fn()} categories={[]} error="First problem" />
        <CategoryCombobox
          value=""
          onChange={vi.fn()}
          categories={[]}
          label="Second category"
          error="Second problem"
        />
      </>,
    );

    // The id is derived from `useId()`, so two mounts on one page each describe
    // their OWN message. A module-level constant would have pointed both inputs
    // at whichever error rendered first — silently, since `aria-describedby`
    // resolving to a real-but-wrong element looks identical to a correct one in
    // the DOM. No dialog renders two today; nothing stops one from doing so.
    expect(screen.getByLabelText('Category')).toHaveAccessibleDescription('First problem');
    expect(screen.getByLabelText('Second category')).toHaveAccessibleDescription('Second problem');
  });

  it('drops the marker, `required` and `aria-required` together when opted out', () => {
    // All three come off one flag, as in `Field` — a caller that turns the
    // requirement off must not be left with a `*` the contract does not back.
    render(<CategoryCombobox value="" onChange={vi.fn()} categories={[]} required={false} />);

    const input = screen.getByLabelText('Category');
    expect(input).not.toHaveAttribute('required');
    expect(input).not.toHaveAttribute('aria-required');
    expect(screen.queryByText('*')).not.toBeInTheDocument();
  });
});
