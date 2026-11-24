import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { templateContentMatches, templateEditError, templateSubmissionError } from '../utils/whatsappTemplateLifecycle.js';

const fakeDb = { select: jest.fn(), update: jest.fn(), insert: jest.fn(), delete: jest.fn() };
const downloadByUrl = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../services/StorageService.js', () => ({
  StorageService: { getInstance: () => ({ downloadByUrl }) },
}));
jest.unstable_mockModule('../models/db.js', () => ({ db: fakeDb }));
jest.unstable_mockModule('../models/adminApiCredentials/functions.js', () => ({
  getActiveAdminCredential: jest.fn(async () => ({ apiKey: 'app-1', config: { apiVersion: 'v25.0' } })),
}));
jest.unstable_mockModule('../services/whatsappApiService.js', () => ({ whatsappApiService: {
  resolveCreds: jest.fn(async () => ({ accessToken: 'test-only-token', businessAccountId: 'waba-9' })),
  ensureTokenValidity: jest.fn(async () => 'test-only-token'),
} }));
const { submitTemplate, syncTemplates, updateTemplate } = await import('../controllers/whatsappTemplateController.js');

const base = {
  id: 3, userId: 9, name: 'support_alert', language: 'en_US', category: 'UTILITY',
  body: 'Ticket {{1}} needs a reply.', header: null, headerType: 'NONE', footer: null,
  buttons: null, examples: { '1': 'TKT-DEMO' }, wabaTemplateId: 'meta-3',
  metaStatus: 'APPROVED', status: 'DRAFT', hasLocalChanges: true, submissionStatus: 'local_draft',
  updatedAt: new Date('2026-09-05T00:00:00.123Z'), revision: '2026-09-05 00:00:00.123456',
};
const request = (body = {}) => ({ user: { id: 9 }, params: { id: '3' }, body }) as unknown as Request;
function response() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response & { status: ReturnType<typeof jest.fn>; json: ReturnType<typeof jest.fn> };
}
let changes: Record<string, unknown>[];
let predicates: SQL[];
function selectRow(row: Record<string, unknown>) {
  fakeDb.select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }));
}
function providerRecord(overrides = {}) {
  return { id: 'meta-3', name: 'support_alert', language: 'en_US', category: 'UTILITY', status: 'APPROVED',
    components: [{ type: 'BODY', text: base.body, example: { body_text: [['TKT-DEMO']] } }], ...overrides };
}
beforeEach(() => {
  jest.clearAllMocks();
  changes = []; predicates = [];
  selectRow(base);
  fakeDb.update.mockImplementation(() => ({ set: (patch: Record<string, unknown>) => {
    changes.push(patch);
    return { where: (predicate: SQL) => {
      predicates.push(predicate);
      return Object.assign(Promise.resolve([]), { returning: async () => [{ ...base, ...patch }] });
    } };
  } }));
});
afterEach(() => { jest.restoreAllMocks(); });

