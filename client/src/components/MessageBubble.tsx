import { Sparkles, Users, Mail, Target, Edit, AlertCircle, Zap, ArrowRight, Play, Instagram, Upload, CheckCircle2 } from "lucide-react";
import Image from "next/image";
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { type Message } from "../models/message";
import { aiSetupErrorDisplay } from '../../../shared/aiSetupMessage';
import { type AgentType } from "../models/agent";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { AGENT_AVATARS, AGENT_NAMES as AGENT_NAMES_MAP, AGENT_RING_COLORS } from "@/lib/agent-personas";
import { ConversationMessageFrame } from "@/components/conversation/ConversationMessageFrame";
import { StreamingText } from "@/components/conversation/StreamingText";
import { formatTimeIST } from "@/lib/utils";
import { campaignReplyText } from "@/lib/campaign-reply-presentation";
import { useWidgets, InlineWidgetCard } from "@/components/widgets";
import { type ConversationAttachment } from "@/lib/conversation-attachments";
import { PrivateAttachmentDownload } from "@/components/storage/PrivateAttachmentDownload";
import {ChatOperationResults} from '@/components/operations/ChatOperationResults';
import {
  isOneShotConversationAction,
  type ConversationActionResolution,
} from "@/lib/conversation-action-resolution";

/** Chat tables scroll sideways inside a framed surface instead of breaking
 * words letter by letter (emails, job titles) to fit a narrow bubble. */
const chatMarkdownComponents: Components = {
  table: ({ node: _node, ...props }) => (
    <div className="not-prose my-3 max-w-full overflow-x-auto rounded-lg border border-border bg-card" role="region" aria-label="Table" tabIndex={0}>
      <table {...props} className="w-full border-collapse text-left text-[13px] leading-snug [overflow-wrap:normal]" />
    </div>
  ),
  thead: ({ node: _node, ...props }) => <thead {...props} className="bg-muted/60" />,
  th: ({ node: _node, ...props }) => <th {...props} className="whitespace-nowrap border-b border-border px-3 py-2 text-xs font-semibold text-foreground" />,
  td: ({ node: _node, ...props }) => <td {...props} className="max-w-[18rem] border-b border-border/60 px-3 py-2 align-top text-foreground [overflow-wrap:normal] [&_a]:whitespace-nowrap [&_a]:break-normal" />,
  tr: ({ node: _node, ...props }) => <tr {...props} className="last:[&>td]:border-b-0" />,
};

function formatTime(timestamp: number): string {
  if (!timestamp) return '';
  return formatTimeIST(timestamp);
}

/** Strip raw function call text that some models emit instead of native tool calling */
function stripFunctionCallXml(text: string): string {
  return text
    .replace(/<FunctionCallBegin>[\s\S]*?<\/?\s*FunctionCallEnd\s*>/gi, '')
    .replace(/<FunctionCall>[\s\S]*?<\/FunctionCall>/gi, '')
    .replace(/struct\s+Tool\s*\{[\s\S]*?\}\s*\}/gi, '')
    .replace(/\{\s*"?tool"?\s*:\s*"[^"]+"\s*,\s*"?args"?\s*:\s*\{[\s\S]*?\}\s*\}/g, '')
    .replace(/<\/?FunctionCall[^>]*>/gi, '')
    .replace(/<\/?FunctionCallBegin[^>]*>/gi, '')
    .replace(/<\/?FunctionCallEnd[^>]*>/gi, '')
    .replace(/<\/?function_call[^>]*>/gi, '')
    .replace(/<\/?tool_call[^>]*>/gi, '')
    .replace(/<\/?tool_name[^>]*>/gi, '')
    .replace(/<param\s+name="[^"]*">[^<]*<\/param>/gi, '')
    .trim();
}
// Action button interface matching server definition
interface ChatActionButton {
  id: string;
  label: string;
  action: string;
  type: 'primary' | 'secondary' | 'outline' | 'danger';
  icon?: string;
  data?: Record<string, unknown>;
}



interface MessageBubbleProps {
  message: Message;
  onActionClick?: (
    action: string,
    data?: Record<string, unknown>,
    context?: { sourceMessageId: string; buttonId: string; oneShot: boolean },
  ) => void | Promise<void>;
  isLastMessage?: boolean;
  actionResolution?: ConversationActionResolution;
  displayContent?: string;
}

