import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import EmailTab from '@/components/tabs/content-studio/EmailTab';
import SmsTab from '@/components/tabs/content-studio/SmsTab';
import SocialTab from '@/components/tabs/content-studio/SocialTab';
import SocialMessageTab from '@/components/tabs/content-studio/SocialMessageTab';
import api from '@/lib/api';
const mocks = vi.hoisted(() => ({ toast: vi.fn(), subscribe: vi.fn(() => () => {}) }));
vi.mock('@/lib/api', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-content-brand-context', () => ({ useContentBrandContext: () => ({ brandToolkitId: 7, businessProfileId: 9 }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: mocks.subscribe }) }));
vi.mock('@/components/content-studio/GenerationEstimate', () => ({ GenerationEstimate: () => null }));
vi.mock('@/components/content-studio/SmsSendingEstimate', () => ({ SmsSendingEstimate: () => null }));
vi.mock('@/components/content-cards', () => ({
  EmailCard: ({ title, onEdit }: { title: string; onEdit: () => void }) => <article>{title}<button onClick={onEdit}>Open saved email</button></article>,
  SmsCard: () => <article>Saved SMS card</article>, SocialPostCard: () => <article>Saved social card</article>, SocialMessageCard: () => <article>Saved message card</article>,
}));
vi.mock('@/components/modals', () => ({ ContentFullscreenModal: () => null }));
vi.mock('@/components/social-publishing/SocialPublisher', () => ({ SocialPublisher: () => null }));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.get).mockResolvedValue([] as never); });
afterEach(cleanup);

async function openEmailMedia(kind: 'image' | 'video') {
  const user = userEvent.setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Open saved email' }));
  await user.click(screen.getByRole('button', { name: 'Generate' }));
  if (kind === 'video') await user.click(screen.getByRole('tab', { name: 'Video' }));
  return screen.getByRole('button', { name: kind === 'image' ? 'Generate Image' : 'Generate Video' });
}

it.each([true, false])('attaches email images through the shared manager only with the exact parent receipt: %s', async attached => {
  vi.mocked(api.get).mockResolvedValue([{ id: 123, type: 'email_template', title: 'Saved email', content: '{"subject":"Saved email","body":"Notes"}', createdAt: '2026-09-01T00:00:00Z' }] as never);
  vi.mocked(api.post).mockResolvedValue({ success: true, persisted: attached, assetId: attached ? 123 : 999, imageUrl: '/uploads/attached.png' } as never);
  const onSendMessage = vi.fn();
  render(<EmailTab threadId={171} onSendMessage={onSendMessage} />);
  fireEvent.click(await openEmailMedia('image'));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/content/studio/image', expect.objectContaining({ assetId: 123, threadId: 171, saveToAssets: true })));
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: attached ? 'Image attached' : 'Error' })));
  expect(onSendMessage).not.toHaveBeenCalled();
  expect(api.post).toHaveBeenCalledTimes(1);
});

it.each(['saved', 'queued', 'unconfirmed'] as const)('preserves the email parent for reviewed video attachment: %s', async outcome => {
  vi.mocked(api.get).mockResolvedValue([{ id: 123, type: 'email_template', title: 'Saved email', content: '{"subject":"Saved email","body":"Notes"}', createdAt: '2026-09-01T00:00:00Z' }] as never);
  vi.mocked(api.post).mockResolvedValue({ success: true, persisted: outcome !== 'unconfirmed', assetId: 123, ...(outcome === 'saved' ? { videoUrl: '/uploads/tour.mp4' } : { operationName: 'operations/tour' }) } as never);
  render(<EmailTab threadId={171} />);
  fireEvent.click(await openEmailMedia('video'));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/content/studio/video', expect.objectContaining({ assetId: 123, threadId: 171, saveToAssets: true })));
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: outcome === 'saved' ? 'Video attached' : outcome === 'queued' ? 'Video generation queued' : 'Error' })));
  expect(api.post).toHaveBeenCalledTimes(1);
});

for (const [Component, endpoint, _compose, placeholder, card, response] of [
  [EmailTab, 'email', 'Generate Email', /^Enter a prompt for the email/, 'Resort invitation', { subject: 'Resort invitation', body: 'Visit our resort' }],
  [SmsTab, 'sms', 'Generate SMS', /^Enter a prompt for the SMS/, 'Saved SMS card', { message: 'A useful message' }],
  [SocialTab, 'social', 'Generate Post', /^Enter a prompt for the social post/, 'Saved social card', { content: 'A social caption' }],
  [SocialMessageTab, 'social-message', 'Generate DM', /^Enter a prompt for the DM/, 'Saved message card', { message: 'A useful message' }],
] as const) {
  it.each([true, false])(`${endpoint} uses the canonical creator, keeps campaign ownership and requires persistence: %s`, async persisted => {
    vi.mocked(api.post).mockResolvedValueOnce({ success: true, ...response, ...(persisted ? { assetId: 124 } : {}) } as never);
    render(<Component threadId={171} />);
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value: 'A reviewed resort update' } });
    fireEvent.click(document.querySelector<HTMLButtonElement>('button[data-creator-action]')!);
    const request = [`/api/content/studio/${endpoint}`, expect.objectContaining({ threadId: 171 })];
    if (endpoint === 'email') request.push({ signal: expect.any(AbortSignal) });
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(...request));
    if (persisted) await screen.findByText(card);
    else {
      await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error', description: expect.stringContaining('confirmed saved draft') })));
      expect(screen.queryByText(card)).not.toBeInTheDocument();
    }
    expect(api.post).toHaveBeenCalledTimes(1);
  });
}
