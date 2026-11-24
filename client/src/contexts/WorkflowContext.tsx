"use client";

import { createContext, useContext, useReducer, type ReactNode, useEffect, useCallback, useRef } from "react";
import { type WorkflowStage } from "@/models/workflow";
import { type ICP } from "@/models/icp";
import { type LeadGenStrategy } from "@/models/leadGenStrategy";
import { type AgentType } from "@/models/agent";
import { type ChannelScrapingProgress } from "@/models/channelScrapingProgress";
import { type OutreachChannelProgress } from "@/models/outreachChannelProgress";
import { type ContentAssetPreview } from "@/models/contentAssetPreview";
import { type Lead } from "@/models/lead";
import { type SentMessage } from "@/models/sentMessage";
import { useWorkflowApi } from "@/hooks/useWorkflowApi";

// Workflow State
interface WorkflowState {
  stage: WorkflowStage | "idle";
  progress: number;
  activeAgent?: AgentType;
  currentTask?: string;
  icpData?: ICP;
  strategyData?: LeadGenStrategy;
  userPrompt?: string;
  scrapingChannels?: ChannelScrapingProgress[];
  totalLeadsScraped?: number;
  outreachChannels?: OutreachChannelProgress[];
  totalLeadsOutreached?: number;
  contentPreview?: ContentAssetPreview;
  useContentStudio?: boolean;
  campaignId?: string;
  outreachNeedsReview?: boolean;
  workflowId?: string;
  leads?: Lead[];
  sentMessages?: Record<string, SentMessage[]>;
}

// Events
type WorkflowEvent =
  | { type: "USER_PROMPT"; payload: string }
  | { type: "ICP_READY"; payload: ICP }
  | { type: "STRATEGY_READY"; payload: LeadGenStrategy }
  | { type: "USER_APPROVED" }
  | { type: "USER_REJECTED" }
  | { type: "PROGRESS_TICK" }
  | { type: "UPDATE_SCRAPING"; payload: { channels: ChannelScrapingProgress[]; totalLeads: number } }
  | { type: "SCRAPE_DONE" }
  | { type: "START_OUTREACH" }
  | { type: "DECLINE_OUTREACH" }
  | { type: "UPDATE_OUTREACH"; payload: { channels: OutreachChannelProgress[]; totalOutreached: number } }
  | { type: "RECOMMEND_CONTENT_STUDIO" }
  | { type: "ACCEPT_CONTENT_STUDIO" }
  | { type: "DECLINE_CONTENT_STUDIO" }
  | { type: "CONTENT_READY"; payload: ContentAssetPreview }
  | { type: "APPROVE_CONTENT" }
  | { type: "REJECT_CONTENT" }
  | { type: "OUTREACH_DONE" }
  | { type: "RESET" }
  | { type: "SET_WORKFLOW_ID"; payload: string }
  | { type: "SET_CAMPAIGN_ID"; payload: string }
  | { type: "OUTREACH_REVIEW_REQUIRED"; payload: string };

const initialState: WorkflowState = {
  stage: "idle",
  progress: 0,
};

