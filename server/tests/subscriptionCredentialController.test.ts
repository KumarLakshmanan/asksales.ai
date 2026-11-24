import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';

const existing = { id:7, platform:'razorpay', name:'Synthetic selected billing credential', apiKey:'rzp_live_fixture', apiSecret:'synthetic-secret', isActive:true, config:{subscriptionWebhookSecret:'synthetic-old-webhook-secret'} };
const changed:Record<string,unknown>[]=[];
const noop=jest.fn(async()=>null);
const getAdminCredentialById=jest.fn(async()=>({...existing}));
const updateAdminCredential=jest.fn(async(_id:number,data:Record<string,unknown>)=>{
  changed.push(data); return {...existing,...data};
});
const recordAdminCredentialAudit=jest.fn(async()=>undefined);
jest.unstable_mockModule('../models/adminApiCredentials/functions',()=>({
  getAdminCredentialsByPlatform:noop,getActiveAdminCredential:noop,getAllAdminCredentials:noop,
  createAdminCredential:noop,updateAdminCredential,deleteAdminCredential:noop,toggleAdminCredential:noop,
  getAdminCredentialStats:noop,getAdminCredentialById,recordAdminCredentialAudit,
  updateAdminCredentialValidation:noop,listAdminCredentialAudit:noop,
}));
jest.unstable_mockModule('../services/agents/LLMProviderFactory',()=>({LLMProviderFactory:{clearCache:()=>undefined}}));
jest.unstable_mockModule('../services/agents/VertexAIProvider',()=>({VertexAIProvider:class {}}));
jest.unstable_mockModule('../services/embeddings/testEmbeddingCredential',()=>({testEmbeddingCredential:noop}));
const execute=jest.fn(async()=>({rows:[{enforced:true,credential_id:7}]}));
jest.unstable_mockModule('../models/db',()=>({db:{execute}}));
const {updateIntegration,toggleIntegration,deleteIntegration}=await import('../controllers/adminIntegrationsNewController');

describe('regression: selected subscription credential safety guard',()=>{
  beforeEach(()=>{jest.clearAllMocks();changed.length=0;updateAdminCredential.mockClear();execute.mockClear();});
  it.each([updateIntegration,toggleIntegration,deleteIntegration])('rejects generic selected credential mutation during enforcement',async handler=>{
    const req={params:{id:'7'},body:{apiKey:'rzp_test_fixture',config:{subscriptionWebhookSecret:'synthetic-new-webhook-secret'}},user:{id:1,role:'super_admin'}} as unknown as Request;
    let status=200;let body:unknown;
    const res={status(code:number){status=code;return this;},json(value:unknown){body=value;return this;}} as Response;
    await handler(req,res);
    // Expected parity with configureSubscriptions guard: HTTP 409 and no update.
    expect(status).toBe(409);
    expect(body).toMatchObject({code:'BILLING_CREDENTIAL_ENFORCED'});
    expect(updateAdminCredential).not.toHaveBeenCalled();
    expect(noop).not.toHaveBeenCalled();
  });
});
