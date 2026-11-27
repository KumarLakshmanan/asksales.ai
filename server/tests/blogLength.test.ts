import { describe, expect, it } from '@jest/globals';
import { blogExpansionRequest, blogLengthInstruction, blogLengthTarget, blogNeedsExpansion, countWords } from '../services/content/blogLength.js';

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('blog length follows the reviewed setting', () => {
  it('counts what a reader sees, not Markdown markers or link targets', () => {
    expect(countWords('## Heading here\n\n- one **two** [three](https://example.com/a-b-c)')).toBe(5);
  });

  it('gives each length a word range and a large enough output budget', () => {
    expect(blogLengthInstruction('medium')).toContain('1000-1500 words');
    expect(blogLengthInstruction('medium')).toContain('at least 1000 words');
    expect(blogLengthTarget('long').maxTokens).toBeGreaterThan(blogLengthTarget('medium').maxTokens);
    expect(blogLengthTarget(undefined)).toEqual(blogLengthTarget('medium'));
  });

  it('expands a medium post that came back with about 500 words', () => {
    expect(blogNeedsExpansion(words(499), 'medium')).toBe(true);
    expect(blogNeedsExpansion(words(900), 'medium')).toBe(false);
    expect(blogNeedsExpansion(words(499), 'short')).toBe(false);
    expect(blogExpansionRequest(words(499), 'medium')).toContain('has 499 words');
  });
});