// Map agent types to avatar images — from centralized agent-personas
const agentAvatars = AGENT_AVATARS as Record<AgentType, string>;

const agentNames = AGENT_NAMES_MAP as Record<AgentType, string>;

// Tailwind class pairs (light + dark) per agent — from centralized agent-personas
const agentRingColors = AGENT_RING_COLORS as Record<AgentType, string>;

// Icon mapping for action buttons
const actionIcons: Record<string, React.ReactNode> = {
  sparkles: <Sparkles className="w-4 h-4" />,
  users: <Users className="w-4 h-4" />,
  mail: <Mail className="w-4 h-4" />,
  target: <Target className="w-4 h-4" />,
  edit: <Edit className="w-4 h-4" />,
};

function getActionPresentation(button: ChatActionButton) {
  const actionText = `${button.action} ${button.label}`.toLowerCase();
  const label = button.label.replace(/^[^\p{L}\p{N}]+/u, '').trim() || button.label;

  if (actionText.includes('instagram')) {
    return { label, icon: <Instagram className="h-4 w-4" aria-hidden="true" /> };
  }
  if (actionText.includes('email')) {
    return { label, icon: <Mail className="h-4 w-4" aria-hidden="true" /> };
  }
  if (actionText.includes('upload')) {
    return { label, icon: <Upload className="h-4 w-4" aria-hidden="true" /> };
  }

  return { label, icon: button.icon ? actionIcons[button.icon] : null };
}

