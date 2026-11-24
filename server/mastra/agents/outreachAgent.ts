import crypto from 'node:crypto';
import {
  addProposalCatalogItemsTool,
  createProposalDraftTool,
  createProposalRevisionTool,
  listProposalCatalogTool,
  listProposalsTool,
  listProposalTemplatesTool,
  refineProposalDraftTool,
  sendProposalTool,
} from '../tools/proposalTools.js';
/**
 * Mastra Outreach Agent — Emily
 * Migrated to extend BaseAgent (Phase 1 refactoring).
 *
 * Unique logic preserved:
 *  - buildSystemPrompt()  — Emily's full outreach system prompt
 *  - getTools()           — outreach tool registry
 *  - preProcess()         — lead count pre-check (no leads → early response)
 *  - _handleToolResult()  — track approval state for send/publish tools
 *  - _handleToolCall()    — guard premature tasks_completed
 *  - buildActionButtons() — approval, send email/IG buttons
 *
 * Backward-compatible export: runOutreachAgent(state) is still exported.
 */

import type { AgentState, ActionButton, PendingApproval } from '../state.js';
import type { AgentType } from '../state.js';
import type { ToolContext } from '../tools/toolRegistry.js';
import type { ToolCallResult } from '../utils/toolCallingLoop.js';
import { BaseAgent, hasSuccessfulWidgetContinuation, type PreProcessResult } from './BaseAgent.js';
import { sendOutreachMessagesTool } from '../tools/outreachTools.js';
import { publishSocialPostTool } from '../tools/contentTools.js';
import { crawlWebsiteTool } from '../tools/icpTools.js';
import { tasksCompletedTool, suggestSwitchAgentsTool } from '../tools/controlTools.js';
import { analyticsQueryTool, createCrmReminderTool, updatePipelineStatusTool } from '../tools/analyticsTools.js';
import {dashboardOutreachTools} from '../tools/dashboardOperationTools.js';
import {getOutreachPreparationOptionsTool,prepareOutreachCampaignTool,getPreparedOutreachTool} from '../tools/preparedOutreachTools.js';
import {createCampaignExportTool,getCampaignExportTool} from '../tools/campaignExportTools.js';
import {queryCampaignCustomersTool,queryCampaignHistoryTool} from '../tools/campaignEngagementTools.js';
import {previewOutreachRetriesTool,getOutreachRetryPreviewTool} from '../tools/outreachRetryTools.js';
import { queryLeadsTool, queryContentAssetsTool, queryOutreachCampaignsTool } from '../tools/dataQueryTools.js';
import { checkIntegrationStatusTool } from '../tools/integrationTools.js';
import { buildAgentContext } from '../utils/contextManager.js';
import { buildPipelineStatusPrompt } from '../utils/pipelinePrompt.js';
import { getToolDescriptionsForAgent } from '../tools/toolRegistry.js';
import { logger } from '../../utils/logger.js';
import { stampPendingApproval } from '../approvalExpiry.js';
import { toolHasWidget } from '../../shared/toolWidgetMap.js';
import { LeadModel } from '../../models/leads/functions.js';

// ── System Prompt ──────────────────────────────────────────────────────

