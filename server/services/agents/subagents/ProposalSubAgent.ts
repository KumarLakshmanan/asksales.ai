import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../../models/db.js';
import { proposalsTable } from '../../../models/proposals/schema.js';
import { proposalLineItemsTable } from '../../../models/proposalLineItems/schema.js';
import { outreachConversationsTable } from '../../../models/outreachConversations/schema.js';
import type { ProposalDocumentMetadata, ProposalRequirements } from '../../../../shared/proposals.js';
import { SubAgentBase, type SubAgentContext, type SubAgentResult } from './SubAgentBase.js';
import { validateSupportToolArgs } from '../orchestration/SupportToolSchemas.js';
import { isToolExposed, supportToolIdempotencyKey, supportToolScopeError } from '../orchestration/SafeToolExecutor.js';
import { redactPiiWithStableTokens } from '../orchestration/PrivacyVaultService.js';
import { resolveWidgetProposalIdentity } from '../orchestration/SupportWidgetProposalIdentity.js';
import { isPositiveSafeInteger as positiveId } from '../../../../shared/numbers.js';

const PRIVATE_CHANNELS = new Set(['email', 'gmail', 'whatsapp', 'facebook', 'instagram', 'web', 'sms', 'linkedin', 'twitter']);
const CUSTOMER_DOCUMENT_STATUSES = new Set(['sent', 'viewed', 'accepted', 'rejected', 'expired', 'superseded']);
const REVISION_STATUSES = new Set(['draft', 'sent', 'viewed', 'rejected', 'expired']);
type ProposalRow = typeof proposalsTable.$inferSelect;

function result(name: string, payload: Record<string, unknown>): SubAgentResult {
  return { toolResults: [{ name, result: payload }] };
}

function unavailable(name: string): SubAgentResult {
  // Do not distinguish missing records from records belonging to another customer.
  return result(name, { success: false, code: 'conversation_proposal_unavailable', confirmedSideEffect: false });
}

function reviewRequested(name: string, payload: Record<string, unknown>): SubAgentResult {
  // Seller review belongs to the saved proposal's approval lifecycle, not a
  // takeover of the support conversation. Escalation here blocks the successful
  // receipt on accounts that require an explicit customer handoff request.
  return result(name, { success: true, confirmedSideEffect: true, seller_review_required: true, delivered: false, ...payload });
}

function redactedText(value: unknown): string {
  return typeof value === 'string' ? redactPiiWithStableTokens(value).redactedText : '';
}

function customerRequirements(value: unknown): ProposalRequirements | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  return Object.fromEntries(['objectives', 'deliverables', 'timeline', 'responsibilities', 'budget']
    .filter(key => typeof fields[key] === 'string')
    .map(key => [key, redactedText(fields[key])])) as ProposalRequirements;
}

/** A draft is internal authoring material. Only confirmed customer documents can
 * contribute prices, title, or terms to a support reply. Never return metadata,
 * internal notes, AI assumptions, approval decisions, or public-link credentials. */
export function customerProposalSummary(proposal: Pick<ProposalRow,
  'id' | 'proposalNumber' | 'title' | 'status' | 'sentAt' | 'validUntil'
  | 'currency' | 'subtotal' | 'discountType' | 'discountValue' | 'taxRate' | 'total'> & {metadata?: ProposalDocumentMetadata | null}) {
  const published = Boolean(proposal.sentAt) && CUSTOMER_DOCUMENT_STATUSES.has(proposal.status);
  const base = {
    proposal_id: proposal.id,
    proposal_number: published ? proposal.proposalNumber : undefined,
    status: published ? proposal.status : proposal.metadata?.automaticSendEligible === true ? (proposal.status === 'delivery_unknown' ? 'delivery_not_confirmed' : proposal.metadata?.teamApproval && (proposal.metadata.teamApproval as {status?:string}).status === 'pending' ? 'awaiting_seller_review' : 'not_sent') : 'awaiting_seller_review',
  };
  if (!published) return base;
  const subtotal = Number(proposal.subtotal || 0);
  const discountValue = Number(proposal.discountValue || 0);
  const discount = Math.min(subtotal, Math.max(0, proposal.discountType === 'percentage'
    ? subtotal * discountValue / 100 : proposal.discountType === 'fixed' ? discountValue : 0));
  const tax = Math.max(0, (subtotal - discount) * Number(proposal.taxRate || 0) / 100);
  const expired = ['sent', 'viewed'].includes(proposal.status)
    && proposal.validUntil && proposal.validUntil.getTime() < Date.now();
  return {
    ...base,
    status: expired ? 'expired' : proposal.status,
    title: proposal.title,
    currency: proposal.currency,
    subtotal: subtotal.toFixed(2),
    discount: discount.toFixed(2),
    tax: tax.toFixed(2),
    total: proposal.total,
    valid_until: proposal.validUntil,
    sent_at: proposal.sentAt,
  };
}

