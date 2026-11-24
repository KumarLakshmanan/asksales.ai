import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import VideoCard from '@/components/content-cards/VideoCard';
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(cleanup);

it('plays the saved asset inline and retries loading without generating a new asset', () => {
  render(<VideoCard title="Resort tour" videoUrl="/uploads/tour.mp4" thumbnailUrl="/uploads/poster.png" />);
  const first = screen.getByLabelText('Resort tour video preview');
  expect(first).toHaveAttribute('controls');
  expect(first).toHaveAttribute('preload', 'metadata');
  expect(first).not.toHaveAttribute('autoplay');
  fireEvent.error(first);
  expect(screen.getByRole('alert')).toHaveTextContent('This saved video could not be loaded.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading video' }));
  const retry = screen.getByLabelText('Resort tour video preview');
  expect(retry).not.toBe(first);
  expect(retry).toHaveAttribute('src', '/uploads/tour.mp4');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('does not retain a previous asset load error when the URL changes', () => {
  const view = render(<VideoCard title="Resort tour" videoUrl="/uploads/old.mp4" />);
  fireEvent.error(screen.getByLabelText('Resort tour video preview'));
  view.rerender(<VideoCard title="Resort tour" videoUrl="/uploads/new.mp4" />);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Resort tour video preview')).toHaveAttribute('src', '/uploads/new.mp4');
});

it('keeps the generation prompt in the expanded preview', () => {
  render(<VideoCard title="Resort tour" videoUrl="/uploads/tour.mp4" prompt="A sunrise tour of the resort" />);
  expect(screen.queryByText('A sunrise tour of the resort')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Expand video' }));

  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByText('Prompt Used')).toBeInTheDocument();
  expect(screen.getByText('A sunrise tour of the resort')).toBeInTheDocument();
});
