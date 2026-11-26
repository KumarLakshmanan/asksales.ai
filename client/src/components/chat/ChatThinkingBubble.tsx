import type { AgentStatus } from "@/models/agentStatus";
import type { Message } from "@/models/message";
import { ToolCallChip } from "@/components/conversation/ToolCallChip";
import { collapseToolExecutionMessages } from "@/lib/tool-message-pairing";
import type { ConversationActivityStep } from "@/components/conversation/types";
import { AGENT_AVATAR_INFO, getPersona } from "@/lib/agent-personas";
import { readableToolName } from "@/lib/readableToolName";

/** Tool execution log entry */
export interface ToolLogEntry {
  id: string;
  toolName: string;
  toolCallId?: string;
  status: 'started' | 'completed' | 'failed' | 'gated';
  agentType?: string;
  args?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
  timestamp: number;
}

/** Map of agent types to display names, avatar paths, and ring colors */
const AGENT_INFO = AGENT_AVATAR_INFO;

/** Friendly display names for tool names */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  generate_icp: "Generating ICP Profile",
  crawl_website: "Crawling Website",
  save_business_profile: "Saving Business Profile",
  generate_lead_inputs: "Generating Lead Inputs",
  execute_lead_workflow: "Running Lead Workflow",
  select_brand_toolkit: "Loading Brand Toolkit",
  generate_image: "Generating Image",
  generate_video: "Generating Video",
  generate_social_media_post: "Creating Social Post",
  generate_social_chat_template: "Creating Chat Template",
  generate_email_template: "Creating Email Template",
  generate_sms_template: "Creating SMS Template",
  send_outreach_messages: "Sending Outreach Messages",
  list_proposal_templates: "Loading Proposal Templates",
  list_proposal_catalog: "Loading Approved Services",
  list_proposals: "Loading Proposals",
  create_proposal_draft: "Creating Proposal Draft",
  refine_proposal_draft: "Refining Proposal Draft",
  add_proposal_catalog_items: "Adding Approved Services",
  create_proposal_revision: "Creating Proposal Revision",
  send_proposal: "Preparing Proposal Delivery",
  generate_ad: "Generating Ad",
  publish_meta_ads: "Publishing Meta Ads",
  analytics_query: "Querying Analytics",
  switch_agent: "Switching Agent",
};

/** Map display agent name back to agent type key */
const NAME_TO_TYPE: Record<string, string> = {
  Marcus: "lead_generation",
  "Alex Chen": "content_studio",
  Alex: "content_studio",
  Emily: "outreach",
  "Sarah Martinez": "performance_marketing",
};

interface ChatThinkingBubbleProps {
  messages: Message[];
  activeAgent?: AgentStatus | null;
  displaySelectedAgentName?: string | null;
  isDarkMode: boolean;
  toolLogs?: ToolLogEntry[];
}

/** Format tool args into a compact display string */
function formatToolArgs(args: Record<string, unknown>): string | null {
  const entries = Object.entries(args).filter(
    ([, v]) => v !== undefined && v !== null && v !== ''
  );
  if (entries.length === 0) return null;
  const parts = entries.slice(0, 4).map(([key, val]) => {
    const display = typeof val === 'string'
      ? (val.length > 30 ? val.substring(0, 30) + '…' : val)
      : Array.isArray(val) ? `[${val.length} items]`
      : typeof val === 'object' ? '{…}'
      : String(val);
    return `${key}: ${display}`;
  });
  return parts.join(', ') + (entries.length > 4 ? ', …' : '');
}

