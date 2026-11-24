import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DeleteDraftAction } from '@/components/content-studio/DeleteDraftAction';
afterEach(cleanup);
it('requires confirmation and lets the user keep the draft', () => {
  const remove = vi.fn();
  render(<DeleteDraftAction onDelete={remove} />);
  fireEvent.click(screen.getByRole('button', { name: 'Delete draft' }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Keep draft' }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Delete draft' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete draft' }).at(-1)!);
  expect(remove).toHaveBeenCalledTimes(1);
});
