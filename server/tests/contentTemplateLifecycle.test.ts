import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mockAuthRequest, mockResponse as baseResponse } from './helpers/mockHelpers';

function mockResponse() {
  const res = baseResponse();
  jest.spyOn(res, 'status');
  jest.spyOn(res, 'json');
  return res;
}

class Conflict extends Error {}
const functions = {
  ContentTemplateVersionConflictError: Conflict,
  getContentTemplateById: jest.fn<any>(), createContentTemplate: jest.fn<any>(),
  updateContentTemplateForUser: jest.fn<any>(), approveContentTemplateForUser: jest.fn<any>(),
  duplicateContentTemplate: jest.fn<any>(), incrementTemplateUsage: jest.fn<any>(),
  countContentTemplatesByTypeForUser: jest.fn<any>(),
};
const context = { businessProfile: { id: 11, version: 2, companyName: 'Trusted business', valueProposition: 'Trusted value' }, brandToolkit: { id: 12, version: 3 } };
const snapshot = { provenance: { businessProfile: { version: 2 }, brandToolkit: { version: 3 } } };
jest.unstable_mockModule('../models/contentTemplates/functions', () => functions);
const findLead = jest.fn<any>();
jest.unstable_mockModule('../models/leads/functions.js', () => ({ LeadModel: { findByIdForUser: findLead } }));
jest.unstable_mockModule('../models/brandToolkits/functions.js', () => ({ BrandToolkitModel: {} }));
jest.unstable_mockModule('../services/content/ContentBrandContextService.js', () => ({
  ContentBrandContextError: class extends Error {},
  resolveContentBrandContext: jest.fn<any>().mockResolvedValue(context),
  brandContextSnapshot: () => snapshot,
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn() } }));
const controller = await import('../controllers/contentTemplatesController');
const { assertApprovedTemplateDelivery } = await import('../services/content/ApprovedTemplateResolver.js');
const template = () => ({ id: 1, userId: 1, name: 'Welcome', type: 'email', subject: 'Hi {{firstname}}', content: 'Welcome to {{company}}', htmlContent: '<p>{{first_name}}: {{link}}</p>', variables: ['{{first_name}}'], version: 3, isApproved: true, isPredefined: false, brandToolkitId: 12, businessProfileId: 11, brandContextSnapshot: snapshot });
const request = (body: Record<string, unknown> = {}) => mockAuthRequest(1, { params: { id: '1' }, body });