/** Copies document content while dropping every prior send, approval, signature,
 * recipient override and delivery-attempt field. Review begins again on a draft. */
export function revisionDocumentMetadata(metadata: ProposalDocumentMetadata | null): ProposalDocumentMetadata {
  return {
    ...(metadata?.generatedSections ? { generatedSections: metadata.generatedSections } : {}),
    ...(metadata?.commercial ? { commercial: metadata.commercial } : {}),
    ...(metadata?.requirements ? { requirements: metadata.requirements } : {}),
    ...(metadata?.assumptions ? { assumptions: metadata.assumptions } : {}),
    ...(metadata?.onboardingPlan ? { onboardingPlan: metadata.onboardingPlan } : {}),
    ...(metadata?.templateSnapshot ? { templateSnapshot: metadata.templateSnapshot } : {}),
    ...(metadata?.templateValues ? { templateValues: metadata.templateValues } : {}),
    ...(metadata?.requiredTemplateFields ? { requiredTemplateFields: metadata.requiredTemplateFields } : {}),
  };
}

export class ProposalSubAgent extends SubAgentBase {
  readonly metadata = {
    id: 'proposal',
    name: 'Proposal Sub-Agent',
    description: 'Finds this conversation’s proposals and prepares requested offers according to the account review settings.',
    intents: ['proposal_request', 'proposal_status', 'proposal_revision'],
    priority: 30,
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_conversation_proposals',
          description: 'Look up proposals linked to this customer conversation. Returns confirmed customer-facing prices only for proposals already sent. Unsent drafts expose only review status. Never invent a public link or claim a draft has been sent.',
          parameters: {
            type: 'object', additionalProperties: false,
            properties: { proposal_id: { type: 'integer', description: 'Optional ID returned by this tool in the current conversation.' } },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'create_conversation_proposal_draft',
          description: 'Prepare a proposal only when this customer requests a proposal or written offer. The account setting determines whether a complete, catalog-priced offer is sent automatically or saved for review. Explicit draft-only requests are never sent. Capture stated requirements and ask only for missing details. Never claim a send unless the tool confirms delivered=true. This tool cannot book, sign, choose another recipient or invent prices.',
          parameters: {
            type: 'object', additionalProperties: false,
            properties: {
              title: { type: 'string', maxLength: 500, description: 'A short descriptive title based on the customer’s request.' },
              context: { type: 'string', maxLength: 8000, description: 'Only customer-stated requirements and relevant context; not instructions to the seller or invented commitments.' },
              requirements: {
                type: 'object', additionalProperties: false,
                properties: Object.fromEntries(['objectives', 'deliverables', 'timeline', 'responsibilities', 'budget']
                  .map(key => [key, { type: 'string', maxLength: 4000 }])),
              },
            },
            required: ['title'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'request_proposal_revision',
          description: 'Prepare the customer’s requested changes to a proposal in this conversation. Eligible revised offers follow the account automatic-send setting; explicit drafts remain unsent. Use either a proposal ID obtained from get_conversation_proposals or the customer’s exact proposal number. Ask which proposal if ambiguous. Keeps the existing offer intact until replacement delivery is confirmed. Never claim booking or acceptance.',
          parameters: {
            type: 'object', additionalProperties: false,
            properties: {
              proposal_id: { type: 'integer' },
              proposal_number: { type: 'string', maxLength: 50, description: 'The exact proposal number shown on the customer’s proposal. Provide this or proposal_id, never both.' },
              requested_changes: { type: 'string', maxLength: 8000, description: 'Changes explicitly requested by the customer.' },
            },
            required: ['requested_changes'],
          },
        },
      },
    ],
  };

