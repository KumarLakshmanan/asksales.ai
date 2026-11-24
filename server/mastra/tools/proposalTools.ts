import crypto from 'node:crypto';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ToolContext } from './toolRegistry.js';
import { getEffectiveModuleAccess } from '../../models/platformAccess/functions.js';
import {
  calculateProposalPricing,
  missingProposalRequirements,
  proposalLineItemInput,
  type ProposalDocument,
  type ProposalDocumentMetadata,
  type ProposalSection,
} from '../../../shared/proposals.js';

const statusSchema = z.enum(['draft', 'sending', 'delivery_unknown', 'sent', 'viewed', 'accepted', 'rejected', 'expired', 'superseded']);
const channelSchema = z.enum(['email', 'whatsapp', 'facebook', 'instagram', 'sms', 'linkedin', 'twitter', 'web']);
const requirementsSchema = z.object({
  objectives: z.string().trim().max(10_000).optional(),
  deliverables: z.string().trim().max(10_000).optional(),
  timeline: z.string().trim().max(5_000).optional(),
  responsibilities: z.string().trim().max(10_000).optional(),
  budget: z.string().trim().max(5_000).optional(),
}).strict();
const whatsappTemplateSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  language: z.string().regex(/^[A-Za-z_]{2,20}$/),
  components: z.array(z.unknown()).max(100),
}).strict();

export const sendProposalFromChatSchema = z.object({
  proposalId: z.number().int().positive(),
  channel: channelSchema.default('email'),
  outreachConversationId: z.number().int().positive().optional(),
  leadId: z.number().int().positive().optional(),
  providerAccountId: z.string().trim().max(255).optional(),
  providerVariant: z.enum(['gmail', 'resend']).optional(),
  recipientName: z.string().trim().max(255).optional(),
  recipientEmail: z.string().trim().email().max(320).optional(),
  subject: z.string().trim().min(1).max(500).optional(),
  message: z.string().trim().min(1).max(10_000).optional(),
  whatsappTemplate: whatsappTemplateSchema.optional(),
  expectedRevision: z.number().int().positive().optional(),
  expectedTargetFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expectedReviewFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
  proposalTitle: z.string().max(500).optional(),
  proposalNumber: z.string().max(100).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  total: z.number().finite().nonnegative().optional(),
  resolvedRecipient: z.string().max(500).optional(),
  reviewUrl: z.string().max(1000).optional(),
}).strict();

type SendProposalFromChatInput = z.infer<typeof sendProposalFromChatSchema>;
type ProposalSummaryInput = ProposalDocument & {
  id: number;
  proposalNumber?: string | null;
  status?: string;
  revision?: number;
  leadId?: number | null;
  readiness?: { ready?: boolean; issues?: unknown[] } | null;
};
type TemplateSummaryInput = {
  id: number;
  name: string;
  description?: string | null;
  category?: string | null;
  version?: number;
  lineItems?: unknown[] | null;
};
type CatalogSummaryInput = {
  id: number;
  name: string;
  description?: string | null;
  currency: string;
  unitPrice: number | string;
  unit?: string | null;
  active: boolean;
};
const requirementQuestions = {
  objectives: 'What customer outcome should this proposal achieve?',
  deliverables: 'Which deliverables and exclusions should the proposal state?',
  timeline: 'What timeline or target start date has the customer agreed?',
  responsibilities: 'What responsibilities belong to the customer and to the delivery team?',
  budget: 'What budget or payment expectations should the proposal reflect?',
} as const;

async function authorize(context?: ToolContext) {
  if (!context?.userId || !context.threadId) throw new Error('Authenticated campaign proposal context is required');
  const access = (await getEffectiveModuleAccess(context.userId)).find(module => module.key === 'proposals');
  if (!access?.enabled) throw new Error(access?.message || 'Proposals are not available for this account');
  return context;
}

