import { issueTemplateRenderContext, verifyTemplateRenderContext } from './TemplateRenderContext.js';
import { DEFAULT_BUSINESS_TIMEZONE } from '../../utils/timezone.js';
import type { TemplateRenderContext } from '../../../shared/templateRenderContext.js';
import { canonicalizeTemplateVariable, extractTemplateVariables, renderContentTemplate, sanitizeEmailHtml } from '../../utils/contentTemplateRendering.js';
import { readLibraryDraft } from '../../../shared/libraryDraft.js';
import type { OutreachRecipient } from '../../../shared/outreachCompose.js';
import type { LeadRecord } from '../../models/leads/schema.js';
import { firstWhatsAppNumberSource } from '../../../shared/whatsappPhone.js';

export class ApprovedTemplateError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string,
    public readonly unresolved?: string[]) { super(message); }
}

export interface TemplateDeliverySnapshot {
  sourceTemplateId?: unknown;
  sourceTemplateVersion?: unknown;
  templateRenderContext?: unknown;
  content: string;
  subject?: string | null;
  htmlContent?: string | null;
}

export function templateRecipientFromLead(lead: Partial<LeadRecord> | null | undefined, channel: string) {
  const fullName = lead?.fullName || lead?.name || [lead?.firstName, lead?.lastName].filter(Boolean).join(' ');
  return { fullName, name: fullName || lead?.email || lead?.phone || 'Contact',
    firstName: lead?.firstName || fullName.split(' ')[0] || '', lastName: lead?.lastName || '',
    company: lead?.company || lead?.companyName || '', email: lead?.email || '',
    phone: channel === 'sms' ? lead?.phone || '' : firstWhatsAppNumberSource(lead?.whatsapp, lead?.phone),
    job_title: lead?.role || '', department: lead?.department || '', company_industry: lead?.industry || '',
    company_size: lead?.companySize || '', company_website: lead?.companyDomain || lead?.website || '',
    company_location: [lead?.companyHeadquarters?.hqCity, lead?.companyHeadquarters?.hqState, lead?.companyHeadquarters?.hqCountry].filter(Boolean).join(', '),
  };
}

/** The provenance is kept only for an unchanged, approved recipient rendering. */
export async function assertApprovedTemplateDelivery(userId: number, channel: string,
  snapshot: TemplateDeliverySnapshot, recipient: Pick<OutreachRecipient, 'firstName' | 'lastName' | 'fullName' | 'name' | 'company' | 'email' | 'phone'> & Partial<Record<'job_title' | 'department' | 'company_industry' | 'company_size' | 'company_website' | 'company_location', string>>) {
  if (snapshot.sourceTemplateId === undefined && snapshot.sourceTemplateVersion === undefined) return;
  if (!Number.isSafeInteger(snapshot.sourceTemplateId) || Number(snapshot.sourceTemplateId) <= 0
    || !Number.isSafeInteger(snapshot.sourceTemplateVersion) || Number(snapshot.sourceTemplateVersion) <= 0)
    throw new ApprovedTemplateError(400, 'INVALID_TEMPLATE_PROVENANCE', 'Choose and review a valid saved template again.');
  const resolved = await resolveApprovedTemplate(userId, Number(snapshot.sourceTemplateId), {
    job_title: recipient.job_title, department: recipient.department, company_industry: recipient.company_industry,
    company_size: recipient.company_size, company_website: recipient.company_website, company_location: recipient.company_location,
    first_name: recipient.firstName, last_name: recipient.lastName, full_name: recipient.fullName || recipient.name,
    company_name: recipient.company, email: recipient.email, phone: recipient.phone,
  }, Number(snapshot.sourceTemplateVersion), undefined, snapshot.templateRenderContext);
  if (resolved.templateRenderContext && !snapshot.templateRenderContext)
    throw new ApprovedTemplateError(409, 'TEMPLATE_RENDER_CONTEXT_REQUIRED', 'Review this template again to preserve its approved date and timezone.');
  if (resolved.type !== channel && !(resolved.type === 'social_message' && ['instagram', 'facebook'].includes(channel)))
    throw new ApprovedTemplateError(400, 'TEMPLATE_CHANNEL_MISMATCH', 'Choose a template for this channel.');
  const draft = readLibraryDraft(resolved.content);
  if (snapshot.content.trim() !== draft.body.trim()
    || (snapshot.subject || '') !== (resolved.subject || draft.subject || '')
    || sanitizeEmailHtml(snapshot.htmlContent || '') !== sanitizeEmailHtml(resolved.htmlContent || draft.html || ''))
    throw new ApprovedTemplateError(409, 'TEMPLATE_RENDER_CHANGED', 'The template or recipient changed after review. Review the message again.');
}

