import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Mocks ──────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockCredential: any = null;

jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getActiveAdminCredential: jest.fn<any>().mockImplementation((platform: string) => {
    if (platform === 'openai' && mockCredential?.platform === 'openai') {
      return Promise.resolve(mockCredential);
    }
    if (platform === 'gemini' && mockCredential?.platform === 'gemini') {
      return Promise.resolve(mockCredential);
    }
    if (platform === 'openrouter' && mockCredential?.platform === 'openrouter') {
      return Promise.resolve(mockCredential);
    }
    return Promise.resolve(null);
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreateChatCompletion = jest.fn<any>();
jest.unstable_mockModule('openai', () => {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    default: jest.fn<any>().mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCreateChatCompletion,
        },
      },
    })),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFetch = jest.fn<any>();
jest.unstable_mockModule('node-fetch', () => ({
  default: mockFetch,
}));

jest.unstable_mockModule('pdf-parse', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: jest.fn<any>().mockImplementation(() => Promise.resolve({ text: 'User: Hello\nAgent: Hi there' })),
}));

// Load Service after mocking
const { DemoParserService } = await import('../services/agents/DemoParserService.js');

describe('DemoParserService Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCredential = null;
  });

  it('should parse PDF using extracted text and OpenAI', async () => {
    mockCredential = {
      platform: 'openai',
      apiKey: 'sk-test-key',
      config: { model: 'gpt-4o' },
    };

    mockCreateChatCompletion.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify([
              { role: 'user', content: 'Hello' },
              { role: 'agent', content: 'Hi there' },
            ]),
          },
        },
      ],
    });

    const result = await DemoParserService.parseFile(
      Buffer.from('PDF_BYTES'),
      'application/pdf',
      'demo.pdf'
    );

    expect(result).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'agent', content: 'Hi there' },
    ]);

    expect(mockCreateChatCompletion).toHaveBeenCalled();
  });

  it('should parse screenshot image using OpenAI vision API', async () => {
    mockCredential = {
      platform: 'openai',
      apiKey: 'sk-test-key',
      config: { model: 'gpt-4o' },
    };

    mockCreateChatCompletion.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify([
              { role: 'user', content: 'Booking inquiry' },
              { role: 'agent', content: 'I can help with that' },
            ]),
          },
        },
      ],
    });

    const result = await DemoParserService.parseFile(
      Buffer.from('IMAGE_BYTES'),
      'image/png',
      'screenshot.png'
    );

    expect(result).toEqual([
      { role: 'user', content: 'Booking inquiry' },
      { role: 'agent', content: 'I can help with that' },
    ]);
  });

  it('should parse screenshot image using Gemini API', async () => {
    mockCredential = {
      platform: 'gemini',
      apiKey: 'gemini-test-key',
      config: { model: 'gemini-1.5-flash' },
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify([
                      { role: 'user', content: 'Rooms please' },
                      { role: 'agent', content: 'Standard room starts at $100' },
                    ]),
                  },
                ],
              },
            },
          ],
        }),
    });

    const result = await DemoParserService.parseFile(
      Buffer.from('IMAGE_BYTES'),
      'image/png',
      'screenshot.png'
    );

    expect(result).toEqual([
      { role: 'user', content: 'Rooms please' },
      { role: 'agent', content: 'Standard room starts at $100' },
    ]);
  });

  it('should parse text from KB entry using OpenAI', async () => {
    mockCredential = {
      platform: 'openai',
      apiKey: 'sk-test-key',
      config: { model: 'gpt-4o' },
    };

    mockCreateChatCompletion.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify([
              { role: 'user', content: 'What is checkout?' },
              { role: 'agent', content: 'Checkout is at 11:00 AM.' },
            ]),
          },
        },
      ],
    });

    const result = await DemoParserService.parseText('Checkout time is 11:00 AM.');

    expect(result).toEqual([
      { role: 'user', content: 'What is checkout?' },
      { role: 'agent', content: 'Checkout is at 11:00 AM.' },
    ]);

    expect(mockCreateChatCompletion).toHaveBeenCalled();
  });

  it('should parse text into multiple scenario conversations using OpenAI', async () => {
    mockCredential = {
      platform: 'openai',
      apiKey: 'sk-test-key',
      config: { model: 'gpt-4o' },
    };

    mockCreateChatCompletion.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              conversations: [
                [
                  { role: 'user', content: 'What is checkout?' },
                  { role: 'agent', content: 'Checkout is at 11:00 AM.' },
                ],
                [
                  { role: 'user', content: 'Can I check in early?' },
                  { role: 'agent', content: 'Early check-in is based on availability.' },
                ]
              ]
            }),
          },
        },
      ],
    });

    const result = await DemoParserService.parseTextMulti('Checkout time is 11:00 AM. Early check-in depends.');

    expect(result).toEqual([
      [
        { role: 'user', content: 'What is checkout?' },
        { role: 'agent', content: 'Checkout is at 11:00 AM.' },
      ],
      [
        { role: 'user', content: 'Can I check in early?' },
        { role: 'agent', content: 'Early check-in is based on availability.' },
      ]
    ]);

    expect(mockCreateChatCompletion).toHaveBeenCalled();
  });
});
