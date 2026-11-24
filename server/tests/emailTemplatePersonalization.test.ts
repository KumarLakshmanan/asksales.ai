import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const context = jest.fn<(...args: unknown[]) => Promise<any>>();
jest.unstable_mockModule('../services/content/ContentBrandContextService.js', () => ({ resolveContentBrandContext: context }));
const { resolveLeadEmailTokens, renderLeadEmailField } = await import('../services/content/EmailTemplatePersonalizationService.js');
const { assertResolvedEmailTemplate } = await import('../utils/emailTemplateVariables.js');

describe('email variable value resolution and final-send validation', () => {
  beforeEach(() => { context.mockReset().mockResolvedValue({ businessProfile: { businessName: 'Aimplify', industry: 'AI', website: 'https://aimplify.test', valueProposition: 'Practical automation', targetMarket: 'Finance teams', timezone: 'Asia/Kolkata' } }); });
  it('keeps sender business fields separate from recipient company fields', async () => {
    const template = 'Hi {{first_name}}, {{your_company_name}} helps {{company_name}} with {{value_proposition}}. {{your_website}}';
    const tokens = await resolveLeadEmailTokens(9, { firstName: 'Uma', company: 'Recipient Ltd' }, [template]);
    expect(renderLeadEmailField(template, tokens)).toBe('Hi Uma, Aimplify helps Recipient Ltd with Practical automation. https://aimplify.test');
    expect(context).toHaveBeenCalledWith(9);
  });
  it('does not resolve a global brand for a recipient-only template or invent links', async () => {
    const tokens = await resolveLeadEmailTokens(9, { firstName: 'Uma' }, ['Hi {{First Name}}']);
    expect(renderLeadEmailField('Hi {{First Name}}', tokens)).toBe('Hi Uma');
    expect(context).not.toHaveBeenCalled();
    expect(() => renderLeadEmailField('{{unsubscribe_link}}', tokens)).toThrow('Missing email personalization values');
  });
  it('resolves an encoded sender-company variable from the approved business context', async () => {
    const template = '<p>&#123;&#123;your_company_name&#125;&#125;</p>';
    const tokens = await resolveLeadEmailTokens(9, { company: 'Recipient Ltd' }, [template]);
    expect(renderLeadEmailField(template, tokens, true)).toBe('<p>Aimplify</p>');
  });
  it.each(['{{first_name}}', '&#123;&#123;company_name&#125;&#125;', '&amp;#123;&amp;#123;job_title&amp;#125;&amp;#125;', '<span>{{first_</span><b>name}}</b>'])('blocks source or visible placeholders %s', html => {
    expect(() => assertResolvedEmailTemplate({ subject: 'Follow-up', html })).toThrow('Missing email personalization values');
  });
  it('preserves formatting while escaping resolved values', async () => {
    const tokens = await resolveLeadEmailTokens(9, { firstName: '<Uma>' }, ['{{first_name}}']);
    expect(renderLeadEmailField('<strong>{{first_name}}</strong>', tokens, true)).toBe('<strong>&lt;Uma&gt;</strong>');
    expect(() => assertResolvedEmailTemplate({ html: '<b>Hi Uma</b>' })).not.toThrow();
  });
});
