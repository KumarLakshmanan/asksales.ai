import { buildOutreachTemplate, personalizeOutreach, type OutreachFollowUp, type OutreachRecipient, type OutreachTemplate } from './outreachCompose.js';
import type { InboxChannel } from './outreachInbox.js';

/** Draft data belongs to one composer instance, never to channel settings. */
export interface OutreachFollowUpDraft {
  id: string;
  delayValue: number;
  delayUnit: 'minutes' | 'hours' | 'days';
  message: string;
  subject: string;
  templateId: string;
  templateValues: Record<string, string>;
}
export interface OutreachLocalFollowUps {
  enabled: boolean;
  steps: OutreachFollowUpDraft[];
}
export function localFollowUpMinutes(step: OutreachFollowUpDraft) {
  return step.delayValue * ({ minutes: 1, hours: 60, days: 1440 }[step.delayUnit] || 0);
}
export function renderLocalFollowUps(draft: OutreachLocalFollowUps, channel: InboxChannel, recipient: OutreachRecipient, templates: OutreachTemplate[]) {
  const steps: OutreachFollowUp[] = [], errors: string[] = [];
  if (!draft.enabled) return { steps, errors };
  if (!draft.steps.length || draft.steps.length > 10) errors.push('Add between one and ten follow-ups.');
  let previous = 0;
  for (const [index, step] of draft.steps.entries()) {
    const delayMinutes = localFollowUpMinutes(step);
    if (!Number.isInteger(step.delayValue) || delayMinutes <= previous || delayMinutes > 129600) errors.push(`Follow-up ${index + 1}: choose increasing whole-number delays within 90 days.`);
    previous = delayMinutes;
    if (channel === 'whatsapp') {
      const template = templates.find(item => item.id === step.templateId);
      if (!template) { errors.push(`Follow-up ${index + 1}: choose an approved WhatsApp template.`); continue; }
      const rendered = buildOutreachTemplate(template, step.templateValues, recipient);
      if (rendered.missing.length) errors.push(`Follow-up ${index + 1}: complete all template variables and media.`);
      steps.push({ delayMinutes, message: rendered.content, templateName: rendered.templateName, templateLanguage: rendered.templateLanguage, templateComponents: rendered.templateComponents });
    } else {
      const message = personalizeOutreach(step.message, recipient);
      const subject = channel === 'email' ? personalizeOutreach(step.subject, recipient) : undefined;
      if (!message.trim() || /{{.*?}}/.test(message) || (subject && /{{.*?}}/.test(subject))) errors.push(`Follow-up ${index + 1}: complete the message and personalization.`);
      steps.push({ delayMinutes, message, ...(subject ? { subject } : {}) });
    }
  }
  return { steps, errors };
}
