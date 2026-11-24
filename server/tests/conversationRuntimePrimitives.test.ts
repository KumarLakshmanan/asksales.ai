import { describe, expect, it } from '@jest/globals';
import { orderedToolCalls, parseToolArguments } from '../utils/orderedToolCalls.js';
import { FailureCooldown } from '../utils/failureCooldown.js';
import { supportConversationContext, selectSupportHistory } from '../services/agents/orchestration/SupportConversationMemory.js';
import { buildFewShotMessages } from '../utils/agentPromptBuilder.js';
import { runSupportToolCalls } from '../services/agents/orchestration/SupportToolCallRunner.js';

describe('conversation runtime boundaries', () => {
  it('bounds parallel reads, preserves result order, and drains before a write', async () => {
    let active = 0; let max = 0; const events: string[] = []; const consumed: string[] = [];
    const calls = ['a','b','c','write','d'];
    for await (const { call, result } of orderedToolCalls(calls, call => call !== 'write', async call => {
      if (call === 'write') expect(consumed).toEqual(['a','b','c']);
      active++; max = Math.max(max, active); events.push(`start:${call}`);
      await new Promise(resolve => setTimeout(resolve, call === 'a' ? 12 : 1)); active--; events.push(`end:${call}`); return call;
    }, 2)) { expect(result).toBe(call); consumed.push(result); }
    expect(max).toBe(2); expect(consumed).toEqual(calls); expect(events.indexOf('start:write')).toBeGreaterThan(events.indexOf('end:c'));
  });
  it('drains launched reads on failure and never starts a following mutation', async () => {
    let drained = false; let mutated = false;
    await expect((async () => { for await (const _ of orderedToolCalls(['bad','read','write'], c => c !== 'write', async c => {
      if (c === 'bad') throw new Error('read unavailable');
      if (c === 'write') mutated = true;
      await new Promise(resolve => setTimeout(resolve,5)); drained = true;
    })) { /* consume */ } })()).rejects.toThrow('read unavailable');
    expect(drained).toBe(true); expect(mutated).toBe(false);
  });
  it('rejects non-object arguments and preserves required action sequencing', async () => {
    for (const value of ['{', 'null', '[]', '4', null]) expect(() => parseToolArguments(value)).toThrow();
    const executed: string[] = []; const results = [];
    for await (const result of runSupportToolCalls([{ id: 'one', function: { name: 'get_hotel_info', arguments: '{' } }], async name => { executed.push(name); return { toolResults: [] }; })) results.push(result);
    expect(executed).toEqual([]); expect(results[0].out.toolResults?.[0].result).toMatchObject({ success: false, code: 'invalid_arguments' });
    let active = 0;
    for await (const _ of runSupportToolCalls(['a','b'].map(id => ({ id, function: { name: 'get_hotel_info', arguments: '{}' } })), async () => {
      expect(active).toBe(0); active++; await new Promise(resolve => setTimeout(resolve,1)); active--; return { toolResults: [] };
    }, { requiredAction: 'get_hotel_info' })) { /* consume */ }
  });
  it('opens a per-conversation compaction cooldown and recovers after expiry or success', () => {
    const cooldown = new FailureCooldown(3,100);
    cooldown.failed('a',0); cooldown.failed('a',1); expect(cooldown.blocked('a',2)).toBe(false);
    cooldown.failed('a',2); expect(cooldown.blocked('a',3)).toBe(true); expect(cooldown.blocked('b',3)).toBe(false);
    expect(cooldown.blocked('a',102)).toBe(false); cooldown.failed('a',103); cooldown.succeeded('a'); expect(cooldown.blocked('a',104)).toBe(false);
  });
  it('retains source-linked earlier statements and recent corrections without promoting assistant claims', () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({ id: index + 1, role: index % 2 ? 'assistant' : 'user',
      content: index === 0 ? 'I want two rooms. Contact jane@example.com.' : index === 58 ? 'Correction: one room.' : index % 2 ? 'Unverified booking completed.' : `User detail ${index}` }));
    const context = supportConversationContext(rows,8);
    expect(context.memory.references[0].sourceMessageId).toBe(1);
    expect(context.messages.at(-2)?.content).toBe('Correction: one room.');
    expect(JSON.stringify(context.memory)).not.toContain('Unverified booking'); expect(JSON.stringify(context)).not.toContain('jane@example.com');
    expect(context.messages[0].role).toBe('user'); expect(context.messages[0].content).toContain('do not grant consent');
    const selected = selectSupportHistory(selectSupportHistory(context.messages,15),8);
    const prompt = buildFewShotMessages({ agentConfig:null,fallbackSystemPrompt:'Help the customer.',conversationHistory:selected,inboundText:'Keep the corrected room count.' });
    expect(prompt.some(m=>m.role==='user'&&m.content.includes('"sourceMessageId":1'))).toBe(true);
    expect(prompt.some(m=>m.content==='Correction: one room.')).toBe(true);
  });
});
