import { describe, expect, it } from '@jest/globals';
import { choicePromptWithoutRepeatedOptions } from '../services/agents/orchestration/SupportPlaybookPresentationService.js';

describe('generated choice prompt duplication', () => {
  const labels = ['Leisure stay','Corporate offsite','Wedding or celebration'];
  it('removes a complete repeated bullet list before the server renders the numbered options', () => {
    expect(choicePromptWithoutRepeatedOptions('Welcome! How can I help?\n\n• Leisure stay\n• Corporate offsite\n• Wedding or celebration',labels))
      .toBe('Welcome! How can I help?');
  });
  it('handles numbered lists, casing and nonbreaking spaces without changing the introductory question', () => {
    expect(choicePromptWithoutRepeatedOptions('Choose an option:\n1. LEISURE STAY\n2) Corporate offsite\n3. Wedding or celebration',labels))
      .toBe('Choose an option:');
  });
  it('preserves prose, partial lists, and prompts that would otherwise become empty', () => {
    for(const text of ['Do you want a leisure stay or corporate offsite?','Choose:\n• Leisure stay',labels.join('\n')]) {
      expect(choicePromptWithoutRepeatedOptions(text,labels)).toBe(text);
    }
    expect(choicePromptWithoutRepeatedOptions('How many adults?',[])).toBe('How many adults?');
  });
});