function buildOutreachSystemPrompt(state: AgentState): string {
  const toolDescriptions = getToolDescriptionsForAgent('outreach');

  let prompt = `You're Emily, an outreach specialist focused on building real customer relationships. Personable, genuine, and practical.

YOUR TOOLS:
${toolDescriptions}

PREREQUISITES CHECK:
- A review widget is not execution. When the user asks to prepare or review a campaign for selected leads, infer a concise subject/body from the ICP and open send_outreach_messages immediately, even if there is no separately saved template.
- For WhatsApp, preserve the requested channel and open the shared composer for approved-template selection, media, recipient filters, scheduling and per-outreach follow-ups. Never replace a requested approved template with generated marketing copy. The composer performs the final template and recipient checks.
- Saved email/SMS templates may be reused when available, but they are not required to prepare a review.
- Provider credentials are enforced again when the approved action executes. A disconnected provider must never be described as sent or queued.

WORKFLOW:
1. Preserve exact selected lead IDs and reject an empty recipient selection
2. Reuse a saved template when appropriate, otherwise draft the subject/body from ICP context
3. Invoke send_outreach_messages to open the interactive review widget; this does not send or queue anything yet
4. Tell the user to verify recipients, copy, channel, and schedule before approval
5. Track and report on provider results only after approval and execution

PROPOSAL WORKFLOW:
- Use list_proposal_templates for real template IDs, list_proposal_catalog for stable approved service IDs, and list_proposals for real proposal IDs/revisions. Never invent any ID.
- create_proposal_draft creates customer-specific saved drafts for the selected campaign leads. It never sends them.
- Capture confirmed objectives, deliverables and exclusions, timeline, responsibilities, and budget in create_proposal_draft requirements. Never invent missing facts. After creation, ask the concise requirementQuestions returned by the tool and identify the returned sources and assumptions for seller review.
- refine_proposal_draft edits only requested text in the same draft and preserves pricing and unselected sections. Use its current revision.
- add_proposal_catalog_items appends exact approved services to a draft using the current proposal revision. Review its returned pricing before delivery.
- create_proposal_revision is required before changing a proposal that has already been sent, viewed, rejected, expired, or superseded.
- send_proposal prepares a recipient/account/content review. Its first call never sends. Tell the seller to review the proposal, customer, total, channel, provider account, subject, and message in the approval panel.
- Only the bound approval executes proposal delivery. Assigned team review can still hold delivery; never claim sent unless the tool returns status sent and a provider receipt.
- Do not call send_outreach_messages for a proposal link. Use send_proposal so readiness, customer ownership, consent, provider account, review fingerprints, and durable delivery receipts are enforced.
- A proposal is customer-specific. For multiple selected leads, create one proposal per lead; never reuse another customer's link.

GUIDELINES:
- Personalize based on ICP. Keep emails under 200 words, SMS under 160 chars.
- Include clear CTAs. Respect opt-out preferences.

MINIMIZE QUESTIONS:
- If ICP and leads available, proceed IMMEDIATELY
- NEVER re-ask about audience, channel, tone, or message style — infer from ICP and Brand Toolkit
- Only ask for genuine choices (e.g., "send to all 500 leads or test batch of 50?")

WEBSITE CRAWLING: Call crawl_website when user provides a URL. Summarize findings, do NOT auto-generate content.

DATA QUERIES:
- If the user asks about existing leads (names, emails, phone numbers, details), call the "query_leads" tool.
- If the user asks about generated content assets, templates, emails, or SMS templates, call the "query_content_assets" tool.
- For delivery receipts, responding customers, queued/failed counts, import/account/date filters or next retry times, call analytics_query with query_type="outreach". It reads the same report as the dashboard. For a list of saved campaign configurations use query_outreach_campaigns.
- Respond with a clear markdown table or list summarizing the query results.

SOCIAL PUBLISHING & SCHEDULING:
- You have the "publish_social_post" tool to publish previously generated content assets to Facebook, Instagram, YouTube, LinkedIn, or Twitter. Facebook and Instagram may be reviewed together as independent targets in the approval widget.
- To schedule a post for a future time, pass the "scheduled_for" parameter as an ISO timestamp (e.g., "2026-07-15T09:00:00Z").

INTEGRATION STATUS CHECK:
- You may call "check_integration_status" before preparing a review, but a missing integration must not prevent the review widget from being created.
- The approved execution performs a mandatory provider readiness check. If it is not integrated, report the action as blocked/failed and direct the user to Settings → Integrations; never claim it was sent or queued.

TOOL SAFETY RULES:
- NEVER call a campaign execution tool ("send_outreach_messages" or "publish_social_post") when the user is asking a question about existing data or integration status.
- If the user asks "what are the names of my leads?" → call query_leads, NOT send_outreach_messages.
- If the user asks "show me the emails we sent" → call query_outreach_campaigns, NOT send_outreach_messages.
- If the user asks "is my WhatsApp connected?" → call check_integration_status, NOT send_outreach_messages.
- When you call a tool that requires confirmation (like send_outreach_messages or publish_social_post), the system will automatically render an interactive confirmation widget below the message bubble. Tell the user they can review and submit the action directly inside that widget.

TASK COMPLETION: After all outreach work is done, ask the user: "Are you satisfied with the results, or would you like any changes?" Only call tasks_completed after the user confirms satisfaction.
NEVER call tasks_completed after planning outreach or waiting for approval. Only call it after outreach messages have actually been sent AND the user confirmed they are satisfied.

PIPELINE COMPLETION:
- When you have finished ALL outreach work AND the user is satisfied, ALWAYS call tasks_completed so the system can advance to the next agent in the pipeline.
- After calling tasks_completed, say something like: "I've completed outreach. Let me hand things over to the next agent."
- Do NOT skip tasks_completed — without it, the pipeline cannot advance.`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contextInfo = buildAgentContext(state as any, {
    userInstruction: 'Be personable and genuine, like Emily.',
    businessInstruction: 'Personalize outreach messages to this business context.',
    icpInstruction: 'Use ICP for message personalization.',
    brandLabel: 'BRAND VOICE',
    brandInstruction: 'Match brand voice in all messages.',
  });

  if (contextInfo) prompt += `\n\n--- CONTEXT ---${contextInfo}`;

  if ((state.selectedLeadIds?.length ?? 0) > 0) {
    prompt += `\n\nSELECTED RECIPIENTS:\nThe user explicitly selected these immutable lead IDs: ${state.selectedLeadIds!.join(', ')}. Use exactly these IDs for send_outreach_messages and only these IDs for customer-specific proposal creation or delivery. Do not replace them with a query result or infer recipients by name.`;
  }

  // Pipeline context
  prompt += buildPipelineStatusPrompt(state, {
    workLabel: 'outreach',
    handoffExample: nextName => `I have configured the outreach sequences and initiated the campaign for your contacts. Next up, I'll pass you to ${nextName} to track campaign results and set up performance tracking. ${nextName}, over to you!`,
  });

  return prompt;
}

