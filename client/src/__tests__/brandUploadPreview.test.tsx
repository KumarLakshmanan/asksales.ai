import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BrandToolkitSelectorModal from '@/components/BrandToolkitSelectorModal';

const mocks = vi.hoisted(() => ({ get: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

afterEach(() => vi.unstubAllEnvs());

describe('saved brand upload previews', () => {
  it.each([
    '/uploads/1/brand_asset/logo.png',
    'uploads/1/brand_asset/logo.png',
    'https://api.example.com/uploads/1/brand_asset/logo.png',
  ])('reopens the saved logo through the same-origin proxy: %s', async (logoUrl) => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com');
    mocks.get.mockResolvedValue([{ id: 1, name: 'Saved brand', logoUrl }]);
    render(<BrandToolkitSelectorModal isOpen onClose={vi.fn()} onSelect={vi.fn()} />);
    expect(await screen.findByAltText('Saved brand')).toHaveAttribute('src', '/api/uploads/1/brand_asset/logo.png');
  });
});
