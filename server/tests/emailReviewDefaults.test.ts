import { describe, expect, it } from '@jest/globals';
import { applyEmailReviewDefaults } from '../mastra/utils/contentRequestConstraints.js';
import { EMAIL_OPT_OUT_LINE, normalizeOutreachEmailBody, textDraftMessages, withEmailOptOut } from '../services/content/TextContentGenerationService.js';
import { unresolvedEmailTemplateVariables } from '../utils/emailTemplateVariables.js';

describe('reviewed outreach email body', () => {
  it('drops the unfilled unsubscribe link and puts the opt-out ahead of a named sign-off', () => {
    const body = 'Hi Priya,\n\nGuests message hotels late at night.\n\nUnsubscribe: {{unsubscribe_link}}';
    expect(normalizeOutreachEmailBody(body, 'Regression Company')).toBe(
      `Hi Priya,\n\nGuests message hotels late at night.\n\n${EMAIL_OPT_OUT_LINE}\n\nBest,\nRegression Company`);
  });

  it('names the sender after a bare sign-off and keeps an existing opt-out', () => {
    const body = 'Hi,\n\nReply stop if you would rather not hear from us.\n\nThanks,';
    expect(normalizeOutreachEmailBody(body, 'Regression Company')).toBe(
      'Hi,\n\nReply stop if you would rather not hear from us.\n\nThanks,\nRegression Company');
  });

  it('leaves a complete signature alone and adds no name it does not know', () => {
    const signed = `Hi,\n\nA short note.\n\n${EMAIL_OPT_OUT_LINE}\n\nBest regards,\nAnu`;
    expect(normalizeOutreachEmailBody(signed, 'Regression Company')).toBe(signed);
    expect(normalizeOutreachEmailBody('Hi,\n\nA short note.', null)).toBe(`Hi,\n\nA short note.\n\n${EMAIL_OPT_OUT_LINE}`);
  });
});

describe('email opt-out wording', () => {
  it('replaces an unsendable {{unsubscribe_link}} line with a reply-to-opt-out sentence', () => {
    const email = withEmailOptOut({ body: 'We help teams automate.', closing: 'Best,\n{{unsubscribe_link}}' }, true);
    expect(email.closing).toBe(`${EMAIL_OPT_OUT_LINE}\n\nBest,`);
    expect(unresolvedEmailTemplateVariables({ text: JSON.stringify(email) })).toEqual([]);
    // Even when no opt-out was requested, the placeholder never survives.
    expect(withEmailOptOut({ body: 'Hi.\n\nUnsubscribe: {{unsubscribe_link}}' }, false)).toEqual({ body: 'Hi.', closing: EMAIL_OPT_OUT_LINE });
  });

  it('adds the sentence ahead of the sign-off when an opt-out was requested and the draft has none', () => {
    expect(withEmailOptOut({ body: 'Hello.', closing: 'Thanks,' }, true).closing).toBe(`${EMAIL_OPT_OUT_LINE}\n\nThanks,`);
    expect(withEmailOptOut<Record<string, unknown>>({ body: 'Hello.' }, true).closing).toBe(EMAIL_OPT_OUT_LINE);
  });

  it('keeps an opt-out the model already wrote, and adds nothing when none was requested', () => {
    expect(withEmailOptOut({ body: 'Hi.', closing: 'Reply "stop" if you would rather not hear from me.' }, true).closing).toBe('Reply "stop" if you would rather not hear from me.');
    expect(withEmailOptOut({ body: 'Hi.', closing: 'Thanks,' }, false)).toEqual({ body: 'Hi.', closing: 'Thanks,' });
  });

  it('never asks the model for {{unsubscribe_link}}', () => {
    const prompt = JSON.stringify(textDraftMessages('email', { request: 'Cold email', includeUnsubscribe: true }));
    expect(prompt).toContain('reply to stop further emails');
    expect(prompt).not.toMatch(/Include \{\{unsubscribe_link\}\}/);
  });
});

describe('email review card defaults', () => {
  it('keeps the unsubscribe link on for a cold email even when the model turned it off', () => {
    expect(applyEmailReviewDefaults({ email_type: 'cold_outreach', include_unsubscribe: false }).include_unsubscribe).toBe(true);
    expect(applyEmailReviewDefaults({ include_unsubscribe: false }).include_unsubscribe).toBe(true);
    expect(applyEmailReviewDefaults({ email_type: 'newsletter', include_unsubscribe: false }).include_unsubscribe).toBe(true);
  });

  it('respects the user switching it off on an earlier revision of the review', () => {
    expect(applyEmailReviewDefaults({ email_type: 'cold_outreach', include_unsubscribe: false }, { include_unsubscribe: false }).include_unsubscribe).toBe(false);
  });

  it('leaves one-to-one emails alone', () => {
    expect(applyEmailReviewDefaults({ email_type: 'thank_you', include_unsubscribe: false }).include_unsubscribe).toBe(false);
    expect(applyEmailReviewDefaults({ email_type: 'follow_up', include_unsubscribe: false }).include_unsubscribe).toBe(false);
  });

  it('shows the business profile as sender when none was given, and keeps an explicit one', () => {
    expect(applyEmailReviewDefaults({}, {}, '  Aimplify  ').sender_business_name).toBe('Aimplify');
    expect(applyEmailReviewDefaults({ sender_business_name: ' ' }, {}, 'Aimplify').sender_business_name).toBe('Aimplify');
    expect(applyEmailReviewDefaults({ sender_business_name: 'NimbusFlow' }, {}, 'Aimplify').sender_business_name).toBe('NimbusFlow');
    expect(applyEmailReviewDefaults({}, {}, null)).not.toHaveProperty('sender_business_name');
  });
});
