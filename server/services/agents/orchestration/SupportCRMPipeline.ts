import { sql } from 'drizzle-orm';
import { db } from '../../../models/db.js';
import { getCrmConfiguration } from '../../CRMConfigurationService.js';
import { selectAutomaticCrmStage, type CrmPipelineContext, type CrmStageDecision } from '../../../../shared/crmPipeline.js';
import type { ToolOutcome } from '../BaseOutreachAgent.js';
import { requireBusinessScope } from '../../../tenancy/businessContext.js';
import { savedContactResponse } from '../../automations/ContactAutomationHandoff.js';

export async function supportCrmPipelineContext(userId: number, conversationId: number, leadId?: number | null): Promise<CrmPipelineContext> {
  const configuration = await getCrmConfiguration(userId);
  const scope = requireBusinessScope();
  const contact = await db.execute(sql`
    SELECT contact.pipeline_status
    FROM crm_contacts contact
    WHERE contact.user_id = ${userId} AND contact.business_profile_id = ${scope.businessProfileId} AND contact.deleted_at IS NULL
      AND (
        EXISTS (SELECT 1 FROM outreach_conversations conversation
          WHERE conversation.id = ${conversationId} AND conversation.user_id = ${userId}
            AND conversation.business_profile_id = ${scope.businessProfileId}
            AND (conversation.crm_contact_id = contact.id
              OR (conversation.crm_contact_id IS NULL AND conversation.lead_id = contact.lead_id)))
        OR (${conversationId} < 0 AND contact.lead_id = ${leadId ?? null})
      )
    ORDER BY contact.id LIMIT 1
  `);
  return { stages: configuration.stages.map(({ key, label, type }) => ({ key, label, type })),
    currentStageKey: String(contact.rows[0]?.pipeline_status || 'new') };
}

function verifiedToolTransition(tools: ToolOutcome[] = []) {
  let verifiedOutcome: 'won' | 'lost' | undefined;
  let verifiedProgress: string | undefined;
  for (const tool of tools) {
    if (tool.status !== 'success' || tool.success !== true || !tool.result || typeof tool.result !== 'object') continue;
    const result = tool.result as Record<string, unknown>;
    if (tool.name === 'check_payment_status' && result.paid === true) verifiedOutcome = 'won';
    if (['confirm_booking', 'create_booking', 'finalize_booking'].includes(tool.name)
      && result.booked === true && tool.confirmedSideEffect) verifiedOutcome = 'won';
    if (tool.name === 'cancel_booking' && result.cancelled === true && tool.confirmedSideEffect) verifiedOutcome = 'lost';
    if (tool.name === 'create_conversation_proposal_draft' && result.delivered === true && tool.confirmedSideEffect) verifiedProgress = 'proposal_sent';
    if (tool.name === 'create_ticket' && result.ticket_created === true && tool.confirmedSideEffect) verifiedProgress = 'ticket_open';
  }
  return { verifiedOutcome, verifiedProgress };
}

export async function applySupportCrmStage(userId: number, contactId: number, input: {
  decision?: CrmStageDecision;
  legacyStage?: string;
  tools?: ToolOutcome[];
  conversation?: { kind: 'outreach' | 'widget'; id: number };
}) {
  // Always reload owner configuration at the commit boundary, including
  // deferred delivery. Draft metadata never defines the available stages.
  const configuration = await getCrmConfiguration(userId);
  const { crmService } = await import('../../CRMService.js');
  const contact = await crmService.getContactById(userId, contactId);
  if (!contact) return null;
  const currentKey = contact.pipelineStatus || 'new';
  const target = selectAutomaticCrmStage(configuration, currentKey, {
    decision: input.decision, legacyStage: input.legacyStage, ...verifiedToolTransition(input.tools),
  });
  if (!target) return { contact, stage: configuration.stages.find(stage => stage.key === currentKey), changed: false };
  const updated = await crmService.updatePipelineStatus(userId, contact.id, target.key, { automatic: true, expectedStageType: target.type,
    // A routine unchanged observation must not resume an older pending edit.
    recoverableAutomation: currentKey !== target.key ? 'pipeline' : false,
    ...(input.conversation ? { insightsConversation: input.conversation } : {}) });
  if (!updated) throw new Error('The CRM contact could not be updated.');
  const final = await savedContactResponse(userId, updated);
  return { contact: final, stage: configuration.stages.find(stage => stage.key === final.pipelineStatus),
    changed: currentKey !== final.pipelineStatus };
}
