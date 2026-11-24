import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BlogCmsReviewHandoff } from '@/components/content-library/BlogCmsReviewHandoff';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get, post: mocks.post } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
let complete = true;
const source = { id: 9, userId: 7, title: 'Article', content: 'Draft body', version: 2, brandToolkitId: 3, businessProfileId: 4 };
beforeEach(() => {
  vi.clearAllMocks(); complete = true;
  mocks.get.mockImplementation(async (path: string) => path === '/api/content/assets/9' ? source : path.endsWith('/audits') ? { audits: complete ? [{ status: 'completed' }] : [] } : { projects: [{ id: 2, userId: 7, name: 'Brand site', domain: 'https://example.com', brandToolkitId: 3, businessProfileId: 4 }, { id: 3, userId: 7, name: 'Other brand', brandToolkitId: 99, businessProfileId: 4 }] });
  mocks.post.mockResolvedValue({ linkId: 77 });
});
afterEach(cleanup);
function setup() { const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); render(<QueryClientProvider client={client}><BlogCmsReviewHandoff assetId={9} /></QueryClientProvider>); fireEvent.click(screen.getByRole('button', { name: 'Send to CMS review' })); }

it('hands the exact saved version to a matching website review without publishing', async () => {
  setup(); const select = await screen.findByRole('combobox', { name: 'CMS review website' });
  expect(screen.queryByRole('option', { name: /Other brand/ })).not.toBeInTheDocument();
  fireEvent.change(select, { target: { value: '2' } });
  const button = screen.getByRole('button', { name: 'Continue to exact-version review' });
  await waitFor(() => expect(button).not.toBeDisabled()); fireEvent.click(button);
  await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/ai-visibility/projects/2/assets/import-blog', { contentAssetId: 9, expectedVersion: 2 }));
  expect(mocks.push).toHaveBeenCalledWith('/dashboard/ai-visibility/websites/2/assets?asset=77');
  expect(mocks.post).toHaveBeenCalledTimes(1);
});
it('shows the missing-analysis prerequisite and does not start paid work', async () => {
  complete = false; setup(); fireEvent.change(await screen.findByRole('combobox'), { target: { value: '2' } });
  await screen.findByText('Complete an analysis for this website before sending a blog to review.');
  expect(screen.getByRole('button', { name: 'Continue to exact-version review' })).toBeDisabled();
  expect(mocks.post).not.toHaveBeenCalled();
});
