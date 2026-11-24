import { describe, expect, it } from 'vitest';
import { campaignReplyOverrides, campaignReplyText } from '@/lib/campaign-reply-presentation';
import type { Message } from '@/models/message';

const turn: Message[] = [
  { id: 'user', role: 'user', timestamp: 1, content: '@marcus @sarah Give one answer each.' },
  { id: 'marcus', role: 'assistant', timestamp: 2, agentType: 'lead_generation', content: '**Marcus:** A boutique hotel in Bengaluru.\n**Sarah:** Review CTR.' },
  { id: 'sarah', role: 'assistant', timestamp: 3, agentType: 'performance_marketing', content: '**Marcus:** An independent hotel.\n**Sarah:** CTR (click-through rate).' },
];

describe('campaign reply presentation', () => {
  it.each(['Marcus: ', '**Marcus:** ', '**Marcus**: ', '__Marcus:__ ', '### Marcus Johnson: '])('removes only a redundant leading %s', label => {
    expect(campaignReplyText(`${label}Ask Sarah about CTR.`, 'lead_generation')).toBe('Ask Sarah about CTR.');
  });

  it('shows each specialist’s own section for the duplicated historical team turn without editing history', () => {
    const original = structuredClone(turn);
    const replies = campaignReplyOverrides(turn);
    expect(replies.get('marcus')).toBe('A boutique hotel in Bengaluru.');
    expect(replies.get('sarah')).toBe('CTR (click-through rate).');
    expect(turn).toEqual(original);
  });

  it('keeps a lone combined answer intact', () => {
    expect(campaignReplyOverrides(turn.slice(0, 2)).size).toBe(0);
    expect(campaignReplyText(turn[1].content, 'lead_generation')).toBe(turn[1].content);
  });

  it('does not combine replies across different user turns', () => {
    expect(campaignReplyOverrides([turn[0], turn[1], { ...turn[0], id: 'another-user' }, turn[2]]).size).toBe(0);
  });

  it.each([
    'Sarah suggested reviewing CTR.',
    'Draft dialogue:\nMarcus: Hello\nSarah: Hi',
    '> Marcus: A quoted reply.',
    '```text\nMarcus: A code example.\n```',
    '    Marcus: An indented code example.',
    '| Agent | Note |\n| --- | --- |\n| Marcus | Existing lead |',
  ])('preserves meaningful prose, quotations and drafts: %s', content => {
    expect(campaignReplyText(content, 'lead_generation')).toBe(content);
    expect(campaignReplyOverrides([turn[0], { ...turn[1], content }, turn[2]]).size).toBe(0);
  });

  it('preserves combined coordinator summaries', () => {
    expect(campaignReplyText(turn[1].content, 'orchestrator')).toBe(turn[1].content);
  });

  it('preserves additional unrecognised sections', () => {
    const content = turn[1].content + '\n**Synthesis:** Review both suggestions.';
    expect(campaignReplyOverrides([turn[0], { ...turn[1], content }, turn[2]]).size).toBe(0);
  });
});