describe('governed WhatsApp template revisions', () => {
  it('submits an edited approved template to the existing Meta ID', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new globalThis.Response(JSON.stringify({ success: true }), { status: 200 }));
    const res = response();
    await submitTemplate(request(), res);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://graph.facebook.com/v25.0/meta-3');
    const payload = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(payload).not.toHaveProperty('name');
    expect(payload).not.toHaveProperty('language');
    expect(payload).not.toHaveProperty('category');
    expect(changes[0].submissionStatus).toBe('submitting');
    expect(changes.at(-1)).toMatchObject({ status: 'PENDING', hasLocalChanges: false });
    expect(res.status).toHaveBeenCalledWith(202);
    expect(new PgDialect().sqlToQuery(predicates[0]).params).toEqual([3, 9, base.revision]);
  });

  it('submits media headers with their Meta upload handle', async () => {
    selectRow({ ...base, headerType: 'IMAGE', headerMediaUrl: '4::meta-header-handle' });
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new globalThis.Response(JSON.stringify({ success: true }), { status: 200 }));
    const res = response();
    await submitTemplate(request(), res);
    const payload = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(payload.components[0]).toEqual({
      type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::meta-header-handle'] },
    });
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('uploads an owned local header to Meta instead of sending its path as a handle', async () => {
    const reference = '/uploads/9/content_asset/header.png';
    selectRow({ ...base, headerType: 'IMAGE', headerMediaUrl: reference });
    downloadByUrl.mockResolvedValue({ buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), file: { mimeType: 'image/png', originalName: 'header.png' } });
    const fetch = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new globalThis.Response(JSON.stringify({ id: 'upload:session' }), { status: 200 }))
      .mockResolvedValueOnce(new globalThis.Response(JSON.stringify({ h: '4::uploaded-header' }), { status: 200 }))
      .mockResolvedValueOnce(new globalThis.Response(JSON.stringify({ success: true }), { status: 200 }));
    const res = response();
    await submitTemplate(request(), res);
    expect(downloadByUrl).toHaveBeenCalledWith(reference, 9);
    expect(fetch).toHaveBeenCalledTimes(3);
    const payload = JSON.parse(String(fetch.mock.calls[2][1]?.body));
    expect(payload.components[0].example.header_handle).toEqual(['4::uploaded-header']);
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('keeps header and body examples independent in the Meta payload', async () => {
    selectRow({
      ...base,
      header: 'Hello {{1}}',
      headerType: 'TEXT',
      body: 'Order {{1}} is ready.',
      examples: { 'header:1': 'Customer', 'body:1': 'ORDER-42' },
    });
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new globalThis.Response(JSON.stringify({ success: true }), { status: 200 }));
    await submitTemplate(request(), response());
    const payload = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(payload.components[0].example).toEqual({ header_text: ['Customer'] });
    expect(payload.components[1].example).toEqual({ body_text: [['ORDER-42']] });
  });

  it('does not call Meta when another request acquired the same revision', async () => {
    fakeDb.update.mockImplementation(() => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }));
    const fetch = jest.spyOn(globalThis, 'fetch');
    const res = response();
    await submitTemplate(request(), res);
    expect(fetch).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('records an unknown provider outcome and requires sync before retry', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch failed'));
    const res = response();
    await submitTemplate(request(), res);
    expect(changes.at(-1)).toMatchObject({ submissionStatus: 'submission_uncertain', hasLocalChanges: true, status: 'DRAFT' });
    expect(templateSubmissionError({ ...base, submissionStatus: 'submission_uncertain' })).toMatch(/synchronization/);
  });

  it('keeps local changes as a draft when the prior Meta version is approved', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new globalThis.Response(JSON.stringify({ data: [providerRecord()] })));
    await syncTemplates(request(), response());
    expect(changes[0]).toMatchObject({ submissionStatus: 'local_draft', status: 'DRAFT', metaStatus: 'APPROVED' });
    expect(changes[0]).not.toHaveProperty('body');
    expect(changes[0]).not.toHaveProperty('hasLocalChanges', false);
  });

  it.each(['NONE', ' none ', ''])('clears Meta no-feedback sentinels when synchronizing (%s)', async (reason) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new globalThis.Response(JSON.stringify({ data: [providerRecord({ rejected_reason: reason })] })));
    await syncTemplates(request(), response());
    expect(changes[0]).toMatchObject({ metaRejectionReason: null, metaStatus: 'APPROVED' });
  });

  it('preserves actual Meta rejection feedback when synchronizing', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new globalThis.Response(JSON.stringify({ data: [providerRecord({ status: 'REJECTED', rejected_reason: 'Review the message category' })] })));
    await syncTemplates(request(), response());
    expect(changes[0]).toMatchObject({ metaRejectionReason: 'Review the message category', metaStatus: 'REJECTED' });
  });

  it('recovers a timed-out submission only when Meta contains the same message definition', async () => {
    selectRow({ ...base, submissionStatus: 'submission_uncertain' });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new globalThis.Response(JSON.stringify({ data: [providerRecord()] })));
    await syncTemplates(request(), response());
    expect(changes[0]).toMatchObject({ submissionStatus: 'approved', status: 'APPROVED', hasLocalChanges: false });
    expect(templateContentMatches(base, { ...base, body: 'Other wording' })).toBe(false);
    expect(templateContentMatches(base, { ...base, footer: 'New footer' })).toBe(false);
  });

  it('clears removed provider components and does not retain stale buttons or footer', async () => {
    selectRow({ ...base, hasLocalChanges: false, status: 'APPROVED', footer: 'Old footer', buttons: [{ type: 'QUICK_REPLY', text: 'Old option' }] });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new globalThis.Response(JSON.stringify({ data: [providerRecord()] })));
    await syncTemplates(request(), response());
    expect(changes[0]).toMatchObject({ buttons: null, footer: null, headerType: 'NONE' });
  });

  it('does not let sync overwrite a currently submitting revision', async () => {
    selectRow({ ...base, submissionStatus: 'submitting', updatedAt: new Date() });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new globalThis.Response(JSON.stringify({ data: [providerRecord()] })));
    await syncTemplates(request(), response());
    expect(changes).toHaveLength(0);
  });

  it('rejects linked identity changes and pending-review edits before saving', async () => {
    for (const input of [{ ...base, name: 'different' }, { ...base, language: 'ta' }]) {
      expect(templateEditError(base, input, base)).toMatch(/name or language/);
    }
    selectRow({ ...base, metaStatus: 'PENDING' });
    const res = response();
    await updateTemplate(request(base), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(changes).toHaveLength(0);
  });

  it('does not replace a local template with another language or provider identity', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new globalThis.Response(JSON.stringify({ data: [providerRecord({ language: 'ta' })] })));
    await syncTemplates(request(), response());
    expect(changes).toHaveLength(0);
    jest.mocked(fetch).mockResolvedValue(new globalThis.Response(JSON.stringify({ data: [providerRecord({ id: 'other-account-template' })] })));
    await syncTemplates(request(), response());
    expect(changes[0]).toMatchObject({ status: 'DRAFT', hasLocalChanges: true, submissionStatus: 'identity_conflict' });
    expect(changes[0]).not.toHaveProperty('wabaTemplateId');
  });
});


