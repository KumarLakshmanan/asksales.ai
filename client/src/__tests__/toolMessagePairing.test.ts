import { describe, expect, it } from "vitest";
import type { Message } from "@/models/message";
import { collapseToolExecutionMessages } from "@/lib/tool-message-pairing";

function toolMessage(id: number, metadata: Record<string, unknown>): Message {
  return { id: String(id), role: "assistant", agentType: "orchestrator", content: "", timestamp: id, metadata } as Message;
}

describe("collapseToolExecutionMessages", () => {
  it("keeps an unmatched tool call running", () => {
    const call = toolMessage(1, { isToolCall: true, toolName: "crawl_website" });
    expect(collapseToolExecutionMessages([call])).toEqual([call]);
  });

  it("replaces a matched call with its completed result", () => {
    const result = collapseToolExecutionMessages([
      toolMessage(1, { isToolCall: true, toolName: "crawl_website", toolArgs: { url: "https://example.com" } }),
      toolMessage(2, { isToolResult: true, toolName: "crawl_website", success: true }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].metadata).toMatchObject({ isToolCall: false, isToolResult: true, success: true, toolArgs: { url: "https://example.com" } });
  });

  it("pairs repeated calls and results in order", () => {
    const result = collapseToolExecutionMessages([
      toolMessage(1, { isToolCall: true, toolName: "generate_icp", toolArgs: { attempt: 1 } }),
      toolMessage(2, { isToolCall: true, toolName: "generate_icp", toolArgs: { attempt: 2 } }),
      toolMessage(3, { isToolResult: true, toolName: "generate_icp", success: true }),
      toolMessage(4, { isToolResult: true, toolName: "generate_icp", success: false }),
    ]);
    expect(result.map((message) => message.metadata?.toolArgs)).toEqual([{ attempt: 1 }, { attempt: 2 }]);
    expect(result.map((message) => message.metadata?.success)).toEqual([true, false]);
  });

  it("pairs concurrent calls by toolCallId even when results finish out of order", () => {
    const result = collapseToolExecutionMessages([
      toolMessage(1, { isToolCall: true, toolName: "query_leads", toolCallId: "call-a", toolArgs: { page: 1 } }),
      toolMessage(2, { isToolCall: true, toolName: "query_leads", toolCallId: "call-b", toolArgs: { page: 2 } }),
      toolMessage(3, { isToolResult: true, toolName: "query_leads", toolCallId: "call-b", success: true }),
      toolMessage(4, { isToolResult: true, toolName: "query_leads", toolCallId: "call-a", success: false }),
    ]);
    expect(result.map((message) => message.metadata?.toolArgs)).toEqual([{ page: 2 }, { page: 1 }]);
    expect(result.map((message) => message.metadata?.success)).toEqual([true, false]);
  });

  it("collapses reconnect replays with the same durable message ID", () => {
    const original = toolMessage(9, { isToolResult: true, toolName: "query_leads", success: true });
    const replay = { ...original, content: "latest durable payload" };
    expect(collapseToolExecutionMessages([original, replay])).toEqual([replay]);
  });
});