function requestedLeadIds(context: ToolContext, input: { leadId?: number; leadIds?: number[] }) {
  const explicit = input.leadIds?.length ? input.leadIds : input.leadId ? [input.leadId] : [];
  const selected = [...new Set((context.selectedLeadIds || []).map(Number))];
  if (!selected.length) throw new Error('Select at least one lead in this campaign conversation before creating a proposal.');
  const resolved = [...new Set((explicit.length ? explicit : selected).map(Number))];
  if (resolved.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Proposal creation requires valid persisted lead IDs.');
  if (selected.length && explicit.some(id => !selected.includes(id))) {
    throw new Error('Use only the lead IDs selected in this campaign conversation.');
  }
  return resolved;
}

function proposalSummary(proposal: ProposalSummaryInput) {
  const pricing = calculateProposalPricing(proposal);
  const metadata = proposal.metadata || {};
  const missingRequirements = missingProposalRequirements(metadata.requirements);
  return {
    id: proposal.id,
    proposalNumber: proposal.proposalNumber,
    title: proposal.title,
    status: proposal.status,
    revision: proposal.revision,
    recipientName: proposal.recipientName,
    recipientEmail: proposal.recipientEmail,
    leadId: proposal.leadId,
    currency: proposal.currency,
    total: pricing.total,
    validUntil: proposal.validUntil,
    ready: proposal.readiness?.ready,
    issues: proposal.readiness?.issues || [],
    missingRequirements,
    requirementQuestions: missingRequirements.map(field => ({ field, question: requirementQuestions[field] })),
    sources: metadata.sources || [],
    assumptions: metadata.assumptions || [],
    reviewUrl: `/dashboard/proposals/${proposal.id}`,
    editUrl: proposal.status === 'draft' ? `/dashboard/proposals/${proposal.id}/edit` : undefined,
  };
}

function deliveryInput(input: Omit<SendProposalFromChatInput, 'channel'> & { channel?: SendProposalFromChatInput['channel'] }) {
  return {
    channel: input.channel || 'email',
    outreachConversationId: input.outreachConversationId,
    leadId: input.leadId,
    providerAccountId: input.providerAccountId,
    providerVariant: input.providerVariant,
    recipientName: input.recipientName,
    recipientEmail: input.recipientEmail,
    subject: input.subject,
    message: input.message,
    whatsappTemplate: input.whatsappTemplate,
    expectedRevision: input.expectedRevision,
    idempotencyKey: input.idempotencyKey,
  };
}

function assertSelectedRecipient(context: ToolContext, leadId: number | null | undefined) {
  const selected = [...new Set((context.selectedLeadIds || []).map(Number))];
  if (!selected.length) {
    throw new Error('Select the proposal customer lead in this campaign conversation before continuing.');
  }
  if (!leadId || !selected.includes(Number(leadId))) {
    throw new Error('This proposal is not linked to a lead selected in the current campaign conversation.');
  }
}

export const listProposalTemplatesTool = createTool({
  id: 'list_proposal_templates',
  description: 'List real proposal templates available to this seller. Use a returned ID; never invent a template ID.',
  inputSchema: z.object({}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (_input, { mastra }: any) => {
    const context = await authorize(mastra?.__toolContext);
    const { proposalService } = await import('../../services/ProposalService.js');
    const templates = await proposalService.getTemplates(context.userId);
    return {
      success: true,
      toolName: 'list_proposal_templates',
      output: templates.map((template: TemplateSummaryInput) => ({
        id: template.id,
        name: template.name,
        description: template.description,
        category: template.category,
        version: template.version,
        lineItemCount: Array.isArray(template.lineItems) ? template.lineItems.length : 0,
      })),
    };
  },
});

export const listProposalCatalogTool = createTool({
  id: 'list_proposal_catalog',
  description: 'List active, tenant-approved proposal services with their stable catalog IDs and exact prices. Use a returned ID before adding a service; never infer one from its name.',
  inputSchema: z.object({
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    search: z.string().trim().max(255).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }).strict(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const context = await authorize(mastra?.__toolContext);
    const { proposalService } = await import('../../services/ProposalService.js');
    const items = await proposalService.getCatalogItems(context.userId, {
      currency: input.currency,
      search: input.search,
      activeOnly: true,
      limit: input.limit,
    });
    return {
      success: true,
      toolName: 'list_proposal_catalog',
      output: {
        items: items.map((item: CatalogSummaryInput) => ({
          id: item.id,
          name: item.name,
          description: item.description || '',
          currency: item.currency,
          unitPrice: Number(item.unitPrice),
          unit: item.unit || 'unit',
        })),
        total: items.length,
      },
    };
  },
});

export const listProposalsTool = createTool({
  id: 'list_proposals',
  description: 'List or inspect saved proposals owned by this seller. Use this before refining, revising, or sending an existing proposal.',
  inputSchema: z.object({
    proposalId: z.number().int().positive().optional(),
    status: statusSchema.optional(),
    leadId: z.number().int().positive().optional(),
    search: z.string().trim().max(255).optional(),
    scope: z.enum(['current_campaign', 'all']).default('current_campaign'),
    limit: z.number().int().min(1).max(20).default(10),
  }).strict(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const context = await authorize(mastra?.__toolContext);
    const { proposalService } = await import('../../services/ProposalService.js');
    if (input.proposalId) {
      const proposal = await proposalService.getProposalById(context.userId, input.proposalId);
      if (!proposal) return { success: false, toolName: 'list_proposals', error: 'Proposal not found.' };
      assertSelectedRecipient(context, proposal.leadId);
      return { success: true, toolName: 'list_proposals', output: { proposals: [proposalSummary(proposal)], total: 1 } };
    }
    if (input.leadId) assertSelectedRecipient(context, input.leadId);
    const result = await proposalService.getProposals(context.userId, {
      status: input.status,
      search: input.search,
      limit: input.limit,
      chatThreadId: input.scope === 'current_campaign' ? context.threadId : undefined,
    });
    const listed = result.proposals as Array<{ id: number; leadId?: number | null }>;
    const candidates = input.leadId
      ? listed.filter(proposal => Number(proposal.leadId) === input.leadId)
      : context.selectedLeadIds?.length
        ? listed.filter(proposal => proposal.leadId && context.selectedLeadIds!.includes(Number(proposal.leadId)))
        : listed;
    const proposals = await Promise.all(candidates.map(proposal => proposalService.getProposalById(context.userId, proposal.id)));
    return { success: true, toolName: 'list_proposals', output: { proposals: proposals.filter(Boolean).map(proposalSummary), total: proposals.filter(Boolean).length, scope: input.scope } };
  },
});

export const createProposalDraftTool = createTool({
  id: 'create_proposal_draft',
  description: 'Create one customer-specific proposal draft for each requested selected lead, grounded in the campaign chat, selected template, business profile, knowledge base, and approved catalog. This saves drafts for seller review, returns source references and exact questions for missing requirements, and never sends.',
  inputSchema: z.object({
    title: z.string().trim().min(1).max(500),
    context: z.string().trim().max(30_000).optional(),
    templateId: z.number().int().positive().optional(),
    leadId: z.number().int().positive().optional(),
    leadIds: z.array(z.number().int().positive()).min(1).max(10).optional(),
    outreachConversationId: z.number().int().positive().optional(),
    supportTicketId: z.number().int().positive().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).default('USD'),
    validUntil: z.string().datetime().optional(),
    signatureRequired: z.boolean().default(false),
    requirements: requirementsSchema.optional(),
    assumptions: z.array(z.string().trim().min(1).max(2_000)).max(30).optional(),
    templateValues: z.record(z.string(), z.string().max(10_000)).optional(),
    generateWithAI: z.boolean().default(true),
  }).strict().superRefine((value, issue) => {
    if (value.leadId && value.leadIds?.length) issue.addIssue({ code: z.ZodIssueCode.custom, path: ['leadIds'], message: 'Use leadId or leadIds, not both.' });
    if ((value.outreachConversationId || value.supportTicketId) && value.leadIds && value.leadIds.length > 1) issue.addIssue({ code: z.ZodIssueCode.custom, path: ['leadIds'], message: 'A conversation or support ticket can create a proposal for only one customer.' });
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const context = await authorize(mastra?.__toolContext);
    const leadIds = requestedLeadIds(context, input);
    if ((input.outreachConversationId || input.supportTicketId) && leadIds.length > 1) {
      throw new Error('Choose exactly one selected lead when creating a proposal from a conversation or support ticket.');
    }
    if (!leadIds.length && !input.outreachConversationId && !input.supportTicketId) {
      throw new Error('Select at least one lead, outreach conversation, or support ticket before creating a campaign proposal.');
    }
    const targets: Array<number | undefined> = leadIds.length ? leadIds : [undefined];
    const { proposalService } = await import('../../services/ProposalService.js');
    const operationId = context.runContext?.turnId || context.runContext?.actionId || crypto.randomUUID();
    const proposals: Array<Record<string, unknown>> = [];
    const failures: Array<{ leadId?: number; error: string }> = [];
    for (const [index, leadId] of targets.entries()) {
      const digest = crypto.createHash('sha256').update(JSON.stringify({ operationId, index, leadId, title: input.title, templateId: input.templateId })).digest('hex').slice(0, 28);
      const draft = {
        title: input.title,
        context: input.context,
        coverNote: input.generateWithAI ? undefined : input.context,
        templateId: input.templateId,
        leadId,
        outreachConversationId: input.outreachConversationId,
        supportTicketId: input.supportTicketId,
        chatThreadId: context.threadId,
        businessProfileId: context.companyProfile?.id,
        currency: input.currency,
        validUntil: input.validUntil ? new Date(input.validUntil) : undefined,
        signatureRequired: input.signatureRequired,
        requirements: input.requirements,
        assumptions: input.assumptions,
        templateValues: input.templateValues,
        approvalRequired: true,
        autoOnboard: true,
        draftKey: `campaign-proposal-${context.threadId}-${digest}`,
      };
      try {
        const proposal = input.generateWithAI
          ? await proposalService.generateProposalFromKBAndProfile(context.userId, draft)
          : await proposalService.createProposal(context.userId, draft);
        const saved = await proposalService.getProposalById(context.userId, proposal.id);
        if (saved) proposals.push(proposalSummary(saved));
      } catch (error) {
        failures.push({ leadId, error: error instanceof Error ? error.message : 'Proposal draft could not be created.' });
      }
    }
    const success = failures.length === 0;
    return {
      success,
      toolName: 'create_proposal_draft',
      ...(success ? {} : { error: proposals.length ? 'Some proposal drafts could not be created.' : failures[0]?.error || 'Proposal drafts could not be created.' }),
      output: { status: success ? 'drafts_created' : proposals.length ? 'partial_success' : 'failed', proposals, failures, createdCount: proposals.length },
    };
  },
});

export const refineProposalDraftTool = createTool({
  id: 'refine_proposal_draft',
  description: 'Refine selected text in the same saved draft with AI while preserving customer identity, pricing, packages, milestones, sources, and every unselected section. Requires the current revision and never sends.',
  inputSchema: z.object({
    proposalId: z.number().int().positive(),
    expectedRevision: z.number().int().positive(),
    instructions: z.string().trim().min(1).max(20_000),
    sectionIndexes: z.array(z.number().int().nonnegative()).max(100).optional(),
    refineCoverNote: z.boolean().default(false),
    refineTerms: z.boolean().default(false),
  }).strict(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const context = await authorize(mastra?.__toolContext);
    const { proposalService } = await import('../../services/ProposalService.js');
    const current = await proposalService.getProposalById(context.userId, input.proposalId);
    if (!current) return { success: false, toolName: 'refine_proposal_draft', error: 'Proposal not found.' };
    assertSelectedRecipient(context, current.leadId);
    if (current.status !== 'draft') return { success: false, toolName: 'refine_proposal_draft', error: 'Create a revision before refining a proposal that is no longer a draft.' };
    if (current.revision !== input.expectedRevision) return { success: false, toolName: 'refine_proposal_draft', error: `The proposal is now revision ${current.revision}. Reload it before refining.` };
    const metadata = (current.metadata || {}) as ProposalDocumentMetadata;
    const existingSections = (metadata.generatedSections || []) as ProposalSection[];
    const selectedSections = input.sectionIndexes?.length ? [...new Set(input.sectionIndexes)] : existingSections.map((_, index) => index);
    if (selectedSections.some(index => index >= existingSections.length)) return { success: false, toolName: 'refine_proposal_draft', error: 'A selected proposal section no longer exists.' };
    const refineCoverNote = input.refineCoverNote || (!existingSections.length && !input.refineTerms);
    if (!selectedSections.length && !refineCoverNote && !input.refineTerms) return { success: false, toolName: 'refine_proposal_draft', error: 'Choose a section, cover note, or terms to refine.' };
    const generatedSections = existingSections.map((section, index) => selectedSections.includes(index) ? { ...section, body: '' } : section);
    const suggestion = await proposalService.suggestProposalDraft(context.userId, {
      title: current.title,
      context: input.instructions,
      templateId: current.templateId || undefined,
      leadId: current.leadId || undefined,
      contactId: current.contactId || undefined,
      outreachConversationId: current.outreachConversationId || undefined,
      supportTicketId: Number(metadata.supportTicketId || 0) || undefined,
      chatThreadId: context.threadId,
      businessProfileId: current.businessProfileId || undefined,
      recipientName: current.recipientName || undefined,
      recipientEmail: current.recipientEmail || undefined,
      currency: current.currency || 'USD',
      validUntil: current.validUntil || undefined,
      signatureRequired: current.signatureRequired === true,
      coverNote: refineCoverNote ? '' : current.coverNote || undefined,
      termsAndConditions: input.refineTerms ? '' : current.termsAndConditions || undefined,
      lineItems: current.lineItems.map(proposalLineItemInput),
      discountType: current.discountType === 'fixed' || current.discountType === 'percentage' ? current.discountType : null,
      discountValue: Number(current.discountValue || 0),
      taxRate: Number(current.taxRate || 0),
      generatedSections,
      generationMode: 'replace_selected',
      generationSections: selectedSections,
      commercial: metadata.commercial,
      requirements: metadata.requirements,
      assumptions: metadata.assumptions,
      templateValues: metadata.templateValues,
    });
    const updated = await proposalService.updateProposal(context.userId, current.id, {
      expectedRevision: input.expectedRevision,
      ...(existingSections.length ? { generatedSections: suggestion.generatedSections } : {}),
      ...(refineCoverNote ? { coverNote: suggestion.coverNote || '' } : {}),
      ...(input.refineTerms ? { termsAndConditions: suggestion.termsAndConditions || '', showTermsAndConditions: true } : {}),
    });
    return { success: true, toolName: 'refine_proposal_draft', output: { status: 'draft_refined', proposal: proposalSummary(updated), preservedPricing: true, refinedSectionIndexes: selectedSections, refinedCoverNote: refineCoverNote, refinedTerms: input.refineTerms } };
  },
});

export const addProposalCatalogItemsTool = createTool({
  id: 'add_proposal_catalog_items',
  description: 'Add exact tenant-approved catalog services to an owned proposal draft by stable catalog ID. Requires the current revision, rejects duplicates, preserves all existing content and pricing, and never sends.',
  inputSchema: z.object({
    proposalId: z.number().int().positive(),
    expectedRevision: z.number().int().positive(),
    catalogItemIds: z.array(z.number().int().positive()).min(1).max(20),
  }).strict().superRefine((value, issue) => {
    if (new Set(value.catalogItemIds).size !== value.catalogItemIds.length) {
      issue.addIssue({ code: z.ZodIssueCode.custom, path: ['catalogItemIds'], message: 'Choose each catalog item only once.' });
    }
  }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const context = await authorize(mastra?.__toolContext);
    if (new Set(input.catalogItemIds).size !== input.catalogItemIds.length) {
      return { success: false, toolName: 'add_proposal_catalog_items', error: 'Choose each catalog item only once.' };
    }
    const { proposalService } = await import('../../services/ProposalService.js');
    const current = await proposalService.getProposalById(context.userId, input.proposalId);
    if (!current) return { success: false, toolName: 'add_proposal_catalog_items', error: 'Proposal not found.' };
    assertSelectedRecipient(context, current.leadId);
    if (current.status !== 'draft') {
      return { success: false, toolName: 'add_proposal_catalog_items', error: 'Create a revision before adding services to a proposal that is no longer a draft.' };
    }
    if (current.revision !== input.expectedRevision) {
      return { success: false, toolName: 'add_proposal_catalog_items', error: `The proposal is now revision ${current.revision}. Reload it before adding services.` };
    }
    const currentLineItems = (current.lineItems || []) as NonNullable<ProposalDocument['lineItems']>;
    const existingItems = currentLineItems.map(proposalLineItemInput);
    const existingCatalogIds = new Set(existingItems.flatMap(item => item.catalogId ? [Number(item.catalogId)] : []));
    const duplicates = input.catalogItemIds.filter(id => existingCatalogIds.has(id));
    if (duplicates.length) {
      return { success: false, toolName: 'add_proposal_catalog_items', error: `Catalog item ${duplicates.join(', ')} is already included in this proposal.` };
    }
    const catalogItems = await proposalService.getCatalogItems(context.userId, {
      ids: input.catalogItemIds,
      currency: current.currency || 'USD',
      activeOnly: true,
      limit: input.catalogItemIds.length,
    }) as CatalogSummaryInput[];
    const byId = new Map(catalogItems.map(item => [item.id, item]));
    const unavailable = input.catalogItemIds.filter(id => !byId.has(id));
    if (unavailable.length) {
      return { success: false, toolName: 'add_proposal_catalog_items', error: `Catalog item ${unavailable.join(', ')} is inactive, unavailable, or uses another currency.` };
    }
    const addedItems = input.catalogItemIds.map(id => {
      const item = byId.get(id)!;
      const unitPrice = Number(item.unitPrice);
      return {
        catalogId: item.id,
        name: item.name,
        description: item.description || '',
        quantity: 1,
        unitPrice,
        unit: item.unit || 'unit',
        discount: 0,
        isComplimentary: false,
        priceConfirmed: unitPrice > 0,
        isOptional: false,
        selected: true,
        packageId: null,
        billingPeriod: 'one_time' as const,
      };
    });
    const updated = await proposalService.updateProposal(context.userId, current.id, {
      expectedRevision: input.expectedRevision,
      lineItems: [...existingItems, ...addedItems],
    });
    if (!updated) return { success: false, toolName: 'add_proposal_catalog_items', error: 'Proposal not found.' };
    const updatedLineItems = (updated.lineItems || []) as NonNullable<ProposalDocument['lineItems']>;
    const addedCatalogItems = input.catalogItemIds.map(id => updatedLineItems.find(item => Number(item.catalogId) === id)!);
    return {
      success: true,
      toolName: 'add_proposal_catalog_items',
      output: {
        status: 'catalog_items_added',
        proposal: proposalSummary(updated),
        addedCatalogItems: addedCatalogItems.map(item => ({
          id: Number(item.catalogId),
          name: item.name,
          currency: current.currency || 'USD',
          unitPrice: Number(item.unitPrice),
          unit: item.unit || 'unit',
        })),
        preservedLineItemCount: existingItems.length,
      },
    };
  },
});

export const createProposalRevisionTool = createTool({
  id: 'create_proposal_revision',
  description: 'Create a new full-fidelity draft revision of an owned proposal, optionally tied to an exact customer feedback item. The earlier customer link remains valid until the revision is actually delivered.',
  inputSchema: z.object({
    proposalId: z.number().int().positive(),
    expectedRevision: z.number().int().positive(),
    feedbackId: z.number().int().positive().optional(),
  }).strict(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const context = await authorize(mastra?.__toolContext);
    const { proposalService } = await import('../../services/ProposalService.js');
    const current = await proposalService.getProposalById(context.userId, input.proposalId);
    if (!current) return { success: false, toolName: 'create_proposal_revision', error: 'Proposal not found.' };
    assertSelectedRecipient(context, current.leadId);
    const { proposalLifecycleService } = await import('../../services/ProposalLifecycleService.js');
    const operationId = context.runContext?.turnId || context.runContext?.actionId || crypto.randomUUID();
    const revision = await proposalLifecycleService.createRevision(context.userId, input.proposalId, {
      expectedRevision: input.expectedRevision,
      feedbackId: input.feedbackId,
      draftKey: `campaign-revision-${context.threadId}-${crypto.createHash('sha256').update(`${operationId}:${input.proposalId}:${input.expectedRevision}:${input.feedbackId || 0}`).digest('hex').slice(0, 28)}`,
    });
    return { success: true, toolName: 'create_proposal_revision', output: { status: 'revision_created', proposal: proposalSummary(revision), previousProposalId: input.proposalId } };
  },
});

export const sendProposalTool = createTool({
  id: 'send_proposal',
  description: 'Prepare an exact proposal delivery review for Email, WhatsApp, Facebook Messenger, Instagram, SMS, LinkedIn, or X. This first call never sends. It resolves the real recipient and provider account and requires explicit approval of the frozen proposal and delivery fingerprints.',
  inputSchema: sendProposalFromChatSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: async (input, { mastra }: any) => {
    const context = await authorize(mastra?.__toolContext);
    const { proposalDeliveryService } = await import('../../services/ProposalDeliveryService.js');
    const review = await proposalDeliveryService.prepare(context.userId, input.proposalId, deliveryInput(input));
    assertSelectedRecipient(context, review.target.leadId);
    if (!['draft', 'sent', 'viewed'].includes(review.proposal.status)) {
      return { success: false, toolName: 'send_proposal', error: `A ${review.proposal.status} proposal cannot be sent.` };
    }
    if (!review.ready) {
      return { success: false, toolName: 'send_proposal', error: 'Complete the proposal delivery checklist before requesting approval.', output: { status: 'gated', issues: review.issues, proposal: proposalSummary(review.proposal) } };
    }
    const pricing = calculateProposalPricing(review.proposal);
    const frozen: SendProposalFromChatInput = {
      proposalId: input.proposalId,
      channel: review.target.channel,
      outreachConversationId: review.target.outreachConversationId || undefined,
      leadId: review.target.leadId || undefined,
      providerAccountId: review.target.providerAccountId,
      providerVariant: review.target.providerVariant,
      recipientName: review.target.recipientName,
      recipientEmail: review.target.recipientEmail || undefined,
      subject: review.target.subject,
      message: review.target.message,
      whatsappTemplate: review.target.whatsappTemplate,
      expectedRevision: review.proposal.revision,
      expectedTargetFingerprint: review.targetFingerprint,
      expectedReviewFingerprint: review.reviewFingerprint,
      idempotencyKey: `campaign-proposal-send-${context.threadId}-${context.runContext?.turnId || crypto.randomUUID()}`,
      proposalTitle: review.proposal.title,
      proposalNumber: review.proposal.proposalNumber,
      currency: review.proposal.currency || 'USD',
      total: pricing.total,
      resolvedRecipient: review.target.recipientEmail || review.target.recipientName || review.target.recipient,
      reviewUrl: `/dashboard/proposals/${input.proposalId}`,
    };
    return {
      success: true,
      toolName: 'send_proposal',
      requiresApproval: true,
      output: {
        status: 'approval_pending',
        message: `Review ${review.proposal.proposalNumber || `proposal ${input.proposalId}`} for ${review.target.recipientName} and approve this exact ${review.target.channel} delivery.`,
        args: frozen,
        issues: review.issues,
      },
    };
  },
});

/** Executes only after the campaign approval receipt has claimed the frozen request. */
export async function executeApprovedProposalDelivery(rawInput: unknown, rawContext?: ToolContext) {
  const context = await authorize(rawContext);
  const input = sendProposalFromChatSchema.parse(rawInput);
  if (!input.expectedRevision || !input.expectedTargetFingerprint || !input.expectedReviewFingerprint || !input.idempotencyKey) {
    return { success: false, toolName: 'send_proposal', error: 'This proposal review is incomplete or stale. Prepare it again.', output: { status: 'gated', retrySafe: false } };
  }
  const { proposalDeliveryService } = await import('../../services/ProposalDeliveryService.js');
  const { reviewProposalForDelivery } = await import('../../services/ProposalApprovalService.js');
  const prepared = await proposalDeliveryService.prepare(context.userId, input.proposalId, deliveryInput(input));
  assertSelectedRecipient(context, prepared.target.leadId);
  if (prepared.targetFingerprint !== input.expectedTargetFingerprint || prepared.reviewFingerprint !== input.expectedReviewFingerprint) {
    return { success: false, toolName: 'send_proposal', error: 'The proposal, recipient, message, or provider account changed. Prepare a fresh review.', output: { status: 'gated', retrySafe: false } };
  }
  const approval = await reviewProposalForDelivery(context.userId, input.proposalId, {
    ...deliveryInput(input),
    expectedRevision: input.expectedRevision,
    expectedTargetFingerprint: input.expectedTargetFingerprint,
    expectedReviewFingerprint: input.expectedReviewFingerprint,
  });
  if (!approval.approved) {
    return {
      success: true,
      toolName: 'send_proposal',
      output: {
        status: 'awaiting_team_review',
        proposalId: input.proposalId,
        reviewUrl: input.reviewUrl,
        reasons: approval.requirement.reasons,
        reviewerMemberIds: approval.requirement.reviewerMemberIds,
        message: 'Seller review is recorded. The proposal was not sent because assigned team reviews are still pending.',
      },
    };
  }
  const result = await proposalDeliveryService.send(context.userId, input.proposalId, {
    ...deliveryInput(input),
    expectedRevision: approval.revision,
    idempotencyKey: input.idempotencyKey,
  });
  const sent = result.delivery.state === 'sent';
  return {
    success: sent,
    toolName: 'send_proposal',
    ...(sent ? {} : { error: result.delivery.state === 'uncertain' ? 'The provider outcome is uncertain. Reconcile the provider receipt before any new send.' : result.delivery.error || 'The proposal was not delivered.' }),
    output: {
      status: sent ? 'sent' : result.delivery.state === 'uncertain' ? 'needs_attention' : 'failed',
      proposalId: input.proposalId,
      publicUrl: result.publicUrl,
      delivery: result.delivery,
      proposal: result.proposal ? proposalSummary(result.proposal as ProposalSummaryInput) : undefined,
      retrySafe: false,
      sideEffectsMayHaveOccurred: result.delivery.state === 'uncertain',
    },
  };
}
