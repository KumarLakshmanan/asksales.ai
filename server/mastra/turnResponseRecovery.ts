type SavedTurnMessage = {
  id: number;
  role: string;
  content: string;
  agentType?: string | null;
  metadata?: unknown;
  createdAt?: Date;
};
type IntermediateTurnMessage = { content?: string; agentType?: string };

/** A successful HTTP turn must carry the same nonempty assistant reply that
 * was durably persisted after its user message, even when graph state omitted
 * that reply from its final message list. */
export function recoverEmptyAssistantTurn(
  userMessageId: number,
  savedMessages: SavedTurnMessage[],
  intermediateMessages: IntermediateTurnMessage[],
): { content: string; agentType?: string; persistedMessage?: SavedTurnMessage } {
  const persistedMessage = savedMessages
    .filter(message => message.id > userMessageId && message.role === 'assistant' && message.content.trim())
    .sort((a, b) => b.id - a.id)[0];
  if (persistedMessage) return { content: persistedMessage.content,
    agentType: persistedMessage.agentType || undefined, persistedMessage };
  const intermediate = [...intermediateMessages].reverse().find(message => message.content?.trim());
  if (intermediate) return { content: intermediate.content!, agentType: intermediate.agentType };
  return { content: 'I could not complete a reply for this turn. No new campaign action is confirmed. Please retry or check the saved review status.' };
}
