import { roundMoney as money } from './money.js';
import { isEmailAddress } from './emailAddress.js';
export { money };
/** Shared customer-document rules. Keep this module free of browser, database and provider imports. */
export type ProposalChannel = 'email' | 'whatsapp' | 'facebook' | 'instagram' | 'sms' | 'linkedin' | 'twitter' | 'web';
export type BillingPeriod = 'one_time' | 'monthly' | 'quarterly' | 'yearly';
export type ProposalSection = {
  title: string;
  body: string;
  kind: 'cover' | 'content' | 'terms' | 'closing';
  /** Authoring guidance is never rendered as part of the customer document. */
  instruction?: string;
};
export type ProposalLineItem = {
  id?: number | string;
  catalogId?: number | null;
  name: string;
  description?: string | null;
  quantity?: number | string | null;
  unitPrice?: number | string | null;
  unit?: string | null;
  discount?: number | string | null;
  total?: number | string | null;
  isComplimentary?: boolean;
  priceConfirmed?: boolean;
  isOptional?: boolean;
  selected?: boolean;
  packageId?: string | null;
  billingPeriod?: BillingPeriod;
};
export type ProposalPackage = { id: string; name: string; description?: string };
export type ProposalMilestone = { id: string; title: string; percentage: number; dueDate?: string | null };
export type ProposalCommercial = {
  packages?: ProposalPackage[];
  selectedPackageId?: string | null;
  milestones?: ProposalMilestone[];
};
export type ProposalOnboardingItem = {
  id: string;
  title: string;
  deliverable?: string;
  dueDate?: string | null;
};
export type ProposalOnboardingPlan = {
  teamId?: number | null;
  assignedMemberId?: number | null;
  dueDate?: string | null;
  checklist?: ProposalOnboardingItem[];
};
export type ProposalOnboardingOutcome = {
  status: 'pending' | 'created' | 'failed' | 'disabled';
  supportTicketId?: number | null;
  teamId?: number | null;
  assignedMemberId?: number | null;
  createdAt?: string;
  lastError?: string;
};
export type ProposalSourceReference = { kind: 'contact' | 'lead' | 'outreach' | 'support' | 'campaign' | 'knowledge' | 'business'; id?: number; label: string };
export type ProposalRequirements = {
  objectives?: string;
  deliverables?: string;
  timeline?: string;
  responsibilities?: string;
  budget?: string;
};
export type ProposalDocumentMetadata = {
  generatedSections?: ProposalSection[];
  commercial?: ProposalCommercial;
  requirements?: ProposalRequirements;
  sources?: ProposalSourceReference[];
  assumptions?: string[];
  approvalRequired?: boolean;
  approvedAt?: string | null;
  approvalFingerprint?: string | null;
  autoOnboard?: boolean;
  onboardingPlan?: ProposalOnboardingPlan;
  onboarding?: ProposalOnboardingOutcome;
  supportTicketId?: number | null;
  revisionOf?: number;
  templateSnapshot?: {
    name?: string;
    version?: number;
    content?: unknown;
  } | null;
  templateValues?: Record<string, string>;
  requiredTemplateFields?: string[];
  missingTemplateFields?: string[];
  [key: string]: unknown;
};
export type ProposalDocument = {
  title: string;
  proposalNumber?: string;
  coverNote?: string | null;
  recipientName?: string | null;
  recipientEmail?: string | null;
  currency?: string | null;
  status?: string;
  validUntil?: string | Date | null;
  termsAndConditions?: string | null;
  showTermsAndConditions?: boolean | null;
  discountType?: string | null;
  discountValue?: number | string | null;
  taxRate?: number | string | null;
  lineItems?: ProposalLineItem[];
  metadata?: ProposalDocumentMetadata | null;
};
export type ReadinessIssue = {
  code: string;
  field: string;
  message: string;
  severity: 'error' | 'warning';
};

export const PROPOSAL_CHANNEL_LABELS: Record<ProposalChannel, string> = {
  email: 'Email', whatsapp: 'WhatsApp', facebook: 'Facebook Messenger', instagram: 'Instagram',
  sms: 'SMS', linkedin: 'LinkedIn', twitter: 'X', web: 'Webchat',
};

