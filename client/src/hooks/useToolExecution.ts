import { useState, useCallback, useEffect, useRef } from "react";
import { useToast } from "@/hooks/use-toast";
import api, { ApiError } from "@/lib/api";
import type { ToolLogEntry } from "@/components/chat/ChatThinkingBubble";

export function useToolExecution(
  currentThreadId: number | null,
  clearProcessingTimeout: () => void,
  setIsProcessing: (val: boolean) => void
) {
  const { toast } = useToast();
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [approvalData, setApprovalData] = useState<{
    toolName: string;
    toolDescription?: string;
    parameters?: Record<string, unknown>;
    agentType?: string;
    requestId?: string;
  } | null>(null);
  const [approvingTool, setApprovingTool] = useState(false);
  const [toolLogs, setToolLogs] = useState<ToolLogEntry[]>([]);
  const reviewScopeRef = useRef(0);
  const submissionScopeRef = useRef<number | null>(null);
  useEffect(() => {
    reviewScopeRef.current += 1;
    submissionScopeRef.current = null;
    setApprovingTool(false);
  }, [currentThreadId, approvalData?.requestId, approvalData?.toolName]);

  const handleApproveTool = useCallback(async (approved: boolean, overrides?: Record<string, unknown>) => {
    if (!currentThreadId) return;
    if (!approvalData?.requestId || !approvalData.toolName) {
      toast({
        title: "Approval Expired",
        description: "This request is missing its execution identity. Ask the agent to prepare it again.",
        variant: "destructive",
      });
      setShowApprovalModal(false);
      setApprovalData(null);
      return;
    }
    const scope = reviewScopeRef.current;
    if (submissionScopeRef.current === scope) return;
    submissionScopeRef.current = scope;
    const ownsReview = () => reviewScopeRef.current === scope;

    try {
      setApprovingTool(true);

      const result = await api.post<{ status: 'running' | 'succeeded' | 'rejected' | 'failed'; error?: string }>(`/api/chat/langgraph/approve`, {
        threadId: currentThreadId,
        approved,
        requestId: approvalData.requestId,
        toolName: approvalData.toolName,
        overrides,
      });
      if (!ownsReview()) return;

      setShowApprovalModal(false);
      setApprovalData(null);

      const toolDisplayName = approvalData.toolName;
      if (result.status === 'running') {
        toast({
          title: "Already running",
          description: `${toolDisplayName} is already being processed. It was not submitted again.`,
        });
        return;
      }
      toast({
        title: result.status === 'succeeded' ? "Completed" : "Rejected",
        description: result.status === 'succeeded'
          ? `${toolDisplayName} completed successfully.`
          : `${toolDisplayName} was rejected.`,
        variant: result.status === 'succeeded' ? "default" : "destructive",
      });
    } catch (error: unknown) {
      if (!ownsReview()) return;
      console.error('[Chat] Error sending approval:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to process approval';
      const executionFinishedWithFailure = error instanceof ApiError && error.status === 422;
      if (executionFinishedWithFailure) {
        setShowApprovalModal(false);
        setApprovalData(null);
      }
      toast({
        title: executionFinishedWithFailure ? "Execution failed" : "Approval Failed",
        description: errorMessage,
        variant: "destructive"
      });
    } finally {
      if (submissionScopeRef.current === scope) submissionScopeRef.current = null;
      if (ownsReview()) {
        setApprovingTool(false);
        clearProcessingTimeout();
        setIsProcessing(false);
      }
    }
  }, [currentThreadId, approvalData, toast, clearProcessingTimeout, setIsProcessing]);

  return {
    showApprovalModal,
    setShowApprovalModal,
    approvalData,
    setApprovalData,
    approvingTool,
    setApprovingTool,
    toolLogs,
    setToolLogs,
    handleApproveTool,
  };
}
