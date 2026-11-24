import type { ComponentType } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import EmailPage from '@/app/dashboard/(main)/saved-templates/email/generate/page';
import SmsPage from '@/app/dashboard/(main)/saved-templates/sms/generate/page';
import DmPage from '@/app/dashboard/(main)/saved-templates/dm/generate/page';
import BlogPage from '@/app/dashboard/(main)/saved-templates/blog/generate/page';
import AdsPage from '@/app/dashboard/(main)/saved-templates/ads/generate/page';
import SocialPage from '@/app/dashboard/(main)/saved-templates/social/generate/page';
import ImagePage from '@/app/dashboard/(main)/saved-templates/image/generate/page';
import VideoPage from '@/app/dashboard/(main)/saved-templates/video/generate/page';

// Render real pages and drive their form handlers. Only provider/API boundaries
// and presentation-only children are mocked; no generation or publication leaves this test.
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), toast: vi.fn(), push: vi.fn(), subscribe: vi.fn(() => () => undefined) }));
vi.mock('@/lib/api', () => ({ default: mocks, api: mocks }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: mocks.subscribe }) }));
vi.mock('@/hooks/use-content-brand-context', () => ({ useContentBrandContext: () => ({ brandToolkitId: 7, businessProfileId: 9, missingMessage: '' }) }));
vi.mock('@/components/MediaManager', () => ({ default: () => null }));
vi.mock('@/components/content-studio/GenerationEstimate', () => ({ GenerationEstimate: () => null }));
vi.mock('@/components/content-studio/SmsSendingEstimate', () => ({ SmsSendingEstimate: () => null }));
vi.mock('@/components/content-library/BlogCmsReviewHandoff', () => ({ BlogCmsReviewHandoff: () => null }));
vi.mock('@/components/modals', () => ({ ContentFullscreenModal: () => null }));
vi.mock('@/components/modals/EditAdModal', () => ({ default: () => null }));
vi.mock('@/components/social-publishing/SocialPublisher', () => ({ SocialPublisher: () => null }));
vi.mock('@/components/content-studio/CreatorPreview', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/components/content-studio/CreatorPreview')>(),
  CreatorPreview: ({ model }: { model: Record<string, unknown> }) => <output data-testid="current-preview" data-status={String(model.status)}>{JSON.stringify(model)}</output>,
}));
vi.mock('@/components/content-cards', () => ({
  EmailCard: () => <article>Saved email card</article>, SmsCard: () => <article>Saved SMS card</article>,
  SocialMessageCard: () => <article>Saved DM card</article>, BlogPostCard: () => <article>Saved blog card</article>,
  AdCopyCard: () => <article>Saved ad card</article>, SocialPostCard: () => <article>Saved social card</article>,
  ImageCard: () => <article>Image preview card</article>, VideoCard: () => <article>Video preview card</article>,
}));

type FormatCase = { name: string; Component: ComponentType; endpoint: string; button: string; placeholder: RegExp; response: Record<string, unknown>; media?: 'image' | 'video' };
const formats: FormatCase[] = [
  { name: 'email', Component: EmailPage, endpoint: 'email', button: 'Generate Email', placeholder: /^Enter a prompt for the email/, response: { subject: 'Exact reviewed subject', body: 'Saved generated email body' } },
  { name: 'SMS', Component: SmsPage, endpoint: 'sms', button: 'Generate SMS', placeholder: /^Enter a prompt for the SMS/, response: { message: 'Saved generated SMS body' } },
  { name: 'DM', Component: DmPage, endpoint: 'social-message', button: 'Generate DM', placeholder: /^Enter a prompt for the DM/, response: { message: 'Saved generated direct message' } },
  { name: 'blog', Component: BlogPage, endpoint: 'blog-post', button: 'Generate Blog Post', placeholder: /^Enter a prompt for the blog post/, response: { title: 'Saved blog title', content: 'Saved generated blog body' } },
  { name: 'ad copy', Component: AdsPage, endpoint: 'ad-copy-content', button: 'Generate Ad Copy', placeholder: /^Enter a prompt for the ad/, response: { headline: 'Saved ad headline', primaryText: 'Saved generated ad body', cta: 'Review details' } },
  { name: 'social', Component: SocialPage, endpoint: 'social', button: 'Generate Post', placeholder: /^Enter a prompt for the social post/, response: { content: 'Saved generated social body' } },
  { name: 'image', Component: ImagePage, endpoint: 'image', button: 'Generate Image', placeholder: /^A professional marketing image/, response: { imageUrl: '/uploads/generated-proof.png', persisted: true }, media: 'image' },
  { name: 'video', Component: VideoPage, endpoint: 'video', button: 'Generate Video', placeholder: /^A smooth product reveal video/, response: { videoUrl: '/uploads/generated-proof.mp4', persisted: true }, media: 'video' },
];
const PROMPT = 'Keep the exact subject "Quarterly planning". Do not add performance claims. End with https://example.invalid/review?a=1&b=2.';