// ── Lead count helpers ─────────────────────────────────────────────────

async function getThreadLeadCount(userId: number, threadId: number): Promise<number> {
  try {
    return await LeadModel.countByUserAndThread(userId, threadId);
  } catch {
    return 0;
  }
}

async function getTotalLeadCount(userId: number): Promise<number> {
  try {
    return await LeadModel.countByUser(userId);
  } catch {
    return 0;
  }
}

// ── OutreachAgent class ────────────────────────────────────────────────

class OutreachAgent extends BaseAgent {
  readonly agentType: AgentType = 'outreach';
  readonly thinkingMessage = 'Emily is preparing your outreach strategy...';
  protected readonly widgetCompletionTools = ['send_outreach_messages', 'publish_social_post'];

  // Per-run mutable state
  private _requiresApproval = false;
  private _pendingApproval: PendingApproval | null = null;
  private _hasCompletedPrimaryWork = false;

  protected get intentDomain(): string {
    return 'outreach campaigns, sending emails or SMS, or setting up follow-up sequences';
  }

  buildSystemPrompt(state: AgentState): string {
    return buildOutreachSystemPrompt(state);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTools(_toolContext: ToolContext): Record<string, any> {
    return {
      ...dashboardOutreachTools,
      create_campaign_export:createCampaignExportTool,get_campaign_export:getCampaignExportTool,
      query_campaign_customers:queryCampaignCustomersTool,query_campaign_history:queryCampaignHistoryTool,
        preview_outreach_retries:previewOutreachRetriesTool,get_outreach_retry_preview:getOutreachRetryPreviewTool,
      get_outreach_preparation_options:getOutreachPreparationOptionsTool,prepare_outreach_campaign:prepareOutreachCampaignTool,get_prepared_outreach:getPreparedOutreachTool,
      send_outreach_messages: sendOutreachMessagesTool,
      tasks_completed: tasksCompletedTool,
      suggest_switch_agents: suggestSwitchAgentsTool,
      crawl_website: crawlWebsiteTool,
      list_proposal_templates: listProposalTemplatesTool,
      list_proposal_catalog: listProposalCatalogTool,
      list_proposals: listProposalsTool,
      create_proposal_draft: createProposalDraftTool,
      refine_proposal_draft: refineProposalDraftTool,
      add_proposal_catalog_items: addProposalCatalogItemsTool,
      create_proposal_revision: createProposalRevisionTool,
      send_proposal: sendProposalTool,
      create_crm_reminder: createCrmReminderTool,
      update_pipeline_status: updatePipelineStatusTool,
      query_leads: queryLeadsTool,
      query_content_assets: queryContentAssetsTool,
      query_outreach_campaigns: queryOutreachCampaignsTool,
      analytics_query: analyticsQueryTool,
      check_integration_status: checkIntegrationStatusTool,
      publish_social_post: publishSocialPostTool,
    };
  }

  /**
   * Pre-process: reset per-run state, check lead count.
   * If no leads exist, return early with helpful buttons.
   */
  protected async preProcess(state: AgentState): Promise<PreProcessResult> {
    const { userId, threadId } = state;

    // Reset per-run state
    this._requiresApproval = false;
    this._pendingApproval = null;
    this._hasCompletedPrimaryWork = hasSuccessfulWidgetContinuation(
      state,
      this.widgetCompletionTools,
    ) || (state.toolResults || []).some(result => result.toolName === 'send_proposal' && result.success && result.output?.status === 'sent');

    // Inspecting connections, existing sends, or lead eligibility must still
    // reach the read-only tools even when this conversation has no recipients.
    // The executor validates recipients independently before any send.
    if (state.intentAnalysis?.action === 'question' || state.intentAnalysis?.semanticRequest?.dashboardOperation==='campaign_prepare') return {};

    if (state.intentAnalysis?.semanticRequest?.outreachOperation === 'proposal') return {};

    // Existing CRM/import recipients do not have to be re-owned by this
    // campaign. Selection is checked against business ownership before this
    // state is created and again by the reviewed send executor.
    if (state.selectedLeadIds?.length) return {};

    const threadLeads = await getThreadLeadCount(userId, threadId);
    const totalLeads = await getTotalLeadCount(userId);

    if (threadLeads === 0 && totalLeads === 0) {
      return {
        earlyResponse: `Hi! I'd love to help you with outreach, but I don't see any leads yet. You'll need some leads first before we can send messages. Here are your options:`,
        earlyActionButtons: [
          { id: 'hire_lead', label: '🔍 Hire Lead Agent', action: 'HIRE_LEAD_GEN', type: 'primary' as const },
          { id: 'upload_csv', label: '📤 Upload CSV', action: 'OPEN_CSV_UPLOAD', type: 'secondary' as const },
          { id: 'add_manual', label: '➕ Add Manually', action: 'OPEN_ADD_LEAD', type: 'secondary' as const },
        ],
      };
    }

    if (threadLeads === 0 && totalLeads > 0) {
      return {
        earlyResponse: `You have ${totalLeads} leads in your account, but none linked to this conversation yet. Would you like to:`,
        earlyActionButtons: [
          { id: 'select_existing', label: '📋 Select From Existing', action: 'OPEN_LEAD_SELECTOR', type: 'primary' as const },
          // Hands the request to Marcus directly; a "Hire" card is wrong when he
          // is already on this campaign's team.
          { id: 'gen_new_leads', label: '🔍 Find New Leads with Marcus', action: 'LEAD_AGENT_START', type: 'secondary' as const,
            data: { message: 'Find new leads for this campaign based on the ICP. Recommend strategies first; do not run a search yet.' } },
          { id: 'upload_csv', label: '📤 Upload CSV', action: 'OPEN_CSV_UPLOAD', type: 'secondary' as const },
        ],
      };
    }

    return {};
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected _handleToolResult(toolName: string, toolResult: any): void {
    if (toolName === 'send_outreach_messages' && toolResult.requiresApproval) {
      this._requiresApproval = true;
      this._pendingApproval = stampPendingApproval({
        toolName: 'send_outreach_messages',
        args: toolResult.output?.args || toolResult.approvalData?.args || {},
        executionId: `outreach-${Date.now()}`,
        message: toolResult.output?.message || 'Ready to send. Approve?',
      });
    }

    if (toolName === 'publish_social_post' && toolResult.requiresApproval) {
      this._requiresApproval = true;
      this._pendingApproval = stampPendingApproval({
        toolName: 'publish_social_post',
        args: toolResult.output?.args || toolResult.approvalData?.args || {},
        executionId: `publish-${Date.now()}`,
        message: toolResult.output?.message || 'Ready to publish. Approve?',
      });
    }

    if (toolName === 'send_proposal' && toolResult.requiresApproval) {
      this._requiresApproval = true;
      this._pendingApproval = stampPendingApproval({
        toolName: 'send_proposal',
        args: toolResult.output?.args || {},
        executionId: `proposal-${Date.now()}-${crypto.randomUUID()}`,
        message: toolResult.output?.message || 'Review and approve this exact proposal delivery.',
      });
    }

    if ((toolName === 'send_outreach_messages' || toolName === 'publish_social_post' || toolName === 'send_proposal') &&
        toolResult.success && !toolResult.requiresApproval) {
      this._hasCompletedPrimaryWork = true;
    }
  }

  protected _handleToolCall(toolName: string): boolean {
    if (toolName === 'tasks_completed' && !this._hasCompletedPrimaryWork) {
      logger.warn('[Outreach Agent] Blocking premature tasks_completed');
      return false;
    }
    return true;
  }

  protected buildActionButtons(_state: AgentState, toolResults: ToolCallResult[]): ActionButton[] {
    if (this._requiresApproval && this._pendingApproval?.toolName && !toolHasWidget(this._pendingApproval.toolName)) {
      return [
        { id: 'outreach_approve', label: 'Approve & Send', action: 'approve_tool', type: 'primary' as const },
        { id: 'outreach_cancel', label: 'Cancel', action: 'reject_tool', type: 'danger' as const },
      ];
    }
    if (this._requiresApproval) {
      // Widget handles approval — no chat-level buttons needed
      return [];
    }
    // Quick-send shortcuts only make sense on a plain outreach reply. After a
    // proposal, export, review card or data lookup they were unrelated noise.
    if (toolResults.length > 0) return [];
    return [
      { id: 'open_email', label: '📧 Send Email', action: 'OPEN_EMAIL_MODAL', type: 'secondary' as const },
      { id: 'open_ig_dm', label: '📸 Send Instagram DM', action: 'OPEN_INSTAGRAM_DM_MODAL', type: 'secondary' as const },
    ];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected buildReturnState(_state: AgentState, _result: any): Partial<AgentState> {
    return {
      requiresApproval: this._requiresApproval,
      pendingApproval: this._pendingApproval,
    };
  }

  protected _fallbackResponse(): string {
    return `I'm ready to help with your outreach strategy. What would you like to do?`;
  }
}

// ── Singleton instance ─────────────────────────────────────────────────


// ── Backward-compatible export ─────────────────────────────────────────

export function createOutreachAgent(): BaseAgent {
  return new OutreachAgent();
}

export async function runOutreachAgent(state: AgentState): Promise<Partial<AgentState>> {
  return createOutreachAgent().run(state);
}
