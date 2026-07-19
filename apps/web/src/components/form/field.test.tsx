import { render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it } from 'vitest';

import { Field, useFocusFirstInvalidField } from './field';

describe('<Field>', () => {
  it('renders a visible required marker and aria-required, not required at all otherwise', () => {
    const { rerender } = render(<Field label="Name" value="" onChange={() => {}} required />);
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input).toHaveAttribute('required');
    expect(input).toHaveAttribute('aria-required', 'true');
    // The marker is a glyph, not a color-only cue (WCAG 1.4.1), and it is
    // aria-hidden so it never duplicates the "required" AT already announces
    // from aria-required.
    expect(screen.getByText('*')).toHaveAttribute('aria-hidden');

    rerender(<Field label="Name" value="" onChange={() => {}} />);
    expect(input).not.toHaveAttribute('required');
    expect(input).not.toHaveAttribute('aria-required');
    expect(screen.queryByText('*')).not.toBeInTheDocument();
  });

  it('associates the error message via aria-describedby and sets aria-invalid', () => {
    render(<Field label="Name" value="" onChange={() => {}} error="Name is required" />);
    const input = screen.getByRole('textbox', { name: 'Name' });
    const errorMessage = screen.getByText('Name is required');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toContain(errorMessage.id);
  });

  it('associates the hint via aria-describedby when there is no error', () => {
    render(<Field label="Name" value="" onChange={() => {}} hint="Shown on the host row" />);
    const input = screen.getByRole('textbox', { name: 'Name' });
    const hint = screen.getByText('Shown on the host row');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input.getAttribute('aria-describedby')).toContain(hint.id);
  });

  it('prefers the error over the hint and composes with a caller-supplied aria-describedby', () => {
    render(
      <Field
        label="Name"
        value=""
        onChange={() => {}}
        hint="Shown on the host row"
        error="Name is required"
        aria-describedby="external-note"
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(screen.queryByText('Shown on the host row')).not.toBeInTheDocument();
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(describedBy).toContain(screen.getByText('Name is required').id);
    expect(describedBy).toContain('external-note');
  });

  it('has no aria-describedby when there is neither an error, a hint, nor a caller value', () => {
    render(<Field label="Name" value="" onChange={() => {}} />);
    expect(screen.getByRole('textbox', { name: 'Name' })).not.toHaveAttribute('aria-describedby');
  });
});

describe('useFocusFirstInvalidField', () => {
  function Harness({ errors }: { errors: Record<string, string | undefined> }): React.JSX.Element {
    const formRef = useRef<HTMLFormElement>(null);
    useFocusFirstInvalidField(formRef, errors);
    return (
      <form ref={formRef}>
        <Field label="First" value="" onChange={() => {}} error={errors.first} />
        <Field label="Second" value="" onChange={() => {}} error={errors.second} />
      </form>
    );
  }

  it('moves focus to the first invalid field when errors appear', () => {
    const { rerender } = render(<Harness errors={{}} />);
    expect(screen.getByRole('textbox', { name: 'First' })).not.toHaveFocus();

    rerender(<Harness errors={{ second: 'Required' }} />);
    expect(screen.getByRole('textbox', { name: 'Second' })).toHaveFocus();
  });

  it('does not move focus when the errors object has no messages', () => {
    render(<Harness errors={{ first: undefined, second: undefined }} />);
    expect(screen.getByRole('textbox', { name: 'First' })).not.toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'Second' })).not.toHaveFocus();
  });

  it('refocuses on a second, different failed submission', () => {
    const { rerender } = render(<Harness errors={{ first: 'Required' }} />);
    expect(screen.getByRole('textbox', { name: 'First' })).toHaveFocus();

    screen.getByRole('textbox', { name: 'First' }).blur();
    // A fresh object with a different shape — as a real dialog's setErrors
    // would produce on a second, distinct validation failure.
    rerender(<Harness errors={{ second: 'Required' }} />);
    expect(screen.getByRole('textbox', { name: 'Second' })).toHaveFocus();
  });
});