function mountAndFill(format: FormatCase) {
  // The app wraps every page in a QueryClientProvider; the image page reads model options through it.
  const view = render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><format.Component /></QueryClientProvider>);
  fireEvent.change(screen.getByPlaceholderText(format.placeholder), { target: { value: PROMPT } });
  return { ...view, generate: screen.getByRole('button', { name: format.button }) };
}

describe('all eight Studio generator pages: reviewed requests and receipts', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    mocks.get.mockResolvedValue([]);
    mocks.post.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each(formats)('$name sends the exact user prompt without implicit enhancement and confirms a saved success', async (format) => {
    mocks.post.mockResolvedValue({ success: true, assetId: 901, ...format.response });
    const { generate } = mountAndFill(format);
    fireEvent.click(generate);
    await waitFor(() => expect(screen.getByTestId('current-preview')).toHaveAttribute('data-status', 'ready'));
    expect(screen.getByTestId('current-preview')).toHaveTextContent(String(Object.values(format.response).find((value) => typeof value === 'string')));
    const request = [`/api/content/studio/${format.endpoint}`, expect.objectContaining({ prompt: expect.stringContaining(PROMPT), brandToolkitId: 7, businessProfileId: 9 })];
    if (format.name === 'email') request.push({ signal: expect.any(AbortSignal) });
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(...request);
    const sent = mocks.post.mock.calls[0][1].prompt as string;
    expect(sent.startsWith(PROMPT)).toBe(true);
    expect(sent.split(PROMPT)).toHaveLength(2);
    expect(mocks.post.mock.calls.some(([path]) => String(path).includes('enhance-prompt'))).toBe(false);
    expect(mocks.toast.mock.calls.at(-1)?.[0].variant).not.toBe('destructive');
    expect(screen.getByRole('button', { name: format.button })).toBeEnabled();
    expect(screen.getByPlaceholderText(format.placeholder)).toHaveValue(PROMPT);
  });

  it.each(formats)('$name clears the generation loader after provider failure without claiming success', async (format) => {
    let rejectRequest!: (error: Error) => void;
    mocks.post.mockImplementation(() => new Promise((_resolve, reject) => { rejectRequest = reject; }));
    const { generate } = mountAndFill(format);
    fireEvent.click(generate);
    expect(generate).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('current-preview')).toHaveAttribute('data-status', 'generating');
    await act(async () => { rejectRequest(new Error('Provider unavailable — test only')); });
    await waitFor(() => { const button = screen.getByRole('button', { name: format.button }); expect(button).toBeEnabled(); expect(button).not.toHaveAttribute('aria-busy'); });
    expect(screen.getByTestId('current-preview')).toHaveAttribute('data-status', 'failed');
    expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ variant: 'destructive', description: format.name === 'email' ? 'Email generation could not be confirmed. Check email templates before generating again.' : 'Provider unavailable — test only' }));
    expect(screen.getByPlaceholderText(format.placeholder)).toHaveValue(PROMPT);
  });

  for (const format of formats.filter((item) => !item.media)) {
    it.each([undefined, 0, -1])(`${format.name} requires a positive saved asset ID, received %s`, async (assetId) => {
      mocks.post.mockResolvedValue({ success: true, assetId, ...format.response });
      const { generate } = mountAndFill(format);
      fireEvent.click(generate);
      await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive', description: expect.stringContaining('confirmed saved draft') })));
      expect(screen.getByTestId('current-preview')).toHaveAttribute('data-status', 'failed');
      expect(screen.getByRole('button', { name: format.button })).toBeEnabled();
    });
  }

  it.each(formats.filter((item) => item.media))('$name permits an unsaved preview but clearly warns that library saving was not confirmed', async (format) => {
    mocks.post.mockResolvedValue({ success: true, ...format.response, persisted: false });
    const { generate } = mountAndFill(format);
    fireEvent.click(generate);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive', description: expect.stringContaining('saving to your library was not confirmed') })));
    expect(screen.getByTestId('current-preview')).toHaveAttribute('data-status', 'ready');
    expect(screen.getByRole('button', { name: format.button })).toBeEnabled();
  });

  it.each(formats.filter((item) => item.media !== 'video'))('$name keeps the previous result while editing and reports a later generation failure', async (format) => {
    let resolveRequest!: (result: unknown) => void;
    mocks.post.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const { generate } = mountAndFill(format);
    const preview = () => JSON.parse(screen.getByTestId('current-preview').textContent || '{}');
    expect(preview().status).toBe('empty');
    expect(JSON.stringify(preview())).not.toContain(PROMPT);
    fireEvent.click(generate);
    expect(preview().submittedPrompt).toBe(PROMPT);
    fireEvent.change(screen.getByPlaceholderText(format.placeholder), { target: { value: 'Different next request' } });
    expect(preview().submittedPrompt).toBe(PROMPT);
    await act(async () => { resolveRequest({ success: true, assetId: 901, ...format.response }); });
    expect(preview().status).toBe('ready');
    const result = preview();
    fireEvent.change(screen.getByPlaceholderText(format.placeholder), { target: { value: 'A third request' } });
    expect(preview()).toEqual(result);
    mocks.post.mockRejectedValueOnce(new Error('Temporary outage'));
    fireEvent.click(screen.getByRole('button', { name: format.button }));
    await waitFor(() => expect(preview().error).toBe(format.name === 'email' ? 'Email generation could not be confirmed. Check email templates before generating again.' : 'Temporary outage'));
    // Email keeps showing the previous result with the error above it (see emailGenerationRecovery.test).
    expect(preview().status).toBe(format.name === 'email' ? 'ready' : 'failed');
    for (const key of ['body', 'message', 'caption', 'sourceUrl']) expect(preview()[key]).toEqual(result[key]);
  });

  it('reports a video generation failure after a previous successful video', async () => {
    const format = formats.find(item => item.name === 'video')!;
    mocks.post.mockResolvedValueOnce({ success: true, assetId: 901, ...format.response });
    const { generate } = mountAndFill(format);
    fireEvent.click(generate);
    await waitFor(() => expect(screen.getByTestId('current-preview')).toHaveAttribute('data-status', 'ready'));
    await waitFor(() => expect(screen.getByRole('button', { name: format.button })).toBeEnabled());
    mocks.post.mockRejectedValueOnce(new Error('Video provider unavailable'));
    fireEvent.click(screen.getByRole('button', { name: format.button }));
    await waitFor(() => expect(screen.getByTestId('current-preview')).toHaveAttribute('data-status', 'failed'));
    expect(screen.getByTestId('current-preview')).toHaveTextContent('Video provider unavailable');
  });

  it.each([
    { format: formats[0], mode: 'Write an email', label: 'Email body', field: 'body' },
    { format: formats[1], mode: 'Write an SMS', label: 'SMS message', field: 'message' },
    { format: formats[2], mode: 'Write a DM', label: 'Direct message', field: 'message' },
    { format: formats[3], mode: 'Write a post', label: 'Article content', field: 'body' },
    { format: formats[4], mode: 'Build an ad', label: 'Ad copy', field: 'body' },
  ])('$format.name previews manual writing and retains it across mode changes', async ({ format, mode, label, field }) => {
    mountAndFill(format);
    fireEvent.click(screen.getByRole('button', { name: mode }));
    fireEvent.change(screen.getByLabelText(label), { target: { value: 'Manual content only' } });
    expect(JSON.parse(screen.getByTestId('current-preview').textContent || '{}')[field]).toBe('Manual content only');
    expect(screen.getByTestId('current-preview')).not.toHaveTextContent(PROMPT);
    fireEvent.click(screen.getByRole('button', { name: 'AI generator' }));
    expect(screen.getByTestId('current-preview')).toHaveAttribute('data-status', 'empty');
    fireEvent.click(screen.getByRole('button', { name: mode }));
    expect(screen.getByLabelText(label)).toHaveValue('Manual content only');
    expect(screen.getByTestId('current-preview')).toHaveTextContent('Manual content only');
  });

  it('previews only manual social copy and preserves it across mode changes', async () => {
    mountAndFill(formats[5]);
    expect(screen.getByLabelText('Social Post Prompt')).toHaveValue(PROMPT);
    fireEvent.click(screen.getByRole('button', { name: 'Custom Post' }));
    expect(screen.getByLabelText('Post Content / Caption')).toBeInTheDocument();
    const input = screen.getByPlaceholderText('Write your custom post caption here...');
    fireEvent.change(input, { target: { value: 'My manual social caption' } });
    expect(JSON.parse(screen.getByTestId('current-preview').textContent || '{}').caption).toBe('My manual social caption');
    expect(screen.getByTestId('current-preview')).not.toHaveTextContent(PROMPT);
    fireEvent.click(screen.getByRole('button', { name: 'AI generator' }));
    expect(screen.getByTestId('current-preview')).toHaveAttribute('data-status', 'empty');
    fireEvent.click(screen.getByRole('button', { name: 'Custom Post' }));
    await waitFor(() => expect(screen.getByPlaceholderText('Write your custom post caption here...')).toHaveValue('My manual social caption'));
  });

  it('previews a manual image URL independently of AI instructions', () => {
    mountAndFill(formats[6]);
    fireEvent.click(screen.getByRole('button', { name: 'Upload an image' }));
    fireEvent.change(screen.getByLabelText('Image URL'), { target: { value: '/uploads/manual-proof.png' } });
    expect(JSON.parse(screen.getByTestId('current-preview').textContent || '{}').sourceUrl).toBe('/uploads/manual-proof.png');
    expect(screen.getByTestId('current-preview')).not.toHaveTextContent(PROMPT);
    fireEvent.click(screen.getByRole('button', { name: 'AI generator' }));
    expect(screen.getByTestId('current-preview')).toHaveAttribute('data-status', 'empty');
    fireEvent.click(screen.getByRole('button', { name: 'Upload an image' }));
    expect(screen.getByLabelText('Image URL')).toHaveValue('/uploads/manual-proof.png');
  });

  it.each(formats.filter((item) => item.media !== 'video'))('$name enhances only on request without changing the output preview', async (format) => {
    mocks.post.mockResolvedValue({ success: true, enhancedPrompt: 'Enhanced instructions only' });
    mountAndFill(format);
    fireEvent.click(screen.getByRole('button', { name: 'Enhance' }));
    await screen.findByRole('button', { name: 'Apply' });
    expect(screen.getByPlaceholderText(format.placeholder)).toHaveValue(PROMPT);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.getByPlaceholderText(format.placeholder)).toHaveValue('Enhanced instructions only'));
    expect(mocks.post).toHaveBeenCalledWith('/api/content/studio/magic-prompt', expect.objectContaining({ currentPrompt: PROMPT, brandToolkitId: 7, businessProfileId: 9, contentType: expect.any(String) }));
    expect(screen.getByTestId('current-preview')).toHaveAttribute('data-status', 'empty');
    expect(screen.getByTestId('current-preview')).not.toHaveTextContent('Enhanced instructions only');
  });

  it('sends the selected blog length and tone as structured API settings', async () => {
    mocks.post.mockResolvedValue({ success: true, assetId: 905, ...formats[3].response });
    mountAndFill(formats[3]);
    fireEvent.click(screen.getByRole('button', { name: 'Additional Settings' }));
    fireEvent.click(screen.getByRole('button', { name: /~500 words/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate Blog Post' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/content/studio/blog-post', expect.objectContaining({ wordCount: 500, tone: 'professional' })));
  });

  it.each(formats.filter((item) => item.media))('$name never treats a negative asset ID as saved', async (format) => {
    mocks.post.mockResolvedValue({ success: true, ...format.response, persisted: true, assetId: -1 });
    const { generate } = mountAndFill(format);
    fireEvent.click(generate);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive', description: expect.stringContaining('saving to your library was not confirmed') })));
  });

  it('keeps a persisted queued video in processing until the saved completion receipt arrives', async () => {
    vi.useFakeTimers();
    mocks.post.mockResolvedValue({ success: true, persisted: true, assetId: 901, operationName: 'operations/review-proof' });
    mocks.get.mockImplementation((path: string) => path.includes('/video/status/') ? Promise.resolve({ done: true, success: true, persisted: true, assetId: 901, videoUrl: '/uploads/completed-proof.mp4' }) : Promise.resolve([]));
    const { generate } = mountAndFill(formats.find((format) => format.media === 'video')!);
    await act(async () => { fireEvent.click(generate); });
    expect(screen.getByTestId('current-preview')).toHaveAttribute('data-status', 'generating');
    expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Video generation started', description: expect.stringContaining('processing') }));
    expect(screen.getByRole('button', { name: 'Generate Video' })).toBeEnabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByTestId('current-preview')).toHaveAttribute('data-status', 'ready');
    expect(screen.getByTestId('current-preview')).toHaveTextContent('/uploads/completed-proof.mp4');
    expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Video ready' }));
  });

  it('does not show an untracked queued video as safely processing', async () => {
    mocks.post.mockResolvedValue({ success: true, persisted: false, operationName: 'operations/untracked' });
    const { generate } = mountAndFill(formats.find((format) => format.media === 'video')!);
    fireEvent.click(generate);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive', description: expect.stringContaining('tracking record was not saved') })));
    expect(screen.getByTestId('current-preview')).toHaveAttribute('data-status', 'failed');
    expect(screen.getByRole('button', { name: 'Generate Video' })).toBeEnabled();
  });

  it('warns once for an unconfirmed video save and keeps checking the same operation until persistence succeeds', async () => {
    vi.useFakeTimers();
    mocks.post.mockResolvedValue({ success: true, persisted: true, assetId: 901, operationName: 'operations/save-recovery' });
    let statusCalls = 0;
    mocks.get.mockImplementation((path: string) => {
      if (!path.includes('/video/status/')) return Promise.resolve([]);
      statusCalls += 1;
      return Promise.resolve({ done: true, success: true, persisted: statusCalls >= 3, assetId: statusCalls >= 3 ? 901 : undefined, videoUrl: '/uploads/save-recovery.mp4' });
    });
    const { generate } = mountAndFill(formats.find((format) => format.media === 'video')!);
    await act(async () => { fireEvent.click(generate); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(screen.getByTestId('current-preview')).toHaveAttribute('data-status', 'generating');
    expect(mocks.toast.mock.calls.filter(([value]) => value.title === 'Video save not confirmed')).toHaveLength(1);
    expect(mocks.toast.mock.calls.some(([value]) => value.title === 'Video generation failed')).toBe(false);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByTestId('current-preview')).toHaveAttribute('data-status', 'ready');
    expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Video ready' }));
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it('shows a terminal queued-video failure without leaving the current preview loading', async () => {
    vi.useFakeTimers();
    mocks.post.mockResolvedValue({ success: true, persisted: true, assetId: 901, operationName: 'operations/failed-proof' });
    mocks.get.mockImplementation((path: string) => path.includes('/video/status/') ? Promise.resolve({ done: true, success: false, error: 'Provider rejected the generated video' }) : Promise.resolve([]));
    const { generate } = mountAndFill(formats.find((format) => format.media === 'video')!);
    await act(async () => { fireEvent.click(generate); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByTestId('current-preview')).toHaveAttribute('data-status', 'failed');
    expect(screen.getByRole('button', { name: 'Generate Video' })).toBeEnabled();
    expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Video generation failed', variant: 'destructive' }));
  });
});
