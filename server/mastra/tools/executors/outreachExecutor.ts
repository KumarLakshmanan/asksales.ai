/** Campaign conversations use the same reviewed batch admission as Compose outreach. */
import type { ToolContext } from '../toolRegistry.js';
import type { ToolResult } from '../../state';
import { INBOX_CHANNELS, type InboxChannel } from '../../../../shared/outreachInbox.js';

export async function executeSendOutreachMessages(input: {
  lead_ids: number[]; channel: string; template_id?: string; provider_account_id?: string;
  subject?: string; body?: string; scheduled_for?: string; outreach_review?: Record<string, unknown>;
}, context: ToolContext): Promise<ToolResult> {
  const toolName = 'send_outreach_messages';
  if (!context.widgetId || !input.outreach_review) return {
    success: false, toolName, requiresApproval: true,
    error: 'Open the outreach review card and review the account, recipients, messages and follow-ups before sending.',
    output: { status: 'requires_review', retrySafe: true, channel: input.channel, leadIds: input.lead_ids },
  };
  const review = input.outreach_review;
  const messages = review.messages as Array<{ leadId?: number }> | undefined;
  if (!INBOX_CHANNELS.includes(input.channel as InboxChannel) || review.channel !== input.channel || review.creationVersion !== 1
    || review.followUpSource !== 'outreach' || review.useSavedFollowUpSettings !== undefined || review.campaignManualReviewId !== undefined
    || !Array.isArray(messages) || !messages.length
    || !Array.isArray(input.lead_ids) || new Set(input.lead_ids).size !== input.lead_ids.length
    || new Set(messages.map(message => message.leadId)).size !== messages.length
    || messages.length !== input.lead_ids.length || messages.some(message => !input.lead_ids.includes(Number(message.leadId)))) return {
      success: false, toolName, error: 'The outreach review does not match the selected channel and recipients. Review it again.',
      output: { status: 'failed_before_side_effect', retrySafe: true },
    };
  const { executeOutreachBatch } = await import('../../../controllers/outreachConversationsController.js');
  const result = await executeOutreachBatch(Number(context.userId), review, `campaign-widget-${context.widgetId}`, { id: context.widgetId, threadId: Number(context.threadId) });
  const body = result.body;
  if (result.status >= 400) return { success: false, toolName, error: String(body.error || 'Outreach could not be prepared.'),
    output: { ...body, status: result.status >= 500 || body.code === 'REQUEST_KEY_CONFLICT' ? 'needs_attention' : 'failed_before_side_effect', retrySafe: result.status < 500 && body.code !== 'REQUEST_KEY_CONFLICT' } };
  const queued = Number(body.queued || 0), uncertain = Number(body.uncertain || 0);
  const hasSavedMessages = Array.isArray(body.results) && body.results.some((item: { messageId?: number }) => Number(item.messageId) > 0);
  const accepted = queued > 0 || uncertain > 0 || body.inProgress === true;
  if (queued && Array.isArray(body.results)) {
    const rejected = body.results.filter((item: { status?: string }) => item.status === 'error');
    if (rejected.length) {
      const { WidgetStateModel } = await import('../../../models/widgetStates/functions.js');
      for (const item of rejected) await WidgetStateModel.recordQueuedJobOutcomeForUser(
        context.widgetId, Number(context.userId), `batch-rejection-${item.leadId}`, messages.length, false, item,
      );
    }
  }
  return { success: accepted, toolName,
    ...(!queued && !uncertain && !body.inProgress ? { error: 'No messages were queued. Review the recipient errors.' } : {}),
    output: { ...body, success: accepted, channel: input.channel, leadIds: input.lead_ids,
      status: uncertain || body.inProgress ? 'needs_attention' : queued ? (body.errors ? 'queued_partial' : 'queued') : 'failed_before_side_effect',
      successCount: queued, totalLeads: messages.length, failCount: Number(body.errors || 0), retrySafe: !accepted && !hasSavedMessages,
      message: uncertain || body.inProgress ? 'Queue confirmation is pending. Check outreach history before retrying.' : `${queued} messages queued with their own follow-up settings.`,
    },
  };
}
