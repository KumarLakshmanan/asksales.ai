import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CreatorPreview } from '@/components/content-studio/CreatorPreview';
import SocialPostCard from '@/components/content-cards/SocialPostCard';

vi.mock('@/components/modals', () => ({ ContentFullscreenModal: () => null }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(cleanup);

it('shows a generated SMS opt-out once rather than appending another footer', () => {
  render(<CreatorPreview model={{ format: 'sms', status: 'ready', message: 'A neutral QA note. Reply STOP to opt out.', includeOptOut: true }} />);
  expect(screen.getAllByText(/Reply STOP to opt out\./)).toHaveLength(1);
});

it('shows the saved social CTA and copies hashtags exactly once', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  render(<SocialPostCard title="QA draft" content={JSON.stringify({ caption: 'A neutral note. #Workflow', callToAction: 'Read the notes.', hashtags: ['Workflow', '#Workflow', 'QA'] })} />);
  expect(screen.getByText(/Read the notes\./)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('A neutral note. #Workflow\n\nRead the notes.\n\n#QA'));
  expect(writeText).toHaveBeenCalledTimes(1);
});
