import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationEstimate } from '@/components/content-studio/GenerationEstimate';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: { get: mocks.get }, api: { get: mocks.get } }));

function renderEstimate(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => vi.clearAllMocks());

describe('generation cost copy', () => {
  it('says the cost is unavailable in plain words and does not expose the raw model slug', async () => {
    mocks.get.mockResolvedValue({
      text: { credits: null, ready: true, model: 'openai/gpt-6-luna', basis: 'Configured model has no verified price estimate' },
      image: { credits: 67, ready: true, model: 'gemini-2.5-flash-image', basis: 'One 1K image' },
      video: { credits: null, ready: true, basis: 'x' },
    });
    renderEstimate(<GenerationEstimate />);
    expect(await screen.findByText('Cost estimate unavailable for this model')).toBeInTheDocument();
    expect(screen.getByText(/Ready: no verified price yet/)).toBeInTheDocument();
    expect(screen.queryByText(/openai\/gpt-6-luna/)).not.toBeInTheDocument();
    expect(screen.queryByText(/unquoted/)).not.toBeInTheDocument();
  });
});
