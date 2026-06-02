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
});
