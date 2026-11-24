import { describe, expect, it } from '@jest/globals';
import { SUPPORT_TOOL_NAMES } from '../services/agents/orchestration/SafeToolExecutor.js';
import { escalationSubAgent } from '../services/agents/subagents/EscalationSubAgent.js';
import { assistantDraftSchema } from '../services/assistants/AssistantConfiguration.js';

describe('follow-up scheduling boundaries', () => {
  it('does not offer the model an independent sequence enrollment tool', () => {
    expect(SUPPORT_TOOL_NAMES.has('schedule_follow_up')).toBe(false);
    expect(escalationSubAgent.metadata.tools.map(tool => tool.function.name)).toEqual(['escalate_to_human']);
  });
  it('gives a truthful review outcome for recorded legacy calls without a lead lookup or send', async () => {
    const result = await escalationSubAgent.execute('schedule_follow_up', { type: 'payment_reminder', delay_hours: 1 }, {} as any);
    expect(result.toolResults?.[0].result).toMatchObject({ success: false, confirmedSideEffect: false, status: 'requires_configuration' });
    expect(result.toolResults?.[0].result.message).toContain('No follow-up was scheduled');
    expect(Object.keys(result)).toEqual(['toolResults']);
  });
  it('rejects web follow-ups until a supported opt-in delivery contract exists', () => {
    // Existing public drafts cannot smuggle a web sequence past the API schema.
    const shape = assistantDraftSchema.shape.followUps;
    expect(shape.safeParse({ mode: 'selected', sequences: [{ channel: 'web', steps: [{ delayMinutes: 60, templateId: 1 }] }] }).success).toBe(false);
  });
});