describe('reusable template create, edit, import and render lifecycle', () => {
  it('counts saved templates for the authenticated business owner', async () => {
    functions.countContentTemplatesByTypeForUser.mockResolvedValue({ email: 4, sms: 2 });
    const res = mockResponse();
    await controller.getContentTemplateCounts(request(), res);
    expect(functions.countContentTemplatesByTypeForUser).toHaveBeenCalledWith(1);
    expect(res.json).toHaveBeenCalledWith({ email: 4, sms: 2 });
  });

  it('reports count load errors without presenting an empty library', async () => {
    functions.countContentTemplatesByTypeForUser.mockRejectedValueOnce(new Error('Unavailable'));
    const res = mockResponse();
    await controller.getContentTemplateCounts(request(), res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unable to retrieve saved template counts.' });
  });
  beforeEach(() => {
    jest.clearAllMocks();
    findLead.mockResolvedValue({ firstName: 'Asha', role: 'Engineer', industry: 'Technology' });
    functions.getContentTemplateById.mockResolvedValue(template());
    functions.createContentTemplate.mockResolvedValue({ id: 2, version: 1 });
    functions.updateContentTemplateForUser.mockResolvedValue({ ...template(), version: 4 });
    functions.approveContentTemplateForUser.mockResolvedValue({ ...template(), version: 4 });
    functions.duplicateContentTemplate.mockResolvedValue({ id: 2, version: 1 });
  });

  it.each(['email', 'whatsapp', 'sms', 'social', 'social_message', 'ad_copy', 'blog', 'landing_page'])('manually creates %s templates with detected canonical variables and approval', async (type) => {
    const res = mockResponse();
    await controller.createContentTemplate(request({ name: 'Manual', type, content: 'Hi {{firstname}} at {{company}}', variables: ['company_name'] }), res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(functions.createContentTemplate).toHaveBeenCalledWith(expect.objectContaining({ type, variables: ['{{company_name}}', '{{first_name}}'], isApproved: true, approvedBy: 1, brandContextSnapshot: snapshot }));
  });

  it('sanitizes HTML before saving and detects variables in subject and HTML', async () => {
    const res = mockResponse();
    await controller.createContentTemplate(request({ name: 'Email', type: 'email', content: 'Hello', subject: '{{company}}', htmlContent: '<p onclick="bad()">{{firstname}}</p><script>bad()</script>' }), res);
    const saved = functions.createContentTemplate.mock.calls[0][0] as { htmlContent: string; variables: string[] };
    expect(saved.htmlContent).toBe('<p>{{firstname}}</p>');
    expect(saved.variables).toEqual(['{{company_name}}', '{{first_name}}']);
  });

  it('rejects unsupported variables without saving', async () => {
    const res = mockResponse();
    await controller.createContentTemplate(request({ name: 'Email', type: 'email', content: '{{not_supported}}' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(functions.createContentTemplate).not.toHaveBeenCalled();
  });

  it('clears email HTML and its obsolete variables when changing type', async () => {
    const res = mockResponse();
    await controller.updateContentTemplate(request({ type: 'sms', content: 'Hello {{company}}' }), res);
    expect(functions.updateContentTemplateForUser).toHaveBeenCalledWith(1, 1, expect.objectContaining({ type: 'sms', subject: null, htmlContent: null, variables: ['{{company_name}}'], isApproved: true }), 3);
  });

  it('preserves omitted email content while recomputing variables and checking the validated version', async () => {
    const res = mockResponse();
    await controller.updateContentTemplate(request({ name: 'Renamed' }), res);
    expect(functions.updateContentTemplateForUser).toHaveBeenCalledWith(1, 1, expect.objectContaining({ htmlContent: undefined, variables: ['{{first_name}}', '{{company_name}}', '{{link}}'] }), 3);
  });

  it('reports a concurrent change as a retryable conflict', async () => {
    functions.updateContentTemplateForUser.mockRejectedValueOnce(new Conflict('Reload the latest version'));
    const res = mockResponse();
    await controller.updateContentTemplate(request({ name: 'Renamed' }), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'Reload the latest version', code: 'TEMPLATE_VERSION_CONFLICT' });
  });

  it('refuses approval of a version newer than the user reviewed', async () => {
    const res = mockResponse();
    await controller.approveContentTemplate(request({ expectedVersion: 2 }), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(functions.approveContentTemplateForUser).not.toHaveBeenCalled();
  });

  it('approves the exact reviewed version', async () => {
    await controller.approveContentTemplate(request({ expectedVersion: 3 }), mockResponse());
    expect(functions.approveContentTemplateForUser).toHaveBeenCalledWith(1, 1, expect.any(Object), 3);
  });

  it('reports deletion during editing instead of a successful null response', async () => {
    functions.updateContentTemplateForUser.mockResolvedValueOnce(null);
    const res = mockResponse();
    await controller.updateContentTemplate(request({ name: 'Renamed' }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('renders aliases consistently, escapes HTML values and only then counts use', async () => {
    const res = mockResponse();
    await controller.useTemplate(request({ variables: { firstname: '<Asha>', company_name: 'Acme', link: 'https://example.com' } }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ templateVersion: 3, subject: 'Hi <Asha>', content: 'Welcome to Acme', htmlContent: '<p>&lt;Asha&gt;: https://example.com</p>' }));
    expect(functions.incrementTemplateUsage).toHaveBeenCalledWith(1);
  });

  it('resolves sender context from the approved business instead of caller aliases', async () => {
    functions.getContentTemplateById.mockResolvedValueOnce({ ...template(), subject: '', htmlContent: '', content: '{{your_company_name}}: {{value_proposition}}' });
    const res = mockResponse();
    await controller.useTemplate(request({ variables: { yourcompanyname: 'Forged', value_proposition: 'Forged' } }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ content: 'Trusted business: Trusted value' }));
  });

  it('renders structured email sections without corrupting JSON for quoted recipient names', async () => {
    functions.getContentTemplateById.mockResolvedValueOnce({ ...template(), subject: '', htmlContent: '', content: JSON.stringify({ subject: 'Hi {{first_name}}', greeting: 'Dear {{first_name}}', body: 'Welcome', closing: 'Thanks', signature: 'Team' }) });
    const res = mockResponse();
    await controller.useTemplate(request({ variables: { first_name: 'Asha "A"' } }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Hi Asha "A"', content: 'Dear Asha "A"\n\nWelcome\n\nThanks\n\nTeam' }));
  });

  it('rejects stale template provenance before a delivery can be queued', async () => {
    await expect(assertApprovedTemplateDelivery(1, 'email', { sourceTemplateId: 1, sourceTemplateVersion: 2, content: 'Welcome' }, { firstName: 'Asha', lastName: '', fullName: 'Asha', name: 'Asha', company: 'Acme', email: '', phone: '' }))
      .rejects.toMatchObject({ code: 'TEMPLATE_VERSION_CONFLICT' });
  });

  it('rejects partial provenance and a mismatched reviewed recipient snapshot', async () => {
    const recipient = { firstName: 'Asha', lastName: '', fullName: 'Asha', name: 'Asha', company: 'Acme', email: '', phone: '' };
    await expect(assertApprovedTemplateDelivery(1, 'email', { sourceTemplateId: 1, content: 'Welcome' }, recipient)).rejects.toMatchObject({ code: 'INVALID_TEMPLATE_PROVENANCE' });
    functions.getContentTemplateById.mockResolvedValue({ ...template(), htmlContent: '', content: 'Welcome {{first_name}}' });
    await expect(assertApprovedTemplateDelivery(1, 'email', { sourceTemplateId: 1, sourceTemplateVersion: 3, content: 'Welcome Other', subject: 'Hi Asha' }, recipient)).rejects.toMatchObject({ code: 'TEMPLATE_RENDER_CHANGED' });
    await expect(assertApprovedTemplateDelivery(1, 'email', { sourceTemplateId: 1, sourceTemplateVersion: 3, content: 'Welcome Asha', subject: 'Hi Asha' }, recipient)).resolves.toBeUndefined();
  });

  it('resolves the full recipient catalog from owned lead data', async () => {
    functions.getContentTemplateById.mockResolvedValueOnce({ ...template(), subject: '', htmlContent: '', content: '{{first_name}}: {{job_title}} in {{company_industry}}' });
    const res = mockResponse();
    await controller.useTemplate(request({ leadId: 12, variables: { job_title: 'Forged' } }), res);
    expect(findLead).toHaveBeenCalledWith(12, 1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ content: 'Asha: Engineer in Technology' }));
  });

  it('rejects unavailable recipients without rendering private values', async () => {
    findLead.mockResolvedValueOnce(null);
    const res = mockResponse();
    await controller.useTemplate(request({ leadId: 12 }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(functions.incrementTemplateUsage).not.toHaveBeenCalled();
  });

  it('does not count unresolved previews as successful uses', async () => {
    const res = mockResponse();
    await controller.useTemplate(request({ variables: { first_name: 'Asha' } }), res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(functions.incrementTemplateUsage).not.toHaveBeenCalled();
  });

  it('blocks use after brand context changes until review', async () => {
    functions.getContentTemplateById.mockResolvedValueOnce({ ...template(), brandContextSnapshot: {} });
    const res = mockResponse();
    await controller.useTemplate(request(), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(functions.incrementTemplateUsage).not.toHaveBeenCalled();
  });

  it('prevents another tenant from editing private templates', async () => {
    functions.getContentTemplateById.mockResolvedValueOnce({ ...template(), userId: 99 });
    const res = mockResponse();
    await controller.updateContentTemplate(request({ content: 'Oops' }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(functions.updateContentTemplateForUser).not.toHaveBeenCalled();
  });

  it.each(['getContentTemplateById', 'useTemplate', 'importPredefinedTemplate'] as const)('does not expose unapproved predefined content through %s', async (action) => {
    functions.getContentTemplateById.mockResolvedValueOnce({ ...template(), userId: 99, isPredefined: true, isApproved: false });
    const res = mockResponse();
    await controller[action](request(), res);
    expect(res.status).toHaveBeenCalledWith(action === 'importPredefinedTemplate' ? 404 : 403);
    expect(functions.duplicateContentTemplate).not.toHaveBeenCalled();
  });

  it('imports approved predefined templates with tenant governance in a single create', async () => {
    functions.getContentTemplateById.mockResolvedValueOnce({ ...template(), userId: 99, isPredefined: true });
    const res = mockResponse();
    await controller.importPredefinedTemplate(request(), res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(functions.duplicateContentTemplate).toHaveBeenCalledWith(1, 1, { brandToolkitId: 12, businessProfileId: 11, brandContextSnapshot: snapshot });
    expect(functions.updateContentTemplateForUser).not.toHaveBeenCalled();
  });

  it('ties approval to the exact version that was validated', async () => {
    await controller.approveContentTemplate(request(), mockResponse());
    expect(functions.approveContentTemplateForUser).toHaveBeenCalledWith(1, 1, expect.any(Object), 3);
  });
});