export function isSelectedProposalItem(item: ProposalLineItem, commercial?: ProposalCommercial): boolean {
  return (!item.isOptional || item.selected === true)
    && (!item.packageId || item.packageId === commercial?.selectedPackageId);
}

/** Recurring lines contribute their first period to the initial total, not an invented contract value. */
export function calculateProposalPricing(proposal: Pick<ProposalDocument, 'lineItems' | 'discountType' | 'discountValue' | 'taxRate' | 'metadata'>) {
  const commercial = proposal.metadata?.commercial;
  const rows = (proposal.lineItems || []).map(item => {
    const gross = money(Number(item.quantity ?? 1) * Number(item.unitPrice ?? 0));
    const discount = money(Math.min(gross, Math.max(0, Number(item.discount ?? 0))));
    return { ...item, total: money(gross - discount), included: isSelectedProposalItem(item, commercial) };
  });
  const subtotal = money(rows.filter(item => item.included).reduce((sum, item) => sum + item.total, 0));
  const discountValue = Math.max(0, Number(proposal.discountValue ?? 0));
  const discount = money(Math.min(subtotal, proposal.discountType === 'percentage'
    ? subtotal * Math.min(100, discountValue) / 100
    : proposal.discountType === 'fixed' ? discountValue : 0));
  const tax = money((subtotal - discount) * Math.min(100, Math.max(0, Number(proposal.taxRate ?? 0))) / 100);
  const total = money(subtotal - discount + tax);
  const recurring = rows.filter(item => item.included && item.billingPeriod && item.billingPeriod !== 'one_time')
    .reduce<Partial<Record<BillingPeriod, number>>>((result, item) => {
      const period = item.billingPeriod!;
      result[period] = money((result[period] || 0) + item.total);
      return result;
    }, {});
  const milestones = (commercial?.milestones || []).map(item => ({ ...item, amount: money(total * item.percentage / 100) }));
  // Allocate the rounding remainder to the last instalment, so the schedule matches the total exactly.
  if (milestones.length && Math.abs(milestones.reduce((sum, item) => sum + item.percentage, 0) - 100) < 0.001) {
    milestones[milestones.length - 1].amount = money(total - milestones.slice(0, -1).reduce((sum, item) => sum + item.amount, 0));
  }
  return { rows, subtotal, discount, tax, total, recurring, milestones };
}

const placeholderPattern = /\{\{\s*([^{}]+?)\s*\}\}|\[\[\s*([^\[\]]+?)\s*\]\]|\[(?:TODO|TBD|REQUIRED|INSERT)\s*:?\s*([^\]]*)\]/gi;
const normalizeField = (key: string) => key.trim().toLowerCase().replace(/[\s.-]+/g, '_');

export function unresolvedProposalFields(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(placeholderPattern), match => normalizeField(match[1] || match[2] || match[3] || 'unfinished_content')))];
}

export function fillProposalFields(text: string, values: Record<string, string | undefined | null>): string {
  const fields = Object.fromEntries(Object.entries(values).map(([key, value]) => [normalizeField(key), value]));
  return text.replace(placeholderPattern, (original, first, second, third) => {
    const value = fields[normalizeField(first || second || third || '')];
    return typeof value === 'string' && value.trim() ? value.trim() : original;
  });
}

export function missingProposalTemplateFields(
  requiredFields: string[],
  values: Record<string, string | undefined | null>,
): string[] {
  return [...new Set(requiredFields.map(normalizeField))].filter(field =>
    unresolvedProposalFields(fillProposalFields(`{{${field}}}`, values)).length > 0,
  );
}

/** Old starter templates stored writing prompts in body. Carry them into the authoring lane only. */
export function isProposalAuthoringInstruction(body: string): boolean {
  if (/^describe .+ using verified customer requirements\./i.test(body.trim())) return true;
  return /^(?:prepare (?:a|an) .+ proposal|describe (?:the |confirmed |agreed |audience)|state (?:the )?confirmed |list (?:the )?confirmed |summari[sz]e (?:the )?confirmed |specify (?:only )?(?:confirmed|agreed) |include only confirmed |document (?:the )?agreed |set out milestones|confirm payment)/i.test(body.trim());
}

