import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import EmailCard from '@/components/content-cards/EmailCard';

vi.mock('@/components/modals', () => ({ ContentFullscreenModal: () => null }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(cleanup);

it('renders the saved email video without autoplay', () => {
  render(<EmailCard title="Resort invitation" content="An invitation" videoUrl="https://example.com/tour.mp4" />);
  const video = screen.getByLabelText('Email video attachment');
  expect(video).toHaveAttribute('src', 'https://example.com/tour.mp4');
  expect(video).toHaveAttribute('controls');
  expect(video).not.toHaveAttribute('autoplay');
});

it('does not infer video failure from a prompt without a result', () => {
  render(<EmailCard title="Resort invitation" content={JSON.stringify({ body: 'An invitation', videoPrompt: 'Resort tour' })} onGenerateVideo={vi.fn()} />);
  expect(screen.queryByText('Failed to generate video.')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Email video attachment')).not.toBeInTheDocument();
});
