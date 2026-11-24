interface PersistedChatMessage {
  id: number;
  createdAt?: Date | string;
}

interface LeadWorkflowApprovalMessageDependencies {
  persist: (message: {
    userId: number;
    threadId: number;
    role: 'user' | 'assistant';
    content: string;
    agentType: string;
  }) => Promise<PersistedChatMessage>;
  emit: (userId: number, threadId: number, message: {
    id: number;
    role: 'user' | 'assistant';
    content: string;
    agentType: string;
    timestamp: number;
  }) => void;
}

export async function persistAndBroadcastChatMessage(
  userId: number,
  threadId: number,
  message: {
    role: 'user' | 'assistant';
    content: string;
    agentType: string;
  },
  dependencies: LeadWorkflowApprovalMessageDependencies,
): Promise<PersistedChatMessage> {
  const persisted = await dependencies.persist({
    userId,
    threadId,
    ...message,
  });
  const persistedId = Number(persisted.id);
  if (!Number.isSafeInteger(persistedId) || persistedId <= 0) {
    throw new Error('Chat message did not return a durable message ID');
  }

  const createdAt = persisted.createdAt instanceof Date
    ? persisted.createdAt
    : persisted.createdAt
      ? new Date(persisted.createdAt)
      : new Date();
  dependencies.emit(userId, threadId, {
    id: persistedId,
    ...message,
    timestamp: Number.isNaN(createdAt.getTime()) ? Date.now() : createdAt.getTime(),
  });
  return persisted;
}

export async function persistAndBroadcastLeadWorkflowApproval(
  userId: number,
  threadId: number,
  content: string,
  dependencies: LeadWorkflowApprovalMessageDependencies,
): Promise<PersistedChatMessage> {
  return persistAndBroadcastChatMessage(userId, threadId, {
    role: 'user',
    content,
    agentType: 'user',
  }, dependencies);
}
