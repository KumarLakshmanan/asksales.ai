import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import SmsGenerationPage from '@/app/dashboard/(main)/saved-templates/sms/generate/page';
import EmailGenerationPage from '@/app/dashboard/(main)/saved-templates/email/generate/page';
import BlogGenerationPage from '@/app/dashboard/(main)/saved-templates/blog/generate/page';
import { useDmOutreach } from '@/components/content-studio/useDmOutreach';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), push: vi.fn(), toast: vi.fn(), subscribe: vi.fn(() => () => {}) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/lib/api', () => ({ default: mocks }));
vi.mock('@/components/content-studio/SmsSendingEstimate', () => ({ SmsSendingEstimate: () => null }));
vi.mock('@/components/content-studio/GenerationEstimate', () => ({ GenerationEstimate: () => null }));
vi.mock('@/components/content-library/BlogCmsReviewHandoff', () => ({ BlogCmsReviewHandoff: () => null }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: mocks.subscribe }) }));
vi.mock('@/hooks/use-content-brand-context', () => ({ useContentBrandContext: () => ({ brandToolkitId: 7, businessProfileId: 9 }) }));
vi.mock('@/components/content-studio/GeneratorMode', () => ({ GeneratorModeSwitch: () => null, ManualContentComposer: () => null }));
vi.mock('@/components/content-studio/CreatorPreview', () => ({ CreatorPreview: () => null, manualDraftPreview: () => ({}) }));
vi.mock('@/components/content-studio/ContentCreatorShell', () => {
  const Wrap = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return { ContentCreatorBody: Wrap, ContentCreatorComposer: Wrap, ContentCreatorHeader: Wrap, ContentCreatorShell: Wrap, ContentCreatorStage: Wrap, CreatorResultsPane: Wrap };
});
vi.mock('@/components/content-cards', () => ({
  EmailCard: ({ onEdit }: { onEdit: () => void }) => <button onClick={onEdit}>Open saved draft</button>,
  BlogPostCard: ({ onPreview }: { onPreview: () => void }) => <button onClick={onPreview}>Open saved draft</button>,
  SmsCard: () => null,
}));
vi.mock('@/components/MediaManager', () => ({ default: ({ images, videos, onMediaChange }: { images: string[]; videos: string[]; onMediaChange: (images: string[], videos: string[]) => void }) => <div><output data-testid="media">{images.join(',')}|{videos.join(',')}</output><button onClick={() => onMediaChange(['/uploads/new.png'], [])}>Replace media</button></div> }));
beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); mocks.get.mockResolvedValue([]); });
afterEach(cleanup);

it('passes the visible SMS limit and opt-out requirement as structured settings', async () => {
  mocks.post.mockResolvedValue({ success: true, assetId: 12, message: 'Hello. Reply STOP to opt out.' });
  render(<SmsGenerationPage />);
  fireEvent.change(screen.getByLabelText('SMS Prompt'), { target: { value: 'Promote a workshop' } });
  fireEvent.click(screen.getByRole('button', { name: '320 characters' }));
  fireEvent.click(screen.getByRole('button', { name: 'Generate SMS' }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/content/studio/sms', expect.objectContaining({ maxCharacters: 320, includeOptOut: true })));
});

it.each([
  ['email', EmailGenerationPage, 'email_template', JSON.stringify({ subject: 'QA subject', body: 'QA message' })],
  ['sms', SmsGenerationPage, 'sms_template', 'QA SMS message'],
  ['blog', BlogGenerationPage, 'blog_post', 'QA article body'],
] as const)('hydrates and updates %s draft attachments in the dialog', async (kind, Page, type, content) => {
  mocks.get.mockResolvedValue([{ id: 12, type, title: 'QA saved draft', content, createdAt: '2026-09-01', imageUrls: ['/uploads/existing.png'], videoUrls: ['/uploads/existing.mp4'] }]);
  render(<Page />);
  if (kind === 'sms') {
    fireEvent.click(screen.getByRole('button', { name: 'List view' }));
    fireEvent.click(await screen.findByText('QA SMS message'));
  } else fireEvent.click(await screen.findByRole('button', { name: 'Open saved draft' }));
  expect(await screen.findByTestId('media')).toHaveTextContent('/uploads/existing.png|/uploads/existing.mp4');
  fireEvent.click(screen.getByRole('button', { name: 'Replace media' }));
  expect(screen.getByTestId('media')).toHaveTextContent('/uploads/new.png|');
  expect(screen.getByTestId('media')).not.toHaveTextContent('existing');
});

it('does not silently choose Instagram for an all-platform DM', () => {
  function Harness() {
    const { openOutreach, destinationDialog } = useDmOutreach();
    return <><button onClick={() => openOutreach('Hello prospect', 'all')}>Use in outreach</button>{destinationDialog}</>;
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Use in outreach' }));
  expect(mocks.push).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'LinkedIn' }));
  expect(mocks.push).toHaveBeenCalledWith('/dashboard/outreach/linkedin/create?message=Hello%20prospect');
});

it('requires explicit outline approval and includes reviewed editorial fields', async () => {
  mocks.post.mockResolvedValue({ success: true, assetId: 14, title: 'Article', content: '# Article\nReviewed body' });
  render(<BlogGenerationPage />);
  fireEvent.change(screen.getByLabelText('Blog Prompt'), { target: { value: 'Explain workflows' } });
  fireEvent.click(screen.getByLabelText('Review an outline first'));
  const generate = screen.getByRole('button', { name: 'Generate Blog Post' });
  expect(generate).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Outline to review'), { target: { value: '## Workflow basics' } });
  fireEvent.change(screen.getByLabelText('SEO title'), { target: { value: 'Workflow guide' } });
  fireEvent.click(screen.getByRole('button', { name: 'Approve outline' }));
  fireEvent.click(generate);
  await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/content/studio/blog-post', expect.objectContaining({ stage: 'article', editorial: expect.objectContaining({ outline: '## Workflow basics', outlineApproved: true, seoTitle: 'Workflow guide' }) })));
});
