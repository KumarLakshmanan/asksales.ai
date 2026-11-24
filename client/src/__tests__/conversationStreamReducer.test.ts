import { describe, expect, it } from 'vitest';
import {
  createConversationEventLedger,
  createConversationStreamAccumulator,
  findStreamingMessageToReconcile,
  ingestConversationEventEnvelope,
  ingestConversationStreamChunk,
  reconcileDurableConversationMessage,
  isDurableConversationMessage,
  reconcileConversationResponseMessage,
} from '@/lib/conversation-stream-reducer';

describe('conversation stream reducer', () => {
  it('buffers an out-of-order terminal event until the missing chunk arrives', () => {
    const state = createConversationStreamAccumulator();
    expect(ingestConversationStreamChunk(state, { sequence: 2, chunk: '', done: true })).toMatchObject({ appendedText: '', completed: false });
    expect(ingestConversationStreamChunk(state, { sequence: 1, chunk: 'Complete response', done: false })).toMatchObject({ appendedText: 'Complete response', completed: true, lastSequence: 2 });
  });

  it('ignores replayed sequences and late events', () => {
    const state = createConversationStreamAccumulator();
    expect(ingestConversationStreamChunk(state, { sequence: 1, chunk: 'Hello', done: false }).appendedText).toBe('Hello');
    expect(ingestConversationStreamChunk(state, { sequence: 1, chunk: 'Hello', done: false }).accepted).toBe(false);
    expect(ingestConversationStreamChunk(state, { sequence: 2, chunk: '', done: true }).completed).toBe(true);
    expect(ingestConversationStreamChunk(state, { sequence: 3, chunk: 'late', done: false }).accepted).toBe(false);
  });

  it('rejects invalid sequences', () => {
    const state = createConversationStreamAccumulator();
    expect(ingestConversationStreamChunk(state, { sequence: 0, chunk: 'bad', done: false }).accepted).toBe(false);
  });
});

describe('durable conversation message reconciliation', () => {
  const streamed = {
    id: 'streaming-run-response-1',
    role: 'assistant',
    agentType: 'lead_generation',
    content: 'Here are the exact lead IDs.',
    metadata: { responseId: 'run-response-1' },
  };

  it('keeps one complete bubble when a final message arrives before the final chunk', () => {
    const accumulators = new Map([['run-response-1', createConversationStreamAccumulator()]]);
    const accumulator = accumulators.get('run-response-1')!;
    ingestConversationStreamChunk(accumulator, { sequence: 1, chunk: 'Hello', done: false });
    const messages = reconcileDurableConversationMessage([{ ...streamed, content: 'Hello' }], {
      ...streamed, id: '481', content: 'Hello world',
    }, accumulators);
    const delayed = ingestConversationStreamChunk(accumulator, { sequence: 2, chunk: ' world', done: true });
    expect(delayed.accepted).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: '481', content: 'Hello world', metadata: { persisted: true, streaming: false } });
    expect(isDurableConversationMessage(messages[0])).toBe(true);
  });

  it('seals a durable response even when none of its chunks have arrived', () => {
    const accumulators = new Map();
    const messages = reconcileDurableConversationMessage([], { ...streamed, id: '481' }, accumulators);
    expect(messages).toHaveLength(1);
    expect(ingestConversationStreamChunk(accumulators.get('run-response-1')!, {
      sequence: 1, chunk: 'stale', done: false,
    }).accepted).toBe(false);
  });

  it('discards buffered chunks and reconciles replays without duplicating the durable row', () => {
    const accumulators = new Map([['run-response-1', createConversationStreamAccumulator()]]);
    const accumulator = accumulators.get('run-response-1')!;
    ingestConversationStreamChunk(accumulator, { sequence: 3, chunk: 'late', done: true });
    const final = { ...streamed, id: '481' };
    const messages = reconcileDurableConversationMessage([streamed, final], final, accumulators);
    expect(messages).toHaveLength(1);
    expect(accumulator.pending.size).toBe(0);
    expect(reconcileDurableConversationMessage(messages, final, accumulators)).toHaveLength(1);
  });

  it('matches the authoritative response ID', () => {
    expect(findStreamingMessageToReconcile([streamed], {
      ...streamed,
      id: '481',
    })).toBe(0);
  });

  it('reconciles both full-response and streamed copies of the same error into one durable bubble', () => {
    const full = { ...streamed, id: 'run-response-1', content: 'The provider could not process this request.' };
    const stream = { ...full, id: 'streaming-run-response-1' };
    const durable = { ...full, id: '481' };
    const unrelated = { ...full, id: '480', metadata: { responseId: 'a-different-request' } };
    const messages = reconcileDurableConversationMessage([unrelated, full, stream], durable, new Map());
    expect(messages.map(message => message.id)).toEqual(['480', '481']);
    expect(messages[1].metadata).toMatchObject({ persisted: true, streaming: false });
  });

  it('replaces a non-streaming chat response when its durable message arrives', () => {
    expect(findStreamingMessageToReconcile([{
      ...streamed,
      id: 'run-response-1',
    }], {
      ...streamed,
      id: '481',
    })).toBe(0);
  });

  it('falls back to exact content only for an ephemeral streaming row', () => {
    expect(findStreamingMessageToReconcile([streamed], {
      ...streamed,
      id: '481',
      metadata: { responseId: 'legacy-mismatched-id' },
    })).toBe(0);
  });

  it.each(['resp-legacy', 'http-response-legacy'])('reconciles legacy ephemeral response ID %s by exact content', (id) => {
    expect(findStreamingMessageToReconcile([{ ...streamed, id }], {
      ...streamed,
      id: '481',
      metadata: { responseId: 'legacy-mismatched-id' },
    })).toBe(0);
  });

  it('does not collapse two durable messages with identical content', () => {
    expect(findStreamingMessageToReconcile([{ ...streamed, id: '480' }], {
      ...streamed,
      id: '481',
      metadata: {},
    })).toBe(-1);
  });

  it.each([
    ['stream', 'full', 'durable'], ['stream', 'durable', 'full'],
    ['full', 'stream', 'durable'], ['full', 'durable', 'stream'],
    ['durable', 'stream', 'full'], ['durable', 'full', 'stream'],
  ])('keeps one receipt across response arrival order %s → %s → %s', (...order) => {
    const map = new Map();
    const copies = {
      stream: { ...streamed, id: 'streaming-run-response-1' },
      full: { ...streamed, id: 'run-response-1' },
      durable: { ...streamed, id: '3268' },
    };
    let messages: Array<typeof streamed> = [];
    for (const kind of order) {
      // A queued stream updater must also respect a completed response fence.
      if (kind === 'stream' && map.get('run-response-1')?.completed) continue;
      messages = reconcileConversationResponseMessage(messages, copies[kind as keyof typeof copies], map);
    }
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('3268');
  });

  it('removes every ephemeral sibling after HTTP fallback races durable WS delivery', () => {
    const durable = { ...streamed, id: '3268', metadata: { responseId: 'run-response-1', persisted: true } };
    const full = { ...streamed, id: 'run-response-1', metadata: { responseId: 'run-response-1', persisted: true } };
    const messages = reconcileConversationResponseMessage([streamed, full, durable], full);
    expect(messages).toEqual([durable]);
    expect(isDurableConversationMessage(full)).toBe(false);
  });

  it('matches generic HTTP transient IDs through authoritative response metadata', () => {
    const http = { ...streamed, id: 'http-response-delivery-1' };
    expect(reconcileDurableConversationMessage([http], { ...streamed, id: '3268' }, new Map()).map(message => message.id)).toEqual(['3268']);
  });

  it('does not suppress a new turn simply because an earlier durable reply has identical text', () => {
    const old = { ...streamed, id: '3267', metadata: { responseId: 'old-turn' } };
    const next = { ...streamed, id: 'new-turn', metadata: { responseId: 'new-turn' } };
    expect(reconcileConversationResponseMessage([old], next).map(message => message.id)).toEqual(['3267', 'new-turn']);
  });
});

