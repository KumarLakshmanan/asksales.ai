import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { normalizeToolExecutionResult } from '../utils/toolExecutionResult.js';
/**
 * Widget Routes
 * API endpoints for interactive widget state management
 */

import { Router, Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { WidgetStateModel } from '../models/widgetStates/functions';
import type { WidgetState } from '../models/widgetStates/schema.js';
import { createChatMessage } from '../models/chatMessages/functions';
import { webSocketEmitter } from '../services/agents/WebSocketEmitter';
import {
  getChatThreadById,
  getChatThreadMetadata,
  updateChatThreadMetadata,
} from '../models/chatThreads/functions.js';
import { getWidgetTypeForTool } from '../shared/toolWidgetMap.js';
import {
  executeCanonicalWidgetTool,
  validateCanonicalWidgetToolInput,
} from '../mastra/tools/canonicalToolRegistry.js';
import { logger } from '../utils/logger.js';
import { getEffectiveModuleAccess } from '../models/platformAccess/functions.js';
import { getBalance } from '../models/wallets/functions.js';
import { ThreadService } from '../services/agents/ThreadService.js';
import type { PlatformModuleKey } from '../utils/platformModules.js';
import { db } from '../models/db.js';
import { chatMessagesTable } from '../models/chatMessages/schema.js';
import { eq } from 'drizzle-orm';
import { summarizeAdPublication } from '../../shared/adPublicationStatus.js';
import {
  createConversationWorkflowAction,
  createLeadInputSet,
  createLeadStrategySelection,
  ensureConversationWorkflowRun,
  getLatestLeadStrategySelection,
  setConversationWorkflowActionStatus,
  transitionConversationWorkflowRun,
} from '../models/conversationWorkflow/functions.js';
import { isRecord as isPlainRecord } from '../../shared/records.js';
import { toUserFacingError } from '../../shared/userFacingError.js';

function parsePositiveId(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isBoundedRecord(value: unknown, limit = 100_000): value is Record<string, unknown> {
  return isPlainRecord(value) && Buffer.byteLength(JSON.stringify(value), 'utf8') <= limit;
}

// Reviewed outreach contains a personalized message/sequence per recipient.
// Keep the larger allowance tied to the stored widget binding, never client input.
function reviewSizeLimit(toolName: string) {
  return toolName === 'send_outreach_messages' ? 8_000_000 : 100_000;
}

function requiredModuleForTool(toolName: string): PlatformModuleKey {
  if (toolName.includes('lead')) return 'lead_generation';
  if (toolName.includes('crm') || toolName.includes('pipeline')) return 'crm';
  if (toolName.includes('outreach')) return 'outreach';
  if (toolName.includes('ads')) return 'performance_marketing';
  if (
    toolName.includes('image') ||
    toolName.includes('video') ||
    toolName.includes('content') ||
    toolName.includes('social') ||
    toolName.includes('email_template') ||
    toolName.includes('sms_template') ||
    toolName.includes('blog')
  ) return 'content';
  return 'campaigns';
}

type WidgetWorkflowStatus = 'running' | 'queued' | 'succeeded' | 'failed' | 'gated' | 'cancelled';

async function updateWidgetWorkflowAction(
  widget: WidgetState,
  status: WidgetWorkflowStatus,
  result?: unknown,
  error?: string,
): Promise<void> {
  if (!widget.runId || !widget.actionId) return;
  const durableRun = await ensureConversationWorkflowRun({
    userId: widget.userId,
    threadId: widget.threadId,
    runId: widget.runId,
    stage: 'agent_running',
  });
  await createConversationWorkflowAction({
    actionId: widget.actionId,
    runId: durableRun.id,
    userId: widget.userId,
    threadId: widget.threadId,
    actionType: widget.toolName,
    status: status === 'running' ? 'running' : 'awaiting_approval',
    idempotencyKey: `widget:${widget.id}`,
    resourceType: 'widget',
    resourceId: String(widget.id),
  });
  await setConversationWorkflowActionStatus({
    actionId: widget.actionId,
    runId: durableRun.id,
    userId: widget.userId,
    threadId: widget.threadId,
    status: status === 'gated' ? 'gated' : status,
    output: isPlainRecord(result) ? result : undefined,
    error,
  });
  const metadata = await getChatThreadMetadata(widget.threadId) || {};
  const runs = Array.isArray(metadata.workflowRuns)
    ? metadata.workflowRuns.filter(run => run && typeof run === 'object') as Array<Record<string, unknown>>
    : [];
  const current = runs.find(run => run.runId === widget.runId)
    || (isPlainRecord(metadata.workflowRun) && metadata.workflowRun.runId === widget.runId
      ? metadata.workflowRun
      : undefined);
  if (!current) return;

  const now = new Date().toISOString();
  const actions = Array.isArray(current.actions)
    ? current.actions.filter(action => action && typeof action === 'object') as Array<Record<string, unknown>>
    : [];
  const existingAction = actions.find(action => action.actionId === widget.actionId);
  const output = isPlainRecord(result) && isPlainRecord(result.output) ? result.output : undefined;
  const action = {
    ...(existingAction || {}),
    actionId: widget.actionId,
    toolName: widget.toolName,
    widgetId: widget.id,
    status,
    error,
    ...(output ? { resourceIds: output.assetIds || output.asset_ids || output.campaignId || output.campaign_id } : {}),
    updatedAt: now,
  };
  const updatedActions = [
    ...actions.filter(item => item.actionId !== widget.actionId),
    action,
  ];
  const hasOpenAction = updatedActions.some(item =>
    item.status === 'running' || item.status === 'queued' || item.status === 'awaiting_approval'
  );
  const runStatus = hasOpenAction
    ? updatedActions.some(item => item.status === 'running') ? 'running' : 'queued'
    : status;
  const updatedRun = {
    ...current,
    actionId: widget.actionId,
    status: runStatus,
    actions: updatedActions,
    updatedAt: now,
    ...(!hasOpenAction ? { completedAt: now } : {}),
  };
  const workflowRuns = [
    ...runs.filter(run => run.runId !== widget.runId),
    updatedRun,
  ].slice(-25);

  await updateChatThreadMetadata(widget.threadId, {
    ...metadata,
    workflowOutcome: runStatus,
    workflowRun: updatedRun,
    workflowRuns,
    runContext: {
      ...(isPlainRecord(metadata.runContext) ? metadata.runContext : {}),
      userId: widget.userId,
      threadId: widget.threadId,
      runId: widget.runId,
      actionId: widget.actionId,
    },
  });
  webSocketEmitter.emit(widget.userId, 'workflow_run_status', {
    thread_id: widget.threadId,
    run_id: widget.runId,
    action_id: widget.actionId,
    status: runStatus,
    updated_at: now,
  });
}

const CONTENT_RESULT_LABELS: Record<string, string> = {
  generate_social_media_post: 'Social post', generate_social_chat_template: 'DM template', generate_email_template: 'Email template',
  generate_sms_template: 'SMS template', generate_whatsapp_template: 'WhatsApp template', generate_blog_post: 'Blog post',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getFriendlyToolResultMessage = (toolName: string, success: boolean, result: any): string => {
  const contentLabel = CONTENT_RESULT_LABELS[toolName];
  if (!success) {
    // Content validation errors are written for the user ("The Instagram post
    // exceeds the 2,200-character limit ... split it into separate posts").
    if (contentLabel) return `❌ ${contentLabel} was not generated. ${toUserFacingError(result?.error, 'Generation did not complete.')}`;
    return `❌ Failed to execute ${toolName.replace(/_/g, ' ')}: ${result?.error || 'Unknown error'}`;
  }
  if (contentLabel && typeof result?.output?.message === 'string' && result.output.message.trim()) {
    return `✅ ${result.output.message.replace(/^\p{Extended_Pictographic}️?\s*/u, '')}`;
  }
  switch (toolName) {
    case 'generate_lead_inputs':
      return `✅ Lead search parameters generated successfully! Ready to run lead generation.`;
    case 'execute_lead_workflow':
      return `✅ Lead search completed! Found ${result?.output?.totalLeads || 0} leads.`;
    case 'analytics_query':
      return result?.output?.summary || result?.output?.message || 'Analytics loaded successfully.';
    case 'generate_ad':
      return result?.output?.message || '✅ Ad creative generated and saved successfully.';
    case 'generate_image':
      return result?.output?.message || '✅ Image generated and saved successfully.';
    case 'publish_ads':
      return result?.output?.message || 'Campaign launch is queued. Provider confirmation is still required.';
    case 'stop_ads':
      return result?.output?.message || 'Stop request queued. Provider pause has not yet been confirmed.';
    case 'publish_meta_ads':
      return result?.output?.message || `✅ Meta campaign launch queued. It is not active until the provider confirms activation.`;
    case 'publish_google_ads':
      return result?.output?.message || `✅ Google campaign launch queued. It is not active until the provider confirms activation.`;
    case 'publish_social_post': {
      const output = result?.output;
      if (output?.status === 'provider_succeeded') {
        return '⚠️ Meta accepted the post, but local finalization is pending reconciliation. It will not be submitted again.';
      }
      if (Array.isArray(output?.platforms) && output.platforms.length > 1) {
        return output?.message || `✅ Publishing review completed for ${output.platforms.join(', ')}.`;
      }
      return output?.postUrl
        ? `✅ Published to ${output.platform}. [View post](${output.postUrl})`
        : `✅ ${output?.message || `Published to ${output?.platform || 'the selected platform'}.`}`;
    }
    case 'send_outreach_messages':
      return result?.output?.failCount > 0
        ? `⚠️ Queued outreach for ${result.output.successCount}/${result.output.totalLeads} leads; ${result.output.failCount} failed before enqueue.`
        : `✅ Outreach messages queued successfully.`;
    default:
      return `✅ Completed ${toolName.replace(/_/g, ' ')} successfully.`;
  }
};

const router = Router();

// Prepare a saved draft, not an approval or a provider action. The client
// renders the effective settings before enabling the final approval button.
router.get('/:id/stop-review', authenticateToken, async (req: Request, res: Response) => {
  const userId = Number(businessOwnerUserId(req));
  const id = parsePositiveId(req.params.id);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!id) return res.status(400).json({ error: 'A valid review ID is required.' });
  try {
    const widget = await WidgetStateModel.findByIdForUser(id, userId);
    if (!widget || widget.toolName !== 'stop_ads') return res.status(404).json({ error: 'Stop review not found.' });
    const { stopAdsSchema } = await import('../mastra/tools/stopAdsTool.js');
    const args = stopAdsSchema.parse(widget.submittedValues || widget.formValues);
    const { executeQueryAdCampaigns } = await import('../mastra/tools/adCampaignQuery.js');
    const result = await executeQueryAdCampaigns({ campaignId: args.campaignId, limit: 1 }, { userId, threadId: widget.threadId });
    const campaign = result.output.campaigns[0];
    if (!campaign) return res.status(404).json({ error: 'Saved campaign not found.' });
    return res.json({ campaign, platforms: args.platforms });
  } catch (error) {
    return res.status(409).json({ error: error instanceof Error ? error.message : 'Stop review unavailable.' });
  }
});

router.post('/:id/ad-review', authenticateToken, async (req: Request, res: Response) => {
  const userId = Number(businessOwnerUserId(req));
  const id = parsePositiveId(req.params.id);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!id || !isBoundedRecord(req.body.values)) return res.status(400).json({ error: 'A widget ID and bounded review values are required.' });
  try {
    const widget = await WidgetStateModel.findByIdForUser(id, userId);
    if (!widget || !['publish_ads', 'publish_meta_ads', 'publish_google_ads'].includes(widget.toolName)) {
      return res.status(404).json({ error: 'Ad review widget not found.' });
    }
    if (!['active', 'draft'].includes(widget.status)) return res.status(409).json({ error: 'This review is already submitted. It cannot be changed.' });
    const thread = await getChatThreadById(widget.threadId);
    if (!thread || thread.userId !== userId) return res.status(404).json({ error: 'Chat thread not found.' });
    const access = (await getEffectiveModuleAccess(userId)).find(module => module.key === 'performance_marketing');
    if (!access?.enabled) return res.status(403).json({ error: 'Performance marketing is unavailable for this account.' });
    const values = validateCanonicalWidgetToolInput(widget.toolName, req.body.values);
    const platforms = widget.toolName === 'publish_meta_ads' ? ['meta'] as const
      : widget.toolName === 'publish_google_ads' ? ['google'] as const
        : values.platforms as Array<'meta' | 'google'>;
    const { prepareAdCampaignReview } = await import('../mastra/tools/executors/adsExecutor.js');
    const review = await prepareAdCampaignReview({ ...values, platforms: [...platforms] }, {
      userId, threadId: widget.threadId, widgetId: widget.id,
    });
    const formValues = { campaign_id: String(review.campaignId), platforms: [...platforms], review_revision: review.revision };
    const saved = await WidgetStateModel.updateFormValuesForUser(id, userId, formValues);
    if (!saved) return res.status(409).json({ error: 'The review was submitted while preparing it. Reload the conversation.' });
    return res.json({ success: true, review, formValues });
  } catch (error) {
    logger.warn({ err: error, widgetId: id, userId }, '[WidgetRoutes] Ad review could not be prepared');
    return res.status(409).json({ error: error instanceof Error ? error.message : 'Unable to prepare the saved campaign review.' });
  }
});

router.get('/:id/ad-review', authenticateToken, async (req: Request, res: Response) => {
  const userId = Number(businessOwnerUserId(req));
  const id = parsePositiveId(req.params.id);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!id) return res.status(400).json({ error: 'A valid widget ID is required.' });
  try {
    const widget = await WidgetStateModel.findByIdForUser(id, userId);
    if (!widget || !['publish_ads', 'publish_meta_ads', 'publish_google_ads'].includes(widget.toolName)) {
      return res.status(404).json({ error: 'Ad review widget not found.' });
    }
    const values = widget.submittedValues || widget.formValues || {};
    const campaignId = Number(values.campaign_id);
    if (!Number.isSafeInteger(campaignId) || campaignId <= 0) return res.status(409).json({ error: 'Prepare a saved campaign before reviewing it.' });
    const { autonomousAdsService } = await import('../services/ads/AutonomousAdsService.js');
    const review = await autonomousAdsService.getPublishReview(userId, campaignId);
    if (widget.submittedValues && values.review_revision !== review.revision) {
      return res.status(409).json({ error: 'The campaign has changed since this approval. The current draft is not the previously approved creative.' });
    }
    return res.json({ success: true, review });
  } catch (error) {
    return res.status(409).json({ error: error instanceof Error ? error.message : 'Unable to load the campaign review.' });
  }
});

