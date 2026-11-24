import type { AgentState, RunContext } from '../../mastra/state.js';
import { toolMetadata } from '../../mastra/tools/toolRegistry.js';
import { logger } from '../../utils/logger.js';
import {
  chatHistoryManager,
  contentWithAttachmentContext,
} from '../ChatHistoryManager.js';
import { getChatThreadById, getChatThreadMetadata } from '../../models/chatThreads/functions.js';
import { getLatestLeadInputsByThreadId } from '../../models/leadInputs/functions.js';
import {
  getBusinessProfileContextByUserId,
  getCompanySettingsById,
} from '../../models/companySettings/functions.js';
import { getUserById } from '../../models/users/functions.js';
import { ICPGenerationService } from '../ICPGenerationService.js';
import { webSocketEmitter } from './WebSocketEmitter.js';
import { acquireConversationThreadMutex } from './ThreadMutex.js';
import { WidgetStateModel } from '../../models/widgetStates/functions.js';

const icpService = new ICPGenerationService();

export class ThreadService {
  /**
   * Acquire per-thread mutex to prevent race conditions on concurrent processMessage calls
   */
  static async acquireThreadMutex(
    userId: number,
    threadId: number,
  ): Promise<{ release: () => void }> {
    return acquireConversationThreadMutex(userId, threadId);
  }

