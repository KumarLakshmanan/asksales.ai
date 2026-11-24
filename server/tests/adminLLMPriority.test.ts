import { describe, expect, it } from '@jest/globals';
import { sortActiveCredentials } from '../models/adminApiCredentials/functions.js';

describe('general LLM integration priority', () => {
  it('selects active high before normal, low and fallback across providers', () => {
    const rows = [
      { id: 1, platform: 'gemini', priority: 'fallback', isActive: true },
      { id: 2, platform: 'openai', priority: 'high', isActive: false },
      { id: 3, platform: 'openrouter', priority: 'high', isActive: true },
      { id: 4, platform: 'gemini', priority: 'normal', isActive: true },
      { id: 5, platform: 'vertex_ai', priority: 'low', isActive: true },
    ];
    expect(sortActiveCredentials(rows).map(row => row.id)).toEqual([3, 4, 5, 1]);
  });
});
