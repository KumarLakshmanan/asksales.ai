import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DraftLibraryCard } from '@/components/content-library/DraftLibraryCard';
import { libraryCampaignUrl, readLibraryDraft, updateLibraryDraft, reusableLibraryContent } from '@/lib/libraryDraft';
import { useLibraryCampaignHandoff } from '@/hooks/use-library-campaign-handoff';
import { ReusableTemplateActions } from '@/components/content-library/ReusableTemplateActions';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), push: vi.fn(), toast: vi.fn(), params: new URLSearchParams() }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get, post: mocks.post, put: mocks.put, delete: mocks.delete } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }), useSearchParams: () => mocks.params }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/components/content-library/TemplateVersionHistory', () => ({ TemplateVersionHistory: () => null }));

const asset = { id: 42, title: 'Welcome', type: 'email_template', channel: 'email', status: 'ready', createdAt: '2026-09-18T00:00:00Z', businessProfileId: 5, brandToolkitId: 6, imageUrls: ['https://example.com/image.png'], content: JSON.stringify({ subject: 'Hello', greeting: 'Hi {{first_name}},', body: 'Welcome aboard.', signature: 'Team', imageUrl: 'https://example.com/image.png' }) };
function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><DraftLibraryCard kind="email" asset={asset} onPreview={() => {}} /></QueryClientProvider>);
}
beforeEach(() => { vi.clearAllMocks(); mocks.get.mockResolvedValue(asset); mocks.post.mockResolvedValue({ id: 43 }); mocks.put.mockResolvedValue(asset); mocks.delete.mockResolvedValue({}); mocks.params = new URLSearchParams(); });
afterEach(cleanup);

