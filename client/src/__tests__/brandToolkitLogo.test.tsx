import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrandToolkitPage from '@/app/dashboard/(main)/brand-toolkit/page';
import { BrandToolkitLogo } from '@/components/brand-toolkit/BrandToolkitLogo';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({ get: vi.fn(), push: vi.fn(), toast: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get } }));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('Brand Toolkit card logo', () => {
  it('replaces a failed logo with a named fallback while keeping the card and Edit available', async () => {
    mocks.get.mockResolvedValue([{ id: 71, name: 'Synthetic Studio', logoUrl: '/uploads/synthetic-logo.png', isDefault: true }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><BrandToolkitPage /></QueryClientProvider>);
    const image = await screen.findByRole('img', { name: 'Synthetic Studio logo' });
    fireEvent.error(image);
    expect(screen.queryByRole('img', { name: 'Synthetic Studio logo' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Synthetic Studio logo unavailable' })).toHaveAttribute('title', 'Synthetic Studio logo unavailable');
    expect(screen.getByRole('heading', { name: 'Synthetic Studio' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(mocks.get).toHaveBeenCalledWith('/api/content/brand-toolkits');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(mocks.push).toHaveBeenCalledWith('/dashboard/brand-toolkit/71');
  });

  it('retains a loaded image and displays a named fallback after a decoding error', () => {
    render(<BrandToolkitLogo src="/api/uploads/synthetic.png" name="Synthetic Studio" />);
    const image = screen.getByRole('img', { name: 'Synthetic Studio logo' });
    expect(image).toHaveAttribute('src', '/api/uploads/synthetic.png');
    expect(image).toHaveAttribute('title', 'Synthetic Studio logo');
    fireEvent.load(image);
    expect(image).toBeInTheDocument();
    fireEvent.error(image);
    expect(screen.getByRole('img', { name: 'Synthetic Studio logo unavailable' })).toHaveTextContent('Logo unavailable');
    expect(image).not.toBeInTheDocument();
  });

  it('keeps the same failed URL stable but retries a changed asset independently', () => {
    const { rerender } = render(<BrandToolkitLogo src="/api/uploads/failed.png" name="Original Studio" />);
    const failedImage = screen.getByRole('img', { name: 'Original Studio logo' });
    fireEvent.error(failedImage);
    rerender(<BrandToolkitLogo src="/api/uploads/failed.png" name="Renamed Studio" />);
    expect(screen.getByRole('img', { name: 'Renamed Studio logo unavailable' })).toHaveAttribute('title', 'Renamed Studio logo unavailable');
    expect(document.querySelector('img')).toBeNull();
    rerender(<BrandToolkitLogo src="/api/uploads/replacement.png" name="Renamed Studio" />);
    const image = screen.getByRole('img', { name: 'Renamed Studio logo' });
    fireEvent.load(image);
    fireEvent.error(failedImage);
    expect(image).toBeInTheDocument();
    expect(image).toHaveAttribute('src', '/api/uploads/replacement.png');
    expect(screen.queryByText('Logo unavailable')).not.toBeInTheDocument();
  });

  it.each([undefined, null, '', '   '])('names a missing URL without rendering an image: %s', (src) => {
    const { rerender } = render(<BrandToolkitLogo src={src} name="Empty Studio" />);
    expect(screen.getByRole('img', { name: 'Empty Studio has no logo' })).toHaveAttribute('title', 'Empty Studio has no logo');
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('No logo')).toBeInTheDocument();
    rerender(<BrandToolkitLogo src={src} name="   " />);
    expect(screen.getByRole('img', { name: 'Untitled Brand has no logo' })).toBeInTheDocument();
  });

  it('starts another image attempt after the URL is cleared and restored', () => {
    const { rerender } = render(<BrandToolkitLogo src="/api/uploads/one.png" name="Studio" />);
    fireEvent.error(screen.getByRole('img', { name: 'Studio logo' }));
    rerender(<BrandToolkitLogo name="Studio" />);
    expect(screen.getByRole('img', { name: 'Studio has no logo' })).toBeInTheDocument();
    rerender(<BrandToolkitLogo src="/api/uploads/one.png" name="Studio" />);
    expect(screen.getByRole('img', { name: 'Studio logo' })).toHaveAttribute('src', '/api/uploads/one.png');
  });
});
