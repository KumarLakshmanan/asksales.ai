/**
 * Mastra Approval Handlers
 * Extracted from langgraph/nodes/{leadAgent,outreachAgent,performanceAgent}.ts
 * Replaces AIMessage with plain { role, content } objects.
 */

 
import type { AgentState, ActionButton } from './state.js';
import type { ToolContext } from './tools/toolRegistry.js';
import { executeLeadWorkflow } from './tools/executors/leadExecutor.js';
import { executeSendOutreachMessages } from './tools/executors/outreachExecutor.js';
import { executeApprovedProposalDelivery } from './tools/proposalTools.js';
import { executePublishMetaAds, executePublishGoogleAds } from './tools/executors/adsExecutor.js';
import { executePublishSocialPost } from './tools/executors/contentExecutor.js';
import { webSocketEmitter } from '../services/agents/WebSocketEmitter.js';
import { createChatMessage } from '../models/chatMessages/functions.js';
import { TAB_TYPES, TAB_LABELS } from './tabConfig.js';
import { isRateLimitError } from '../services/agents/LLMProviderFactory.js';
import { logger } from '../utils/logger.js';
import { isCurrentIcpRevisionApproved } from '../models/conversationWorkflow/stateMachine.js';

// ── isIcpComplete ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isIcpComplete(icpProfile: any): boolean {
  if (!icpProfile) return false;
  return (icpProfile.fitScore || 0) >= 50 && isCurrentIcpRevisionApproved(icpProfile);
}

// ── Lead Workflow Approval ─────────────────────────────────────────────