/** Preview and delivery share ownership, approval, version and brand checks. */
export async function resolveApprovedTemplate(userId: number, templateId: number,
  values: Record<string, string | number | null | undefined> = {}, expectedVersion?: number,
  selection?: { leadId: number; channel?: string }, renderingContext?: unknown) {
  const templates = await import('../../models/contentTemplates/functions.js');
  const { resolveContentBrandContext } = await import('./ContentBrandContextService.js');
  const template = await templates.getContentTemplateById(templateId);
  if (!template) throw new ApprovedTemplateError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
  if (template.userId !== userId && !(template.isPredefined && template.isApproved))
    throw new ApprovedTemplateError(403, 'TEMPLATE_ACCESS_DENIED', 'Access denied');
  if (!template.isApproved) throw new ApprovedTemplateError(409, 'TEMPLATE_APPROVAL_REQUIRED', 'Approve this template before using it.');
  if (expectedVersion !== undefined && template.version !== expectedVersion)
    throw new ApprovedTemplateError(409, 'TEMPLATE_VERSION_CONFLICT', 'The template changed after review. Review it again.');
  if (selection) {
    if (!Number.isSafeInteger(selection.leadId) || selection.leadId <= 0)
      throw new ApprovedTemplateError(400, 'INVALID_TEMPLATE_RECIPIENT', 'Choose a valid recipient.');
    const { LeadModel } = await import('../../models/leads/functions.js');
    const lead = await LeadModel.findByIdForUser(selection.leadId, userId);
    if (!lead || lead.deletedAt) throw new ApprovedTemplateError(404, 'TEMPLATE_RECIPIENT_NOT_FOUND', 'This recipient is unavailable.');
    const recipient = templateRecipientFromLead(lead, selection.channel || template.type);
    // Recipient selection owns the entire set of personal fields.
    values = { first_name: recipient.firstName, last_name: recipient.lastName, full_name: recipient.fullName || recipient.name,
      company_name: recipient.company, email: recipient.email, phone: recipient.phone, job_title: recipient.job_title,
      department: recipient.department, company_industry: recipient.company_industry, company_size: recipient.company_size,
      company_website: recipient.company_website, company_location: recipient.company_location };
  }
  const requiresBusiness = extractTemplateVariables([template.subject, template.content, template.htmlContent].join('\n'))
    .some(variable => ['your_company_name', 'your_industry', 'your_website', 'value_proposition', 'target_audience'].includes(canonicalizeTemplateVariable(variable) || ''));
  const context = !template.isPredefined || requiresBusiness ? await resolveContentBrandContext(userId,
    template.isPredefined ? {} : { businessProfileId: template.businessProfileId, brandToolkitId: template.brandToolkitId }) : null;
  if (context && !template.isPredefined) {
    const provenance = (template.brandContextSnapshot as { provenance?: { businessProfile?: { version?: number }; brandToolkit?: { version?: number } } })?.provenance;
    if (provenance?.businessProfile?.version !== context.businessProfile.version || provenance?.brandToolkit?.version !== context.brandToolkit.version)
      throw new ApprovedTemplateError(409, 'TEMPLATE_BRAND_CONTEXT_STALE', 'The approved brand or business profile changed. Review and approve this template again.');
  }
  // Canonicalize first so an alias cannot override a trusted business value.
  const canonicalValues = Object.fromEntries(Object.entries(values).map(([key, value]) => [canonicalizeTemplateVariable(key.replace(/^\{\{|\}\}$/g, '')) || key, value]));
  if (context) Object.assign(canonicalValues, {
    your_company_name: context.businessProfile.companyName || context.businessProfile.businessName,
    your_industry: context.businessProfile.industry,
    your_website: context.businessProfile.website,
    value_proposition: context.businessProfile.valueProposition,
    target_audience: context.businessProfile.targetMarket,
  });
  // Decode structured drafts before substitution: quotes in a contact name
  // must never corrupt the serialized email or drop its greeting/signature.
  const draft = ['email', 'sms', 'social_message'].includes(template.type) ? readLibraryDraft(template.content) : null;
  const usesClock = extractTemplateVariables([template.subject, template.content, template.htmlContent].join('\n'))
    .some(variable => ['current_date', 'current_month', 'current_year'].includes(canonicalizeTemplateVariable(variable) || ''));
  let templateRenderContext: TemplateRenderContext | undefined;
  if (usesClock) {
    try {
      templateRenderContext = renderingContext === undefined
        ? issueTemplateRenderContext(userId, template.id, template.version, context?.businessProfile.timezone || DEFAULT_BUSINESS_TIMEZONE)
        : verifyTemplateRenderContext(userId, template.id, template.version, renderingContext);
    } catch (error) {
      throw new ApprovedTemplateError(409, 'INVALID_TEMPLATE_RENDER_CONTEXT', error instanceof Error ? error.message : 'Review this template again.');
    }
  }
  const renderOptions = { now: templateRenderContext ? new Date(templateRenderContext.renderedAt) : undefined, timeZone: templateRenderContext?.timeZone };
  const subject = renderContentTemplate(template.subject || draft?.subject || '', canonicalValues, renderOptions);
  const content = renderContentTemplate(draft?.body ?? template.content, canonicalValues, renderOptions);
  const html = renderContentTemplate(template.htmlContent || draft?.html || '', canonicalValues, { ...renderOptions, escapeHtml: true });
  const unresolved = [...new Set([...subject.unresolved, ...content.unresolved, ...html.unresolved])];
  if (unresolved.length) throw new ApprovedTemplateError(422, 'UNRESOLVED_TEMPLATE_VARIABLES',
    `Resolve template variables before previewing or sending: ${unresolved.join(', ')}.`, unresolved);
  return { success: true as const, templateId: template.id, templateVersion: template.version,
    subject: subject.rendered || null, content: content.rendered,
    htmlContent: html.rendered ? sanitizeEmailHtml(html.rendered) : null, brandContext: template.brandContextSnapshot,
    type: template.type, ...(templateRenderContext ? { templateRenderContext } : {}) };
}