// Reducer
function workflowReducer(state: WorkflowState, event: WorkflowEvent): WorkflowState {
  switch (event.type) {
    case "USER_PROMPT":
      return {
        ...state,
        stage: "icp_building",
        progress: 0,
        activeAgent: "lead_generation",
        currentTask: "Analyzing your requirements...",
        userPrompt: event.payload,
        icpData: undefined,
        strategyData: undefined,
        campaignId: undefined,
        outreachNeedsReview: false,
      };

    case "PROGRESS_TICK":
      return {
        ...state,
        progress: Math.min(state.progress + 5, 100),
      };

    case "ICP_READY":
      return {
        ...state,
        stage: "strategy_creation",
        progress: 0,
        currentTask: "Creating lead generation strategy...",
        icpData: event.payload,
      };

    case "STRATEGY_READY":
      return {
        ...state,
        stage: "awaiting_approval",
        progress: 100,
        currentTask: "Awaiting your approval",
        strategyData: event.payload,
      };

    case "USER_APPROVED":
      return {
        ...state,
        stage: "executing",
        progress: 0,
        currentTask: "Scraping leads from channels...",
      };

    case "USER_REJECTED":
      return {
        ...state,
        stage: "idle",
        progress: 0,
        currentTask: undefined,
      };

    case "UPDATE_SCRAPING":
      return {
        ...state,
        scrapingChannels: event.payload.channels,
        totalLeadsScraped: event.payload.totalLeads,
        progress: Math.min(
          Math.round(
            event.payload.channels.reduce((sum, ch) => sum + ch.progress, 0) / event.payload.channels.length
          ),
          100
        ),
      };

    case "SCRAPE_DONE":
      return {
        ...state,
        stage: "outreach_recommendation",
        progress: 100,
        currentTask: "Lead generation complete!",
        activeAgent: "outreach",
      };

    case "START_OUTREACH":
      return {
        ...state,
        stage: "content_creation",
        progress: 0,
        currentTask: "Content Studio coordinator available for better engagement...",
        activeAgent: "content_studio",
      };

    case "DECLINE_OUTREACH":
      return {
        ...state,
        stage: "completed",
        progress: 100,
        currentTask: "Workflow complete",
      };

    case "UPDATE_OUTREACH":
      return {
        ...state,
        outreachChannels: event.payload.channels,
        totalLeadsOutreached: event.payload.totalOutreached,
        progress: Math.min(
          Math.round(
            event.payload.channels.reduce((sum, ch) => sum + ch.progress, 0) / event.payload.channels.length
          ),
          100
        ),
      };

    case "RECOMMEND_CONTENT_STUDIO":
      return {
        ...state,
        stage: "content_creation",
        progress: 50,
        currentTask: "Content Studio available for personalization...",
        activeAgent: "content_studio",
      };

    case "ACCEPT_CONTENT_STUDIO":
      return {
        ...state,
        useContentStudio: true,
        progress: 0,
        currentTask: "Generating personalized content...",
      };

    case "DECLINE_CONTENT_STUDIO":
      return {
        ...state,
        stage: "outreaching",
        useContentStudio: false,
        progress: 0,
        currentTask: "Preparing a campaign draft for delivery review...",
      };

    case "CONTENT_READY":
      return {
        ...state,
        stage: "content_approval",
        progress: 100,
        currentTask: "Content ready for your approval",
        contentPreview: event.payload,
      };

    case "APPROVE_CONTENT":
      return {
        ...state,
        stage: "outreaching",
        progress: 0,
        currentTask: "Preparing a campaign draft with personalized content for delivery review...",
      };

    case "REJECT_CONTENT":
      return {
        ...state,
        stage: "content_creation",
        progress: 0,
        currentTask: "Regenerating content...",
        contentPreview: undefined,
      };

    case "OUTREACH_DONE": {
      return {
        ...state,
        stage: "completed",
        progress: 100,
        currentTask: "Outreach complete!",
      };
    }

    case "OUTREACH_REVIEW_REQUIRED":
      return { ...state, campaignId: event.payload, outreachNeedsReview: true, stage: "outreach_recommendation", progress: 0, activeAgent: "outreach", currentTask: "Review recipients and sending accounts before scheduling the draft campaign." };

    case "SET_CAMPAIGN_ID":
      return {
        ...state,
        campaignId: event.payload,
      };

    case "SET_WORKFLOW_ID":
      return {
        ...state,
        workflowId: event.payload,
      };

    case "RESET":
      return initialState;

    default:
      return state;
  }
}


// Context
interface WorkflowContextType {
  state: WorkflowState;
  dispatch: React.Dispatch<WorkflowEvent>;
}

const WorkflowContext = createContext<WorkflowContextType | undefined>(undefined);

