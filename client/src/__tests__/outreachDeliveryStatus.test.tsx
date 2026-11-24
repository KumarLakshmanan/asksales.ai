import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { outboundDeliveryDetail, outboundDeliveryLabel, outboundQueueDetail, plainDeliveryReason, UNCONFIRMED_DELIVERY_DETAIL } from '@/lib/outreach-delivery-status';
import { failureExplanation } from '@/components/outreach/tracking/status';
import { emailGenerationErrorMessage } from '@/lib/emailGenerationRecovery';
import { ApiError } from '@/lib/api-client';
import { EmailDeliveryActivity } from '@/components/outreach/EmailDeliveryActivity';
import { clearOutreachComposerDraft, outreachDraftHandoffKey, readOutreachComposerDraft, resetOutreachComposerDraftsForTests, saveOutreachComposerDraft } from '@/lib/outreach-composer-draft-store';

const legacy = 'Provider delivery could not be authoritatively confirmed. Review provider history before reconciliation.';

describe('outbound delivery status wording', () => {
  it('names every state as sent, delivered, read, failed, pending or pending confirmation', () => {
    expect(['sent', 'delivered', 'read', 'failed', 'pending', 'manual_review'].map(outboundDeliveryLabel))
      .toEqual(['Sent', 'Delivered', 'Read', 'Failed', 'Pending', 'Pending confirmation']);
  });
  it('replaces internal uncertain-delivery text, including rows saved before the rewording', () => {
    expect(outboundDeliveryDetail('manual_review', legacy)).toBe(UNCONFIRMED_DELIVERY_DETAIL);
    expect(outboundDeliveryDetail('manual_review', '')).toBe(UNCONFIRMED_DELIVERY_DETAIL);
    expect(plainDeliveryReason('The provider did not return a delivery receipt. Manual review is required before retrying.')).toBe(UNCONFIRMED_DELIVERY_DETAIL);
    expect(failureExplanation(null, legacy)).not.toMatch(/authoritatively/);
  });
  it('explains a queued WhatsApp retry and hides other text on pending rows', () => {
    const retryAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    expect(outboundQueueDetail('pending', 'Meta marketing limit reached. Queued to retry in 4 hours.', retryAt))
      .toMatch(/^Meta's limit on marketing messages to this contact was reached, so this is queued\. It will be retried automatically after .+ IST\.$/);
    expect(outboundQueueDetail('pending', 'App sending capacity reached. Waiting for the rate-limit window to reset.'))
      .toBe('Sending capacity is full right now, so this is queued. It will go out automatically when the limit resets.');
    expect(outboundQueueDetail('pending', 'INTERNAL_CLAIM: worker lost lease')).toBeNull();
    expect(outboundQueueDetail('failed', 'Meta marketing limit reached. Queued to retry in 4 hours.')).toBeNull();
  });
  it('keeps a real provider rejection reason and explains nothing for delivered messages', () => {
    expect(outboundDeliveryDetail('failed', 'Mailbox does not exist')).toBe('Mailbox does not exist');
    expect(outboundDeliveryDetail('delivered', legacy)).toBeNull();
  });
  it('shows an unconfirmed email as pending confirmation, never as needing internal review', () => {
    render(<EmailDeliveryActivity message={{ id: 1, conversationId: 1, direction: 'outbound', content: 'x', status: 'manual_review', createdAt: '2026-11-01T00:00:00Z' } as never} />);
    expect(screen.getByText('Pending confirmation', { selector: 'span' })).toBeTruthy();
  });
});

describe('email generation failure messages', () => {
  it('tells the user nothing was created and that retrying is safe', () => {
    const error = new ApiError('Email generation failed', 500, { code: 'EMAIL_GENERATION_FAILED' });
    expect(emailGenerationErrorMessage(error, 'compose')).toMatch(/kept\. Try again\.$/);
    expect(emailGenerationErrorMessage(new ApiError('x', 500, { code: 'CONTENT_GENERATION_FAILED' }), 'compose')).toMatch(/Try again/);
  });
  it('treats a temporarily unavailable server as retryable', () => {
    expect(emailGenerationErrorMessage(new ApiError('x', 503, {}), 'library')).toMatch(/temporarily unavailable.*Try again/);
  });
});

describe('outreach composer draft store', () => {
  const params = (query: string) => new URLSearchParams(query);
  it('restores only for the same signed-in business and the same composer URL', () => {
    resetOutreachComposerDraftsForTests();
    saveOutreachComposerDraft('7:9', { channel: 'email', body: 'Hello', subject: 'Hi' }, outreachDraftHandoffKey(params('channel=email')));
    expect(readOutreachComposerDraft('7:9', params('channel=email'))?.body).toBe('Hello');
    expect(readOutreachComposerDraft('7:9', params(''))?.body).toBe('Hello');
    expect(readOutreachComposerDraft('7:9', params('channel=sms'))).toBeUndefined();
    expect(readOutreachComposerDraft('7:9', params('leadIds=4'))).toBeUndefined();
    expect(readOutreachComposerDraft('7:9', params('message=New'))).toBeUndefined();
    expect(readOutreachComposerDraft('7:10', params('channel=email'))).toBeUndefined();
    clearOutreachComposerDraft('7:9');
    expect(readOutreachComposerDraft('7:9', params('channel=email'))).toBeUndefined();
  });
  it('never keeps drafts for an unselected business or local media previews', () => {
    resetOutreachComposerDraftsForTests();
    saveOutreachComposerDraft('7:unselected', { channel: 'email', body: 'Hello' }, outreachDraftHandoffKey(params('')));
    expect(readOutreachComposerDraft('7:unselected', params(''))).toBeUndefined();
    saveOutreachComposerDraft('7:9', { channel: 'whatsapp', templateId: 't', templateValues: { mediaPreview: 'blob:x', body_1: 'Ada' } }, outreachDraftHandoffKey(params('channel=whatsapp')));
    expect(readOutreachComposerDraft('7:9', params('channel=whatsapp'))?.templateValues).toEqual({ body_1: 'Ada' });
  });
});
