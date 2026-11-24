import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { GoogleGenAI } from '@google/genai';
import { googleApiKeyOptions } from '../utils/googleApiKeyOptions.js';

afterEach(() => { jest.restoreAllMocks(); });

describe('image API authentication routing through the actual Google SDK', () => {
  it.each([
    ['AQ.qa-express-key', 'aiplatform.googleapis.com'],
    ['AIza-qa-studio-key', 'generativelanguage.googleapis.com'],
  ])('routes %s to its compatible API', async (key, expectedHost) => {
    const requests: URL[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      requests.push(new URL(input instanceof Request ? input.url : String(input)));
      return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'QA response' }] } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    });
    const ai = new GoogleGenAI(googleApiKeyOptions(` ${key} `));
    await ai.models.generateContent({ model: 'gemini-2.5-flash-image', contents: 'QA fixture; network is intercepted.' });
    expect(requests).toHaveLength(1);
    expect(requests[0].hostname).toBe(expectedHost);
    expect(requests[0].pathname).toContain('gemini-2.5-flash-image');
  });
});
