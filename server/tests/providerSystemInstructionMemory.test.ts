import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../models/llmUsages/functions.js', () => ({ createLLMUsage: jest.fn() }));
jest.unstable_mockModule('../models/apiPricing/functions.js', () => ({
  getApiPricingByKey: jest.fn<() => Promise<null>>().mockResolvedValue(null), getAllApiPricing: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]), getLLMModelCost: jest.fn(), getOriginalLLMModelCost: jest.fn(),
}));
jest.unstable_mockModule('../services/agents/LLMProvider.js', () => ({ LLMProvider: class {} }));
const { GeminiProvider } = await import('../services/agents/GeminiProvider.js');
const { VertexAIProvider } = await import('../services/agents/VertexAIProvider.js');

type Message = { role: string; content: string; name?: string };
type Converter = { convertMessages(messages: Message[]): {
  systemInstruction: { parts: Array<{ text: string }> } | null;
  contents: Array<{ role: string; parts: unknown[] }>;
} };

describe.each([['Gemini', GeminiProvider], ['Vertex', VertexAIProvider]] as const)('%s system memory', (_name, Provider) => {
  const converter = Object.create(Provider.prototype) as Converter;
  it('retains the router contract, memory, and JSON repair instruction in order', () => {
    const result = converter.convertMessages([
      { role: 'system', content: 'ROUTER CONTRACT: return the complete intent schema; never execute tools.' },
      { role: 'system', content: 'UNTRUSTED HISTORY: request was cancelled; drafts are not published.' },
      { role: 'user', content: 'Memory check only.' },
      { role: 'system', content: 'Return valid JSON matching the schema above.' },
    ]);
    expect(result.systemInstruction?.parts.map(part => part.text)).toEqual([
      'ROUTER CONTRACT: return the complete intent schema; never execute tools.',
      'UNTRUSTED HISTORY: request was cancelled; drafts are not published.',
      'Return valid JSON matching the schema above.',
    ]);
    expect(result.contents).toEqual([{ role: 'user', parts: [{ text: 'Memory check only.' }] }]);
  });
  it('keeps tool responses separate from the system contract and ignores empty supplements', () => {
    const result = converter.convertMessages([
      { role: 'system', content: 'Only report confirmed outcomes.' },
      { role: 'tool', name: 'generate_email_template', content: '{"status":"awaiting_approval"}' },
      { role: 'system', content: '' },
    ]);
    expect(result.systemInstruction?.parts).toEqual([{ text: 'Only report confirmed outcomes.' }]);
    expect(result.contents[0]).toEqual({ role: 'user', parts: [{ functionResponse: {
      name: 'generate_email_template', response: { status: 'awaiting_approval' },
    } }] });
  });
  it('does not invent system instructions for an ordinary conversation', () => {
    expect(converter.convertMessages([{ role: 'user', content: 'Hello' }]).systemInstruction).toBeNull();
  });
});
