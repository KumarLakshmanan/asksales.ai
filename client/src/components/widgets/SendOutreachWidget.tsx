"use client";

import { useRef } from 'react';
import { OutreachCreationPage, type OutreachComposerDraft } from '@/components/outreach/create/OutreachCreationPage';
import { INBOX_CHANNELS, type InboxChannel } from '../../../../shared/outreachInbox';
import type { WidgetProps } from './types';

export function toOutreachDateTimeLocal(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const offsetMs = parsed.getTimezoneOffset() * 60_000;
  return new Date(parsed.getTime() - offsetMs).toISOString().slice(0, 16);
}

export function canonicalOutreachForm(form: {
  lead_ids: number[];
  channel: string;
  template_id: number;
  subject: string;
  body: string;
  scheduled_for: string;
  provider_account_id?: string;
}): Record<string, unknown> {
  return {
    lead_ids: form.lead_ids,
    channel: form.channel,
    ...(form.provider_account_id ? { provider_account_id: form.provider_account_id } : {}),
    ...(form.template_id > 0 ? { template_id: form.template_id } : {}),
    ...(form.subject.trim() ? { subject: form.subject } : {}),
    body: form.body,
    ...(form.scheduled_for
      ? { scheduled_for: new Date(form.scheduled_for).toISOString() }
      : {}),
  };
}

export function SendOutreachWidget({ widget, onFormChange }: WidgetProps) {
  // Autosave acknowledgements must not recreate a composer or erase newer edits.
  const initial = useRef<OutreachComposerDraft>((widget.formValues.composerDraft as OutreachComposerDraft | undefined) || {
    channel: INBOX_CHANNELS.includes(widget.formValues.channel as InboxChannel) ? widget.formValues.channel as InboxChannel : 'email',
    leadIds: (widget.formValues.lead_ids as number[]) || [],
    threadId: widget.threadId,
    subject: String(widget.formValues.subject || ''),
    body: String(widget.formValues.body || ''),
    providerAccountId: typeof widget.formValues.provider_account_id === 'string' ? widget.formValues.provider_account_id : undefined,
    ...(widget.formValues.scheduled_for ? { sendWhen: 'later', schedule: toOutreachDateTimeLocal(widget.formValues.scheduled_for) } : {}),
  });
  return <OutreachCreationPage embedded={{ initial: initial.current, onChange: (draft, review) => onFormChange({
    channel: draft.channel, lead_ids: review ? (review.messages as Array<{leadId: number}>).map(item => item.leadId) : draft.leadIds || [], subject: draft.subject || '', body: draft.body || '',
    composerDraft: draft,
    ...(review ? { outreach_review: review } : { _review_validation_error: 'Review the account, recipients, messages and follow-ups above before confirming.' }),
  }) }} />;
}
