import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';

describe('<Table> sticky column (#243 Part B)', () => {
  it('applies no sticky classes by default, keeping other tables unaffected', () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Row</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    expect(screen.getByRole('columnheader', { name: 'Name' })).not.toHaveClass('sticky');
    expect(screen.getByRole('cell', { name: 'Row' })).not.toHaveClass('sticky');
  });

  it('pins the cell to the right edge with an opaque, bordered surface when sticky is set', () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead sticky>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow className="group">
            <TableCell sticky>Row actions</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    const header = screen.getByRole('columnheader', { name: 'Actions' });
    expect(header).toHaveClass('sticky', 'right-0', 'bg-card', 'border-l', 'border-border');

    const cell = screen.getByRole('cell', { name: 'Row actions' });
    // Opaque bg-card by default, group-hover:bg-card-hover so the sticky cell
    // tracks the row's hover state instead of staying flat while the rest of
    // the row highlights (the row must carry `className="group"` for this to
    // take effect).
    expect(cell).toHaveClass(
      'sticky',
      'right-0',
      'bg-card',
      'border-l',
      'group-hover:bg-card-hover',
    );
  });

  it('lets a consumer className win alongside the sticky classes', () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell sticky className="w-24 text-right">
              Actions
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    const cell = screen.getByRole('cell', { name: 'Actions' });
    expect(cell).toHaveClass('sticky', 'w-24', 'text-right');
  });
});
