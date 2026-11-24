import type { Message } from "@/models/message";

function toolKey(message: Message): string | null {
  const metadata = message.metadata;
  const toolCallId = typeof metadata?.toolCallId === "string" ? metadata.toolCallId : "";
  if (toolCallId) return `id:${toolCallId}`;
  const toolName = typeof metadata?.toolName === "string" ? metadata.toolName : "";
  if (!toolName) return null;
  return `name:${toolName}`;
}

/** Collapse a persisted tool call/result pair into one activity row. */
export function collapseToolExecutionMessages(messages: Message[]): Message[] {
  // Durable fetches and realtime delivery can briefly overlap during reconnect.
  // Collapse identical database IDs before React renders them so a replay can
  // neither duplicate a bubble nor destabilize component identity.
  const positionById = new Map<string, number>();
  const deduplicated: Message[] = [];
  for (const message of messages) {
    const existingPosition = positionById.get(message.id);
    if (existingPosition === undefined) {
      positionById.set(message.id, deduplicated.length);
      deduplicated.push(message);
    } else {
      deduplicated[existingPosition] = message;
    }
  }

  const pendingByTool = new Map<string, number[]>();
  const hiddenCalls = new Set<number>();
  const normalized = [...deduplicated];

  deduplicated.forEach((message, index) => {
    const metadata = message.metadata;
    const key = toolKey(message);
    if (!key) return;

    if (metadata?.isToolCall && !metadata?.isToolResult) {
      const pending = pendingByTool.get(key) || [];
      pending.push(index);
      pendingByTool.set(key, pending);
      return;
    }

    if (!metadata?.isToolResult) return;
    const callIndex = pendingByTool.get(key)?.shift();
    if (callIndex === undefined) return;

    const call = deduplicated[callIndex];
    hiddenCalls.add(callIndex);
    normalized[index] = {
      ...message,
      agentType: message.agentType || call.agentType,
      metadata: {
        ...call.metadata,
        ...metadata,
        isToolCall: false,
        isToolResult: true,
        toolArgs: metadata.toolArgs ?? call.metadata?.toolArgs,
      },
    };
  });

  return normalized.filter((_, index) => !hiddenCalls.has(index));
}