/**
 * GET /api/widgets?threadId=X
 * Get all widgets for a thread (load on page mount)
 */
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    await WidgetStateModel.expireStaleRunning();
    const threadId = parsePositiveId(req.query.threadId);
    if (!threadId) {
      return res.status(400).json({ error: 'A valid threadId is required' });
    }

    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res.status(404).json({ error: 'Chat thread not found' });
    }
    const widgets = await WidgetStateModel.findByThreadForUser(userId, threadId);
    return res.json({ success: true, widgets });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WidgetRoutes] Error fetching widgets');
    return res.status(500).json({ error: 'Failed to fetch widgets' });
  }
});

/**
 * PATCH /api/widgets/:id
 * Auto-save form values (debounced from client)
 */
router.patch('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid widget ID' });
    const { formValues, status } = req.body;
    const existingWidget = await WidgetStateModel.findByIdForUser(id, userId);
    if (!existingWidget) return res.status(404).json({ error: 'Widget not found' });
    const limit = reviewSizeLimit(existingWidget.toolName);
    if (formValues !== undefined && !isBoundedRecord(formValues, limit)) {
      return res.status(400).json({ error: `formValues must be an object no larger than ${limit / 1000} KB` });
    }
    if (status !== undefined && !['draft', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'status must be draft or cancelled' });
    }
    if (formValues === undefined && status === undefined) {
      return res.status(400).json({ error: 'formValues or status is required' });
    }

    let widget;
    if (formValues !== undefined) {
      widget = await WidgetStateModel.updateFormValuesForUser(id, userId, formValues);
    }
    if (status !== undefined) {
      widget = await WidgetStateModel.closeForUser(id, userId, status);
    }
    if (!widget) return res.status(409).json({ error: 'Widget is not editable in its current state' });
    if (status === 'cancelled') await updateWidgetWorkflowAction(widget, 'cancelled');
    return res.json({ success: true, widget });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WidgetRoutes] Error updating widget');
    return res.status(500).json({ error: 'Failed to update widget' });
  }
});

