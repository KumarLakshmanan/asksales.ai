import { findUnresolvedTemplateVariables } from '../../shared/templateVariables.js';
import { emailDisplayText } from './emailDisplay.js';

export interface EmailTemplateFields { subject?: string | null; html?: string | null; text?: string | null }

/** Check both source and visible HTML: encoded braces and inline spans must not hide tokens. */
export function unresolvedEmailTemplateVariables(fields: EmailTemplateFields): string[] {
  return [...new Set([
    ...findUnresolvedTemplateVariables([fields.subject, fields.html, fields.text].filter(Boolean).join('\n')),
    ...findUnresolvedTemplateVariables(fields.html ? emailDisplayText(fields.html, 'html') : ''),
  ])];
}

export function assertResolvedEmailTemplate(fields: EmailTemplateFields): void {
  const unresolved = unresolvedEmailTemplateVariables(fields);
  if (unresolved.length) throw Object.assign(new Error(`Missing email personalization values: ${unresolved.join(', ')}`), {
    code: 'EMAIL_PERSONALIZATION_UNRESOLVED', unresolvedTokens: unresolved,
    deliveryAttempted: false, outcomeUncertain: false, retryable: false,
  });
}
