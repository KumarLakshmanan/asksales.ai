import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingSettingsPanel } from '@/components/admin/EmbeddingSettingsPanel';
import EmbeddingsPage from '@/app/admin/dashboard/integrations/embeddings/page';
const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), toast: vi.fn(), push: vi.fn() }));
vi.mock('@/lib/admin-api', () => ({ api: { get: mocks.get, put: mocks.put } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
const configuration = {
  settings: { defaultProvider: 'openai', defaultModel: 'text-embedding-3-small', enabledProviders: ['openai', 'gemini', 'openrouter'] },
  resolved: { provider: 'openai', model: 'text-embedding-3-small' },
  availableModels: { openai: { 'text-embedding-3-small': { dimensions: 1536 } }, gemini: { 'gemini-embedding-001': { dimensions: 768 } }, openrouter: { 'openai/text-embedding-3-small': { dimensions: 1536 } } },
};
beforeEach(() => { vi.clearAllMocks(); mocks.get.mockImplementation(async (url: string) => url.endsWith('/settings') ? configuration : { credentials: [] }); mocks.put.mockResolvedValue({}); });

describe('admin embedding settings', () => {
  it('loads the unwrapped API response and saves the chosen OpenRouter model', async () => {
    render(<EmbeddingSettingsPanel />);
    fireEvent.change(await screen.findByLabelText('Default embedding provider'), { target: { value: 'openrouter' } });
    expect(screen.getByLabelText('Default embedding model')).toHaveValue('openai/text-embedding-3-small');
    fireEvent.change(screen.getByLabelText('Default embedding model'), { target: { value: 'qwen/qwen3-embedding-8b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save embedding settings' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/api/embeddings/admin/settings', { defaultProvider: 'openrouter', defaultModel: 'qwen/qwen3-embedding-8b', enabledProviders: ['openai', 'gemini', 'openrouter'] }));
  });
  it('prevents saving a disabled default until another enabled provider is selected', async () => {
    render(<EmbeddingSettingsPanel />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable OpenAI embeddings' }));
    expect(screen.getByRole('button', { name: 'Save embedding settings' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Default embedding provider'), { target: { value: 'openrouter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save embedding settings' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith('/api/embeddings/admin/settings', expect.objectContaining({ enabledProviders: ['gemini', 'openrouter'] })));
  });
  it('offers the OpenRouter credential form in the add-provider dialog', async () => {
    render(<EmbeddingsPage />);
    await screen.findByText('No Embedding API Keys');
    fireEvent.click(screen.getAllByRole('button', { name: 'Add API Key' })[0]);
    fireEvent.click(screen.getByRole('button', { name: /OpenRouter Embedding/ }));
    expect(mocks.push).toHaveBeenCalledWith('/admin/dashboard/integrations/embeddings/openrouter-embedding/add');
  });
  it('reports a settings-load failure', async () => {
    mocks.get.mockRejectedValue(new Error('network'));
    render(<EmbeddingSettingsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load embedding settings');
  });
});