describe('library draft lifecycle', () => {
  it('preserves section order and media when editing a structured message', () => {
    expect(readLibraryDraft(asset.content).body).toBe('Hi {{first_name}},\n\nWelcome aboard.\n\nTeam');
    const edited = JSON.parse(updateLibraryDraft(asset.content, 'email', 'New subject', 'Revised', ''));
    expect(edited).toMatchObject({ subject: 'New subject', body: 'Revised', imageUrl: 'https://example.com/image.png' });
    expect(edited.greeting).toBeUndefined();
    expect(readLibraryDraft(JSON.stringify(edited)).body).toBe('Revised');
  });

  it('renders all legacy structured blog sections instead of raw JSON', () => {
    const content = JSON.stringify({ title: 'Guide', introduction: 'Start here', sections: [{ heading: 'Step one', content: 'Details' }], conclusion: 'Wrap up' });
    expect(readLibraryDraft(content).body).toBe('Start here\n\n## Step one\n\nDetails\n\n## Conclusion\n\nWrap up');
    expect(readLibraryDraft(JSON.stringify({ content: JSON.stringify({ body: 'Nested article' }) })).body).toBe('Nested article');
  });

  it('copies every email section from a saved draft', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    setup(); fireEvent.click(screen.getByRole('button', { name: 'Copy Welcome' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Hello\n\nHi {{first_name}},\n\nWelcome aboard.\n\nTeam'));
  });
  it('duplicates a draft without copying approval or published state', async () => {
    setup(); fireEvent.click(screen.getByRole('button', { name: 'Duplicate draft' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/content/assets', expect.objectContaining({ title: 'Welcome (copy)', parentAssetId: 42, status: 'draft', brandToolkitId: 6, imageUrls: asset.imageUrls })));
    expect(mocks.post.mock.calls[0][1].approvalStatus).toBeUndefined();
    expect(mocks.post.mock.calls[0][1].publishedAt).toBeUndefined();
  });
  it('converts to a separate reusable template with all email sections', async () => {
    setup(); fireEvent.click(screen.getByRole('button', { name: 'Save as reusable template' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/content/templates', { name: 'Welcome', type: 'email', content: 'Hi {{first_name}},\n\nWelcome aboard.\n\nTeam', subject: 'Hello', htmlContent: null, category: 'email', businessProfileId: 5, brandToolkitId: 6 }));
    expect(mocks.delete).not.toHaveBeenCalled();
  });
  it('opens a real campaign route without sending', () => {
    setup(); fireEvent.click(screen.getByRole('button', { name: /Use in campaign/ }));
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/outreach/email/create?sourceAssetId=42');
    expect(mocks.post).not.toHaveBeenCalled();
    expect(libraryCampaignUrl('sms', 'template', 8)).toBe('/dashboard/outreach/sms/create?sourceTemplateId=8');
  });

  it('keeps channel-specific fields on editing but removes attached media from reusable text copies', () => {
    const ad = JSON.stringify({ headline: 'First', primaryText: 'Original', callToAction: 'Learn more', imageUrl: 'https://example.com/private.png', headlines: ['One', 'Two'] });
    const edited = JSON.parse(updateLibraryDraft(ad, 'ad', 'New headline', 'New copy', ''));
    expect(edited).toMatchObject({ headline: 'New headline', primaryText: 'New copy', callToAction: 'Learn more', imageUrl: 'https://example.com/private.png' });
    const reusable = JSON.parse(reusableLibraryContent('ad', ad));
    expect(reusable).toMatchObject({ headline: 'First', primaryText: 'Original', headlines: ['One', 'Two'] });
    expect(reusable.imageUrl).toBeUndefined();
    expect(JSON.parse(updateLibraryDraft('{"content":"Old","tags":["news"]}', 'blog', 'Title', 'New article', ''))).toEqual({ content: 'New article', title: 'Title', tags: ['news'] });
  });
  it('requires confirmation before deletion', async () => {
    setup(); fireEvent.click(screen.getByRole('button', { name: 'Delete Welcome' }));
    expect(mocks.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith('/api/content/assets/42'));
  });
  it('loads the latest asset before editing and saves only changed text fields', async () => {
    setup(); fireEvent.click(screen.getByRole('button', { name: 'Edit Welcome' }));
    const message = await screen.findByLabelText('Message');
    fireEvent.change(message, { target: { value: 'Updated message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/api/content/assets/42', { title: 'Welcome', content: expect.any(String) }));
    expect(JSON.parse(mocks.put.mock.calls[0][1].content)).toMatchObject({ body: 'Updated message', imageUrl: 'https://example.com/image.png' });
  });
  it('blocks blind retry when a create response is uncertain', async () => {
    mocks.post.mockRejectedValue(new Error('Connection lost'));
    setup(); fireEvent.click(screen.getByRole('button', { name: 'Duplicate draft' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Duplicate draft' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('may already have been saved');
  });
});

it('campaign handoff loads the selected owned record and preserves the whole message', async () => {
  mocks.params = new URLSearchParams('sourceAssetId=42');
  const apply = vi.fn();
  function Harness() { useLibraryCampaignHandoff('email', apply); return null; }
  render(<Harness />);
  await waitFor(() => expect(apply).toHaveBeenCalledWith({ subject: 'Hello', body: 'Hi {{first_name}},\n\nWelcome aboard.\n\nTeam' }));
  expect(mocks.get).toHaveBeenCalledWith('/api/content/assets/42');
  expect(mocks.post).not.toHaveBeenCalled();
});

it('rejects cross-channel campaign handoff', async () => {
  mocks.params = new URLSearchParams('sourceAssetId=42');
  const apply = vi.fn();
  function Harness() { useLibraryCampaignHandoff('sms', apply); return null; }
  render(<Harness />);
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Unable to load selected content' })));
  expect(apply).not.toHaveBeenCalled();
});

it('reviews and approves the exact displayed reusable template version', async () => {
  const template = { id: 8, name: 'Review copy', content: 'Hello', version: 3, isApproved: false };
  mocks.get.mockResolvedValue(template); mocks.post.mockResolvedValue({ ...template, isApproved: true, version: 4 });
  const queryClient = new QueryClient();
  render(<QueryClientProvider client={queryClient}><ReusableTemplateActions templateId={8} kind="email" /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Review template' }));
  await screen.findByRole('dialog');
  expect(screen.getByText(/Needs approval/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Approve reviewed version' }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/content/templates/8/approve', { expectedVersion: 3 }));
  expect(await screen.findByText(/Approved for reuse/)).toBeInTheDocument();
});

it('does not hand an unapproved reusable copy to a campaign', async () => {
  mocks.params = new URLSearchParams('sourceTemplateId=8');
  mocks.get.mockResolvedValue({ type: 'email', content: 'Hello', isApproved: false });
  const apply = vi.fn();
  function Harness() { useLibraryCampaignHandoff('email', apply); return null; }
  render(<Harness />);
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining('Review and approve') })));
  expect(apply).not.toHaveBeenCalled();
});
