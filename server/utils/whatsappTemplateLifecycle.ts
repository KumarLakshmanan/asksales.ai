import type { WhatsAppTemplateRecord } from '../models/whatsappTemplates/schema.js';

type Lifecycle = Pick<WhatsAppTemplateRecord, 'wabaTemplateId' | 'metaStatus' | 'status' | 'hasLocalChanges' | 'submissionStatus' | 'updatedAt'>;

export function nextTemplateRevision(updatedAt: Date): Date {
  return new Date(Math.max(Date.now(), new Date(updatedAt).getTime() + 1));
}

export function templateSubmissionError(template: Lifecycle): string | null {
  if (template.submissionStatus === 'identity_conflict') return 'Review the connected business account and template identity before submitting.';
  if (['submitting', 'submission_uncertain'].includes(template.submissionStatus)) {
    return 'The previous submission needs synchronization with Meta before retrying.';
  }
  const status = String(template.metaStatus || template.status).toUpperCase();
  if (template.wabaTemplateId && status === 'PENDING') return 'Meta is still reviewing this template. Sync its status before submitting changes.';
  if (template.wabaTemplateId && status === 'APPROVED' && !template.hasLocalChanges) return 'This template is already approved and has no local changes.';
  if (template.wabaTemplateId && !['APPROVED', 'REJECTED', 'PAUSED', 'DISABLED'].includes(status)) {
    return 'Sync the current Meta template status before submitting changes.';
  }
  return null;
}

export function templateEditError(template: Lifecycle, input: { name: string; language: string; category: string }, identity: { name: string; language: string; category: string }): string | null {
  if (['submitting', 'submission_uncertain'].includes(template.submissionStatus)) return 'Sync the outstanding submission before editing this template.';
  if (template.wabaTemplateId && String(template.metaStatus).toUpperCase() === 'PENDING') return 'Wait for Meta review and sync before editing this template.';
  if (template.wabaTemplateId && (input.name !== identity.name || input.language !== identity.language)) {
    return 'A Meta-linked template cannot change its name or language. Create a new template instead.';
  }
  if (template.wabaTemplateId && String(template.metaStatus).toUpperCase() === 'APPROVED' && input.category !== identity.category) {
    return 'Create a new template to change the category of an approved template.';
  }
  return null;
}

export function templateSubmissionLeaseActive(template: Lifecycle, now = Date.now()): boolean {
  return template.submissionStatus === 'submitting'
    && now - new Date(template.updatedAt).getTime() < 60_000;
}

export function providerTemplateSubmissionStatus(status: string): string {
  const normalized = status.toLowerCase();
  return ['approved', 'rejected', 'paused', 'disabled'].includes(normalized) ? normalized : 'pending';
}

/** Provider examples/handles are not customer content. Compare the actual
 * message definition, including removals, before resolving an uncertain edit. */
export function templateContentMatches(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const content = (value: Record<string, unknown>) => JSON.stringify({
    category: String(value.category || '').toUpperCase(),
    ...(String(value.category).toUpperCase() === 'AUTHENTICATION' ? { authConfig: value.authConfig && typeof value.authConfig === 'object' ? {
      otpType: (value.authConfig as Record<string, unknown>).otpType,
      buttonText: (value.authConfig as Record<string, unknown>).buttonText,
      codeExpirationMinutes: (value.authConfig as Record<string, unknown>).codeExpirationMinutes,
      addSecurityRecommendation: (value.authConfig as Record<string, unknown>).addSecurityRecommendation,
      autofillText: (value.authConfig as Record<string, unknown>).autofillText || null,
      packageName: (value.authConfig as Record<string, unknown>).packageName || null,
      signatureHash: (value.authConfig as Record<string, unknown>).signatureHash || null,
    } : null } : { body: String(value.body || '').trim() }),
    headerType: !value.header && ['TEXT', 'NONE', ''].includes(String(value.headerType || '').toUpperCase())
      ? 'NONE' : String(value.headerType || 'TEXT').toUpperCase(),
    header: value.header || null,
    footer: String(value.category).toUpperCase() === 'AUTHENTICATION' ? null : value.footer || null,
    buttons: (Array.isArray(value.buttons) ? value.buttons : []).map((button) => ({
      type: button.type, text: button.text, url: button.url || null, phone_number: button.phone_number || null,
    })),
  });
  return content(left) === content(right);
}
