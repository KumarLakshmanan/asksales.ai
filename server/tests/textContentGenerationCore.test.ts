import { describe, expect, it } from '@jest/globals';
import { explicitlyRequestedMedia, parseTextDraft, reviewedContentOptions, textDraftMessages } from '../services/content/TextContentGenerationService.js';
import { readEmailDraft } from '../../shared/emailTemplateSections.js';

describe('shared REST and chat text generation contract', () => {
  it('canonicalizes generated variables across all email sections and repairs misplaced recipient signatures', () => {
    const draft = parseTextDraft('email', JSON.stringify({ subject: '{{company}} update', greeting: 'Hello,', body: 'For {{jobtitle}} at {{Company Name}}.', signature: 'Sender\n{{First Name}}', html: '<b>&#123;&#123;company&#125;&#125;</b>' }), { request: 'Update' });
    expect(draft.subject).toBe('{{company_name}} update');
    expect(draft.greeting).toBe('Hi {{first_name}},');
    expect(draft.body).toBe('For {{job_title}} at {{company_name}}.');
    expect(draft.signature).toBe('Sender');
    expect(draft.html).toBe('<b>{{company_name}}</b>');
  });
  it.each(['{{made_up_variable}}', '{{unknown label}}', '{{first_name'])('rejects unsupported generated %s before saving', token => {
    expect(() => parseTextDraft('email', JSON.stringify({ subject: 'Update', body: `For ${token}` }), { request: 'Update' })).toThrow('Unsupported generated email variables');
  });
  it('keeps reviewed wording above factual context and supplies the canonical variable contract', () => {
    const messages = reviewedContentOptions({ messages: textDraftMessages('email', { request: 'A neutral update. Do not invite a demo.', brandContext: 'Default CTA: Book a demo', reviewedCta: 'Read the update.', includeImagePrompt: false }) }).messages;
    expect(messages[1].content).toContain('A neutral update. Do not invite a demo.');
    expect(messages[1].content).toContain('{{your_company_name}}');
    expect(messages[1].content).toContain('Do not include imagePrompt');
    expect(messages.at(-1)?.content).toContain('take precedence');
  });
  it('normalizes the complete email once and preserves an exact reviewed CTA without duplicate display', () => {
    const parsed = parseTextDraft('email', JSON.stringify({ subject: 'Update', body: 'Notes.', greeting: 'Hi {{first_name}},', closing: 'Book a demo?', signature: 'Team', imagePrompt: 'Unrequested banner' }), { request: 'Notes', reviewedCta: 'Read the update.', includeImagePrompt: false });
    expect(parsed.closing).toBe('');
    expect(parsed.imagePrompt).toBeUndefined();
    expect(readEmailDraft(parsed).body).toBe('Hi {{first_name}},\n\nNotes.\n\nRead the update.\n\nTeam');
  });
  it('checks reviewed SMS limits and opt-out wording without silently truncating content', () => {
    expect(() => parseTextDraft('sms', JSON.stringify({ message: 'a'.repeat(200) }), { request: 'Notes' })).toThrow();
    expect(parseTextDraft('sms', JSON.stringify({ message: 'a'.repeat(200) }), { request: 'Notes', maxCharacters: 320 }).characterCount).toBe(200);
    expect(() => parseTextDraft('sms', JSON.stringify({ message: 'Notes.' }), { request: 'Notes', includeOptOut: true })).toThrow('opt-out');
  });
  it('starts optional media only when explicitly enabled at either boundary', () => {
    expect(explicitlyRequestedMedia({})).toEqual({ image: false, video: false });
    expect(explicitlyRequestedMedia({ auto_generate_image: true, autoGenerateVideo: true })).toEqual({ image: true, video: true });
  });
});
