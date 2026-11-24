import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../models/db.js';
import { proposalCatalogTable } from '../models/proposalWorkspace/schema.js';
import { calculateProposalPricing, type ProposalCommercial, type ProposalDocumentMetadata, type ProposalLineItem, type ProposalOnboardingPlan, type ProposalRequirements, type ProposalSection, type ProposalSourceReference } from '../../shared/proposals.js';

export type ProposalDraftEnhancements = {
  draftKey?: string;
  generatedSections?: ProposalSection[];
  commercial?: ProposalCommercial;
  requirements?: ProposalRequirements;
  assumptions?: string[];
  onboardingPlan?: ProposalOnboardingPlan;
  templateValues?: Record<string, string>;
  generationMode?: 'fill_missing' | 'replace_selected';
  generationSections?: number[];
};

export class ProposalDocumentError extends Error {
  readonly statusCode = 400;
}

export function proposalSourceReferences(refs: { contactId?: number; leadId?: number; outreachConversationId?: number; supportTicketId?: number; chatThreadId?: number; businessProfileId?: number }): ProposalSourceReference[] {
  const fields = [
    ['contactId', 'contact', 'CRM contact'], ['leadId', 'lead', 'Lead'],
    ['outreachConversationId', 'outreach', 'Outreach conversation'], ['supportTicketId', 'support', 'Support ticket'],
    ['chatThreadId', 'campaign', 'Campaign chat'], ['businessProfileId', 'business', 'Business profile'],
  ] as const;
  return fields.flatMap(([key, kind, label]) => refs[key] ? [{ kind, id: refs[key], label: `${label} #${refs[key]}` }] : []);
}

export function documentMetadata(data: ProposalDraftEnhancements, previous: ProposalDocumentMetadata = {}): ProposalDocumentMetadata {
  return { ...previous,
    ...(data.generatedSections !== undefined ? { generatedSections: data.generatedSections } : {}),
    ...(data.commercial !== undefined ? { commercial: data.commercial } : {}),
    ...(data.requirements !== undefined ? { requirements: data.requirements } : {}),
    ...(data.assumptions !== undefined ? { assumptions: data.assumptions } : {}),
    ...(data.onboardingPlan !== undefined ? { onboardingPlan: data.onboardingPlan } : {}),
  };
}

/** Resolve catalog identity within the tenant. Preserve an existing quote's agreed price when its catalog changes. */
export async function prepareProposalLineItems(userId: number, items: ProposalLineItem[], currency: string, previous: ProposalLineItem[] = []) {
  const catalogIds = [...new Set(items.flatMap(item => item.catalogId ? [item.catalogId] : []))];
  const catalog = catalogIds.length ? await db.select().from(proposalCatalogTable)
    .where(and(eq(proposalCatalogTable.userId, userId), inArray(proposalCatalogTable.id, catalogIds))) : [];
  return items.map((item, index) => {
    const approved = item.catalogId ? catalog.find((entry: typeof proposalCatalogTable.$inferSelect) => entry.id === item.catalogId) : undefined;
    if (item.catalogId && (!approved || approved.currency !== currency)) throw new ProposalDocumentError(`Catalog item ${index + 1} is unavailable in ${currency}.`);
    const existingCatalogSnapshot = approved && previous.some(entry => Number(entry.catalogId) === approved.id);
    if (approved && !approved.active && !existingCatalogSnapshot) throw new ProposalDocumentError(`“${approved.name}” is retired. Choose an active catalog item.`);
    const name = (approved && !existingCatalogSnapshot ? approved.name : item.name)?.trim();
    const description = approved && !existingCatalogSnapshot ? approved.description : item.description;
    const unit = approved && !existingCatalogSnapshot ? approved.unit : item.unit || approved?.unit || 'unit';
    const quantity = Number(item.quantity ?? 1);
    const unitPrice = Number(approved && !existingCatalogSnapshot ? approved.unitPrice : item.unitPrice ?? approved?.unitPrice ?? 0);
    const discount = Number(item.discount ?? 0);
    if (item.billingPeriod && !['one_time', 'monthly', 'quarterly', 'yearly'].includes(item.billingPeriod)) throw new ProposalDocumentError(`Line item ${index + 1} has an invalid billing period.`);
    if (!name || !Number.isFinite(quantity) || quantity <= 0 || quantity > 100000 || !Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(discount) || discount < 0 || discount > quantity * unitPrice) throw new ProposalDocumentError(`Line item ${index + 1} has invalid pricing or no name.`);
    return {
      name, description: description || null,
      quantity, unitPrice, discount, unit,
      catalogId: approved?.id || null,
      isComplimentary: item.isComplimentary === true && unitPrice === 0,
      priceConfirmed: item.isComplimentary === true || (item.priceConfirmed ?? unitPrice > 0),
      isOptional: !!item.isOptional, selected: item.isOptional ? item.selected === true : true,
      packageId: item.packageId || null, billingPeriod: item.billingPeriod || 'one_time',
      sortOrder: index,
    };
  });
}

export function proposalLineItemRows(proposalId: number, items: Awaited<ReturnType<typeof prepareProposalLineItems>>, metadata?: ProposalDocumentMetadata) {
  const pricing = calculateProposalPricing({ lineItems: items, metadata });
  return pricing.rows.map((item, index) => ({
    proposalId, sortOrder: index, name: item.name, description: item.description || null,
    quantity: String(item.quantity), unitPrice: String(item.unitPrice), discount: String(item.discount),
    unit: item.unit || 'unit', total: String(item.total), catalogId: item.catalogId || null,
    isComplimentary: !!item.isComplimentary, priceConfirmed: !!item.priceConfirmed,
    isOptional: !!item.isOptional, selected: !!item.selected, packageId: item.packageId || null, billingPeriod: item.billingPeriod || 'one_time',
  }));
}
