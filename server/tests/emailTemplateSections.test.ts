import { describe, expect, it } from '@jest/globals';
import { normalizeEmailTemplateSections } from '../utils/emailTemplateSections.js';

describe('normalizeEmailTemplateSections', () => {
  it('moves a misplaced first-name variable from the signature to the greeting', () => {
    expect(normalizeEmailTemplateSections({
      greeting: 'Hello,',
      body: 'Welcome to our product.',
      signature: 'Asha\nCustomer Success\n{{first_name}}',
    })).toEqual({
      greeting: 'Hi {{first_name}},',
      body: 'Welcome to our product.',
      signature: 'Asha\nCustomer Success',
    });
  });

  it('does not duplicate a first-name variable already present in the greeting', () => {
    expect(normalizeEmailTemplateSections({
      greeting: 'Dear {{first_name}},',
      signature: 'Asha\n{{first_name}}',
    })).toEqual({
      greeting: 'Dear {{first_name}},',
      signature: 'Asha',
    });
  });

  it('removes an empty signature after relocating the variable', () => {
    expect(normalizeEmailTemplateSections({
      body: 'Welcome.',
      signature: '{{ first_name }}',
    })).toEqual({
      greeting: 'Hi {{first_name}},',
      body: 'Welcome.',
      signature: undefined,
    });
  });

  it('leaves valid signatures unchanged', () => {
    const template = {
      greeting: 'Hi {{first_name}},',
      signature: 'Asha\nCustomer Success',
    };
    expect(normalizeEmailTemplateSections(template)).toBe(template);
  });
});
