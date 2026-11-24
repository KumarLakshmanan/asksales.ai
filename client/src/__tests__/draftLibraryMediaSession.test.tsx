import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DraftLibraryCard } from '@/components/content-library/DraftLibraryCard';
import type { MediaManagerProps } from '@/components/MediaManager';

const mocks = vi.hoisted(() => ({ get: vi.fn(), toast: vi.fn(), callbacks: [] as MediaManagerProps['onMediaChange'][] }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/MediaManager', () => ({ default: ({ images, videos, onMediaChange }: MediaManagerProps) => {
  mocks.callbacks.push(onMediaChange);
  return <output aria-label="Editor media">{images.join(',')}|{videos.join(',')}</output>;
} }));

beforeEach(() => { vi.resetAllMocks(); mocks.callbacks.splice(0); });
afterEach(cleanup);

it('parent editor rejects an already-retained old callback after same-draft reopen', async () => {
  const original = '/uploads/session-original.png', newer = '/uploads/session-newer.png';
  const asset = { id: 812, title: 'Disposable parent guard', type: 'social_post', channel: 'instagram', status: 'draft',
    createdAt: '2026-10-01T00:00:00Z', content: JSON.stringify({ caption: 'Original text' }), imageUrls: [original], videoUrls: ['/uploads/session.mp4'] };
  mocks.get.mockResolvedValue(asset);
  const client = new QueryClient();
  const invalidations = vi.spyOn(client, 'invalidateQueries');
  const user = userEvent.setup();
  render(<QueryClientProvider client={client}><DraftLibraryCard asset={asset} kind="social" /></QueryClientProvider>);
  await user.click(screen.getByRole('button', { name: 'Edit Disposable parent guard' }));
  let editor = within(await screen.findByRole('dialog', { name: 'Edit social draft' }));
  const staleCallback = mocks.callbacks.at(-1)!;
  await user.click(editor.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const closedInvalidations = invalidations.mock.calls.length;
  await act(async () => staleCallback(['/uploads/closed-session.png'], []));
  expect(invalidations).toHaveBeenCalledTimes(closedInvalidations);
  await user.click(screen.getByRole('button', { name: 'Edit Disposable parent guard' }));
  editor = within(await screen.findByRole('dialog', { name: 'Edit social draft' }));
  await user.clear(editor.getByLabelText('Message')); await user.type(editor.getByLabelText('Message'), 'Keep active editor text');
  await act(async () => mocks.callbacks.at(-1)!([original, newer], asset.videoUrls));
  const currentInvalidations = invalidations.mock.calls.length;
  await act(async () => staleCallback(['/uploads/retired-session.png'], []));
  expect(editor.getByLabelText('Editor media')).toHaveTextContent(`${original},${newer}|/uploads/session.mp4`);
  expect(editor.getByLabelText('Message')).toHaveValue('Keep active editor text');
  expect(invalidations).toHaveBeenCalledTimes(currentInvalidations);
  client.clear();
});