export function ChatThinkingBubble({
  messages,
  activeAgent,
  displaySelectedAgentName,
  isDarkMode: _isDarkMode,
  toolLogs = [],
}: ChatThinkingBubbleProps) {
  // Find the last assistant/agent message (not user message, not transition)
  const lastAgentMessage = messages
    .slice()
    .reverse()
    .find((msg) => msg.role === "assistant" && !msg.metadata?.isTransition);

  let currentAgentType = "orchestrator";

  // Priority 1: Active agent from WebSocket
  if (activeAgent?.agentType) {
    currentAgentType = activeAgent.agentType;
  }
  // Priority 2: Selected agent from UI
  else if (displaySelectedAgentName) {
    currentAgentType = NAME_TO_TYPE[displaySelectedAgentName] || "orchestrator";
  }
  // Priority 3: Last agent message
  else if (lastAgentMessage?.agentType) {
    currentAgentType = lastAgentMessage.agentType;
  }

  const agent = AGENT_INFO[currentAgentType] || AGENT_INFO["orchestrator"];
  const persona = getPersona(currentAgentType);

  // Tool/workflow accordions already own progress for their current turn.
  // Do not repeat it in a second live activity card. Ignore historical turns
  // and other agents so a previous search cannot hide a new agent's work.
  const lastUserIndex = messages.findLastIndex(message => message.role === 'user');
  const currentMessages = collapseToolExecutionMessages(messages.slice(lastUserIndex + 1));
  const hasProgressOwner = currentMessages.some(message => {
    if (message.agentType && message.agentType !== currentAgentType) return false;
    const meta = message.metadata || {};
    if (meta.streaming && !meta.streamingComplete) return true;
    if (meta.isToolCall && !meta.isToolResult) return true;
    if (meta.isToolResult && ['running', 'queued', 'provider_succeeded'].includes(String(meta.widgetStatus))) return true;
    return Boolean((meta.isWorkflowStart || meta.isWorkflowStep)
      && !meta.isWorkflowComplete && !meta.isWorkflowError && meta.progress !== 100
      && !currentMessages.some(later => later.timestamp >= message.timestamp
        && (later.metadata?.isWorkflowComplete || later.metadata?.isWorkflowError)));
  });
  if (hasProgressOwner) return null;

  const currentTask = activeAgent?.currentTask;

  const logsByTool = new Map<string, ToolLogEntry>();
  for (const log of toolLogs) {
    const existing = logsByTool.get(log.toolCallId || log.id);
    if (!existing || log.timestamp >= existing.timestamp) logsByTool.set(log.toolCallId || log.id, log);
  }
  const deduplicatedLogs = Array.from(logsByTool.values());

  const steps: ConversationActivityStep[] = deduplicatedLogs.map((log) => {
    const agentLabel = log.agentType ? (AGENT_INFO[log.agentType]?.name || log.agentType) : null;
    const toolLabel = TOOL_DISPLAY_NAMES[log.toolName] || readableToolName(log.toolName);
    const argsDisplay = log.args ? formatToolArgs(log.args) : null;
    return {
      id: log.id,
      label: agentLabel && agentLabel !== agent.name ? `${agentLabel} · ${toolLabel}` : toolLabel,
      detail: log.status === "failed" ? log.error : argsDisplay || undefined,
      status: log.status === "started" ? "running" : log.status,
      durationMs: log.durationMs,
    };
  });

  if (currentTask && !steps.some((step) => step.status === "running" && step.label === currentTask)) {
    steps.push({ id: "current-task", label: currentTask, status: "running" });
  }

  const status = activeAgent?.status === "error"
    ? "failed"
    : activeAgent?.status === "completed"
      ? "completed"
      : "running";
  const elapsed = activeAgent?.timeElapsed != null ? `${activeAgent.timeElapsed.toFixed(1)}s` : undefined;

  return (
    <div data-testid="text-processing">
      <ToolCallChip agentName={agent.name} label={currentTask || "Thinking through the next step"} status={status} duration={elapsed}>
        <div className="space-y-2 p-3">
          <p className="text-muted-foreground">{persona.role}</p>
          <p>{currentTask || "Preparing the next step."}</p>
          {steps.filter(step => step.id !== 'current-task' && !currentMessages.some(message => message.metadata?.toolName === toolLogs.find(log => log.id === step.id)?.toolName)).map(step => (
            <p key={step.id}>{step.label}{step.detail ? ` — ${step.detail}` : ''}</p>
          ))}
        </div>
      </ToolCallChip>
    </div>
  );
}
