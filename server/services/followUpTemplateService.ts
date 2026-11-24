import { getContentTemplateById } from '../models/contentTemplates/functions.js';
import type { ContentTemplate } from '../models/contentTemplates/schema.js';
import { resolveContentBrandContext } from './content/ContentBrandContextService.js';
import { renderContentTemplate, sanitizeEmailHtml } from '../utils/contentTemplateRendering.js';
import { followUpTemplateType, type FollowUpChannel } from '../../shared/followUpChannels.js';
import { readEmailDraft } from '../../shared/emailTemplateSections.js';
import { emailBodyToHtml, hasEmailMarkup } from '../../shared/emailFormatting.js';
import { emailDisplayText } from '../utils/emailDisplay.js';

export class FollowUpTemplateError extends Error {}

/** Selection and delivery both check ownership, channel and the current approval. */
export async function loadFollowUpTemplate(userId: number, channel: FollowUpChannel, templateId: number) {
  const template = await getContentTemplateById(templateId);
  if (!template || template.userId !== userId) throw new FollowUpTemplateError('The selected follow-up template was not found.');
  if (template.type !== followUpTemplateType(channel)) throw new FollowUpTemplateError('The selected template does not match the follow-up channel.');
  if (!template.isApproved) throw new FollowUpTemplateError('Review and approve the selected follow-up template before using it.');
  const context = await resolveContentBrandContext(userId, {
    businessProfileId: template.businessProfileId,
    brandToolkitId: template.brandToolkitId,
  });
  const provenance = template.brandContextSnapshot?.provenance as {
    businessProfile?: { version?: number }; brandToolkit?: { version?: number };
  } | undefined;
  if (provenance?.businessProfile?.version !== context.businessProfile.version
    || provenance?.brandToolkit?.version !== context.brandToolkit.version) {
    throw new FollowUpTemplateError('The brand or business profile changed. Review and approve the follow-up template again.');
  }
  return { template, context };
}

/** Structured library messages must not be sent as JSON to the recipient. */
export function renderFollowUpTemplate(
  template: Pick<ContentTemplate, 'content' | 'subject' | 'htmlContent'>,
  values: Record<string, string | number | null | undefined>,
  originalSubject = '',
  options: { now?: Date; timeZone?: string; channel?: FollowUpChannel } = {},
) {
  const draft = readEmailDraft(template.content);
  const body = draft.body;
  const subject = template.subject || draft.subject;
  const bodyIsHtml = (options.channel ?? 'email') === 'email' && hasEmailMarkup(body);
  let html = template.htmlContent || draft.html;
  if (!html && bodyIsHtml) {
    const sections = draft.sections;
    const section = (key: string) => typeof sections[key] === 'string' ? sections[key] as string : '';
    html = [section('greeting'), section('body'), section('cta') && !section('body').includes(section('cta')) ? section('cta') : '', section('closing'), section('signature')]
      .filter(Boolean).map(emailBodyToHtml).join('<br>');
  }
  // Legacy follow-up-only variable; render it through the escaped canonical renderer.
  const render = (text: string, escapeHtml = false) => renderContentTemplate(
    text.replace(/\{\{\s*original_?subject\s*\}\}/gi, '{{follow_up_original_subject}}'),
    values,
    { ...options, escapeHtml },
  );
  // originalSubject predates the canonical variables. Substitute safely, without
  // allowing recipient values to introduce a second round of template expansion.
  const original = (text: string, escapeHtml = false) => {
    const result = render(text, escapeHtml);
    const replacement = escapeHtml
      ? originalSubject.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
      : originalSubject;
    result.rendered = result.rendered.replaceAll('{{follow_up_original_subject}}', () => replacement);
    result.unresolved = result.unresolved.filter(token => token !== '{{follow_up_original_subject}}');
    return result;
  };
  const rendered = [original(body, bodyIsHtml), original(subject), original(html, true)];
  const unresolved = [...new Set(rendered.flatMap(result => result.unresolved))];
  if (unresolved.length) throw new FollowUpTemplateError(`Missing follow-up template values: ${unresolved.join(', ')}`);
  const renderedHtml = rendered[2].rendered ? sanitizeEmailHtml(rendered[2].rendered) : '';
  const renderedBody = bodyIsHtml || !body.trim()
    ? emailDisplayText(renderedHtml || rendered[0].rendered, 'html') : rendered[0].rendered;
  if (!renderedBody.trim()) throw new FollowUpTemplateError('The follow-up template has no message body.');
  return { body: renderedBody, subject: rendered[1].rendered, html: renderedHtml };
}
