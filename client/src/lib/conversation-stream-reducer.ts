export interface ConversationStreamChunk {
  sequence: number;
  chunk: string;
  done: boolean;
  metadata?: Record<string, unknown>;
}

export interface ConversationStreamAccumulator {
  nextSequence: number;
  pending: Map<number, ConversationStreamChunk>;
  completed: boolean;
}

export interface ConversationStreamUpdate {
  accepted: boolean;
  appendedText: string;
  completed: boolean;
  lastSequence: number;
  metadata: Record<string, unknown>;
}

export interface ConversationEventLedger {
  seenEventIds: Set<string>;
  terminalRuns: Set<string>;
  latestTurns: Map<string, { id: string; updatedAt?: number }>;
  retiredTurns: Set<string>;
}

export interface ConversationEventEnvelope {
  eventId?: string;
  threadId?: number | string;
  runId?: string;
  turnId?: string;
  updatedAt?: string | number;
  messageId?: string | number;
  kind: string;
  status?: string;
}

export interface ReconcileConversationMessage {
  id: string;
  role: string;
  agentType?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

const TERMINAL_RUN_STATUSES = new Set([
  'partial_success', 'succeeded', 'succeeded_empty', 'failed',
  'cancelled', 'gated', 'timed_out',
]);

export function createConversationEventLedger(): ConversationEventLedger {
  return { seenEventIds: new Set(), terminalRuns: new Set(), latestTurns: new Map(), retiredTurns: new Set() };
}

/** Reject transport replays and late run-state regressions before UI mutation. */
export function ingestConversationEventEnvelope(
  ledger: ConversationEventLedger,
  event: ConversationEventEnvelope,
): boolean {
  if (event.eventId) {
    if (ledger.seenEventIds.has(event.eventId)) return false;
    ledger.seenEventIds.add(event.eventId);
    if (ledger.seenEventIds.size > 2_000) {
      const oldest = ledger.seenEventIds.values().next().value;
      if (oldest) ledger.seenEventIds.delete(oldest);
    }
  }

  if (event.runId && event.kind === 'workflow_run_status') {
    const runKey = `${event.threadId ?? 'unknown'}:${event.runId}`;
    // Legacy status events completed a reply, not the durable multi-turn
    // workflow. Keep that terminal fence scoped to its explicitly named turn.
    const statusKey = event.turnId ? `${runKey}:${event.turnId}` : runKey;
    if (event.turnId) {
      if (ledger.retiredTurns.has(statusKey)) return false;
      const prior = ledger.latestTurns.get(runKey);
      const parsedTime = typeof event.updatedAt === 'number' ? event.updatedAt : Date.parse(event.updatedAt || '');
      const updatedAt = Number.isFinite(parsedTime) ? parsedTime : undefined;
      if (prior?.updatedAt !== undefined && updatedAt !== undefined && updatedAt < prior.updatedAt) return false;
      if (prior && prior.id !== event.turnId) ledger.retiredTurns.add(`${runKey}:${prior.id}`);
      ledger.latestTurns.set(runKey, { id: event.turnId, updatedAt: updatedAt ?? prior?.updatedAt });
    }
    if (ledger.terminalRuns.has(statusKey) && !TERMINAL_RUN_STATUSES.has(event.status || '')) {
      return false;
    }
    if (TERMINAL_RUN_STATUSES.has(event.status || '')) ledger.terminalRuns.add(statusKey);
  }
  return true;
}

export function createConversationStreamAccumulator(): ConversationStreamAccumulator {
  return { nextSequence: 1, pending: new Map(), completed: false };
}

/** A stored final response supersedes every chunk, including unseen late chunks. */
export function sealConversationStream(
  accumulators: Map<string, ConversationStreamAccumulator>,
  responseId: unknown,
): void {
  if (typeof responseId !== 'string' || !responseId) return;
  const accumulator = accumulators.get(responseId) || createConversationStreamAccumulator();
  accumulator.completed = true;
  accumulator.pending.clear();
  accumulators.set(responseId, accumulator);
}

export function isDurableConversationMessage(message: ReconcileConversationMessage): boolean {
  // A full HTTP/WS response may carry copied persistence metadata while its
  // local row still uses the transient response ID, not the stored message ID.
  if (message.id === message.metadata?.responseId || /^(streaming-|resp-|http-response-)/.test(message.id)) return false;
  return message.metadata?.persisted === true || (Number.isSafeInteger(Number(message.id)) && Number(message.id) > 0);
}

/** Reconcile a full HTTP/WS response against chunks AND already-persisted rows.
 * Transport order is arbitrary; an ephemeral receipt never replaces a stored
 * message, and every transient copy for this response identity is removed. */
export function reconcileConversationResponseMessage<T extends ReconcileConversationMessage>(
  messages: T[],
  responseMessage: T,
  accumulators: Map<string, ConversationStreamAccumulator> = new Map(),
): T[] {
  if (isDurableConversationMessage(responseMessage)) {
    return reconcileDurableConversationMessage(messages, responseMessage, accumulators);
  }
  const responseId = responseMessage.metadata?.responseId;
  sealConversationStream(accumulators, responseId);
  const matches = (message: T) => message.id === responseMessage.id || (typeof responseId === 'string' && (
    message.metadata?.responseId === responseId || message.id === responseId || message.id === `streaming-${responseId}`
  ));
  const stored = messages.find(message => matches(message) && isDurableConversationMessage(message));
  if (stored) {
    return messages.filter(message => !matches(message) || isDurableConversationMessage(message));
  }
  const first = messages.findIndex(matches);
  if (first < 0) return [...messages, responseMessage];
  return messages.flatMap((message, index) => index === first ? [responseMessage] : matches(message) ? [] : [message]);
}

export function reconcileDurableConversationMessage<T extends ReconcileConversationMessage>(
  messages: T[],
  durableMessage: T,
  accumulators: Map<string, ConversationStreamAccumulator>,
): T[] {
  sealConversationStream(accumulators, durableMessage.metadata?.responseId);
  const streamingIndex = findStreamingMessageToReconcile(messages, durableMessage);
  const streaming = streamingIndex >= 0 ? messages[streamingIndex] : undefined;
  if (streaming) {
    sealConversationStream(accumulators, streaming.metadata?.responseId);
    if (streaming.id.startsWith('streaming-')) sealConversationStream(accumulators, streaming.id.slice('streaming-'.length));
  }
  const replacement = {
    ...durableMessage,
    metadata: {
      ...streaming?.metadata,
      ...durableMessage.metadata,
      streaming: false,
      streamingComplete: true,
      persistencePending: false,
      persisted: true,
    },
  };
  const existingIndex = messages.findIndex(message => message.id === durableMessage.id);
  const targetIndex = existingIndex >= 0 ? existingIndex : streamingIndex;
  if (targetIndex < 0) return [...messages, replacement];
  return messages.flatMap((message, index) => {
    if (index === targetIndex) return [replacement];
    if (index === streamingIndex || message.id === durableMessage.id) return [];
    const responseId = durableMessage.metadata?.responseId;
    if (typeof responseId === 'string' && !isDurableConversationMessage(message) && (
      message.metadata?.responseId === responseId || message.id === responseId || message.id === `streaming-${responseId}`
    )) return [];
    return [message];
  });
}

/**
 * Locate the ephemeral stream that a durable message must replace. The
 * response ID is authoritative, while exact content is a safe compatibility
 * fallback limited to ephemeral rows from legacy/mismatched envelopes.
 */
export function findStreamingMessageToReconcile(
  messages: ReconcileConversationMessage[],
  durableMessage: ReconcileConversationMessage,
): number {
  const responseId = durableMessage.metadata?.responseId;
  if (typeof responseId === 'string' && responseId) {
    const byResponseId = messages.findIndex(message =>
      !isDurableConversationMessage(message) && (
        message.id === responseId ||
        message.id === `streaming-${responseId}` ||
        message.metadata?.responseId === responseId
      )
    );
    if (byResponseId >= 0) return byResponseId;
  }

  return messages.findIndex(message =>
    /^(streaming-|resp-|http-response-)/.test(message.id) &&
    message.role === durableMessage.role &&
    message.agentType === durableMessage.agentType &&
    message.content === durableMessage.content
  );
}

/** Apply a streaming event exactly once and expose only contiguous chunks. */
export function ingestConversationStreamChunk(
  accumulator: ConversationStreamAccumulator,
  event: ConversationStreamChunk,
): ConversationStreamUpdate {
  if (accumulator.completed || !Number.isInteger(event.sequence) || event.sequence < 1) {
    return { accepted: false, appendedText: '', completed: accumulator.completed, lastSequence: accumulator.nextSequence - 1, metadata: {} };
  }
  if (event.sequence < accumulator.nextSequence || accumulator.pending.has(event.sequence)) {
    return { accepted: false, appendedText: '', completed: accumulator.completed, lastSequence: accumulator.nextSequence - 1, metadata: {} };
  }

  accumulator.pending.set(event.sequence, event);
  let appendedText = '';
  let completed = false;
  let metadata: Record<string, unknown> = {};
  while (accumulator.pending.has(accumulator.nextSequence)) {
    const current = accumulator.pending.get(accumulator.nextSequence)!;
    accumulator.pending.delete(accumulator.nextSequence);
    appendedText += current.chunk;
    metadata = { ...metadata, ...current.metadata };
    accumulator.nextSequence += 1;
    if (current.done) {
      accumulator.completed = true;
      accumulator.pending.clear();
      completed = true;
      break;
    }
  }

  return { accepted: true, appendedText, completed, lastSequence: accumulator.nextSequence - 1, metadata };
}