/**
 * POST /api/widgets/:id/submit
 * Submit widget with final values → triggers tool execution
 */
router.post('/:id/submit', authenticateToken, async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid widget ID' });
    const { values } = req.body;

    // Validate tenant ownership and the immutable tool/widget binding before
    // changing lifecycle state. Invalid rows must remain editable/recoverable.
    const existingWidget = await WidgetStateModel.findByIdForUser(id, userId);
    if (!existingWidget) return res.status(404).json({ error: 'Widget not found' });
    const limit = reviewSizeLimit(existingWidget.toolName);
    if (!isBoundedRecord(values, limit)) {
      return res.status(400).json({ error: `values must be an object no larger than ${limit / 1000} KB` });
    }
    const expectedWidgetType = getWidgetTypeForTool(existingWidget.toolName);
    if (!expectedWidgetType || expectedWidgetType !== existingWidget.widgetType) {
      logger.error({ widgetId: existingWidget.id, toolName: existingWidget.toolName }, '[WidgetRoutes] Invalid tool/widget mapping');
      return res.status(409).json({ error: 'This widget is no longer supported' });
    }
    const thread = await getChatThreadById(existingWidget.threadId);
    if (!thread || thread.userId !== userId) {
      return res.status(409).json({ error: 'The associated chat thread is no longer available' });
    }
    let validatedValues: Record<string, unknown>;
    try {
      validatedValues = validateCanonicalWidgetToolInput(existingWidget.toolName, values);
      if (['generate_video', 'generate_video_from_image'].includes(existingWidget.toolName)) {
        const { assertValidVideoReview } = await import('../services/media/VideoReviewPolicy.js');
        await assertValidVideoReview(validatedValues, userId);
      }
      if (validatedValues.auto_generate_video === true) {
        const { assertValidVideoReview } = await import('../services/media/VideoReviewPolicy.js');
        await assertValidVideoReview({ aspect_ratio: validatedValues.video_aspect_ratio, resolution: validatedValues.video_resolution, duration_seconds: validatedValues.video_duration_seconds, number_of_videos: validatedValues.video_count }, userId);
      }
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Widget values are invalid',
        code: 'INVALID_TOOL_INPUT',
      });
    }

    const requiredModule = requiredModuleForTool(existingWidget.toolName);
    const moduleAccess = (await getEffectiveModuleAccess(userId))
      .find(module => module.key === requiredModule);
    if (!moduleAccess?.enabled) {
      return res.status(moduleAccess?.status === 'maintenance' ? 503 : 403).json({
        success: false,
        error: moduleAccess?.message || 'This tool is not available for this account.',
        code: moduleAccess?.status === 'maintenance' ? 'MODULE_MAINTENANCE' : 'MODULE_UNAVAILABLE',
        module: requiredModule,
      });
    }
    // Reducing existing provider spend must not require buying more credits.
    const balance = existingWidget.toolName === 'stop_ads' ? null : await getBalance(userId);
    if (balance !== null && balance <= 0) {
      return res.status(402).json({
        success: false,
        error: 'Insufficient credits',
        code: 'INSUFFICIENT_CREDITS',
        balance,
      });
    }

    await WidgetStateModel.expireStaleRunning();
    const submission = await WidgetStateModel.claimSubmissionForUser(id, userId, validatedValues);
    const widget = submission.widget;
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    if (!submission.claimed) {
      if (['running', 'queued', 'provider_succeeded', 'succeeded', 'failed'].includes(widget.status)) {
        return res.json({
          success: widget.status === 'succeeded',
          widget,
          replayed: true,
          running: widget.status === 'running',
        });
      }
      return res.status(409).json({ error: 'Widget must be active or saved as a draft before submission' });
    }

    webSocketEmitter.emit(userId, 'widget_update', {
      thread_id: widget.threadId,
      widget: {
        id: widget.id,
        status: 'running',
        submittedValues: validatedValues,
        executionStartedAt: widget.executionStartedAt,
      },
    });
    await updateWidgetWorkflowAction(widget, 'running');

    // Execute in the background after the atomic durable claim. Replays observe
    // "running" or the stored terminal state and never repeat the side effect.
    void (async () => {
      const executionLeaseToken = widget.executionLeaseToken;
      if (!executionLeaseToken) {
        logger.error({ widgetId: widget.id }, '[WidgetRoutes] Claimed widget is missing its execution lease token');
        return;
      }
      let result: unknown;
      let success = false;
      let executionError: string | undefined;
      let terminalStatus: 'succeeded' | 'failed' | 'queued' | 'provider_succeeded' | undefined;
      try {
        const state = await ThreadService.loadThreadState(widget.userId, widget.threadId);
        result = await executeCanonicalWidgetTool(widget.toolName, validatedValues, {
          userId: widget.userId,
          threadId: widget.threadId,
          widgetId: widget.id,
          workflowId: widget.runId || state.runContext?.runId,
          runContext: {
            userId: widget.userId,
            threadId: widget.threadId,
            runId: widget.runId || state.runContext?.runId || `widget-${widget.id}`,
            actionId: widget.actionId || undefined,
            idempotencyKey: widget.idempotencyKey || undefined,
          },
          icpProfile: state.icpProfile,
          brandToolkit: state.brandToolkit,
          companyProfile: state.companyProfile,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          brandContextPrompt: (state.brandToolkit as any)?.__brandContextPrompt,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          brandContextSnapshot: (state.brandToolkit as any)?.__brandContextSnapshot,
          leadInputs: state.leadInputs,
        });
        const normalizedResult = normalizeToolExecutionResult(widget.toolName, result);
        result = normalizedResult;
        success = normalizedResult.success;
        // A queue/provider handoff is durable progress, not completed work.
        // Keep it reconcilable so a worker/callback can write the true terminal
        // outcome without executing the provider operation again.
        const normalizedOutput = isPlainRecord(normalizedResult.output) ? normalizedResult.output : {};
        const outputStatus = String(normalizedOutput.status || '').toLowerCase();
        const resultPlatforms = normalizedOutput.platforms;
        const publicationPending = isPlainRecord(resultPlatforms) && summarizeAdPublication(
          Object.values(resultPlatforms).filter(isPlainRecord).map(value => ({ status: String(value.status || '') })),
        ).pending;
        terminalStatus = (
          outputStatus.startsWith('queued') ||
          (widget.toolName === 'send_outreach_messages' && outputStatus === 'needs_attention') ||
          outputStatus === 'scheduled' ||
          outputStatus === 'running' ||
          (publicationPending && ['publish_ads', 'publish_meta_ads', 'publish_google_ads'].includes(widget.toolName)) ||
          outputStatus === 'retryable_failed'
        )
          ? 'queued'
          : outputStatus === 'provider_succeeded'
            ? 'provider_succeeded'
            : success ? 'succeeded' : 'failed';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        executionError = success ? undefined : ((result as any)?.error || 'Tool execution failed');
      } catch (error: unknown) {
        executionError = error instanceof Error ? error.message : 'Tool execution failed';
        result = { success: false, toolName: widget.toolName, error: executionError };
      }

      if (widget.toolName === 'generate_lead_inputs' && success) {
        const resultRecord = isPlainRecord(result) ? result : {};
        const output = isPlainRecord(resultRecord.output) ? resultRecord.output : {};
        const inputIds = Array.isArray(output.inputIds)
          ? output.inputIds.map(Number).filter((value): value is number => Number.isInteger(value) && value > 0)
          : [];
        if (inputIds.length === 0) {
          success = false;
          terminalStatus = 'failed';
          executionError = 'Lead inputs were generated but no durable input records were saved.';
          result = {
            ...resultRecord,
            success: false,
            error: executionError,
            output: { ...output, status: 'failed', inputIds: [] },
          };
        }
      }

      const completedWidget = await WidgetStateModel.completeExecutionForUser(
        widget.id,
        widget.userId,
        executionLeaseToken,
        success,
        result,
        executionError,
        terminalStatus,
      );
      if (!completedWidget) {
        logger.error({ widgetId: widget.id }, '[WidgetRoutes] Could not persist terminal widget execution state');
        return;
      }
      const resultRecord = isPlainRecord(result) ? result : {};
      const resultOutput = isPlainRecord(resultRecord.output) ? resultRecord.output : {};
      const outputStatus = String(resultOutput.status || '').toLowerCase();
      const workflowStatus: WidgetWorkflowStatus = outputStatus === 'gated' || outputStatus === 'blocked'
        ? 'gated'
        : completedWidget.status === 'queued' || completedWidget.status === 'provider_succeeded'
          ? 'queued'
          : success ? 'succeeded' : 'failed';
      await updateWidgetWorkflowAction(completedWidget, workflowStatus, result, executionError);

      // Keep the original tool card truthful across live updates and reloads.
      // The card starts as a review request, then becomes the durable terminal
      // status once this widget-backed execution finishes.
      if (widget.messageId) {
        const [linkedMessage] = await db.select({ metadata: chatMessagesTable.metadata })
          .from(chatMessagesTable)
          .where(eq(chatMessagesTable.id, widget.messageId))
          .limit(1);
        const currentMetadata = isPlainRecord(linkedMessage?.metadata)
          ? linkedMessage.metadata
          : {};
        const currentOutput = isPlainRecord(currentMetadata.toolOutput)
          ? currentMetadata.toolOutput
          : {};
        await db.update(chatMessagesTable)
          .set({
            metadata: {
              ...currentMetadata,
              success,
              error: executionError,
              widgetStatus: completedWidget.status,
              toolOutput: {
                ...currentOutput,
                awaitingSubmission: false,
              },
            },
          })
          .where(eq(chatMessagesTable.id, widget.messageId));
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const friendlyMessage = getFriendlyToolResultMessage(widget.toolName, success, result as any);
      const agentType = widget.agentType || 'orchestrator';
      let actionButtons: Array<Record<string, unknown>> | undefined;
      if (widget.toolName === 'generate_lead_inputs' && success && widget.runId) {
        const output = resultOutput;
        const schemas = Array.isArray(output.schemas) ? output.schemas.filter(isPlainRecord) : [];
        const platforms = Array.isArray(output.platforms) ? output.platforms.filter((value): value is string => typeof value === 'string') : [];
        const workflowIds = Array.isArray(output.workflowIds)
          ? output.workflowIds.filter((value): value is string => typeof value === 'string')
          : schemas.map(schema => schema.workflowId).filter((value): value is string => typeof value === 'string');
        const inputIds = Array.isArray(output.inputIds)
          ? output.inputIds.map(Number).filter((value): value is number => Number.isInteger(value) && value > 0)
          : [];
        const durableRun = await ensureConversationWorkflowRun({
          userId: widget.userId,
          threadId: widget.threadId,
          runId: widget.runId,
          stage: 'lead_inputs_generating',
        });
        const strategy = await getLatestLeadStrategySelection({
          runId: durableRun.id,
          userId: widget.userId,
          threadId: widget.threadId,
        }) || await createLeadStrategySelection({
            runId: durableRun.id,
            userId: widget.userId,
            threadId: widget.threadId,
            platforms,
            workflowIds,
            selection: { source: 'legacy_generated_input_widget', widgetId: widget.id },
          });
        const inputSet = typeof output.leadInputSetId === 'string' && Number.isInteger(output.leadInputSetRevision)
          ? { id: output.leadInputSetId, revision: Number(output.leadInputSetRevision) }
          : await createLeadInputSet({
          runId: durableRun.id,
          userId: widget.userId,
          threadId: widget.threadId,
          strategySelectionId: strategy.id,
          inputIds,
          platforms,
          workflowIds,
          snapshot: { schemas, widgetId: widget.id },
        });
        await transitionConversationWorkflowRun({
          runId: durableRun.id,
          userId: widget.userId,
          threadId: widget.threadId,
          toStage: 'lead_inputs_awaiting_approval',
          status: 'awaiting_approval',
          contextPatch: { leadInputSetId: inputSet.id, leadInputSetRevision: inputSet.revision },
        });
        const requestId = `lead-input-set:${inputSet.id}:${inputSet.revision}`;
        const threadMetadata = await getChatThreadMetadata(widget.threadId) || {};
        await updateChatThreadMetadata(widget.threadId, {
          ...threadMetadata,
          requiresApproval: true,
          pendingApproval: {
            toolName: 'execute_lead_workflow',
            args: {
              platforms,
              selected_workflows: workflowIds,
              leadInputSetId: inputSet.id,
              leadInputSetRevision: inputSet.revision,
              workflowRunId: durableRun.id,
            },
            executionId: requestId,
            message: 'Approve the reviewed lead inputs to run lead generation.',
            createdAt: Date.now(),
          },
        });
        actionButtons = [{
          id: `approve-lead-inputs-${inputSet.id}-${inputSet.revision}`,
          label: 'Approve & Run Lead Generation',
          action: 'approve_tool',
          type: 'primary',
          data: { requestId, toolName: 'execute_lead_workflow', inputSetId: inputSet.id, revision: inputSet.revision },
        }];
      }
      try {
        await createChatMessage({
          userId: widget.userId,
          threadId: widget.threadId,
          role: 'assistant',
          content: friendlyMessage,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          agentType: agentType as any,
          metadata: {
            isToolResult: false,
            toolName: widget.toolName,
            success,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            toolOutput: (result as any)?.output,
            error: executionError,
            widgetId: widget.id,
            ...(actionButtons ? { actionButtons, workflowResumed: true } : {}),
          },
        });

        webSocketEmitter.emitChatResponse(widget.userId, widget.threadId, {
          role: 'assistant',
          content: friendlyMessage,
          agentType,
          metadata: {
            isToolResult: false,
            toolName: widget.toolName,
            success,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            toolOutput: (result as any)?.output,
            error: executionError,
            widgetId: widget.id,
            responseId: `widget-tool-result-${widget.id}-${Date.now()}`,
            ...(actionButtons ? { actionButtons, workflowResumed: true } : {}),
          },
        });
      } catch (error: unknown) {
        logger.error({ err: error, widgetId: widget.id }, '[WidgetRoutes] Failed to persist widget result message');
      }

      // Release the review card from its running state immediately. Pipeline
      // continuation can involve another model turn and must not leave a
      // completed action displaying a leaked spinner while that turn runs.
      webSocketEmitter.emit(widget.userId, 'widget_update', {
        thread_id: widget.threadId,
        widget: completedWidget,
      });

      // The LLM turn intentionally stopped when this review widget was created.
      // Once every sibling card in the same run is terminal, continue the
      // original pipeline in memory without creating a synthetic user bubble.
      // generate_lead_inputs is excluded by the continuation guard because it
      // has a separate explicit execute/review gate.
      if (completedWidget.status === 'succeeded' || completedWidget.status === 'failed') {
        try {
          const { resumeWorkflowAfterWidgetCompletion } = await import('../mastra/chatController.js');
          await resumeWorkflowAfterWidgetCompletion({
            widgetId: completedWidget.id,
            userId: completedWidget.userId,
            threadId: completedWidget.threadId,
            toolName: completedWidget.toolName,
            runId: completedWidget.runId,
            success,
            result,
          });
        } catch (error) {
          logger.error({ err: error, widgetId: widget.id }, '[WidgetRoutes] Failed to resume widget workflow');
        }
      }

    })().catch((error: unknown) => {
      logger.error({ err: error, widgetId: widget.id, toolName: widget.toolName }, '[WidgetRoutes] Widget completion pipeline failed');
    });

    return res.status(202).json({ success: true, widget, running: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WidgetRoutes] Error submitting widget');
    return res.status(500).json({ error: 'Failed to submit widget' });
  }
});

