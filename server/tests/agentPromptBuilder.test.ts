import { describe, it, expect } from '@jest/globals';
import {
  buildFewShotMessages,
  buildTrainingDemosBlock,
  resolveSystemPrompt,
  SUPPORT_DATA_BOUNDARY_PROMPT,
  SUPPORT_PLATFORM_SAFETY_PROMPT,
  SUPPORT_CONVERSATIONAL_STYLE_PROMPT,
  AgentConfigLike,
} from '../utils/agentPromptBuilder.js';

describe('agentPromptBuilder Tests', () => {
  const fallbackPrompt = 'Default fallback system prompt.';
  const protectedSystem = (domainPrompt: string, ownerPrompt?: string, suffix?: string) => [
    SUPPORT_DATA_BOUNDARY_PROMPT,
    SUPPORT_PLATFORM_SAFETY_PROMPT,
    SUPPORT_CONVERSATIONAL_STYLE_PROMPT,
    domainPrompt,
    ownerPrompt ? `Owner-configured persona and task guidance:\n${ownerPrompt}` : undefined,
    suffix,
  ].filter(Boolean).join('\n\n');

  describe('resolveSystemPrompt', () => {
    it('should use custom prompt if present', () => {
      const config: AgentConfigLike = { systemPrompt: 'Custom agent behavior.' };
      expect(resolveSystemPrompt(config, fallbackPrompt)).toBe('Custom agent behavior.');
    });

    it('should fallback if prompt is empty or null', () => {
      expect(resolveSystemPrompt(null, fallbackPrompt)).toBe(fallbackPrompt);
      expect(resolveSystemPrompt({ systemPrompt: '' }, fallbackPrompt)).toBe(fallbackPrompt);
      expect(resolveSystemPrompt({ systemPrompt: '   ' }, fallbackPrompt)).toBe(fallbackPrompt);
    });
  });

  describe('buildFewShotMessages with legacy and multi-turn demos', () => {
    it('should format legacy single-turn userMessage and agentReply', () => {
      const config: AgentConfigLike = {
        systemPrompt: 'System behavior',
        metadata: {
          trainingConversations: [
            {
              id: 'demo-1',
              userMessage: ' hello ',
              agentReply: ' namaskar ',
            },
          ],
        },
      };

      const result = buildFewShotMessages({
        agentConfig: config,
        fallbackSystemPrompt: fallbackPrompt,
        inboundText: 'How are you?',
      });

      expect(result).toEqual([
        { role: 'system', content: protectedSystem(fallbackPrompt, 'System behavior') },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'namaskar' },
        { role: 'user', content: 'How are you?' },
      ]);
    });

    it('should format multi-turn demo messages', () => {
      const config: AgentConfigLike = {
        systemPrompt: 'System behavior',
        metadata: {
          trainingConversations: [
            {
              id: 'demo-2',
              messages: [
                { role: 'user', content: ' Hi, do you have rooms? ' },
                { role: 'agent', content: ' Yes, we have standard rooms. ' },
                { role: 'user', content: ' What is the price? ' },
                { role: 'assistant', content: ' It is $150 per night. ' },
              ],
            },
          ],
        },
      };

      const result = buildFewShotMessages({
        agentConfig: config,
        fallbackSystemPrompt: fallbackPrompt,
        inboundText: 'Book it',
      });

      expect(result).toEqual([
        { role: 'system', content: protectedSystem(fallbackPrompt, 'System behavior') },
        { role: 'user', content: 'Hi, do you have rooms?' },
        { role: 'assistant', content: 'Yes, we have standard rooms.' },
        { role: 'user', content: 'What is the price?' },
        { role: 'assistant', content: 'It is $150 per night.' },
        { role: 'user', content: 'Book it' },
      ]);
    });

    it('should fall back to fallback system prompt and append suffix', () => {
      const result = buildFewShotMessages({
        agentConfig: null,
        fallbackSystemPrompt: fallbackPrompt,
        inboundText: 'Hello',
        systemPromptSuffix: 'Additional suffix here',
      });

      expect(result).toEqual([
        { role: 'system', content: protectedSystem(fallbackPrompt, undefined, 'Additional suffix here') },
        { role: 'user', content: 'Hello' },
      ]);
    });

    it('should include conversation history turns', () => {
      const result = buildFewShotMessages({
        agentConfig: null,
        fallbackSystemPrompt: fallbackPrompt,
        conversationHistory: [
          { role: 'user', content: 'Old question' },
          { role: 'assistant', content: 'Old answer' },
        ],
        inboundText: 'New question',
      });

      expect(result).toEqual([
        { role: 'system', content: protectedSystem(fallbackPrompt) },
        { role: 'user', content: 'Old question' },
        { role: 'assistant', content: 'Old answer' },
        { role: 'user', content: 'New question' },
      ]);
    });
  });

  describe('buildTrainingDemosBlock', () => {
    it('should build block for legacy demos', () => {
      const config: AgentConfigLike = {
        metadata: {
          trainingConversations: [
            {
              userMessage: 'hello',
              agentReply: 'namaskar',
            },
          ],
        },
      };
      const block = buildTrainingDemosBlock(config);
      expect(block).toBe(
        '--- CONVERSATION STYLE EXAMPLES ---\n' +
        'User: hello\n' +
        'Agent: namaskar\n' +
        '---'
      );
    });

    it('should build block for multi-turn demos', () => {
      const config: AgentConfigLike = {
        metadata: {
          trainingConversations: [
            {
              messages: [
                { role: 'user', content: 'hello' },
                { role: 'agent', content: 'namaskar' },
                { role: 'user', content: 'how are you?' },
                { role: 'assistant', content: 'I am good' },
              ],
            },
          ],
        },
      };
      const block = buildTrainingDemosBlock(config);
      expect(block).toBe(
        '--- CONVERSATION STYLE EXAMPLES ---\n' +
        'User: hello\n' +
        'Agent: namaskar\n' +
        'User: how are you?\n' +
        'Agent: I am good\n' +
        '---'
      );
    });

    it('should return empty string when there are no demos', () => {
      expect(buildTrainingDemosBlock(null)).toBe('');
      expect(buildTrainingDemosBlock({ metadata: {} })).toBe('');
    });
  });
});
