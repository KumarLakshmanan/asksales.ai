import { jest } from '@jest/globals';

const getAllActiveAdminCredentials = jest.fn<any>();

jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({
  getAllActiveAdminCredentials,
}));

describe('ContentModerationService embedding credential fallback', () => {
  const originalEnabled = process.env.SUPPORT_MODERATION_ENABLED;
  const originalFetch = global.fetch;

  afterAll(() => {
    process.env.SUPPORT_MODERATION_ENABLED = originalEnabled;
    global.fetch = originalFetch;
  });

  it('uses a Gemini embedding key with a generative moderation model', async () => {
    process.env.SUPPORT_MODERATION_ENABLED = 'true';
    delete process.env.OPENAI_API_KEY;
    getAllActiveAdminCredentials.mockImplementation(async (platform: string) => platform === 'gemini_embedding'
      ? [{ apiKey: 'gemini-key', config: { model: 'gemini-embedding-001' } }]
      : []);
    const fetchMock = jest.fn<any>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"flagged":false,"categories":[]}' }] } }],
      }),
    });
    global.fetch = fetchMock;

    const { contentModerationService } = await import('../services/agents/orchestration/ContentModerationService.js');
    const result = await contentModerationService.moderate('How do I reset my workspace settings?');

    expect(result).toMatchObject({ flagged: false, status: 'safe', source: 'gemini' });
    expect(getAllActiveAdminCredentials).toHaveBeenCalledWith('gemini_embedding');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/models/gemini-3.1-flash-lite:generateContent');
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('gemini-embedding-001');
  });

  it('uses the governed OpenRouter credential before Google fallbacks', async () => {
    process.env.SUPPORT_MODERATION_ENABLED = 'true';
    delete process.env.OPENAI_API_KEY;
    getAllActiveAdminCredentials.mockImplementation(async (platform: string) => platform === 'openrouter'
      ? [{ apiKey: 'openrouter-key', config: { selectedModel: 'openai/gpt-4.1-mini' } }]
      : platform === 'gemini'
        ? [{ apiKey: 'gemini-key', config: { model: 'gemini-3.1-flash-lite' } }]
        : []);
    const fetchMock = jest.fn<any>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"flagged":false,"categories":[]}' } }],
      }),
    });
    global.fetch = fetchMock;

    const { contentModerationService } = await import('../services/agents/orchestration/ContentModerationService.js');
    const result = await contentModerationService.moderate('Please show the live booking link for my day-use stay.');

    expect(result).toMatchObject({ flagged: false, status: 'safe', source: 'openrouter' });
    expect(getAllActiveAdminCredentials).toHaveBeenCalledWith('openrouter');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      model: 'openai/gpt-4.1-mini',
      max_tokens: 300,
    });
  });
});
