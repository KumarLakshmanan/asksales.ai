import { describe, expect, it } from '@jest/globals';
import { applyTokens, buildLeadTokens, personalizeLeadEmail } from '../utils/personalization.js';
import { personalizeOutreach, type OutreachRecipient } from '../../shared/outreachCompose.js';

describe('recipient-bound email personalization', () => {
  it('resolves canonical, camel case and picker labels from snake case and camel case lead data', () => {
    for (const lead of [{ first_name: 'Uma' }, { firstName: 'Uma' }, { full_name: 'Uma Pitla' }, { fullName: 'Uma Pitla' }]) {
      expect(personalizeLeadEmail('Hi {{first Name}} / {{first_name}} / {{firstName}}', lead)).toBe('Hi Uma / Uma / Uma');
    }
  });
  it('does not recursively expand tokens or interpret recipient values as HTML', () => {
    expect(personalizeLeadEmail('<b>{{First Name}}</b>', { firstName: '<img src=x>' }, true)).toBe('<b>&lt;img src=x&gt;</b>');
    expect(applyTokens('{{first_name}}', { '{{first_name}}': '{{company}}', '{{company}}': 'Private' }).text).toBe('{{company}}');
  });
  it.each(['{{First Name}}', '{{unknown label}}', '{{first_name', '{{}}'])('blocks missing or malformed %s', token => {
    expect(() => personalizeLeadEmail(token, {})).toThrow('Missing email personalization values');
  });
  it('preserves nonempty alias values and derives names without leaking another recipient', () => {
    expect(personalizeLeadEmail('{{job_title}}', { job_title: 'CFO' })).toBe('CFO');
    expect(buildLeadTokens({ fullName: '  Uma   Pitla  ' })['{{first_name}}']).toBe('Uma');
    const recipient = { firstName: 'Uma', lastName: 'Pitla', name: 'Uma Pitla', company: 'Acme', email: 'uma@example.test', phone: '' } as OutreachRecipient;
    expect(personalizeOutreach('Hi {{First Name}} / {{firstName}}', recipient)).toBe('Hi Uma / Uma');
    expect(personalizeOutreach('Hi {{First Name}}', { ...recipient, firstName: 'Ravi' })).toBe('Hi Ravi');
  });
  it('resolves every recipient field in the email variable catalog', () => {
    const lead = { firstName: 'Uma', lastName: 'Pitla', email: 'uma@example.test', phone: '+12025550123', companyName: 'Acme', companyIndustry: 'Finance', companySize: 50, companyWebsite: 'https://acme.test', companyLocation: 'Chennai', jobTitle: 'CFO', department: 'Finance', painPoints: ['Slow approvals'], budgetRange: 'Approved range' };
    const tokens = '{{full_name}}|{{phone}}|{{company_name}}|{{company_industry}}|{{company_size}}|{{company_website}}|{{company_location}}|{{job_title}}|{{department}}|{{pain_point}}|{{budget_range}}';
    expect(personalizeLeadEmail(tokens, lead)).toBe('Uma Pitla|+12025550123|Acme|Finance|50|https://acme.test|Chennai|CFO|Finance|Slow approvals|Approved range');
  });
  it('resolves HTML-encoded brace tokens without decoding recipient HTML', () => {
    expect(personalizeLeadEmail('<b>&#123;&#123;First Name&#125;&#125;</b>', { firstName: '<Uma>' }, true)).toBe('<b>&lt;Uma&gt;</b>');
    expect(personalizeLeadEmail('&amp;#123;&amp;#123;company&amp;#125;&amp;#125;', { company: 'Acme' })).toBe('Acme');
  });
});
