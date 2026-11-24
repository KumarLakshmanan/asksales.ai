import type { NLUResult } from '../NLUService.js';
import type { CustomerMemory, LeadIntelligence } from '../SalesIntelligence.js';
import type { AgentConfigLike } from '../../../utils/agentPromptBuilder.js';
import type { ExternalBookingHandoff, SupportEffectProposal } from '../BaseOutreachAgent.js';
import type { KnowledgeRetrievalResult } from '../../knowledge/types.js';

export interface SubAgentContext {
  /** Server-authenticated capability, never model-visible. */
  widgetSession?: { id: number; token: string };
  userId: number;
  conversationId: number;
  channel: string;
  inboundText: string;
  rawMessageId?: string | null;
  messageId?: number | null;
  nlu: NLUResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  slots: Record<string, any>;
  memory: CustomerMemory;
  intel: LeadIntelligence;
  lead: {
    id?: number | null;
    name?: string | null;
    company?: string | null;
    phone?: string | null;
    email?: string | null;
    recipientPhone?: string | null;
  };
  agentConfig: AgentConfigLike | null;
  history: Array<{ role: string; content: string }>;
  playbookDirective?: {
    playbookId: number;
    version: number;
    runId: number;
    nodeId: string;
    nodeType: string;
    requiredAction?: string;
    actionArgs?: Record<string, unknown>;
    journey?: {
      schemaVersion: 2;
      fields: Record<string, { value?: unknown; status: string; source: string; vaultRef?: number }>;
      missingFields: string[];
    };
  } | null;
  businessProfileId?: number | null;
  /** Evidence already authorized and selected by KnowledgeGateway. */
  knowledgeResult?: KnowledgeRetrievalResult;
  dryRun?: boolean;
  executionMode?: 'customer' | 'preview' | 'advisory';
  /** Server-authenticated owner simulator; permits only the explicit public
   * read allowlist while all writes and external actions remain suppressed. */
  isSupportChat?: boolean;
}

export interface SubAgentResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolResults?: Array<{ name: string; result: any }>;
  replyText?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  slotsUpdate?: Record<string, any>;
  escalated?: boolean;
  escalationReason?: string;
  escalationType?: 'sales' | 'support';
  crmPipelineStatus?: string;
  scheduleReminder?: {
    dueAt: Date;
    title: string;
    description: string;
    reminderType: string;
  };
  effectProposals?: SupportEffectProposal[];
  externalBookingHandoff?: ExternalBookingHandoff;
}

export interface SubAgentMetadata {
  id: string; // e.g., 'booking', 'negotiation'
  name: string;
  description: string;
  intents: string[]; // NLU intents this sub-agent handles
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: any[]; // OpenAI-format tools array
  priority: number; // Lower = higher priority
}

export abstract class SubAgentBase {
  abstract readonly metadata: SubAgentMetadata;
  /** Default: handle turns whose NLU intent is listed in metadata.intents. */
  canHandle(ctx: SubAgentContext): boolean {
    return this.metadata.intents.includes(ctx.nlu.intent);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abstract execute(name: string, args: any, ctx: SubAgentContext): Promise<SubAgentResult>;
}