describe('provider readback workspace safety', () => {
  it('keeps a usable owned media source after Meta approval synchronization', async () => {
    selectRow({ ...base, hasLocalChanges: false, headerType:'IMAGE',headerMediaUrl:'/uploads/9/header.png', submittedSnapshot:{headerMediaUrl:'4::same-handle'} });
    jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({data:[providerRecord({components:[{type:'HEADER',format:'IMAGE',example:{header_handle:['4::same-handle']}},{type:'BODY',text:base.body}]})]})));
    await syncTemplates(request(),response());
    expect(changes[0]).toMatchObject({headerMediaUrl:'/uploads/9/header.png'});
  });
  it('does not unlock uncertain media submissions against an older attachment with matching text', async () => {
    selectRow({...base,submissionStatus:'submission_uncertain',headerType:'IMAGE',headerMediaUrl:'/uploads/9/new.png',submittedSnapshot:{headerMediaUrl:'4::new-handle'}});
    jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({data:[providerRecord({components:[{type:'HEADER',format:'IMAGE',example:{header_handle:['4::old-handle']}},{type:'BODY',text:base.body}]})]})));
    await syncTemplates(request(),response());
    expect(changes[0]).toMatchObject({submissionStatus:'submission_uncertain'});
    expect(changes[0]).not.toHaveProperty('headerMediaUrl');
    expect((changes[0].approvedSnapshot as Record<string,unknown>).headerMediaUrl).toBe('4::old-handle');
  });
  it('compares normalized authentication settings independently of JSON property order and provider localization', () => {
    const auth={otpType:'COPY_CODE',buttonText:'Copy code',codeExpirationMinutes:5,addSecurityRecommendation:true};
    expect(templateContentMatches({category:'AUTHENTICATION',headerType:'NONE',authConfig:auth,body:'Preview text'}, {category:'AUTHENTICATION',headerType:'NONE',body:'Localized text',authConfig:{addSecurityRecommendation:true,codeExpirationMinutes:5,buttonText:'Copy code',otpType:'COPY_CODE'}})).toBe(true);
    expect(templateContentMatches({category:'AUTHENTICATION',headerType:'NONE',authConfig:auth}, {category:'AUTHENTICATION',headerType:'NONE',authConfig:{...auth,codeExpirationMinutes:10}})).toBe(false);
  });
});


it('does not infer authentication settings as proof of an uncertain submission', async () => {
  const authConfig={otpType:'COPY_CODE',buttonText:'Copy code',codeExpirationMinutes:5,addSecurityRecommendation:true};
  selectRow({...base, category:'AUTHENTICATION',body:'',submissionStatus:'submission_uncertain',authConfig});
  jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({data:[providerRecord({category:'AUTHENTICATION',components:[{type:'BODY',text:'Localized verification code'},{type:'BUTTONS',buttons:[{type:'URL',text:'Copy code',url:'https://www.whatsapp.com/otp/code'}]}]})]})));
  await syncTemplates(request(),response());
  expect(changes[0]).toMatchObject({submissionStatus:'submission_uncertain'});
});
