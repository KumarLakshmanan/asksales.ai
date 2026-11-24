import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import OutreachCampaignBuilder from '@/components/OutreachCampaignBuilder';

const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/lib/api', () => ({ api }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/LeadFileUpload', () => ({
  default: ({ onUploadComplete }: { onUploadComplete: (leads: unknown[]) => void }) =>
    <button onClick={() => onUploadComplete([{ id: 138, email: 'qa@example.test' }])}>Use test lead</button>,
}));
vi.mock('@/components/outreach/CampaignDeliveryReview', () => ({ default: () => <div>Review</div> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('carries an explicitly enabled auto-reply choice into the new campaign', async () => {
  api.post.mockImplementation(async (url: string) => url.endsWith('/sequences/email')
    ? { sequence_id: 7, email_sequence: { emails: [{ day: 0, subject: 'Hello', body: 'Hi' }] } }
    : { campaign: { id: 51, status: 'draft' } });
  render(<OutreachCampaignBuilder icpId={21} />);
  fireEvent.click(screen.getByRole('button', { name: 'Use test lead' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Campaign Config' }));
  fireEvent.change(screen.getByLabelText('Campaign Name'), { target: { value: 'QA campaign' } });
  fireEvent.click(screen.getByLabelText(/Automatically reply to eligible campaign emails/));
  fireEvent.click(screen.getByRole('button', { name: 'Continue to Follow-ups' }));
  fireEvent.click(screen.getByRole('button', { name: 'Generate Workflow' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Preview Workflow' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create Campaign' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/outreach/campaigns', expect.objectContaining({
    campaign_name: 'QA campaign', auto_reply: true, leads: [{ id: 138, email: 'qa@example.test' }], sequence_id: 7,
  })));
});
