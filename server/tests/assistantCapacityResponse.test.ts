import {describe,expect,it,jest} from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {withBusinessScope} from '../tenancy/businessContext.js';
const limit={code:'PLAN_LIMIT_EXCEEDED',resource:'aiAssistants',current:1,requestedIncrease:1,limit:1,organizationId:701};
const publish=jest.fn<any>().mockRejectedValue({cause:{code:'P0001',detail:JSON.stringify(limit)}});
jest.unstable_mockModule('../middleware/platformAccess.js',()=>({requireModuleAccess:()=> (_req:unknown,_res:unknown,next:()=>void)=>next()}));
jest.unstable_mockModule('../services/assistants/AssistantService.js',()=>({assistantService:{publish},AssistantManagementError:class extends Error{}}));
jest.unstable_mockModule('../services/assistants/AssistantCatalogService.js',()=>({assistantCatalog:{}}));
jest.unstable_mockModule('../services/assistants/AssistantPreviewSession.js',()=>({assistantPreviewSession:{}}));
jest.unstable_mockModule('../services/assistants/AssistantOperationsService.js',()=>({assistantOperations:{}}));
jest.unstable_mockModule('../services/agents/pipeline/ChannelGateway.js',()=>({channelGateway:{}}));
const {default:router}=await import('../routes/outreachAssistants.routes.js');
describe('modern assistant capacity API error',()=>{
 it('preserves a structured403 quota response instead of masking it as500',async()=>{
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user={id:101} as typeof req.user;return withBusinessScope({userId:101,businessProfileId:501},next);});app.use('/assistants',router);
  const response=await request(app).post('/assistants/00000000-0000-4000-8000-000000000001/publish').send({expectedDraftVersion:1,confirmAssignments:true});
  expect(response.status).toBe(403);expect(response.body).toMatchObject(limit);
 });
});