/** Stable public input fields, excluding database identity and display-only calculations. */
export function proposalLineItemInput(item: ProposalLineItem) {
  return {catalogId:item.catalogId || null,name:item.name,description:item.description || '',quantity:Number(item.quantity ?? 1),unitPrice:Number(item.unitPrice ?? 0),unit:item.unit || 'unit',discount:Number(item.discount ?? 0),isComplimentary:item.isComplimentary === true,priceConfirmed:item.priceConfirmed ?? (Number(item.unitPrice || 0) > 0),isOptional:item.isOptional === true,selected:item.isOptional ? item.selected === true : true,packageId:item.packageId || null,billingPeriod:item.billingPeriod || 'one_time'};
}

export function materializeProposalTemplate(sections: ProposalSection[], values: Record<string, string | undefined | null>) {
  const materialized = sections.map(section => {
    const instruction = section.instruction || (isProposalAuthoringInstruction(section.body) ? section.body : undefined);
    const body = !section.instruction && instruction ? '' : fillProposalFields(section.body, values);
    return { ...section, title: fillProposalFields(section.title, values), body, ...(instruction ? { instruction } : {}) };
  });
  return {
    sections: materialized,
    unresolvedFields: unresolvedProposalFields(materialized.map(section => `${section.title}\n${section.body}`).join('\n')),
  };
}

export function missingProposalRequirements(requirements?: ProposalRequirements) {
  return (['objectives', 'deliverables', 'timeline', 'responsibilities', 'budget'] as const)
    .filter(field => !requirements?.[field]?.trim());
}

export function getProposalReadiness(proposal: ProposalDocument, options: { channel?: ProposalChannel; includeApproval?: boolean; now?: Date } = {}) {
  const issues: ReadinessIssue[] = [];
  const add = (code: string, field: string, message: string, severity: ReadinessIssue['severity'] = 'error') => issues.push({ code, field, message, severity });
  const sections = proposal.metadata?.generatedSections || [];
  if (!proposal.title.trim()) add('title', 'title', 'Add a proposal title.');
  if (!proposal.recipientName?.trim()) add('recipient_name', 'recipientName', 'Add the customer name.');
  if ((!options.channel || options.channel === 'email') && !isEmailAddress(proposal.recipientEmail || '')) {
    add('recipient_email', 'recipientEmail', 'Add a valid recipient email for email delivery.');
  }
  if (!/^[A-Z]{3}$/.test(proposal.currency || '')) add('currency', 'currency', 'Choose a currency.');
  if (proposal.validUntil && (!Number.isFinite(new Date(proposal.validUntil).getTime()) || new Date(proposal.validUntil) <= (options.now || new Date()))) {
    add('expired', 'validUntil', 'Choose an expiry date in the future.');
  }
  const texts = [proposal.title, proposal.coverNote || '', proposal.termsAndConditions || '',
    ...sections.flatMap(section => [section.title, section.body]),
    ...(proposal.lineItems || []).flatMap(item => [item.name, item.description || ''])];
  const unresolved = unresolvedProposalFields(texts.join('\n'));
  if (unresolved.length) add('placeholders', 'sections', `Complete these fields: ${unresolved.join(', ')}.`);
  const missingTemplateFields = proposal.metadata?.missingTemplateFields || [];
  if (missingTemplateFields.length) add('template_fields', 'templateValues', `Provide required template fields: ${missingTemplateFields.join(', ')}.`);
  sections.forEach((section, i) => {
    if (!section.body.trim() || isProposalAuthoringInstruction(section.body)) add(`section_${i}`, 'sections', `Write customer-ready content for “${section.title || `Section ${i + 1}`}”.`);
  });
  if (!proposal.coverNote?.trim() && !sections.some(section => section.kind === 'content' && section.body.trim())) add('scope', 'coverNote', 'Describe the agreed scope and deliverables.');
  if (!(proposal.showTermsAndConditions !== false && proposal.termsAndConditions?.trim()) && !sections.some(section => section.kind === 'terms' && section.body.trim())) add('terms', 'termsAndConditions', 'Add visible commercial terms.');
  if (!(proposal.lineItems || []).length) add('pricing', 'lineItems', 'Add at least one priced or explicitly complimentary item.');
  // All offered options must be valid, including ones the customer may choose later.
  (proposal.lineItems || []).forEach((item, index) => {
    const label = item.name?.trim() || `Item ${index + 1}`;
    if (!item.name?.trim()) add(`item_name_${index}`, 'lineItems', `Name item ${index + 1}.`);
    const price = Number(item.unitPrice ?? 0), quantity = Number(item.quantity ?? 1), discount = Number(item.discount ?? 0);
    if (!Number.isFinite(price) || price < 0 || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(discount) || discount < 0 || discount > price * quantity) add(`item_value_${index}`, 'lineItems', `Correct the quantity, price or discount for “${label}”.`);
    else if (item.priceConfirmed === false || (price === 0 && !item.isComplimentary)) add(`item_price_${index}`, 'lineItems', `Confirm the price for “${label}” or mark it complimentary.`);
  });
  const commercial = proposal.metadata?.commercial;
  const discount = Number(proposal.discountValue ?? 0), tax = Number(proposal.taxRate ?? 0);
  if (!Number.isFinite(discount) || discount < 0 || (proposal.discountType === 'percentage' && discount > 100)) add('discount', 'discountValue', 'Enter a valid proposal discount.');
  if (!Number.isFinite(tax) || tax < 0 || tax > 100) add('tax', 'taxRate', 'Tax must be between 0% and 100%.');
  if ((proposal.lineItems || []).some(item => item.billingPeriod && !['one_time', 'monthly', 'quarterly', 'yearly'].includes(item.billingPeriod))) add('billing_period', 'lineItems', 'Choose a supported billing period.');
  if (commercial?.packages?.length && !commercial.packages.some(item => item.id === commercial.selectedPackageId)) add('package', 'commercial', 'Select a proposed package.');
  if ((proposal.lineItems || []).some(item => item.packageId && !commercial?.packages?.some(option => option.id === item.packageId))) add('unknown_package', 'commercial', 'Assign each line item to an existing package.');
  const milestones = commercial?.milestones || [];
  if (milestones.length && (Math.abs(milestones.reduce((sum, item) => sum + item.percentage, 0) - 100) > 0.001 || milestones.some(item => !item.title.trim() || !Number.isFinite(item.percentage) || item.percentage <= 0))) add('milestones', 'commercial', 'Milestone percentages must total 100%, with a name and positive percentage for each.');
  const missingRequirements = missingProposalRequirements(proposal.metadata?.requirements);
  if (missingRequirements.length) add('missing_requirements', 'requirements', `Confirm these proposal requirements: ${missingRequirements.join(', ')}.`, 'warning');
  if (options.includeApproval !== false && proposal.metadata?.approvalRequired && !proposal.metadata.approvedAt) add('approval', 'approval', 'Review and approve this version before sending.');
  if (proposal.metadata?.assumptions?.length) add('assumptions', 'requirements', 'Review the assumptions recorded for this proposal.', 'warning');
  const pricing = calculateProposalPricing(proposal);
  return { ready: !issues.some(issue => issue.severity === 'error'), issues, pricing };
}

