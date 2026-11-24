import type { TemplateRenderContext } from '../../../shared/templateRenderContext';
import api from "@/lib/api";
import type { OutreachRecipient } from '../../../shared/outreachCompose';
import { readLibraryDraft } from './libraryDraft';

export interface RenderedReusableTemplate {
  success: true;
  templateId: number;
  templateVersion: number;
  templateRenderContext?: TemplateRenderContext;
  subject: string | null;
  content: string;
  htmlContent: string | null;
  brandContext: Record<string, unknown>;
}

/** Approval, brand freshness and rendering are enforced together by the server. */
export async function renderApprovedTemplate(
  templateId: number,
  variables: Record<string, string> = {},
  recipient?: { leadId: number; channel: string },
): Promise<RenderedReusableTemplate> {
  const result = await api.post<RenderedReusableTemplate>(`/api/content/templates/${templateId}/use`, { variables, ...recipient });
  if (!result?.success || result.templateId !== templateId || !Number.isInteger(result.templateVersion) || result.templateVersion < 1 || typeof result.content !== "string") {
    throw new Error("The template could not be verified. Reload it and try again.");
  }
  return result;
}

/** All caller values describe the selected recipient; sender context is server-owned. */
export async function resolveRecipientTemplate(templateId: number, recipient: OutreachRecipient, channel: string) {
  const rendered = await renderApprovedTemplate(templateId, {
    first_name: recipient.firstName, last_name: recipient.lastName,
    full_name: recipient.fullName || recipient.name,
    company_name: recipient.company, email: recipient.email, phone: recipient.phone,
  }, { leadId: recipient.id, channel });
  const draft = readLibraryDraft(rendered.content);
  return {
    sourceTemplateId: rendered.templateId, sourceTemplateVersion: rendered.templateVersion,
    ...(rendered.templateRenderContext ? { templateRenderContext: rendered.templateRenderContext } : {}),
    content: draft.body, subject: rendered.subject || draft.subject,
    htmlContent: rendered.htmlContent || draft.html || undefined,
  };
}

/** Bound resolver concurrency for campaigns; every recipient receives its own snapshot. */
export async function resolveCampaignTemplate(templateId: number, recipients: OutreachRecipient[], channel: string) {
  const result: Record<number, Awaited<ReturnType<typeof resolveRecipientTemplate>>> = {};
  for (let index = 0; index < recipients.length; index += 10) {
    await Promise.all(recipients.slice(index, index + 10).map(async recipient => {
      result[recipient.id] = await resolveRecipientTemplate(templateId, recipient, channel);
    }));
  }
  const versions = new Set(Object.values(result).map(item => item.sourceTemplateVersion));
  if (versions.size > 1) throw new Error('The template changed during review. Review the campaign again.');
  return result;
}
