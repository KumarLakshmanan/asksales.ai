import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { toast as sonnerToast } from 'sonner';
import { Toaster } from '@/components/ui/toaster';
import { toast } from '@/hooks/use-toast';

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
afterEach(() => {
  act(() => { sonnerToast.dismiss(); });
  cleanup();
});

it('shared notification actions and cancellation still accept pointer and keyboard input', async () => {
  const user = userEvent.setup();
  render(<Toaster />);
  for (const input of ['pointer', 'keyboard']) {
    const action = vi.fn();
    act(() => { toast({ title: 'Synthetic action notice', variant: 'info', options: {
      duration: Infinity, action: { label: 'Review fixture', onClick: action },
    } }); });
    const button = await screen.findByRole('button', { name: 'Review fixture' });
    if (input === 'pointer') {
      // jsdom has no pointer capture; real browser form regressions use the
      // native implementation. This shim only supplies the missing DOM API.
      Object.defineProperty(button, 'setPointerCapture', { value: vi.fn() });
      await user.click(button);
    }
    else { button.focus(); await user.keyboard('{Enter}'); }
    expect(action).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Review fixture' })).not.toBeInTheDocument());
  }
  const cancel = vi.fn();
  act(() => { toast({ title: 'Synthetic cancel notice', options: {
    duration: Infinity, cancel: { label: 'Keep editing', onClick: cancel },
  } }); });
  const button = await screen.findByRole('button', { name: 'Keep editing' });
  button.focus();
  await user.keyboard(' ');
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('shared notification close controls remain accessible by pointer and keyboard', async () => {
  const user = userEvent.setup();
  render(<Toaster />);
  for (const input of ['pointer', 'keyboard']) {
    act(() => { toast({ title: 'Synthetic error notice', description: 'Recoverable fixture feedback', variant: 'destructive',
      options: { duration: Infinity } }); });
    const button = await screen.findByRole('button', { name: 'Close toast' });
    expect(screen.getByText('Recoverable fixture feedback')).toBeVisible();
    if (input === 'pointer') {
      // jsdom has no pointer capture; real browser form regressions use the
      // native implementation. This shim only supplies the missing DOM API.
      Object.defineProperty(button, 'setPointerCapture', { value: vi.fn() });
      await user.click(button);
    }
    else { button.focus(); await user.keyboard(' '); }
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close toast' })).not.toBeInTheDocument());
  }
});
