"use client";

import React, { createContext, useCallback, useContext, useState } from "react";
import type { AgentStatus } from "@/models/agentStatus";

export interface SelectedAgent {
  id: string;
  name: string;
  role: string;
  specialty: string;
  avatar: string;
}

/** Pending tool approval request from the agent system */
export interface PendingApproval {
  toolName: string;
  description?: string;
  agentType?: string;
  parameters?: Record<string, unknown>;
  timestamp: string;
}

/** Execution pipeline stage */
export type PipelineStage =
  | "idle"
  | "processing"
  | "awaiting_approval"
  | "executing_tool"
  | "streaming"
  | "completed"
  | "error";

interface AgentContextType {
  // Agent selection
  selectedAgent: SelectedAgent | null;
  setSelectedAgent: (agent: SelectedAgent | null) => void;

  // Active agent execution status (from WebSocket)
  activeAgent: AgentStatus | null;
  setActiveAgent: (status: AgentStatus | null) => void;

  // Pipeline stage
  pipelineStage: PipelineStage;
  setPipelineStage: (stage: PipelineStage) => void;

  // Progress tracking
  progress: number;
  progressMessage: string;
  updateProgress: (percent: number, message?: string) => void;
  resetProgress: () => void;

  // Approval state
  pendingApproval: PendingApproval | null;
  requestApproval: (approval: PendingApproval) => void;
  clearApproval: () => void;

  // Error state
  error: string | null;
  setError: (error: string | null) => void;

  // Current thread agent info
  currentAgentType: string;
  setCurrentAgentType: (agentType: string) => void;
}

const AgentContext = createContext<AgentContextType | undefined>(undefined);

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const [selectedAgent, setSelectedAgent] = useState<SelectedAgent | null>(null);
  const [activeAgent, setActiveAgent] = useState<AgentStatus | null>(null);
  const [pipelineStage, setPipelineStage] = useState<PipelineStage>("idle");
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [currentAgentType, setCurrentAgentType] = useState("orchestrator");
  const [error, setError] = useState<string | null>(null);

  const updateProgress = useCallback((percent: number, message?: string) => {
    setProgress(Math.min(100, Math.max(0, percent)));
    if (message) setProgressMessage(message);
  }, []);

  const resetProgress = useCallback(() => {
    setProgress(0);
    setProgressMessage("");
    setPipelineStage("idle");
  }, []);

  const requestApproval = useCallback((approval: PendingApproval) => {
    setPendingApproval(approval);
    setPipelineStage("awaiting_approval");
  }, []);

  const clearApproval = useCallback(() => {
    setPendingApproval(null);
    setPipelineStage(prev => prev === "awaiting_approval" ? "processing" : prev);
  }, []);

  return (
    <AgentContext.Provider
      value={{
        selectedAgent,
        setSelectedAgent,
        activeAgent,
        setActiveAgent,
        pipelineStage,
        setPipelineStage,
        progress,
        progressMessage,
        updateProgress,
        resetProgress,
        pendingApproval,
        requestApproval,
        clearApproval,
        error,
        setError,
        currentAgentType,
        setCurrentAgentType,
      }}
    >
      {children}
    </AgentContext.Provider>
  );
}

export function useAgent() {
  const context = useContext(AgentContext);
  if (!context) {
    throw new Error("useAgent must be used within AgentProvider");
  }
  return context;
}