export async function handleLeadWorkflowApproval(
  state: AgentState,
  approved: boolean,
): Promise<Partial<AgentState>> {
  if (
    !state.pendingApproval ||
    state.pendingApproval.toolName !== 'execute_lead_workflow'
  ) {
    return {
      messages: [{ role: 'assistant', content: 'No pending lead workflow to approve.' }],
      requiresApproval: false,
      pendingApproval: null,
    };
  }

  if (!approved) {
    return {
      messages: [
        {
          role: 'assistant',
          content:
            "No problem! Let me know when you're ready to search for leads, or if you'd like to adjust the search parameters first.",
        },
      ],
      requiresApproval: false,
      pendingApproval: null,
      actionButtons: [],
    };
  }

  const toolContext: ToolContext = {
    userId: Number(state.userId),
    threadId: Number(state.threadId),
    icpProfile: state.icpProfile,
    brandToolkit: state.brandToolkit,
    leadInputs: state.leadInputs,
    selectedWorkflows: state.selectedWorkflows || [],
    runContext: state.runContext,
    workflowId: state.runContext?.runId,
  };

  try {
    let platforms: string[] = state.pendingApproval.args?.platforms || [];
    if (platforms.length === 0 && !state.pendingApproval.args?.leadInputSetId && state.leadInputs && Array.isArray(state.leadInputs) && state.leadInputs.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      platforms = state.leadInputs.map((li: any) => li.platform).filter(Boolean);
    }
    if (platforms.length === 0 && state.pendingApproval.args?.platforms) {
      platforms = state.pendingApproval.args.platforms;
    }

    const workflowArgs = {
      ...state.pendingApproval.args,
      platforms,
      selected_workflows: state.pendingApproval.args?.selected_workflows || state.selectedWorkflows || [],
    };

    logger.info(
      { platforms, selectedWorkflows: state.selectedWorkflows },
      '[handleLeadWorkflowApproval] Executing workflow',
    );

    const leadToolStartTime = Date.now();
    webSocketEmitter.emitToolExecution(Number(state.userId), Number(state.threadId), {
      toolName: 'execute_lead_workflow',
      args: workflowArgs,
      status: 'started',
      agentType: 'lead_generation',
    });

    // Persist tool call to chat
    try {
      await createChatMessage({
        userId: Number(state.userId),
        threadId: Number(state.threadId),
        role: 'assistant',
        content: '🔧 execute_lead_workflow',
        agentType: 'lead_generation',
        metadata: { isToolCall: true, toolName: 'execute_lead_workflow', toolArgs: workflowArgs },
      });
      webSocketEmitter.emitChatResponse(Number(state.userId), Number(state.threadId), {
        role: 'assistant',
        content: '🔧 execute_lead_workflow',
        agentType: 'lead_generation',
        metadata: {
          isToolCall: true,
          toolName: 'execute_lead_workflow',
          toolArgs: workflowArgs,
          responseId: `tool-call-execute_lead_workflow-${Date.now()}`,
        },
      });
    } catch (e) {
      logger.warn({ err: e }, '[Lead Agent] Failed to log tool call');
    }

    const result = await executeLeadWorkflow(workflowArgs, toolContext);

    webSocketEmitter.emitToolExecution(Number(state.userId), Number(state.threadId), {
      toolName: 'execute_lead_workflow',
      args: workflowArgs,
      status: result.success ? 'completed' : 'failed',
      agentType: 'lead_generation',
      error: result.error,
      durationMs: Date.now() - leadToolStartTime,
    });

    // Persist tool result
    try {
      const durationMs = Date.now() - leadToolStartTime;
      const resultContent = `🔧 execute_lead_workflow → ${result.success ? '✅' : '❌'} (${durationMs}ms)${result.error ? ` Error: ${result.error}` : ''}`;
      await createChatMessage({
        userId: Number(state.userId),
        threadId: Number(state.threadId),
        role: 'assistant',
        content: resultContent,
        agentType: 'lead_generation',
        metadata: {
          isToolResult: true,
          toolName: 'execute_lead_workflow',
          success: result.success,
          toolArgs: workflowArgs,
          toolOutput: result.output,
          durationMs,
        },
      });
      webSocketEmitter.emitChatResponse(Number(state.userId), Number(state.threadId), {
        role: 'assistant',
        content: resultContent,
        agentType: 'lead_generation',
        metadata: {
          isToolResult: true,
          toolName: 'execute_lead_workflow',
          success: result.success,
          toolArgs: workflowArgs,
          toolOutput: result.output,
          durationMs,
          responseId: `tool-result-execute_lead_workflow-${Date.now()}`,
        },
      });
    } catch (e) {
      logger.warn({ err: e }, '[Lead Agent] Failed to log tool result');
    }

    const selectedLeadIds = Array.isArray(result.output?.leadIds)
      ? result.output.leadIds.map(Number).filter((id: number) => Number.isInteger(id) && id > 0)
      : [];
    const hasReviewableLeads = result.success && selectedLeadIds.length > 0;
    const message = result.success
      ? hasReviewableLeads
        ? `${result.output?.message || 'Lead generation finished.'}\n\nReview the exact persisted records in the Leads tab. Outreach stays locked until you explicitly approve the reviewed lead set.`
        : `${result.output?.message || 'Lead generation finished without any matching leads.'}\n\nNo outreach handoff is available because there are no persisted lead IDs to review.`
      : `Hmm, there was an issue with the lead search: ${result.error}. Let me know if you'd like to try again.`;

    if (result.success) {
      webSocketEmitter.emit(Number(state.userId), 'open_tab', {
        thread_id: Number(state.threadId),
        tabType: TAB_TYPES.LEADS,
        tabLabel: TAB_LABELS[TAB_TYPES.LEADS],
      });
    }

    const outreachButtons: ActionButton[] = hasReviewableLeads
      ? [
          { id: 'lead_review_approve', label: 'Approve reviewed leads', action: 'LEAD_AGENT_START', type: 'primary' as const, data: { message: 'I approve the reviewed leads.' } },
          { id: 'lead_review_adjust', label: 'Adjust search', action: 'LEAD_AGENT_START', type: 'secondary' as const, data: { message: 'I need to adjust the lead search.' } },
        ]
      : [];

    return {
      messages: [{ role: 'assistant', content: message }],
      toolResults: [...(state.toolResults || []), result],
      requiresApproval: false,
      pendingApproval: null,
      actionButtons: outreachButtons,
      leadWorkflowExecuted: result.success,
      leadReviewApproved: false,
      selectedLeadIds,
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (isRateLimitError(error)) {
      logger.warn('[Lead Agent Approval] Rate limit error, re-throwing');
      throw error;
    }
    return {
      messages: [{ role: 'assistant', content: `The lead search encountered an error: ${error.message}. Would you like me to try a different platform?` }],
      requiresApproval: false,
      pendingApproval: null,
    };
  }
}

// ── Outreach Approval ──────────────────────────────────────────────────

export async function handleOutreachApproval(
  state: AgentState,
  approved: boolean,
): Promise<Partial<AgentState>> {
  if (!state.pendingApproval || state.pendingApproval.toolName !== 'send_outreach_messages') {
    return {
      messages: [{ role: 'assistant', content: 'No pending outreach to approve.' }],
      requiresApproval: false,
      pendingApproval: null,
    };
  }

  if (!approved) {
    return {
      messages: [{ role: 'assistant', content: "No worries! Your templates are saved. Let me know when you're ready to send, or if you'd like to make any changes first." }],
      requiresApproval: false,
      pendingApproval: null,
      actionButtons: [],
    };
  }

  const toolContext: ToolContext = {
    userId: state.userId,
    threadId: state.threadId,
    icpProfile: state.icpProfile,
    brandToolkit: state.brandToolkit,
    leadInputs: state.leadInputs,
  };

  try {
    const args = state.pendingApproval.args as {
      lead_ids: number[];
      channel: 'email' | 'sms' | 'whatsapp' | 'instagram' | 'facebook' | 'linkedin' | 'twitter';
      template_id?: string;
      subject?: string;
      body: string;
      scheduled_for?: string;
    };
    const result = await executeSendOutreachMessages(args, toolContext);

    const message = result.success
      ? `✅ Outreach queued successfully. ${result.output?.message || ''}\n\nI'll track each recipient through sent, delivered, and failed states. Would you like me to prepare a follow-up sequence?`
      : `There was an issue sending the messages: ${result.error}. Would you like me to try again?`;

    return {
      messages: [{ role: 'assistant', content: message }],
      toolResults: [...(state.toolResults || []), result],
      requiresApproval: false,
      pendingApproval: null,
      actionButtons: [],
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (isRateLimitError(error)) {
      logger.warn('[Outreach Approval] Rate limit error, re-throwing');
      throw error;
    }
    return {
      messages: [{ role: 'assistant', content: `The outreach encountered an error: ${error.message}. Would you like me to try a different approach?` }],
      requiresApproval: false,
      pendingApproval: null,
    };
  }
}

// ── Proposal Delivery Approval ─────────────────────────────────────────

export async function handleProposalApproval(
  state: AgentState,
  approved: boolean,
): Promise<Partial<AgentState>> {
  if (!state.pendingApproval || state.pendingApproval.toolName !== 'send_proposal') {
    return {
      messages: [{ role: 'assistant', content: 'No pending proposal delivery to approve.' }],
      requiresApproval: false,
      pendingApproval: null,
    };
  }
  if (!approved) {
    return {
      messages: [{ role: 'assistant', content: 'The proposal was not sent. Its saved draft and customer link remain unchanged.' }],
      requiresApproval: false,
      pendingApproval: null,
      actionButtons: [],
    };
  }
  const context: ToolContext = {
    userId: state.userId,
    threadId: state.threadId,
    runContext: state.runContext,
    workflowId: state.runContext?.runId,
    selectedLeadIds: state.selectedLeadIds,
    icpProfile: state.icpProfile,
    brandToolkit: state.brandToolkit,
    companyProfile: state.companyProfile,
    leadInputs: state.leadInputs,
  };
  let result;
  try {
    result = await executeApprovedProposalDelivery(state.pendingApproval.args, context);
  } catch (error) {
    result = {
      success: false,
      toolName: 'send_proposal',
      error: error instanceof Error ? error.message : 'Proposal delivery failed.',
      output: { status: 'failed', retrySafe: false },
    };
  }
  const status = result.output?.status;
  const message = status === 'sent'
    ? `Proposal sent with a confirmed provider receipt.${result.output?.publicUrl ? ` Customer link: ${result.output.publicUrl}` : ''}`
    : status === 'awaiting_team_review'
      ? 'Your review is recorded. The proposal was not sent because assigned team reviewers still need to approve this exact version.'
      : status === 'needs_attention'
        ? 'The provider outcome is uncertain. The proposal was not sent again; reconcile the provider receipt in the proposal workspace.'
        : `The proposal was not sent: ${result.error || 'delivery did not complete'}`;
  return {
    messages: [{ role: 'assistant', content: message }],
    toolResults: [...(state.toolResults || []), result],
    requiresApproval: false,
    pendingApproval: null,
    actionButtons: [],
  };
}

// ── Ads Approval ───────────────────────────────────────────────────────

export async function handleAdsApproval(
  state: AgentState,
  approved: boolean,
): Promise<Partial<AgentState>> {
  if (!state.pendingApproval || state.pendingApproval.toolName !== 'publish_meta_ads') {
    return {
      messages: [{ role: 'assistant', content: 'No pending ad campaign to approve.' }],
      requiresApproval: false,
      pendingApproval: null,
    };
  }

  if (!approved) {
    return {
      messages: [{ role: 'assistant', content: "No problem! Your ad creatives are saved. Let me know when you're ready to publish, or if you'd like to make any changes first." }],
      requiresApproval: false,
      pendingApproval: null,
      actionButtons: [],
    };
  }

  const toolContext: ToolContext = {
    userId: state.userId,
    threadId: state.threadId,
    icpProfile: state.icpProfile,
    brandToolkit: state.brandToolkit,
    leadInputs: state.leadInputs,
  };

  try {
    const args = state.pendingApproval.args as Parameters<typeof executePublishMetaAds>[0];
    const result = await executePublishMetaAds(args, toolContext);

    const message = result.success
      ? `✅ Meta campaign launch queued.\n\n${result.output?.message || ''}\n\nI'll report active only after Meta confirms activation.`
      : `There was an issue publishing to Meta Ads: ${result.error}. Would you like me to try again or check the campaign settings?`;

    return {
      messages: [{ role: 'assistant', content: message }],
      toolResults: [...(state.toolResults || []), result],
      requiresApproval: false,
      pendingApproval: null,
      actionButtons: [],
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (isRateLimitError(error)) {
      logger.warn('[Performance Approval] Rate limit error, re-throwing');
      throw error;
    }
    return {
      messages: [{ role: 'assistant', content: `The campaign publish encountered an error: ${error.message}. Would you like me to troubleshoot this?` }],
      requiresApproval: false,
      pendingApproval: null,
    };
  }
}

export async function handleGoogleAdsApproval(
  state: AgentState,
  approved: boolean,
): Promise<Partial<AgentState>> {
  if (!state.pendingApproval || state.pendingApproval.toolName !== 'publish_google_ads') {
    return {
      messages: [{ role: 'assistant', content: 'No pending Google Ads campaign to approve.' }],
      requiresApproval: false,
      pendingApproval: null,
    };
  }

  if (!approved) {
    return {
      messages: [{ role: 'assistant', content: "No problem! Your Google Ads campaign was not published. You can revise the plan and try again whenever you're ready." }],
      requiresApproval: false,
      pendingApproval: null,
      actionButtons: [],
    };
  }

  const toolContext: ToolContext = {
    userId: state.userId,
    threadId: state.threadId,
    icpProfile: state.icpProfile,
    brandToolkit: state.brandToolkit,
    leadInputs: state.leadInputs,
  };

  try {
    const args = state.pendingApproval.args as Parameters<typeof executePublishGoogleAds>[0];
    const result = await executePublishGoogleAds(args, toolContext);

    const message = result.success
      ? `✅ Google campaign launch queued.\n\n${result.output?.message || ''}\n\nI'll report active only after Google confirms activation.`
      : `There was an issue publishing to Google Ads: ${result.error}. Would you like me to try again or check settings?`;

    return {
      messages: [{ role: 'assistant', content: message }],
      toolResults: [...(state.toolResults || []), result],
      requiresApproval: false,
      pendingApproval: null,
      actionButtons: [],
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (isRateLimitError(error)) {
      logger.warn('[Google Ads Approval] Rate limit error, re-throwing');
      throw error;
    }
    return {
      messages: [{ role: 'assistant', content: `The Google Ads campaign publish encountered an error: ${error.message}.` }],
      requiresApproval: false,
      pendingApproval: null,
    };
  }
}

export async function handlePublishSocialPostApproval(
  state: AgentState,
  approved: boolean,
): Promise<Partial<AgentState>> {
  if (!state.pendingApproval || state.pendingApproval.toolName !== 'publish_social_post') {
    return {
      messages: [{ role: 'assistant', content: 'No pending social media post to approve.' }],
      requiresApproval: false,
      pendingApproval: null,
    };
  }

  if (!approved) {
    return {
      messages: [{ role: 'assistant', content: "No problem! The post is saved as a draft. Let me know when you're ready to publish." }],
      requiresApproval: false,
      pendingApproval: null,
      actionButtons: [],
    };
  }

  const toolContext: ToolContext = {
    userId: state.userId,
    threadId: state.threadId,
    icpProfile: state.icpProfile,
    brandToolkit: state.brandToolkit,
    leadInputs: state.leadInputs,
  };

  try {
    const args = state.pendingApproval.args as {
      content_asset_id: number;
      platform?: 'facebook' | 'instagram' | 'youtube';
      targets?: Array<{
        platform: 'facebook' | 'instagram' | 'youtube';
        credentialId?: number;
        caption?: string;
        postType?: 'post' | 'feed' | 'reel' | 'story' | 'carousel' | 'text' | 'photo' | 'image' | 'video' | 'short';
        title?: string;
        privacyStatus?: 'public' | 'private' | 'unlisted';
        instagramOptions?: { coverUrl?: string; thumbOffset?: number };
      }>;
      caption?: string;
      title?: string;
      scheduled_for?: string;
      post_type?: 'post' | 'feed' | 'reel' | 'story' | 'carousel' | 'text' | 'photo' | 'video' | 'short';
      privacy_status?: 'public' | 'private' | 'unlisted';
      credential_id?: number;
      idempotency_key?: string;
      instagram_options?: { coverUrl?: string; thumbOffset?: number };
    };
    const result = await executePublishSocialPost(args, toolContext);

    const message = result.success
      ? `${result.output?.message || '🚀 Post published successfully!'}`
      : `There was an issue publishing the post: ${result.error}. Would you like me to try again?`;

    return {
      messages: [{ role: 'assistant', content: message }],
      toolResults: [...(state.toolResults || []), result],
      requiresApproval: false,
      pendingApproval: null,
      actionButtons: [],
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    if (isRateLimitError(error)) {
      logger.warn('[Social Post Approval] Rate limit error, re-throwing');
      throw error;
    }
    return {
      messages: [{ role: 'assistant', content: `The post publishing encountered an error: ${error.message}.` }],
      requiresApproval: false,
      pendingApproval: null,
    };
  }
}
