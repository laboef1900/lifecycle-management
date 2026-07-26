import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api } from '@/lib/api-client';

import { CategoriesForm } from './categories-form';

function renderWithClient(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('<CategoriesForm>', () => {
  beforeEach(() => {
    vi.spyOn(api.settings.categories, 'list').mockResolvedValue([
      { id: 'c1', name: 'Growth' },
      { id: 'c2', name: 'Hardware' },
    ]);
    vi.spyOn(api.settings.categories, 'create').mockResolvedValue({ id: 'c3', name: 'New' });
    vi.spyOn(api.settings.categories, 'delete').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the categories returned by the api', async () => {
    renderWithClient(<CategoriesForm />);
    expect(await screen.findByText('Growth')).toBeInTheDocument();
    expect(screen.getByText('Hardware')).toBeInTheDocument();
  });

  it('opts out of native constraint validation', async () => {
    // Nothing here can raise a bubble today — the input has `maxLength` (which
    // caps typing rather than validating) and no `required`. The assertion
    // guards the invariant, so a constraint added later cannot silently hand
    // this form's error path back to the browser.
    const { container } = renderWithClient(<CategoriesForm />);
    await screen.findByText('Growth');
    expect(container.querySelector('form')?.noValidate).toBe(true);
  });

  it('creates a category with the typed name when Add is clicked', async () => {
    renderWithClient(<CategoriesForm />);
    await screen.findByText('Growth');
    await userEvent.type(screen.getByLabelText(/new category/i), 'Migration');
    await userEvent.click(screen.getByRole('button', { name: /add/i }));
    await waitFor(() => {
      expect(api.settings.categories.create).toHaveBeenCalledWith('Migration');
    });
  });

  it('confirms before deleting, and does not call the api until confirmed', async () => {
    renderWithClient(<CategoriesForm />);
    await screen.findByText('Growth');

    await userEvent.click(screen.getByRole('button', { name: /remove growth/i }));
    // The confirmation must state the scope of the action, not just ask.
    const dialog = screen.getByRole('dialog', { name: 'Remove Growth?' });
    expect(dialog).toHaveTextContent(/category dropdown/i);
    expect(dialog).toHaveTextContent(/no application or event is deleted/i);
    expect(api.settings.categories.delete).not.toHaveBeenCalled();

    // Dismissing is a full abort, not a deferred delete.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.settings.categories.delete).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /remove growth/i }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove category' }),
    );
    await waitFor(() => expect(api.settings.categories.delete).toHaveBeenCalledWith('c1'));
  });

  it('surfaces the CATEGORY_IN_USE message in the dialog, then on the row once dismissed', async () => {
    vi.mocked(api.settings.categories.delete).mockRejectedValue(
      new ApiError(409, {
        error: {
          code: 'CATEGORY_IN_USE',
          message: 'Category "Growth" is used by 2 item(s). Reassign them first.',
        },
      }),
    );
    renderWithClient(<CategoriesForm />);
    await screen.findByText('Growth');
    await userEvent.click(screen.getByRole('button', { name: /remove growth/i }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove category' }),
    );

    // The dialog stays open on failure and carries the reason where the user acted.
    const dialog = await screen.findByRole('dialog', { name: 'Remove Growth?' });
    expect(await within(dialog).findByText(/used by 2 item\(s\)/i)).toBeInTheDocument();

    // Retrying cannot help here, so the reason must survive dismissing the dialog.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/used by 2 item\(s\)/i);
  });

  it('uses the EmptyState primitive rather than ad-hoc copy when there are none', async () => {
    vi.mocked(api.settings.categories.list).mockResolvedValue([]);
    renderWithClient(<CategoriesForm />);
    const title = await screen.findByText('No categories yet');
    expect(title.closest('.border-dashed')).toBeInTheDocument();
  });

  it('shows skeleton placeholders while the categories query is pending', () => {
    // A never-resolving fetch keeps the query in its pending state.
    vi.mocked(api.settings.categories.list).mockReturnValue(new Promise<never>(() => {}));
    const { container } = renderWithClient(<CategoriesForm />);
    expect(container.querySelector('.animate-shimmer')).toBeInTheDocument();
  });
});