export default function MessageBubble({
  message,
  onActionClick,
  isLastMessage = false,
  actionResolution = { status: "pending" },
  displayContent,
}: MessageBubbleProps) {
  const { getWidgetByMessageId } = useWidgets();

  // Check if this message has an associated widget
  const widgetMessageId = message.metadata?.widgetMessageId as number | undefined;
  const associatedWidget = widgetMessageId ? getWidgetByMessageId(widgetMessageId) : null;
  const attachments = Array.isArray(message.metadata?.attachments)
    ? (message.metadata.attachments as ConversationAttachment[]).filter((attachment) =>
        Number.isSafeInteger(Number(attachment?.fileId)) &&
        typeof attachment?.name === 'string' &&
        Number(attachment?.size) >= 0
      )
    : [];

  if (message.role === "user") {
    return (
      <ConversationMessageFrame
        role="user"
        surface="campaign"
        className="mb-4"
        ariaLabel={`You: ${message.content?.slice(0, 100)}`}
        testId={`message-user-${message.id}`}
        footer={<span className="pr-1 text-[10px] tabular-nums text-muted-foreground">{formatTime(message.timestamp)}</span>}
      >
        <p className="break-words whitespace-pre-wrap text-[14px] font-medium leading-relaxed [overflow-wrap:anywhere]">{message.content}</p>
        {attachments.length > 0 ? (
          <div className="mt-3 space-y-1.5 border-t border-white/20 pt-2.5" aria-label="Message attachments">
            {attachments.map((attachment) => (
              <PrivateAttachmentDownload key={attachment.fileId} attachment={attachment} />
            ))}
          </div>
        ) : null}
      </ConversationMessageFrame>
    );
  }

  if (message.role === "system") {
    const isError = message.metadata?.isError === true;

    // Hide non-error system messages (e.g. "Generated workflow inputs for ...")
    if (!isError) {
      return null;
    }

    if (isError) {
      const content = aiSetupErrorDisplay(message.content || '');
      const isCreditError = /credit|insufficient|balance|recharge|wallet|payment/i.test(content);

      return (
        <div className="flex justify-start" data-testid={`message-system-error-${message.id}`}>
          <div role="listitem" aria-label={`System error: ${content.slice(0, 100)}`} className="flex items-start gap-3 max-w-2xl">
            <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/30 ring-2 ring-amber-300 dark:ring-amber-700 flex items-center justify-center flex-shrink-0">
              <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex flex-col gap-2 px-4 py-3 rounded-2xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-sm">
                <span className="text-amber-900 dark:text-amber-100">{content}</span>
                {isCreditError && (
                  <a
                    href="/dashboard/billing/recharge"
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary underline-offset-2 transition-colors hover:text-primary hover:underline"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    Recharge Credits
                  </a>
                )}
              </div>
              <span className="text-[10px] text-gray-400 dark:text-gray-500 pl-1">{formatTime(message.timestamp)}</span>
            </div>
          </div>
        </div>
      );
    }
  }

  // Check if this is a transition message
  const isTransition = message.metadata?.isTransition === true;

  // Render transition as a seamless pill-style divider
  if (isTransition) {
    const toAgent = message.metadata?.toAgent as string || '';
    const toAgentName = message.metadata?.toAgentName as string || agentNames[toAgent as AgentType] || toAgent;
    const isTeamAssembled = message.metadata?.isTeamAssembled === true;

    const toAgentAvatar = agentAvatars[toAgent as AgentType] || '';
    const toAgentRingColor = agentRingColors[toAgent as AgentType] || '#b48cf2';

    if (isTeamAssembled) {
      const pipelineAgents = (message.metadata?.pipelineAgents as string[]) || [];
      return (
        <div className="my-3 flex justify-center" data-testid={`message-transition-${message.id}`}>
          <div className="px-3.5 py-1.5 bg-secondary/40 border border-border/30 rounded-full shadow-sm text-[11px] font-semibold text-muted-foreground/80 flex items-center gap-2">
            <div className="flex -space-x-1.5">
              {pipelineAgents.slice(0, 4).map((agent) => {
                const avatar = agentAvatars[agent as AgentType] || '';
                const ringColor = agentRingColors[agent as AgentType] || '#b48cf2';
                const name = agentNames[agent as AgentType] || agent;
                return avatar ? (
                  <div key={agent} className="w-5 h-5 rounded-full overflow-hidden ring-1.5 ring-background flex-shrink-0" style={{ backgroundColor: `${ringColor}80` }}>
                    <Image src={avatar} alt={name} width={20} height={20} className="h-full w-full object-contain" />
                  </div>
                ) : null;
              })}
            </div>
            <span>Pipeline assembled: {pipelineAgents.map(a => agentNames[a as AgentType] || a.replace('_', ' ')).join(' → ')}</span>
          </div>
        </div>
      );
    }

    if (toAgent === 'icp_generation') {
      return null;
    }
    
    return (
      <div className="my-3 flex justify-center" data-testid={`message-transition-${message.id}`}>
        <div className="px-3.5 py-1.5 bg-secondary/40 border border-border/30 rounded-full shadow-sm text-[11px] font-semibold text-muted-foreground/80 flex items-center gap-2">
          {toAgentAvatar && (
            <div className="w-5 h-5 rounded-full overflow-hidden ring-1.5 ring-background flex-shrink-0" style={{ backgroundColor: `${toAgentRingColor}80` }}>
              <Image src={toAgentAvatar} alt={toAgentName} width={20} height={20} className="h-full w-full object-contain" />
            </div>
          )}
          <span>{message.metadata?.readOnlyHandoff === true ? `Asking ${toAgentName}` : `${toAgentName} assigned to campaign`}</span>
        </div>
      </div>
    );
  }

  // Agent message (role: "assistant" or "agent")
  // Validate agentType against known types; default to orchestrator for invalid values
  const validAgentTypes = new Set<string>(['orchestrator', 'supervisor', 'icp_generation', 'lead_generation', 'content_studio', 'outreach', 'performance_marketing']);
  const effectiveAgentType = (message.agentType && validAgentTypes.has(message.agentType))
    ? message.agentType as AgentType
    : 'orchestrator' as AgentType;
  const avatarSrc = agentAvatars[effectiveAgentType] || agentAvatars.orchestrator;
  const agentName = agentNames[effectiveAgentType] || "AskSales.AI";
  const agentInitials = agentName.split(' ').map((n: string) => n[0]).join('').substring(0, 2).toUpperCase();

  // Use message content directly — strip raw XML function call artifacts from models
  const cleanContent = campaignReplyText(stripFunctionCallXml(displayContent ?? message.content ?? ''), effectiveAgentType);
  const isStreaming = message.metadata?.streaming === true && message.metadata?.streamingComplete !== true;

  // Get action buttons from metadata
  const storedActionButtons = (message.metadata?.actionButtons as ChatActionButton[]) || [];
  // Recover old approval messages whose selected team produced no hire buttons.
  // This only opens a UI view; never infer or launch an agent from message prose.
  const actionButtons: ChatActionButton[] = storedActionButtons.length === 0 && message.metadata?.workflowStage === 'agent_selection'
    ? [{ id: 'choose_agent', label: 'Choose agent', action: 'OPEN_TAB', type: 'secondary', data: { tabType: 'agentchoose' } }]
    : storedActionButtons;
  const selectedActionButton = actionResolution.status !== "pending" && actionResolution.status !== "superseded"
    ? actionButtons.find((button) => button.id === actionResolution.selectedButtonId)
    : undefined;

  const isImportantActionButton = actionButtons.some(btn =>
    btn.action?.includes('SWITCH') || 
    btn.action?.includes('IMPROVE') ||
    btn.action?.includes('BUSINESS') ||
    btn.action?.includes('SELECT') ||
    btn.action?.includes('SAVE') ||
    btn.action?.includes('EDIT') ||
    btn.action?.includes('ICP') ||
    btn.action?.includes('HIRE') ||
    btn.action?.includes('CAMPAIGN') ||
    btn.action?.includes('CONTINUE_PIPELINE') ||
    btn.action?.includes('CONTENT') ||
    btn.action?.includes('GENERATE') ||
    btn.action?.includes('TOOLKIT') ||
    btn.action?.includes('SKIP') ||
    btn.action?.includes('CREATE') ||
    btn.action?.includes('LEAD') ||
    btn.action?.includes('OUTREACH') ||
    btn.action?.includes('APPROVE') ||
    btn.action?.includes('REJECT') ||
    btn.action?.includes('OPEN') ||
    // Lowercase action types from agent buttons
    btn.action === 'approve_tool' ||
    btn.action === 'reject_tool' ||
    btn.action === 'publish_ad' ||
    btn.action === 'export_ad' ||
    btn.action === 'generate_more' ||
    btn.action === 'analytics_query'
  );
  // Show buttons on last message always if there are any; also show on non-last messages if they have important action buttons
  const showActionButtons =
    actionResolution.status === "pending" &&
    actionButtons.length > 0 &&
    onActionClick &&
    (isLastMessage || isImportantActionButton);

  return (
    <div className="mb-6 min-w-0 max-w-full">
      <ConversationMessageFrame
        role="assistant"
        surface="campaign"
        name={agentName}
        timestamp={formatTime(message.timestamp)}
        avatar={avatarSrc}
        initials={agentInitials}
        accentColor={agentRingColors[effectiveAgentType] || "#b48cf2"}
        statusLabel={isStreaming ? "Responding" : undefined}
        ariaLabel={`${agentName}: ${cleanContent.slice(0, 120)}`}
        testId={`message-agent-${message.id}`}
      >
        <StreamingText active={isStreaming} className="prose prose-sm min-w-0 max-w-full break-words dark:prose-invert prose-p:leading-relaxed prose-pre:max-w-full prose-pre:overflow-x-auto prose-pre:bg-black/50 prose-pre:backdrop-blur-md [&_a]:break-all [overflow-wrap:anywhere]">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={chatMarkdownComponents}>
              {cleanContent}
            </ReactMarkdown>
        </StreamingText>

        {message.metadata?.operationResults && <ChatOperationResults results={message.metadata.operationResults}/>}
        {associatedWidget && associatedWidget.status !== "cancelled" ? (
          <InlineWidgetCard widget={associatedWidget} />
        ) : null}
      </ConversationMessageFrame>

      <div className="min-w-0 max-w-full @md/chat:ml-10">
          {selectedActionButton ? (() => {
            const presentation = getActionPresentation(selectedActionButton);
            const isProcessingAction = actionResolution.status === "processing";
            const isFailedAction = actionResolution.status === "failed_retryable";
            const outcome = actionResolution.status !== "pending" && actionResolution.status !== "superseded"
              ? actionResolution.outcome
              : undefined;
            const selectedLabel = outcome === "approved"
              ? selectedActionButton.action === 'APPROVE_ICP' ? 'ICP approved' : 'Approved'
              : outcome === "rejected"
                ? "Rejected"
                : /recommended/i.test(presentation.label)
                  ? "Recommended strategy selected"
                  : `${presentation.label} selected`;
            return (
              <div
                role="status"
                aria-label={isFailedAction ? `${presentation.label} failed` : selectedLabel}
                data-testid={`action-selection-${message.id}`}
                className={`mt-3 max-w-full rounded-lg border px-3 py-2 text-sm font-medium ${isFailedAction ? 'border-destructive/30 bg-destructive/10 text-destructive' : isProcessingAction ? 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'}`}
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {isProcessingAction ? <Spinner size="sm" label={null} /> : isFailedAction ? <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />}
                  <span className="break-words [overflow-wrap:anywhere]">{isFailedAction ? (actionResolution.failure || "The action was not accepted.") : selectedLabel}</span>
                  {!isProcessingAction && !isFailedAction ? (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide">Selected</span>
                  ) : null}
                </div>
                {isFailedAction ? (
                  <button
                    type="button"
                    onClick={() => onActionClick?.(selectedActionButton.action, selectedActionButton.data, {
                      sourceMessageId: message.id,
                      buttonId: selectedActionButton.id,
                      oneShot: true,
                    })}
                    className="mt-2 inline-flex min-h-8 items-center rounded-md border border-destructive/30 bg-background px-3 text-xs font-semibold text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            );
          })() : null}
          {showActionButtons && (() => {
            const hireButtons = actionButtons.filter(btn => btn.action?.startsWith('HIRE_'));
            const nonHireButtons = actionButtons.filter(btn => !btn.action?.startsWith('HIRE_'));
            // A long strategy catalog reads as a compact row of choices, not a wall of large buttons.
            const strategyButtons = nonHireButtons.filter(btn => btn.action === 'LEAD_AGENT_USE_WORKFLOW' && typeof (btn.data as { workflowId?: unknown } | undefined)?.workflowId === 'string');
            const compactStrategies = strategyButtons.length >= 4;
            const otherButtons = compactStrategies ? nonHireButtons.filter(btn => !strategyButtons.includes(btn)) : nonHireButtons;
            const agentScores = message.metadata?.recommendedAgentScores as Record<string, number> | undefined;
            const hireScoreKey: Record<string, string> = { HIRE_LEAD_GEN: 'lead_generation', HIRE_CONTENT_STUDIO: 'content_studio', HIRE_OUTREACH: 'outreach', HIRE_PERFORMANCE: 'performance_marketing' };
            const showGroupedHire = hireButtons.length >= 2;

            // Agent flow ordering
            const agentFlowOrder: Record<string, number> = {
              'HIRE_LEAD_GEN': 1,
              'HIRE_CONTENT_STUDIO': 2,
              'HIRE_OUTREACH': 3,
              'HIRE_PERFORMANCE': 4,
            };
            const agentFlowInfo: Record<string, { name: string; avatar: string; ringColor: string; role: string }> = {
              'HIRE_LEAD_GEN': { name: 'Marcus', avatar: '/agent-avatars/leadagent.png', ringColor: '#6ee7b7', role: 'Lead Generation Specialist' },
              'HIRE_CONTENT_STUDIO': { name: 'Alex', avatar: '/agent-avatars/content-studio.png', ringColor: '#fdba74', role: 'Content Expert' },
              'HIRE_OUTREACH': { name: 'Emily', avatar: '/agent-avatars/outreach.png', ringColor: '#93c5fd', role: 'Outreach Coordinator' },
              'HIRE_PERFORMANCE': { name: 'Sarah', avatar: '/agent-avatars/performance.png', ringColor: '#fca5a5', role: 'Performance Marketing Manager' },
            };
            // ICP match scores order the server's choices; keep that order when present.
            const sortedHireButtons = agentScores ? hireButtons : [...hireButtons].sort(
              (a, b) => (agentFlowOrder[a.action] || 99) - (agentFlowOrder[b.action] || 99)
            );

            return (
              <div className="space-y-2 mt-3">
                {showGroupedHire ? (
                  <div className="grid min-w-0 gap-2 @lg/chat:grid-cols-2" aria-label="Choose your next agent">
                      {sortedHireButtons.map((btn) => {
                        const info = agentFlowInfo[btn.action];
                        const presentation = getActionPresentation(btn);
                        const score = Math.round(Number(agentScores?.[hireScoreKey[btn.action]]) || 0);
                        const best = score > 0 && btn === sortedHireButtons[0];
                        return (
                          <button
                            key={btn.id}
                            type="button"
                            onClick={() => onActionClick(btn.action, btn.data, { sourceMessageId: message.id, buttonId: btn.id, oneShot: isOneShotConversationAction(btn) })}
                            className={`flex min-w-0 items-center gap-3 rounded-xl border p-3 text-left transition-colors hover:border-primary/60 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${best ? 'border-primary/50 bg-primary/5' : 'border-border bg-muted/35'}`}
                          >
                            {info ? <Image src={info.avatar} alt="" width={32} height={32} className="h-8 w-8 shrink-0 rounded-full object-contain" /> : <Users className="h-5 w-5 shrink-0" aria-hidden="true" />}
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-semibold [overflow-wrap:anywhere]">{info ? `Choose ${info.name}` : presentation.label}</span>
                              {info ? <span className="mt-0.5 block text-xs text-muted-foreground [overflow-wrap:anywhere]">{info.role}</span> : null}
                            </span>
                            {score > 0 ? (
                              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${best ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                                {best ? `Best match · ${score}%` : `${score}%`}
                              </span>
                            ) : null}
                            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                          </button>
                        );
                      })}
                  </div>
                ) : (
                  (() => {
                    // Single hire button with agent card style
                    if (hireButtons.length === 1 && agentFlowInfo[hireButtons[0].action]) {
                      const btn = hireButtons[0];
                      const info = agentFlowInfo[btn.action];
                      return (
                        <div className="rounded-xl border border-border bg-muted/35 p-3">
                          <div className="flex items-center gap-3 mb-3">
                            <div className="w-10 h-10 rounded-full overflow-hidden ring-2 flex-shrink-0" style={{ '--tw-ring-color': info.ringColor, backgroundColor: `${info.ringColor}40` } as React.CSSProperties}>
                              <img src={info.avatar} alt={info.name} className="w-full h-full object-contain" />
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{info.name}</p>
                              <p className="text-xs text-muted-foreground">{info.role}</p>
                            </div>
                          </div>
                          <Button
                            size="sm"
                            onClick={() => onActionClick(btn.action, btn.data, { sourceMessageId: message.id, buttonId: btn.id, oneShot: isOneShotConversationAction(btn) })}
                            className="w-full bg-[#B48CF2] hover:bg-[#a875ee] text-white font-medium rounded-lg px-4 py-2.5 shadow-sm"
                          >
                            <Users className="w-4 h-4 mr-2" />
                            Hire {info.name}
                            <Play className="w-3.5 h-3.5 ml-2 fill-current" />
                          </Button>
                        </div>
                      );
                    }
                    // Fallback: plain buttons
                    return (
                      <div className="flex flex-wrap gap-2">
                        {hireButtons.map((button) => {
                          const presentation = getActionPresentation(button);
                          return (
                            <button
                              key={button.id}
                              onClick={() => onActionClick(button.action, button.data, { sourceMessageId: message.id, buttonId: button.id, oneShot: isOneShotConversationAction(button) })}
                              className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                                button.type === 'primary'
                                  ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
                                  : button.type === 'danger'
                                  ? 'border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90'
                                  : 'border-border bg-secondary text-secondary-foreground hover:bg-secondary/80'
                              }`}
                            >
                              {presentation.icon}
                              <span>{presentation.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    );
                  })()
                )}
                {compactStrategies && (
                  <div className="space-y-1.5" role="group" aria-label="Choose a strategy">
                    <p className="text-xs font-medium text-muted-foreground">Prepare search settings for</p>
                    <div className="flex flex-wrap gap-1.5">
                      {strategyButtons.map((button) => (
                        <button
                          key={button.id}
                          type="button"
                          onClick={() => onActionClick(button.action, button.data, { sourceMessageId: message.id, buttonId: button.id, oneShot: isOneShotConversationAction(button) })}
                          className="inline-flex min-h-8 items-center rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-foreground transition-colors hover:border-primary/60 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {button.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {otherButtons.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {otherButtons.map((button) => {
                      const presentation = getActionPresentation(button);
                      return (
                        <button
                          key={button.id}
                          onClick={() => onActionClick(button.action, button.data, { sourceMessageId: message.id, buttonId: button.id, oneShot: isOneShotConversationAction(button) })}
                          className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                            button.type === 'primary'
                              ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
                              : button.type === 'danger'
                              ? 'border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90'
                              : 'border-border bg-secondary text-secondary-foreground hover:bg-secondary/80'
                          }`}
                        >
                          {presentation.icon}
                          <span>{presentation.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}
      </div>
    </div>
  );
}
