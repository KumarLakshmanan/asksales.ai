import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import EmailCard from '@/components/content-cards/EmailCard';
import SmsCard from '@/components/content-cards/SmsCard';
import SocialMessageCard from '@/components/content-cards/SocialMessageCard';
import SocialPostCard from '@/components/content-cards/SocialPostCard';
import AdCopyCard from '@/components/content-cards/AdCopyCard';

vi.mock('@/components/modals', () => ({ ContentFullscreenModal: () => null }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(cleanup);

for (const [name, Component] of [['Email', EmailCard], ['SMS', SmsCard], ['Social message', SocialMessageCard], ['Social post', SocialPostCard], ['Ad copy', AdCopyCard]] as const) {
  it(`${name} does not invent a provider failure for missing media`, () => {
    const onGenerateImage = vi.fn(async () => {});
    render(<Component title="Resort invitation" content={JSON.stringify({
      body: 'Visit the resort', message: 'Visit the resort', caption: 'Visit the resort', headline: 'Visit the resort',
      imagePrompt: 'A resort terrace', autoGenerateImageRequested: true,
    })} onGenerateImage={onGenerateImage} />);
    expect(screen.queryByText('Failed to generate image.')).not.toBeInTheDocument();
    expect(screen.getByText('No image attached yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(onGenerateImage).toHaveBeenCalledWith('A resort terrace');
  });
}

for (const [name, Component] of [['Social message', SocialMessageCard], ['Social post', SocialPostCard], ['Ad copy', AdCopyCard]] as const) {
  it(`${name} distinguishes an unattached video from a failed video`, () => {
    const onGenerateVideo = vi.fn(async () => {});
    render(<Component title="Resort invitation" content={JSON.stringify({
      message: 'Visit the resort', caption: 'Visit the resort', headline: 'Visit the resort',
      videoPrompt: 'A resort tour', autoGenerateVideoRequested: true,
    })} onGenerateVideo={onGenerateVideo} />);
    expect(screen.queryByText('Failed to generate video.')).not.toBeInTheDocument();
    expect(screen.getByText('No video attached yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(onGenerateVideo).toHaveBeenCalledWith('A resort tour');
  });
}