  async execute(name: string, suppliedArgs: Record<string, unknown>, ctx: SubAgentContext): Promise<SubAgentResult> {
    if (!this.metadata.tools.some(tool => tool.function.name === name)
      || !isToolExposed(name, ctx.agentConfig?.toolsEnabled)) {
      return result(name, { success: false, code: 'tool_not_enabled', wouldExecute: false, confirmedSideEffect: false });
    }
    const scopeError = supportToolScopeError(name, ctx.playbookDirective, ctx.agentConfig?.agentType);
    if (scopeError) return result(name, { success: false, code: scopeError, wouldExecute: false, confirmedSideEffect: false });
    const validation = validateSupportToolArgs(name, suppliedArgs);
    if (!validation.success) return result(name, { success: false, code: 'invalid_tool_arguments', confirmedSideEffect: false });
    // Defence in depth for direct registry/resume calls, in addition to the
    // canonical executor's dry-run gate. Simulators never create drafts/feedback.
    if (ctx.dryRun || (ctx.executionMode && ctx.executionMode !== 'customer')) {
      return result(name, { success: false, code: 'dry_run_suppressed', wouldExecute: true, confirmedSideEffect: false });
    }
    if (ctx.channel === 'web' && ctx.conversationId < 0) {
      if (!ctx.widgetSession || ctx.widgetSession.id !== -ctx.conversationId) return unavailable(name);
      const identity = await resolveWidgetProposalIdentity({ userId: ctx.userId,
        sessionId: ctx.widgetSession.id, token: ctx.widgetSession.token, create: name === 'create_conversation_proposal_draft' });
      if (!identity) return unavailable(name);
      ctx = { ...ctx, conversationId: identity.conversationId, lead: { id: identity.leadId, name: 'Webchat visitor' } };
    }
    if (!positiveId(ctx.userId) || !positiveId(ctx.conversationId) || !positiveId(ctx.lead.id)
      || !PRIVATE_CHANNELS.has(ctx.channel)) return unavailable(name);

    const [conversation] = await db.select({ id: outreachConversationsTable.id })
      .from(outreachConversationsTable).where(and(
        eq(outreachConversationsTable.userId, ctx.userId),
        eq(outreachConversationsTable.id, ctx.conversationId),
        eq(outreachConversationsTable.leadId, ctx.lead.id),
        eq(outreachConversationsTable.channel, ctx.channel),
      )).limit(1);
    if (!conversation) return unavailable(name);
    const args = validation.data;
    const scope = and(
      eq(proposalsTable.userId, ctx.userId),
      eq(proposalsTable.outreachConversationId, ctx.conversationId),
      or(eq(proposalsTable.leadId, ctx.lead.id), isNull(proposalsTable.leadId)),
    );

    if (name === 'get_conversation_proposals') {
      const records = await db.select({
        id: proposalsTable.id, proposalNumber: proposalsTable.proposalNumber, title: proposalsTable.title,
        status: proposalsTable.status, sentAt: proposalsTable.sentAt, validUntil: proposalsTable.validUntil,
        currency: proposalsTable.currency, subtotal: proposalsTable.subtotal, discountType: proposalsTable.discountType,
        discountValue: proposalsTable.discountValue, taxRate: proposalsTable.taxRate, total: proposalsTable.total, metadata: proposalsTable.metadata,
      }).from(proposalsTable).where(and(scope, args.proposal_id ? eq(proposalsTable.id, Number(args.proposal_id)) : undefined))
        .orderBy(desc(proposalsTable.createdAt)).limit(10);
      return result(name, { success: true, confirmedSideEffect: false, proposals: records.map(customerProposalSummary) });
    }

    const actionKey = supportToolIdempotencyKey(name, args, ctx);
    const { proposalService } = await import('../../ProposalService.js');
    if (name === 'create_conversation_proposal_draft') {
      const { tryAutomaticSupportProposal } = await import('../../AutomaticSupportProposalService.js');
      const automatic = await tryAutomaticSupportProposal(ctx, args, actionKey);
      if (automatic) return result(name, automatic);
      const created = await proposalService.createProposal(ctx.userId, {
        title: redactedText(args.title),
        outreachConversationId: ctx.conversationId,
        leadId: ctx.lead.id,
        businessProfileId: positiveId(ctx.businessProfileId) ? ctx.businessProfileId : undefined,
        approvalRequired: true,
        draftKey: actionKey,
        requirements: customerRequirements(args.requirements),
        metadata: { supportRequest: {
          source: 'customer_support', channel: ctx.channel,
          ...(ctx.widgetSession ? { widgetSessionId: ctx.widgetSession.id, identity: 'session_only', requiresVerifiedDeliveryContact: true } : {}),
          context: redactedText(args.context || ctx.inboundText),
          requestedAt: new Date().toISOString(),
        } },
      });
      return reviewRequested(name, {
        proposal_id: created.id,
        status: 'awaiting_seller_review',
        note: 'A draft request was recorded. The seller must complete and review the proposal before it can be sent.',
      });
    }

    const [original] = await db.select().from(proposalsTable)
      .where(and(scope, args.proposal_id !== undefined
        ? eq(proposalsTable.id, Number(args.proposal_id))
        : eq(proposalsTable.proposalNumber, String(args.proposal_number)))).limit(1);
    if (!original) return unavailable(name);
    if (!REVISION_STATUSES.has(original.status) || original.signedAt) {
      return {
        ...result(name, { success: false, code: 'proposal_requires_seller_review', confirmedSideEffect: false }),
        escalated: true, escalationType: 'sales',
        escalationReason: `The customer requested changes to proposal #${original.id}; its current agreement or delivery state requires seller review.`,
      };
    }
    const changes = redactedText(args.requested_changes);
    // The feedback and follow-up pause commit together before draft generation.
    // Even if the document adapter later fails, the seller has the customer's
    // request and no stale proposal reminder is queued for that customer.
    const feedback = await db.transaction(async (tx: typeof db) => {
      const current = await tx.execute(sql`SELECT id FROM proposals WHERE id=${original.id}
        AND user_id=${ctx.userId} AND outreach_conversation_id=${ctx.conversationId}
        AND (lead_id=${ctx.lead.id} OR lead_id IS NULL) AND revision=${original.revision}
        AND status=${original.status} AND signed_at IS NULL FOR UPDATE`);
      if (!current.rows.length) return null;
      const inserted = await tx.execute(sql`INSERT INTO proposal_feedback
        (user_id, proposal_id, kind, author_name, content, source_key)
        VALUES (${ctx.userId},${original.id},'change_request',${ctx.lead.name || null},${changes},${actionKey})
        ON CONFLICT (business_profile_id, user_id, source_key) WHERE source_key IS NOT NULL DO NOTHING RETURNING id`);
      const existing = inserted.rows[0] || (await tx.execute(sql`SELECT id FROM proposal_feedback
        WHERE user_id=${ctx.userId} AND proposal_id=${original.id} AND source_key=${actionKey} LIMIT 1`)).rows[0];
      if (!existing) throw new Error('The proposal change request could not be recorded.');
      await tx.execute(sql`UPDATE proposal_reminders SET status='paused', last_sent_at=NULL,
        metadata=COALESCE(metadata,'{}'::jsonb)||${JSON.stringify({ pauseReason: 'change_request', pausedAt: new Date().toISOString() })}::jsonb, updated_at=NOW()
        WHERE user_id=${ctx.userId} AND proposal_id=${original.id} AND reminder_type='customer_followup'
        AND status IN ('pending','snoozed')`);
      return { id: Number(existing.id) };
    });
    if (!feedback) return unavailable(name);

    try {
      const lineItems = await db.select().from(proposalLineItemsTable)
        .where(eq(proposalLineItemsTable.proposalId, original.id)).orderBy(proposalLineItemsTable.sortOrder);
      const { tryAutomaticSupportProposal } = await import('../../AutomaticSupportProposalService.js');
      const automatic = await tryAutomaticSupportProposal(ctx, {
        title: original.title, requested_changes: changes,
        original_scope: original.coverNote, original_items: lineItems.map((item: typeof proposalLineItemsTable.$inferSelect) => ({catalogId:item.catalogId,name:item.name,quantity:item.quantity,unit:item.unit})),
      }, actionKey, original.id);
      if (automatic) return result(name, {...automatic,confirmedSideEffect:true,original_proposal_id:original.id,request_id:feedback.id});
      const authoring = revisionDocumentMetadata(original.metadata);
      const created = await proposalService.createProposal(ctx.userId, {
        title: original.title,
        outreachConversationId: ctx.conversationId,
        leadId: ctx.lead.id,
        contactId: original.contactId || undefined,
        businessProfileId: original.businessProfileId || undefined,
        templateId: original.templateId || undefined,
        draftKey: actionKey,
        approvalRequired: true,
        autoOnboard: original.metadata?.autoOnboard !== false,
        coverNote: original.coverNote || undefined,
        currency: original.currency || 'USD',
        discountType: original.discountType === 'percentage' || original.discountType === 'fixed' ? original.discountType : null,
        discountValue: Number(original.discountValue || 0),
        taxRate: Number(original.taxRate || 0),
        validUntil: original.validUntil || undefined,
        signatureRequired: original.signatureRequired === true,
        showTermsAndConditions: original.showTermsAndConditions === true,
        termsAndConditions: original.termsAndConditions || undefined,
        generatedSections: authoring.generatedSections,
        commercial: authoring.commercial,
        requirements: authoring.requirements,
        assumptions: authoring.assumptions,
        onboardingPlan: authoring.onboardingPlan,
        templateValues: authoring.templateValues,
        knowledgeBaseSections: original.knowledgeBaseSections || [],
        lineItems: lineItems.map((item: typeof proposalLineItemsTable.$inferSelect) => ({
          ...item,
          billingPeriod: (['one_time', 'monthly', 'quarterly', 'yearly'].includes(item.billingPeriod)
            ? item.billingPeriod : 'one_time') as 'one_time' | 'monthly' | 'quarterly' | 'yearly',
        })),
        metadata: {
          ...authoring,
          revisionOf: original.id,
          supportRequest: { source: 'customer_support', channel: ctx.channel,
            requestedChanges: changes, feedbackId: feedback.id, requestedAt: new Date().toISOString() },
        },
      });
      return reviewRequested(name, {
        proposal_id: created.id, original_proposal_id: original.id,
        request_id: feedback.id, status: 'awaiting_seller_review',
        note: 'The requested changes were recorded and a separate draft was prepared. The existing proposal is unchanged. A seller must review and send any revised offer.',
      });
    } catch {
      // The request is durably saved even if copying a retired template/catalog
      // item fails. Do not report an invented draft or replay the customer request.
      return reviewRequested(name, {
        original_proposal_id: original.id, request_id: feedback.id,
        status: 'request_recorded', draft_status: 'not_created',
        note: 'The change request was saved for the seller, but a revision draft could not be prepared. The seller must prepare the revised offer.',
      });
    }
  }
}

export const proposalSubAgent = new ProposalSubAgent();
