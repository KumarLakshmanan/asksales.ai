import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { withBusinessScope } from '../tenancy/businessContext.js';

const retrieve = jest.fn(async (_query: unknown) => ({ status: 'insufficient', evidence: [], diagnostics: { degraded: true } }));
const diagnostics = jest.fn(async (_query: unknown) => ({ scopeOnly: true, privacyBlockedSources: 2, safetyBlockedSources: 0, indexingBlockedSources: 0 }));
const versions = jest.fn(async () => new Map());
jest.unstable_mockModule('../services/knowledge/KnowledgeGateway.js', () => ({ knowledgeGateway: { retrieve } }));
jest.unstable_mockModule('../services/knowledge/KnowledgeReadinessService.js', () => ({ knowledgeReadinessService: { retrievalDiagnostics: diagnostics, versions } }));
jest.unstable_mockModule('../services/knowledge/KnowledgeGovernanceService.js', () => ({ knowledgeGovernanceService: { listVersions: async () => [] } }));
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: async () => ({ rows: [{ id: 42 }] }) } }));
jest.unstable_mockModule('../services/billing/entitlements.js', () => ({ normalizeCapacityError: () => null }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }));
const { testKnowledgeRetrieval, listKnowledgeVersions } = await import('../controllers/knowledgeGovernanceController.js');
const response = () => {
  const res: any = { body: null, code: 200 };
  res.status = (code: number) => { res.code = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
};
beforeEach(() => { jest.clearAllMocks(); });
describe('owner-only knowledge readiness diagnostics', () => {
  it('adds only scoped readiness counts for the owner, preserving retrieval result and privacy filters', async () => {
    const res = response();
    await withBusinessScope({userId:9,actorUserId:9,businessProfileId:42,role:'owner'}, () => testKnowledgeRetrieval({user:{id:9},body:{question:'AI agents'},params:{}} as any,res));
    expect(res.body.result).toEqual({status:'insufficient',evidence:[],diagnostics:{degraded:true},
      ownerReadiness:{scopeOnly:true,privacyBlockedSources:2,safetyBlockedSources:0,indexingBlockedSources:0}});
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({tenantId:9,audience:'customer',channel:'web',purpose:'support_answer'}));
  });
  it('never reveals blocked-source diagnostics to a business member testing customer retrieval', async () => {
    const res = response();
    await withBusinessScope({userId:9,actorUserId:10,businessProfileId:42,role:'member'}, () => testKnowledgeRetrieval({user:{id:10},body:{question:'AI agents'},params:{}} as any,res));
    expect(res.body.result).toEqual({status:'insufficient',evidence:[],diagnostics:{degraded:true}});
    expect(diagnostics).not.toHaveBeenCalled();
  });
  it('does not expand version readiness inspection to business members', async () => {
    const res = response();
    await withBusinessScope({userId:9,actorUserId:10,businessProfileId:42,role:'member'}, () => listKnowledgeVersions({user:{id:10},params:{id:'5'}} as any,res));
    expect(res.code).toBe(403);
    expect(versions).not.toHaveBeenCalled();
  });
  it('rejects invalid test settings before retrieval or owner diagnostics', async () => {
    const res = response();
    await testKnowledgeRetrieval({user:{id:9},body:{question:'AI agents',audience:'public'},params:{}} as any,res);
    expect(res.code).toBe(400);
    expect(retrieve).not.toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalled();
  });
});
