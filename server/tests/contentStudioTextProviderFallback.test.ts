import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Content Studio text provider fallback', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'controllers/contentStudioController.ts'),
    'utf8',
  );

  it('routes every Content Studio text completion through the configured provider fallback chain', () => {
    expect(source).toContain('LLMProviderFactory.createChatCompletionWithFallback');
    expect(source).not.toContain('LLMProviderFactory.createProviderForUser');

    const calls = source.match(/createContentTextCompletion\(userId, \{/g) || [];
    expect(calls).toHaveLength(9);
  });

  it('leaves provider model selection to each configured text provider', () => {
    expect(source).toContain("'messages' | 'temperature' | 'max_tokens' | 'response_format' | 'loggingContext'");
    expect(source).toContain("model: ''");
    expect(source).not.toContain('model: llmProvider.defaultModel');
  });
});