/**
 * POST /api/widgets/:id/close
 * Close a widget (save as draft)
 */
router.post('/:id/close', authenticateToken, async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid widget ID' });
    const { status } = req.body;
    if (status !== undefined && !['draft', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'status must be draft or cancelled' });
    }
    const widget = await WidgetStateModel.closeForUser(id, userId, status || 'draft');
    if (!widget) return res.status(409).json({ error: 'Widget is not closable in its current state' });
    if ((status || 'draft') === 'cancelled') await updateWidgetWorkflowAction(widget, 'cancelled');
    return res.json({ success: true, widget });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WidgetRoutes] Error closing widget');
    return res.status(500).json({ error: 'Failed to close widget' });
  }
});

/**
 * POST /api/widgets/:id/reopen
 * Reopen a closed widget
 */
router.post('/:id/reopen', authenticateToken, async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid widget ID' });
    const widget = await WidgetStateModel.reopenForUser(id, userId);
    if (!widget) return res.status(409).json({ error: 'Widget is not reopenable in its current state' });
    return res.json({ success: true, widget });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WidgetRoutes] Error reopening widget');
    return res.status(500).json({ error: 'Failed to reopen widget' });
  }
});

/**
 * DELETE /api/widgets/:id
 * Delete a widget permanently
 */
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid widget ID' });
    const deleted = await WidgetStateModel.deleteForUser(id, userId);
    if (!deleted) return res.status(404).json({ error: 'Widget not found' });
    return res.json({ success: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WidgetRoutes] Error deleting widget');
    return res.status(500).json({ error: 'Failed to delete widget' });
  }
});

export default router;