export function compareProposalVersions(before: ProposalDocument, after: ProposalDocument) {
  const changes: { field: string; before: string; after: string }[] = [];
  for (const field of ['title', 'coverNote', 'recipientName', 'recipientEmail', 'currency', 'validUntil', 'termsAndConditions'] as const) {
    if (String(before[field] || '') !== String(after[field] || '')) changes.push({ field, before: String(before[field] || ''), after: String(after[field] || '') });
  }
  const pricingSnapshot = (proposal: ProposalDocument) => ({ items: proposal.lineItems, commercial: proposal.metadata?.commercial, discountType: proposal.discountType, discountValue: proposal.discountValue, taxRate: proposal.taxRate, total: calculateProposalPricing(proposal).total });
  if (JSON.stringify(pricingSnapshot(before)) !== JSON.stringify(pricingSnapshot(after))) changes.push({ field: 'Pricing and options', before: JSON.stringify(pricingSnapshot(before)), after: JSON.stringify(pricingSnapshot(after)) });
  const previous = before.metadata?.generatedSections || [], current = after.metadata?.generatedSections || [];
  for (let i = 0; i < Math.max(previous.length, current.length); i++) {
    if (previous[i]?.title !== current[i]?.title || previous[i]?.body !== current[i]?.body) changes.push({ field: current[i]?.title || previous[i]?.title || `Section ${i + 1}`, before: previous[i]?.body || '', after: current[i]?.body || '' });
  }
  return changes;
}
