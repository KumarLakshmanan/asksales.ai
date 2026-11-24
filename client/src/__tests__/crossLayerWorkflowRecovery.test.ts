import { describe, expect, it } from 'vitest';
import type { Message } from '@/models/message';
import {
  createConversationEventLedger,
  createConversationStreamAccumulator,
  ingestConversationEventEnvelope,
  ingestConversationStreamChunk,
} from '@/lib/conversation-stream-reducer';
import { collapseToolExecutionMessages } from '@/lib/tool-message-pairing';

function toolMessage(id: string, metadata: Record<string, unknown>): Message {
  return {
    id,
    role: 'assistant',
    agentType: 'orchestrator',
    content: '',
    timestamp: Number(id.replace(/\D/g, '')) || 1,
    metadata,
  } as Message;
}

describe('cross-layer realtime and approval recovery', () => {
  it('reconciles duplicated, replayed, late, and out-of-order events deterministically', () => {
    const ledger = createConversationEventLedger();
    const stream = createConversationStreamAccumulator();
    const envelopes = [
      { eventId: 'evt-terminal', threadId: 77, runId: 'run-77', kind: 'workflow_run_status', status: 'succeeded' },
      { eventId: 'evt-terminal', threadId: 77, runId: 'run-77', kind: 'workflow_run_status', status: 'succeeded' },
      { eventId: 'evt-late', threadId: 77, runId: 'run-77', kind: 'workflow_run_status', status: 'running' },
      { eventId: 'evt-message', threadId: 77, runId: 'run-77', kind: 'chat_message', messageId: 701 },
    ];
    expect(envelopes.map(event => ingestConversationEventEnvelope(ledger, event))).toEqual([true, false, false, true]);

    const terminalFirst = ingestConversationStreamChunk(stream, { sequence: 3, chunk: '', done: true });
    const second = ingestConversationStreamChunk(stream, { sequence: 2, chunk: 'world', done: false });
    const first = ingestConversationStreamChunk(stream, { sequence: 1, chunk: 'Hello ', done: false });
    expect(terminalFirst).toMatchObject({ accepted: true, appendedText: '', completed: false });
    expect(second).toMatchObject({ accepted: true, appendedText: '', completed: false });
    expect(first).toMatchObject({ accepted: true, appendedText: 'Hello world', completed: true, lastSequence: 3 });
    expect(ingestConversationStreamChunk(stream, { sequence: 2, chunk: 'world', done: false }).accepted).toBe(false);
    expect(ingestConversationStreamChunk(stream, { sequence: 4, chunk: 'late', done: false }).accepted).toBe(false);
  });

  it('retains stable toolCallId/action correlation across reload and collapses duplicate durable effects', () => {
    const call = toolMessage('701', {
      isToolCall: true,
      toolName: 'send_outreach_messages',
      toolCallId: 'action-stable-77',
      toolArgs: { leadIds: [11, 12] },
    });
    const result = toolMessage('702', {
      isToolResult: true,
      toolName: 'send_outreach_messages',
      toolCallId: 'action-stable-77',
      success: true,
      providerMutationCount: 1,
    });
    const replay = { ...result, content: 'authoritative persisted result' };

    const beforeReload = collapseToolExecutionMessages([call, result]);
    const afterReload = collapseToolExecutionMessages([call, result, replay]);
    expect(beforeReload).toHaveLength(1);
    expect(afterReload).toHaveLength(1);
    expect(afterReload[0]).toMatchObject({
      id: '702',
      content: 'authoritative persisted result',
      metadata: {
        toolCallId: 'action-stable-77',
        toolArgs: { leadIds: [11, 12] },
        providerMutationCount: 1,
      },
    });
  });
});
