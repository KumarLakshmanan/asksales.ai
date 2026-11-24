import { useState, useCallback } from "react";
import { type AgentStatus } from "@/models/agentStatus";
import { useToast } from "@/hooks/use-toast";
import api from "@/lib/api";

export function useAgentRouter(
  currentThreadId: number | null,
  handleSendMessage: (content: string, bypassProcessingCheck?: boolean) => Promise<void>
) {
  const { toast } = useToast();
  const [activeAgent, setActiveAgent] = useState<AgentStatus | undefined>();
  const [showAgentSuggestions, setShowAgentSuggestions] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [recommendedAgents, setRecommendedAgents] = useState<string[]>([]);
  const [recommendedAgentScores, setRecommendedAgentScores] = useState<{
    lead_generation?: number;
    content_studio?: number;
    performance_marketing?: number;
    outreach?: number;
  } | undefined>(undefined);
  const [agentDescriptions, setAgentDescriptions] = useState<Record<string, string> | undefined>(undefined);

  const handleAgentSelect = useCallback(async (agentName: string) => {
    const agentTypeMap: { [key: string]: string } = {
      'Lead Generation': 'lead_generation',
      'Content Studio': 'content_studio',
      'Outreach': 'outreach',
      'Performance Marketing': 'performance_marketing',
      'ICP Profile': 'icp_generation',
    };

    const agentType = agentTypeMap[agentName] || agentName.toLowerCase().replace(/\s+/g, '_');
    setSelectedAgent(agentType);

    if (currentThreadId) {
      try {
        await api.post('/api/chat/langgraph/action', {
          threadId: currentThreadId,
          action: 'switch_agent',
          value: agentType,
        });
      } catch (error: unknown) {
        console.error('[Chat] Error switching agent:', error);
        toast({
          title: "Switch Failed",
          description: error instanceof Error ? error.message : "Failed to switch agent",
          variant: "destructive",
        });
      }
    } else {
      await handleSendMessage(`Hire ${agentName}`);
    }
  }, [currentThreadId, handleSendMessage, toast]);

  return {
    activeAgent,
    setActiveAgent,
    showAgentSuggestions,
    setShowAgentSuggestions,
    selectedAgent,
    setSelectedAgent,
    recommendedAgents,
    setRecommendedAgents,
    recommendedAgentScores,
    setRecommendedAgentScores,
    agentDescriptions,
    setAgentDescriptions,
    handleAgentSelect,
  };
}
