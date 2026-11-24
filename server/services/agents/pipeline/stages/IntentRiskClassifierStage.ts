import { PipelineHalt, type PipelineStage } from "../PipelineStage.js";
import type { PipelineContext } from "../ChannelGateway.js";
import { nluService } from "../../NLUService.js";
import { logger } from "../../../../utils/logger.js";
import { supportCrmPipelineContext } from '../../orchestration/SupportCRMPipeline.js';
import { UNCHANGED_CRM_DECISION, type CrmPipelineContext } from '../../../../../shared/crmPipeline.js';
import { db } from '../../../../models/db.js';
import { sql } from 'drizzle-orm';
import { parseExternalSearchCountCorrection } from '../../../booking/ExternalBookingSearchUrl.js';
import { hospitalityStayLeadForm } from '../../orchestration/CustomerTurnUnderstanding.js';

export class IntentRiskClassifierStage implements PipelineStage {
  name = "IntentRiskClassifier";

  async execute(ctx: PipelineContext): Promise<PipelineContext> {
    if (ctx.metadata?.skipAgentGeneration && ctx.agentResult) return ctx;
    const { userId, inboundText } = ctx.message;
    if (!inboundText || !inboundText.trim()) return ctx;

    const selection = ctx.metadata?.activePlaybookSelection;
    if (ctx.metadata?.agentConfig?.agentType === 'hotel_sales'
      && ['journey.type', 'stay.roomPreference'].includes(selection?.fieldKey)
      && [selection?.label, selection?.value].some(value => typeof value === 'string'
        && value.trim().toLocaleLowerCase('en-US') === inboundText.trim().toLocaleLowerCase('en-US'))
      && !ctx.metadata?.activeHandoff && !ctx.metadata?.suspendPlaybookForHandoff
      && ctx.metadata?.historyStatus !== 'unavailable'
      && !ctx.message.metadata?.publicReply && !ctx.message.channel.endsWith('_comment')) {
      // This exact published choice was verified by ActivePlaybookSelection.
      // It answers that field; it never authorizes a booking or human handoff.
      ctx.nlu = { intent: 'clarify', secondaryIntents: [], entities: {}, needsHuman: false,
        semanticRequest: { action: 'other', service: 'stay', explicit: false, topicSwitch: false,
          pricingRequested: false, media: 'none', confidence: 1 },
        sentiment: { label: 'neutral', score: 0 }, urgency: 'low', riskLevel: 'low', riskFactors: [], classificationConfidence: 1,
        summary: 'The customer selected the current published enquiry or room preference.',
        crmStageDecision: { ...UNCHANGED_CRM_DECISION } };
      ctx.confidence = 1;
      return ctx;
    }

    if(ctx.metadata?.agentConfig?.agentType==='hotel_sales'
      && !ctx.metadata?.activeHandoff && !ctx.metadata?.suspendPlaybookForHandoff
      && !ctx.message.metadata?.publicReply && !ctx.message.channel.endsWith('_comment')
      && hospitalityStayLeadForm(inboundText)) {
      ctx.nlu={intent:'sales_inquiry',secondaryIntents:[],entities:{},needsHuman:false,
        semanticRequest:{action:'information',service:'stay',explicit:true,topicSwitch:true,pricingRequested:false,media:'none',confidence:1},
        sentiment:{label:'neutral',score:0},urgency:'low',riskLevel:'low',riskFactors:[],classificationConfidence:1,
        summary:'The customer submitted a stay enquiry with a date window and guest range; exact dates and occupancy are still needed.',
        crmStageDecision:{...UNCHANGED_CRM_DECISION}};
      ctx.confidence=1;return ctx;
    }

    const searchCount = ctx.metadata?.completedPublicSearchCount;
    const correction = searchCount && parseExternalSearchCountCorrection(inboundText);
    if (correction && ctx.message.channel === 'whatsapp'
      && ctx.message.metadata?.executionMode === 'customer' && !ctx.message.metadata?.dryRun
      && !ctx.metadata?.activeHandoff && !ctx.metadata?.suspendPlaybookForHandoff
      && Object.keys(searchCount.correction || {}).length === 1
      && Object.entries(correction).every(([key,value]) => searchCount.correction[key] === value)) {
      // ActivePlaybookSelection verified the acknowledged completed search in
      // the current published assistant/binding after inbound safety checks.
      // This is only a public search correction, never booking/handoff consent.
      ctx.nlu = { intent: 'booking_request', secondaryIntents: [], entities: {},
        semanticRequest: { action: 'correction', service: 'stay', explicit: true,
          topicSwitch: false, pricingRequested: false, media: 'none', confidence: 1 },
        sentiment: { label: 'neutral', score: 0 }, urgency: 'low', needsHuman: false,
        summary: 'The customer corrected a public booking search guest or room count.',
        riskLevel: 'low', riskFactors: [], classificationConfidence: 1,
        crmStageDecision: { ...UNCHANGED_CRM_DECISION } };
      ctx.confidence = 1;
      return ctx;
    }

    // A provider-native generic template reply opens a conversation; it is
    // neither an unanswered factual question nor consent to any action. Read
    // the persisted inbound event rather than trusting caller metadata or text.
    if (ctx.message.channel === 'whatsapp' && ctx.message.messageId
      && inboundText.trim().toLowerCase() === 'reply here'
      && ctx.message.metadata?.executionMode !== 'preview' && !ctx.message.metadata?.dryRun
      && !ctx.metadata?.activeHandoff && !ctx.metadata?.suspendPlaybookForHandoff
      && ctx.metadata?.historyStatus !== 'unavailable') {
      const result = await db.execute(sql`
        SELECT m.metadata->'nativeSelection' AS selection
        FROM outreach_messages m
        JOIN outreach_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id
          AND c.business_profile_id=m.business_profile_id
        WHERE m.id=${ctx.message.messageId} AND m.user_id=${userId}
          AND m.conversation_id=${ctx.message.conversationId} AND m.direction='inbound'
          AND c.channel='whatsapp'
        LIMIT 1
      `);
      const selection = (result.rows[0] as { selection?: { kind?: string; title?: string } } | undefined)?.selection;
      if (selection?.kind === 'template_button' && selection.title?.trim().toLowerCase() === 'reply here') {
        ctx.nlu = {
          intent: 'greeting', secondaryIntents: [], entities: {},
          semanticRequest: { action: 'other', service: 'general', explicit: false,
            topicSwitch: false, pricingRequested: false, media: 'none', confidence: 1 },
          sentiment: { label: 'neutral', score: 0 }, urgency: 'low', needsHuman: false,
          summary: 'The customer opened the conversation using the template reply button.',
          riskLevel: 'low', riskFactors: [], classificationConfidence: 1,
          crmStageDecision: { ...UNCHANGED_CRM_DECISION },
        };
        ctx.confidence = 1;
        return ctx;
      }
    }

    // This metadata is produced only by ActivePlaybookSelectionStage after
    // tenant policy and inbound safety checks, from the immutable active run.
    // A valid answer such as 0 children must not become a durable handoff when
    // the model provider is rate-limited. All downstream policies still run.
    const count = ctx.metadata?.activePlaybookCount;
    if (count && /^\d{1,4}$/.test(inboundText.trim()) && Number(inboundText.trim()) === count.value) {
      ctx.nlu = {
        intent: 'clarify', secondaryIntents: [], entities: {},
        sentiment: { label: 'neutral', score: 0 }, urgency: 'low',
        needsHuman: false, summary: 'The customer answered the current occupancy question.',
        riskLevel: 'low', riskFactors: [], classificationConfidence: 1,
      };
      ctx.confidence = 1;
      return ctx;
    }

    const history = Array.isArray(ctx.message.metadata?.conversationHistory)
      ? ctx.message.metadata.conversationHistory.slice(-3)
      : [];
    const recent = history.map((turn: { role?: unknown; content?: unknown }) =>
      `${turn.role === 'assistant' ? 'Agent' : 'Customer'}: ${String(turn.content || '')}`,
    ).join('\n');

    let crmPipeline: CrmPipelineContext | undefined;
    try {
      crmPipeline = await supportCrmPipelineContext(userId, ctx.message.conversationId, ctx.message.leadId);
    } catch (err) {
      logger.warn({ err, userId }, '[IntentRiskClassifierStage] CRM configuration unavailable; preserving the current stage');
    }

    try {
      const nlu = await nluService.analyze(userId, inboundText, recent, {
        executionMode: ctx.message.metadata?.executionMode,
        conversationKind: ctx.message.metadata?.conversationKind,
        crmPipeline,
      });
      // Missing catalog/uncertain extraction must not authorize an old
      // hard-coded specialist signal to close or regress this contact.
      nlu.crmStageDecision ||= { ...UNCHANGED_CRM_DECISION };
      ctx.nlu = nlu;
      
      // Seed confidence score from classification confidence initially
      ctx.confidence = nlu.classificationConfidence;
    } catch (err) {
      logger.error({ err }, '[IntentRiskClassifierStage] NLU analysis failed');
      ctx.confidence = 0;
      throw new PipelineHalt('Intent and risk classification could not be completed safely.', ctx, 'human_handoff');
    }

    return ctx;
  }
}
