import { describe, expect, it } from '@jest/globals';
import { presentSavedEmailReply } from '../utils/emailPresentation.js';
describe('recorded assistant email presentation', () => {
  it('shows saved HTML replies as readable text with the exact transport design available', () => {
    const message = { direction: 'outbound', content: '<p>Check-in is at 2:00 PM.</p><p>Kind regards,<br>ORO Team</p>', htmlContent: null,
      metadata: { dispatchKind: 'email_smart_reply', emailHtml: '<!DOCTYPE html><body>Branded delivery</body>' } };
    expect(presentSavedEmailReply(message)).toMatchObject({ content: 'Check-in is at 2:00 PM.\nKind regards,\nORO Team', htmlContent: message.metadata.emailHtml });
    expect(message.content).toContain('<p>');
  });
  it('repairs old generated email fragments without inventing a branded transport document', () => {
    const content = '<p>Please continue your booking.</p>';
    expect(presentSavedEmailReply({ direction: 'outbound', content, metadata: { dispatchKind: 'email_smart_reply' } }))
      .toMatchObject({ content: 'Please continue your booking.', htmlContent: content });
  });
  it('preserves a manually reviewed design already stored on a sent draft', () => {
    expect(presentSavedEmailReply({ direction: 'outbound', content: 'Hello', htmlContent: '<p>New design</p>', metadata: { dispatchKind: 'email_smart_reply', emailHtml: '<p>Old design</p>' } }).htmlContent).toBe('<p>New design</p>');
  });
  it('does not guess HTML semantics for inbound mail or other send origins', () => {
    const inbound = { direction: 'inbound', content: 'I meant <p> literally.', metadata: { dispatchKind: 'email_smart_reply' } };
    const manual = { direction: 'outbound', content: 'I meant <p> literally.' };
    expect(presentSavedEmailReply(inbound)).toBe(inbound);
    expect(presentSavedEmailReply(manual)).toBe(manual);
  });
  it('keeps literal email addresses in generated plain text', () => {
    const message = { direction: 'outbound', content: 'Email <support@example.com>', metadata: { dispatchKind: 'email_smart_reply' } };
    expect(presentSavedEmailReply(message).content).toBe(message.content);
  });
  it('exposes the exact saved AI follow-up design without changing its plain text', () => {
    const message = { direction: 'outbound', content: 'Would you like more help?', metadata: { dispatchKind: 'assistant_follow_up', emailHtml: '<!doctype html><body>Warm follow-up</body>' } };
    expect(presentSavedEmailReply(message)).toMatchObject({ content: message.content, htmlContent: message.metadata.emailHtml });
  });
});
