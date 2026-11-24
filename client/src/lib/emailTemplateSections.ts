import { sanitizeEmailPreviewHtml } from './contentTemplateRendering';
import { readEmailDraft } from '../../../shared/emailTemplateSections';
import { escapeHtml } from '../../../shared/html';
export * from '../../../shared/emailTemplateSections';

export function emailDraftHtml(content: unknown): string {
  const draft = readEmailDraft(content);
  if (draft.html) return sanitizeEmailPreviewHtml(draft.html);
  return sanitizeEmailPreviewHtml(`<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;line-height:1.6;padding:16px;max-width:600px;margin:auto">${draft.body.split('\n\n').map(part => `<p style="margin:0 0 12px">${escapeHtml(part).replace(/\n/g, '<br>')}</p>`).join('')}</body></html>`);
}