describe('conversation event ledger', () => {
  it('accepts the next turn in the same workflow and ignores late statuses from the prior turn', () => {
    const ledger = createConversationEventLedger();
    const base = { threadId: 8, runId: 'run-1', kind: 'workflow_run_status' };
    expect(ingestConversationEventEnvelope(ledger, { ...base, turnId: 'turn-1', status: 'succeeded', updatedAt: 10 })).toBe(true);
    expect(ingestConversationEventEnvelope(ledger, { ...base, turnId: 'turn-2', status: 'running', updatedAt: 20 })).toBe(true);
    expect(ingestConversationEventEnvelope(ledger, { ...base, turnId: 'turn-1', status: 'succeeded', updatedAt: 11 })).toBe(false);
    expect(ingestConversationEventEnvelope(ledger, { ...base, turnId: 'turn-2', status: 'awaiting_approval', updatedAt: 21 })).toBe(true);
    expect(ingestConversationEventEnvelope(ledger, { ...base, turnId: 'turn-2', status: 'running', updatedAt: 20 })).toBe(false);
  });

  it('rejects replayed event IDs', () => {
    const ledger = createConversationEventLedger();
    const event = { eventId: 'evt-1', threadId: 8, runId: 'run-1', kind: 'tool_execution' };
    expect(ingestConversationEventEnvelope(ledger, event)).toBe(true);
    expect(ingestConversationEventEnvelope(ledger, event)).toBe(false);
  });

  it('ignores a late running update after a terminal run status', () => {
    const ledger = createConversationEventLedger();
    expect(ingestConversationEventEnvelope(ledger, {
      eventId: 'evt-2', threadId: 8, runId: 'run-1', kind: 'workflow_run_status', status: 'succeeded',
    })).toBe(true);
    expect(ingestConversationEventEnvelope(ledger, {
      eventId: 'evt-3', threadId: 8, runId: 'run-1', kind: 'workflow_run_status', status: 'running',
    })).toBe(false);
  });

  it('still accepts a durable message emitted after a terminal run status', () => {
    const ledger = createConversationEventLedger();
    expect(ingestConversationEventEnvelope(ledger, {
      eventId: 'evt-4', threadId: 8, runId: 'run-1', kind: 'workflow_run_status', status: 'succeeded',
    })).toBe(true);
    expect(ingestConversationEventEnvelope(ledger, {
      eventId: 'evt-5', threadId: 8, runId: 'run-1', messageId: 42, kind: 'chat_message',
    })).toBe(true);
  });
});