  /**
   * Load the full conversation state from database for a thread
   */
  static async loadThreadState(
    userId: number,
    threadId: number,
    options: { excludeMessageId?: number } = {},
  ): Promise<Partial<AgentState>> {
    const icp = await icpService.getICPForThread(userId, threadId);
    const recentMessages = await chatHistoryManager.getMessages(threadId, 'langgraph_context');
    let contextSummary: string | undefined;
    let summarizedThrough = 0;
    try {
      const { conversationCompactionService } = await import('../ConversationCompactionService.js');
      const latestSummary = await conversationCompactionService.getLatestSummary(threadId);
      if (latestSummary?.summaryText && latestSummary.userId === userId) {
        contextSummary = latestSummary.summaryText;
        summarizedThrough = latestSummary.toMessageId ?? 0;
        logger.info({ threadId, summarizedThrough }, '[ThreadService] Loaded latest compaction summary');
      }
    } catch (err) {
      logger.warn({ err }, '[ThreadService] Could not load compaction summary');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let icpWithBusiness = icp ? { ...(icp as any) } : undefined;
    try {
      const thread = await getChatThreadById(threadId);
      if (thread?.businessId) {
        const businessProfile = await getCompanySettingsById(thread.businessId);
        if (businessProfile) {
          if (!icpWithBusiness) icpWithBusiness = {};
          icpWithBusiness.businessId = businessProfile.id;
          icpWithBusiness.businessName = businessProfile.companyName || businessProfile.businessName || businessProfile.name;
          icpWithBusiness.businessIndustry = businessProfile.industry;
          icpWithBusiness.businessDescription = businessProfile.description;
          icpWithBusiness.businessWebsite = businessProfile.website;
        }
      }
    } catch (err) {
      logger.warn({ err }, '[ThreadService] Could not enrich ICP with business profile');
    }

    const lastAssistantMessage = recentMessages.find(
      msg => msg.role === 'assistant' && 
             msg.agentType !== 'user' &&
             // eslint-disable-next-line @typescript-eslint/no-explicit-any
             !(msg.metadata as any)?.isTransition &&
             // eslint-disable-next-line @typescript-eslint/no-explicit-any
             !(msg.metadata as any)?.isTransitionMessage &&
             // Tool cards, progress rows, and widget receipts describe a run;
             // they must never become the conversation's routing owner.
             // eslint-disable-next-line @typescript-eslint/no-explicit-any
             !(msg.metadata as any)?.isToolCall &&
             // eslint-disable-next-line @typescript-eslint/no-explicit-any
             !(msg.metadata as any)?.isToolResult &&
             // eslint-disable-next-line @typescript-eslint/no-explicit-any
             !(msg.metadata as any)?.isProgressMessage &&
             // eslint-disable-next-line @typescript-eslint/no-explicit-any
             !(msg.metadata as any)?.widgetId
    );

    let currentAgent = lastAssistantMessage?.agentType || 'supervisor';
    if (!lastAssistantMessage) {
      const lastTransition = recentMessages.find(
        msg => msg.role === 'assistant' && 
               // eslint-disable-next-line @typescript-eslint/no-explicit-any
               ((msg.metadata as any)?.isTransition || (msg.metadata as any)?.isTransitionMessage) &&
               // eslint-disable-next-line @typescript-eslint/no-explicit-any
               (msg.metadata as any)?.toAgent
      );
      if (lastTransition) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        currentAgent = (lastTransition.metadata as any).toAgent;
      }
    }

    logger.info({
      lastAgentType: lastAssistantMessage?.agentType,
      currentAgent
    }, '[ThreadService] loadThreadState');

    const chronologicalMessages = [...recentMessages].reverse()
      .filter(msg => msg.id > summarizedThrough)
      .filter(msg => msg.id !== options.excludeMessageId)
      .filter(msg => msg.content != null && msg.content !== '');
    const messages = chronologicalMessages
      .map((msg) => ({
        role: msg.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: msg.role === 'user'
          ? contentWithAttachmentContext(msg)
          : msg.content,
        agentType: msg.agentType || undefined,
        metadata: msg.metadata || undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any));

    let brandToolkit = undefined;
    try {
      const thread = await getChatThreadById(threadId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const metadata = thread?.metadata as any;

      if (metadata?.selectedBrandToolkitId && !metadata?.skippedBrandToolkit) {
        const { BrandToolkitModel } = await import('../../models/brandToolkits/functions.js');
        const toolkit = await BrandToolkitModel.findByIdAndUser(metadata.selectedBrandToolkitId, userId);

        if (toolkit) {
          brandToolkit = {
            id: toolkit.id,
            name: toolkit.name,
            primaryBrandColor: toolkit.primaryBrandColor || undefined,
            secondaryBrandColor: toolkit.secondaryBrandColor || undefined,
            fontFamily: toolkit.fontFamily || undefined,
            voiceType: toolkit.voiceType || undefined,
            brandValues: toolkit.brandValues || undefined,
            defaultCtas: toolkit.defaultCtas || undefined,
            defaultHashtags: toolkit.defaultHashtags || undefined,
          };
        }
      }
    } catch (err) {
      logger.warn({ err }, '[ThreadService] Could not load brand toolkit');
    }

    let pendingApproval = undefined;
    let requiresApproval = false;
    let leadWorkflowExecuted = false;
    let leadReviewApproved = false;
    let agentPipeline: string[] | undefined = undefined;
    let deferredLeadReviewPipeline: string[] | undefined = undefined;
    let agentPipelineIndex: number | undefined = undefined;
    let pipelineRequest: string | undefined = undefined;
    let selectedWorkflows: string[] = [];
    let selectedLeadIds: number[] = [];
    let runContext: RunContext | undefined;
    let workflowOutcome: AgentState['workflowOutcome'];
    let pendingClarification: AgentState['pendingClarification'];
    try {
      const threadMetadata = await getChatThreadMetadata(threadId);
      if (threadMetadata) {
        const { readPendingClarification } = await import('../../mastra/conversationClarification.js');
        pendingClarification = readPendingClarification(threadMetadata.pendingClarification);
        if (threadMetadata.pendingApproval && typeof threadMetadata.pendingApproval === 'object' && !Array.isArray(threadMetadata.pendingApproval)) {
          pendingApproval = threadMetadata.pendingApproval;
          requiresApproval = true;
          // A calendar/content side trip can be the latest assistant message;
          // it does not take ownership of an existing specialist's review.
          const pendingRecord = pendingApproval as Record<string, unknown>;
          const owners = typeof pendingRecord.toolName === 'string' ? toolMetadata[pendingRecord.toolName]?.agents : undefined;
          const savedOwner = threadMetadata.pendingApprovalOwner && typeof threadMetadata.pendingApprovalOwner === 'object'
            ? threadMetadata.pendingApprovalOwner as Record<string, unknown> : undefined;
          const requestId = pendingRecord.executionId || pendingRecord.toolCallId;
          if (typeof requestId === 'string' && savedOwner?.requestId === requestId
            && typeof savedOwner.agentType === 'string' && owners?.some(owner => owner === savedOwner.agentType)) currentAgent = savedOwner.agentType;
          else if (owners?.length === 1) currentAgent = owners[0];
        }
        if (threadMetadata.leadWorkflowExecuted) {
          leadWorkflowExecuted = true;
        }
        if (threadMetadata.leadReviewApproved === true) {
          leadReviewApproved = true;
        }
        if (threadMetadata.agentPipeline && Array.isArray(threadMetadata.agentPipeline)) {
          agentPipeline = threadMetadata.agentPipeline as string[];
          agentPipelineIndex = (threadMetadata.agentPipelineIndex as number) || 0;
        }
        if (Array.isArray(threadMetadata.deferredLeadReviewPipeline)) {
          deferredLeadReviewPipeline = threadMetadata.deferredLeadReviewPipeline as string[];
        }
        if (typeof threadMetadata.pipelineRequest === 'string') {
          pipelineRequest = threadMetadata.pipelineRequest;
        }
        if (threadMetadata.selectedWorkflows && Array.isArray(threadMetadata.selectedWorkflows)) {
          selectedWorkflows = threadMetadata.selectedWorkflows as string[];
        }
        if (Array.isArray(threadMetadata.selectedLeadIds)) {
          selectedLeadIds = (threadMetadata.selectedLeadIds as unknown[])
            .map(Number)
            .filter((id) => Number.isInteger(id) && id > 0);
        }
        const storedRunContext = threadMetadata.runContext;
        if (storedRunContext && typeof storedRunContext === 'object') {
          const candidate = storedRunContext as Record<string, unknown>;
          if (
            Number(candidate.userId) === userId
            && Number(candidate.threadId) === threadId
            && typeof candidate.runId === 'string'
            && candidate.runId.length > 0
          ) {
            runContext = {
              userId,
              threadId,
              runId: candidate.runId,
              ...(typeof candidate.turnId === 'string' ? { turnId: candidate.turnId } : {}),
              ...(typeof candidate.actionId === 'string' ? { actionId: candidate.actionId } : {}),
              ...(typeof candidate.idempotencyKey === 'string' ? { idempotencyKey: candidate.idempotencyKey } : {}),
            };
          }
        }
        if (typeof threadMetadata.workflowOutcome === 'string') {
          workflowOutcome = threadMetadata.workflowOutcome as AgentState['workflowOutcome'];
        }
      }
    } catch (err) {
      logger.warn({ err }, '[ThreadService] Could not load thread metadata');
    }

    let leadInputs = undefined;
    try {
      const latestInputs = await getLatestLeadInputsByThreadId(threadId);
      if (latestInputs && latestInputs.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        leadInputs = latestInputs as any;
      }
    } catch (err) {
      logger.warn({ err }, '[ThreadService] Could not load lead inputs');
    }

    let savedToolActions: AgentState['savedToolActions'];
    try {
      const widgets = await WidgetStateModel.findByThreadForUser(userId, threadId);
      savedToolActions = widgets.map(widget => ({
        widgetId: widget.id, toolName: widget.toolName, agentType: widget.agentType,
        status: widget.status, runId: widget.runId,
        userId, threadId,
        formValues: widget.formValues ?? {},
        submittedValues: widget.submittedValues ?? null,
        executionResult: widget.executionResult,
      }));
    } catch (err) {
      logger.warn({ err }, '[ThreadService] Could not load saved tool action status');
    }

    let userName: string | undefined;
    let userEmail: string | undefined;
    try {
      const user = await getUserById(userId);
      if (user) {
        userName = user.name || undefined;
        userEmail = user.email || undefined;
      }
    } catch (err) {
      logger.warn({ err }, '[ThreadService] Could not load user details');
    }

    let companyProfile = undefined;
    try {
      const profile = await getBusinessProfileContextByUserId(userId);
      if (profile) {
        companyProfile = {
          id: profile.id,
          companyName: profile.companyName,
          industry: profile.industry || undefined,
          website: profile.website || undefined,
          description: profile.description || undefined,
          employees: profile.employees || undefined,
          companySize: profile.companySize || undefined,
          primaryMarket: profile.primaryMarket || undefined,
          targetRegions: profile.targetRegions || undefined,
          customerType: profile.customerType || undefined,
          keyBuyerRoles: profile.keyBuyerRoles || undefined,
          businessGoals: profile.businessGoals || undefined,
          preferredChannels: profile.preferredChannels || undefined,
          brandTone: profile.brandTone || undefined,
          platforms: profile.platforms || undefined,
          userName,
          userEmail,
        };
      } else if (userName || userEmail) {
        companyProfile = {
          id: 0,
          companyName: 'Not set',
          userName,
          userEmail,
        };
      }
    } catch (err) {
      logger.warn({ err }, '[ThreadService] Could not load company profile');
    }

    return {
      messages,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      icpProfile: icpWithBusiness ? (icpWithBusiness as any) : undefined,
      brandToolkit,
      companyProfile,
      leadInputs,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      currentAgent: currentAgent as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pendingApproval: pendingApproval as any,
      requiresApproval,
      leadWorkflowExecuted,
      leadReviewApproved,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agentPipeline: agentPipeline as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deferredLeadReviewPipeline: deferredLeadReviewPipeline as any,
      agentPipelineIndex,
      pipelineRequest,
      selectedWorkflows,
      selectedLeadIds,
      runContext,
      workflowOutcome,
      pendingClarification,
      contextSummary,
      savedToolActions,
    };
  }

  /**
   * Schedule auto-compaction and push window status via WebSockets
   */
  static scheduleAutoCompaction(userId: number, threadId: number) {
    setImmediate(async () => {
      try {
        const { computeContextWindowData } = await import('../../controllers/chatController.js');
        const contextData = await computeContextWindowData(threadId);

        webSocketEmitter.emit(userId, 'context_update', {
          thread_id: threadId,
          ...contextData,
        });

        const { conversationCompactionService } = await import('../ConversationCompactionService.js');
        const { AUTO_COMPACT_CONTEXT_PERCENT } = await import('../../utils/chatConstants.js');

        const shouldCompactByContext = contextData.tokenUsage.usagePercent >= AUTO_COMPACT_CONTEXT_PERCENT;
        const shouldCompactByCount = await conversationCompactionService.shouldCompact(threadId);

        if (shouldCompactByContext || shouldCompactByCount) {
          logger.info(
            { threadId, userId, usagePercent: contextData.tokenUsage.usagePercent, shouldCompactByCount },
            '[ThreadService] Auto-compacting thread (compaction condition met)'
          );
          await conversationCompactionService.compact(userId, threadId);

          const updatedContextData = await computeContextWindowData(threadId);
          webSocketEmitter.emit(userId, 'context_update', {
            thread_id: threadId,
            ...updatedContextData,
          });
        }
      } catch (err) {
        logger.warn({ err, threadId }, '[ThreadService] Auto-compaction/context update failed');
      }
    });
  }
}