export function WorkflowProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(workflowReducer, initialState);
  const workflowApi = useWorkflowApi();
  const outreachStartInFlightRef = useRef<string | null>(null);

  // Current workflow (session) ID for tracking
  const workflowId = state.workflowId;

  // Handler for analyzing user goal
  const analyzeUserGoal = useCallback(async (prompt: string) => {
    try {
      const response = await workflowApi.analyzeGoal(prompt);
      
      // Dispatch ICP ready if returned
      if (response.icp) {
        dispatch({ type: "ICP_READY", payload: response.icp });
      }
      
      // Dispatch strategy ready if returned
      if (response.strategy) {
        dispatch({ type: "STRATEGY_READY", payload: response.strategy });
      }

      // Store workflow/session id in state if provided by server
      if ((response as { workflowId?: string }).workflowId) {
        dispatch({ type: "SET_WORKFLOW_ID", payload: (response as { workflowId?: string }).workflowId as string });
      }
    } catch (error) {
      console.error("Error analyzing goal:", error);
    }
  }, [workflowApi]);

  // Handler for starting scraping
  const handleStartScraping = useCallback(async () => {
    if (!workflowId) return;
    
    try {
      await workflowApi.startScraping(workflowId);
    } catch (error) {
      console.error("Error starting scraping:", error);
    }
  }, [workflowId, workflowApi]);

  // Poll scraping progress with exponential backoff
  const pollScrapingProgress = useCallback(async () => {
    if (!workflowId) return;
    
    try {
      const progress = await workflowApi.getScrapingProgress(workflowId);
      
      dispatch({
        type: "UPDATE_SCRAPING",
        payload: {
          channels: progress.channels,
          totalLeads: progress.totalLeads,
        },
      });

      if (progress.status === 'completed') {
        dispatch({ type: "SCRAPE_DONE" });
      }
    } catch (error) {
      console.error("Error fetching scraping progress:", error);
    }
  }, [workflowId, workflowApi]);

  // ICP Building - call API when stage changes
  useEffect(() => {
    if (state.stage === "icp_building" && state.userPrompt) {
      analyzeUserGoal(state.userPrompt);
    }
  }, [state.stage, state.userPrompt, analyzeUserGoal]);

  // Scraping execution - start and poll progress with backoff
  useEffect(() => {
    if (state.stage === "executing") {
      handleStartScraping();

      // Poll progress with exponential backoff: 2s, 4s, 8s, max 30s
      let pollInterval = 2000;
      const maxPollInterval = 30000;
      let timeoutId: NodeJS.Timeout | null = null;

      const schedulePoll = () => {
        timeoutId = setTimeout(async () => {
          await pollScrapingProgress();
          pollInterval = Math.min(pollInterval * 2, maxPollInterval);
          schedulePoll();
        }, pollInterval);
      };

      schedulePoll();

      return () => {
        if (timeoutId) clearTimeout(timeoutId);
      };
    }
  }, [state.stage, handleStartScraping, pollScrapingProgress]);

  // Outreach progress - poll from API with backoff
  useEffect(() => {
    if (state.stage === "outreaching" && state.campaignId) {
      let pollInterval = 2000;
      const maxPollInterval = 30000;
      let timeoutId: NodeJS.Timeout | null = null;

      const schedulePoll = () => {
        timeoutId = setTimeout(async () => {
          try {
            const progress = await workflowApi.getOutreachProgress(state.campaignId!) as {
              progress: number;
              status: string;
              stats: { total: number; sent: number; pending: number; failed: number };
            };
            if (progress.status === "draft" || progress.status === "needs_review") {
              dispatch({ type: "OUTREACH_REVIEW_REQUIRED", payload: state.campaignId! });
              return;
            }
            const attempted = progress.stats.sent + progress.stats.failed;
            const channelStatus: OutreachChannelProgress['status'] = progress.status === 'completed'
              ? 'completed'
              : attempted > 0 || progress.stats.pending > 0
                ? 'outreaching'
                : 'pending';

            dispatch({
              type: "UPDATE_OUTREACH",
              payload: {
                channels: [{
                  channelName: 'Email',
                  icon: 'mail',
                  status: channelStatus,
                  progress: progress.progress,
                  leadsOutreached: attempted,
                  totalLeads: progress.stats.total,
                  successRate: attempted > 0 ? (progress.stats.sent / attempted) * 100 : 0,
                }],
                totalOutreached: attempted,
              },
            });

            if (progress.status === 'completed') {
              dispatch({ type: "OUTREACH_DONE" });
              return;
            }

            pollInterval = Math.min(pollInterval * 2, maxPollInterval);
            schedulePoll();
          } catch (error) {
            console.error("Error fetching outreach progress:", error);
            pollInterval = Math.min(pollInterval * 2, maxPollInterval);
            schedulePoll();
          }
        }, pollInterval);
      };

      schedulePoll();

      return () => {
        if (timeoutId) clearTimeout(timeoutId);
      };
    }
  }, [state.stage, state.campaignId, workflowApi]);

  // When we enter the 'outreaching' stage, call API to start outreach if not already started
  useEffect(() => {
    if (state.stage === "outreaching" && workflowId && !state.campaignId) {
      const launchKey = `${workflowId}:${!!state.useContentStudio}`;

      // Effects may be replayed by React and this provider also rerenders while
      // campaign generation is in progress. Do not launch the same workflow a
      // second time before the first request has returned.
      if (outreachStartInFlightRef.current === launchKey) return;
      outreachStartInFlightRef.current = launchKey;

      (async () => {
        try {
          const result = await workflowApi.startOutreach(workflowId, !!state.useContentStudio);
          // Set campaign ID for subsequent views and tracking
          const campaignId = result.campaign_id;
          if (campaignId) {
            dispatch({ type: result.status === "needs_review" ? "OUTREACH_REVIEW_REQUIRED" : "SET_CAMPAIGN_ID", payload: String(campaignId) });
          } else {
            outreachStartInFlightRef.current = null;
          }
        } catch (error) {
          outreachStartInFlightRef.current = null;
          console.error("Failed to start outreach from client context:", error);
        }
      })();
    }
  }, [state.stage, workflowId, state.useContentStudio, state.campaignId, workflowApi]);

  return (
    <WorkflowContext.Provider value={{ state, dispatch }}>
      {children}
    </WorkflowContext.Provider>
  );
}

export function useOptionalWorkflow() {
  return useContext(WorkflowContext);
}

export function useWorkflow() {
  const context = useContext(WorkflowContext);
  if (!context) {
    throw new Error("useWorkflow must be used within WorkflowProvider");
  }
  return context;
}
