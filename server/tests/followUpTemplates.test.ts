import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getTemplate = jest.fn<(...args: unknown[]) => Promise<any>>();
const getContext = jest.fn<(...args: unknown[]) => Promise<any>>();
jest.unstable_mockModule('../models/contentTemplates/functions.js', () => ({ getContentTemplateById: getTemplate }));
jest.unstable_mockModule('../services/content/ContentBrandContextService.js', () => ({ resolveContentBrandContext: getContext }));
const { loadFollowUpTemplate, renderFollowUpTemplate } = await import('../services/followUpTemplateService.js');
const { FOLLOW_UP_CHANNELS } = await import('../../shared/followUpChannels.js');
const template = {
  id: 4, userId: 9, type: 'email', isApproved: true, businessProfileId: 2, brandToolkitId: 3,
  content: 'Hi {{first_name}},\n\nCan we help?\n\nThanks,\nSupport', subject: 'Hello {{firstName}}', htmlContent: '<p>Hello {{first_name}}</p>',
  brandContextSnapshot: { provenance: { businessProfile: { version: 2 }, brandToolkit: { version: 3 } } },
};

describe('follow-up template delivery', () => {
  beforeEach(() => {
    getTemplate.mockResolvedValue(template);
    getContext.mockResolvedValue({ businessProfile: { version: 2 }, brandToolkit: { version: 3 } });
  });
  it('renders canonical and legacy aliases without removing greetings or signatures', () => {
    const result = renderFollowUpTemplate(template, { first_name: 'Asha <Rao>' });
    expect(result.body).toBe('Hi Asha <Rao>,\n\nCan we help?\n\nThanks,\nSupport');
    expect(result.subject).toBe('Hello Asha <Rao>');
    expect(result.html).toContain('Asha &lt;Rao&gt;');
  });
  it('extracts structured email and DM text without sending JSON', () => {
    expect(renderFollowUpTemplate({ content: JSON.stringify({ greeting: 'Hi {{first_name}},', body: 'Still need help?', closing: 'Thanks', signature: 'Team' }), subject: null, htmlContent: null }, { first_name: 'Asha' }).body)
      .toBe('Hi Asha,\n\nStill need help?\n\nThanks\n\nTeam');
    expect(renderFollowUpTemplate({ content: '{"message":"Hi {{firstName}}"}', subject: null, htmlContent: null }, { first_name: 'Asha' }).body).toBe('Hi Asha');
  });
  it('stops unresolved placeholders and empty structured messages', () => {
    expect(() => renderFollowUpTemplate(template, {})).toThrow('Missing follow-up template values');
    expect(() => renderFollowUpTemplate({ ...template, content: '{"platform":"instagram"}', htmlContent: null }, { first_name: 'Asha' })).toThrow('no message body');
  });
  it('keeps HTML stored in the body as markup for the second follow-up', () => {
    const result = renderFollowUpTemplate({ content: '<p>Hi {{first Name}},</p><p><strong>Finance AI Assessment</strong> with <em>practical</em> next steps.</p><ul><li>Reduce delays</li></ul><p>Best,<br>Shiv</p>', subject: 'Hello {{First Name}}', htmlContent: null }, { first_name: 'Uma & team' });
    expect(result.subject).toBe('Hello Uma & team');
    expect(result.html).toContain('<strong>Finance AI Assessment</strong>');
    expect(result.html).toContain('<em>practical</em>');
    expect(result.html).toContain('<ul><li>Reduce delays</li></ul>');
    expect(result.html).toContain('Hi Uma &amp; team,');
    expect(result.body).toContain('Hi Uma & team,');
    expect(result.body).not.toContain('<strong>');
  });
  it('preserves structured HTML aliases, CTA, and safely escapes recipient values', () => {
    const result = renderFollowUpTemplate({ content: JSON.stringify({ greeting: 'Hi {{First Name}},', body: '<p><strong>Assessment</strong></p>', cta: 'Shall we talk?', signature: 'Shiv\nFounder' }), subject: null, htmlContent: null }, { first_name: '<img src=x onerror=alert(1)>' });
    expect(result.html).toContain('&lt;img');
    expect(result.html).not.toContain('<img');
    expect(result.html).toContain('<strong>Assessment</strong>');
    expect(result.html).toContain('Shall we talk?');
    expect(result.html).toContain('Shiv<br>Founder');
    const htmlOnly = renderFollowUpTemplate({ content: JSON.stringify({ html: '<p><b>Hello {{firstName}}</b></p>' }), subject: null, htmlContent: null }, { first_name: 'Uma' });
    expect(htmlOnly.html).toBe('<p><b>Hello Uma</b></p>');
    expect(htmlOnly.body).toBe('Hello Uma');
  });
  it('blocks unresolved or malformed names even when present only in HTML or subject', () => {
    for (const token of ['{{First Name}}', '{{unknown label}}', '{{first_name']) {
      expect(() => renderFollowUpTemplate({ content: 'Can we talk?', subject: token, htmlContent: null }, {})).toThrow('Missing follow-up template values');
      expect(() => renderFollowUpTemplate({ content: 'Can we talk?', subject: '', htmlContent: `<b>${token}</b>` }, {})).toThrow('Missing follow-up template values');
    }
  });
  it('supports legacy originalSubject and sanitizes rendered HTML', () => {
    const result = renderFollowUpTemplate({ content: 'Regarding {{originalSubject}}', subject: '', htmlContent: '<script>alert(1)</script><p>{{original_subject}}</p>' }, {}, '<booking>');
    expect(result.body).toBe('Regarding <booking>');
    expect(result.html).toBe('<p>&lt;booking&gt;</p>');
  });
  it('loads only an owned, approved, current template for the right channel', async () => {
    await expect(loadFollowUpTemplate(9, 'email', 4)).resolves.toMatchObject({ template: { id: 4 } });
    expect(getContext).toHaveBeenCalledWith(9, { businessProfileId: 2, brandToolkitId: 3 });
    await expect(loadFollowUpTemplate(10, 'email', 4)).rejects.toThrow('not found');
    await expect(loadFollowUpTemplate(9, 'whatsapp', 4)).rejects.toThrow('does not match');
    getTemplate.mockResolvedValueOnce({ ...template, isApproved: false });
    await expect(loadFollowUpTemplate(9, 'email', 4)).rejects.toThrow('approve');
    getContext.mockResolvedValueOnce({ businessProfile: { version: 4 }, brandToolkit: { version: 3 } });
    await expect(loadFollowUpTemplate(9, 'email', 4)).rejects.toThrow('changed');
  });
  it('supports exactly the five requested follow-up channels', () => {
    expect([...FOLLOW_UP_CHANNELS]).toEqual(['email', 'whatsapp', 'instagram', 'facebook', 'sms']);
  });
});
