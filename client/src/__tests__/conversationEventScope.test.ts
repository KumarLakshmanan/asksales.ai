import { describe, expect, it } from 'vitest';
import { matchesConversationEventScope } from '@/lib/conversation-event-scope';

describe('campaign event isolation', () => {
  it.each(['lead_saved', 'leads_batch_saved', 'lead_inputs_generated', 'content_generated', 'open_tab'])('rejects unowned or another campaign’s %s event', type => {
    expect(matchesConversationEventScope(type, {}, 214)).toBe(false);
    expect(matchesConversationEventScope(type, { thread_id: 999 }, 214)).toBe(false);
    expect(matchesConversationEventScope(type, { thread_id: '' }, 214)).toBe(false);
    expect(matchesConversationEventScope(type, { __envelope: { threadId: 214 } }, 214)).toBe(true);
  });
  it('accepts an initial thread only through the conversation adoption flow', () => {
    expect(matchesConversationEventScope('message_sent', { thread_id: 214 }, null)).toBe(false);
    expect(matchesConversationEventScope('message_sent', { thread_id: 214, ackMessageId: 'own-request' }, null, true, 'own-request')).toBe(true);
    expect(matchesConversationEventScope('message_sent', {}, null, true)).toBe(false);
  });
  it.each([
    ['thread_resolved', { threadId: 221, requestMessageId: 'other-request' }],
    ['message_sent', { threadId: 221, ackMessageId: 'other-request' }],
    ['error', { threadId: 221, ackMessageId: 'other-request', terminal: true }],
    ['widget_created', { thread_id: 221, requestId: 'other-request' }],
    ['widget_update', { thread_id: 221, request_id: 'other-request' }],
    ['message_sent', { threadId: 221 }],
  ])('does not adopt another tab’s %s while a new campaign is pending', (type, data) => {
    expect(matchesConversationEventScope(type as string, data as Record<string, unknown>, null, true, 'own-request')).toBe(false);
  });
  it.each(['requestMessageId', 'ackMessageId', 'requestId', 'request_id'])('adopts its own first receipt using %s correlation', key => {
    expect(matchesConversationEventScope('thread_resolved', { threadId: 222, [key]: 'own-request' }, null, true, 'own-request')).toBe(true);
  });
  it('keeps unscoped account notifications available', () => {
    expect(matchesConversationEventScope('credits_updated', {}, 214)).toBe(true);
  });
});
