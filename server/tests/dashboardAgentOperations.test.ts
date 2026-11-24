import {beforeEach,describe,expect,it,jest} from '@jest/globals';
import {randomUUID} from 'node:crypto';
import {withBusinessScope} from '../tenancy/businessContext.js';
const access=jest.fn<any>(),getFile=jest.fn<any>(),downloadFile=jest.fn<any>(),createAnalysis=jest.fn<any>(),status=jest.fn<any>(),owned=jest.fn<any>();
const diagnostics=jest.fn<any>(),assistantList=jest.fn<any>(),assistantGet=jest.fn<any>();
jest.unstable_mockModule('../models/platformAccess/functions.js',()=>({getEffectiveModuleAccess:access}));
jest.unstable_mockModule('../services/StorageService.js',()=>({storageService:{getFile,downloadFile}}));
class DashboardOperationError extends Error {constructor(message:string,public status=400){super(message);}}
jest.unstable_mockModule('../services/operations/DashboardOperations.js',()=>({DashboardOperationError,createContactAnalysis:createAnalysis,dashboardOperationStatus:status,ownedDashboardOperation:owned,listDashboardOperations:jest.fn<any>().mockResolvedValue([])}));
jest.unstable_mockModule('../services/assistants/AssistantService.js',()=>({assistantService:{listPage:assistantList,get:assistantGet}}));
jest.unstable_mockModule('../services/assistants/AssistantOperationsService.js',()=>({assistantOperations:{diagnostics}}));
jest.unstable_mockModule('../services/assistants/AssistantContext.js',()=>({assistantsRuntimeEnabled:()=>false}));
const files=await import('../services/operations/StoredContactWorkbooks.js');
const tools=await import('../mastra/tools/dashboardOperationTools.js');
const {operationCardsFromReceipts}=await import('../mastra/utils/dashboardCards.js');
const {dashboardOperationEvidence}=await import('../mastra/utils/dashboardOperationEvidence.js');
const context={userId:991,threadId:21},scope=<T>(fn:()=>T)=>withBusinessScope({userId:991,businessProfileId:1},fn);
const execute=(tool:any,input:unknown,ctx=context)=>scope(()=>tool.execute(input,{mastra:{__toolContext:ctx}}));
const source=(id=1)=>({id,userId:991,businessProfileId:1,originalName:`Guests-${id}.csv`,fileName:'ignored.csv',fileSizeBytes:12,updatedAt:new Date('2026-11-02T00:00:00Z')});
beforeEach(()=>{
  jest.clearAllMocks();access.mockResolvedValue([{key:'crm',enabled:true},{key:'support_ai',enabled:true}]);
  getFile.mockImplementation(async(id:number)=>source(id));downloadFile.mockImplementation(async(id:number)=>({file:source(id),buffer:Buffer.alloc(12)}));
  createAnalysis.mockResolvedValue({id:randomUUID(),status:'queued'});
});
describe('dashboard agent operation boundaries',()=>{
  it('rejects missing/mismatched context and disabled modules before reading source files',async()=>{
    const input={fileIds:[1],options:{defaultCountry:'IN'}};
    expect(await execute(tools.analyzeContactFilesTool,input,{userId:992,threadId:21})).toMatchObject({success:false});
    access.mockResolvedValue([{key:'crm',enabled:false,status:'disabled'}]);
    expect(await execute(tools.analyzeContactFilesTool,input)).toMatchObject({success:false});
    expect(getFile).not.toHaveBeenCalled();expect(downloadFile).not.toHaveBeenCalled();
  });
  it('analyzes exact managed file IDs with a stable request identity and no CRM effect',async()=>{
    const input={fileIds:[1,2],options:{defaultCountry:'IN'}};
    expect(await execute(tools.analyzeContactFilesTool,input)).toMatchObject({success:true,output:{status:'queued'}});
    await execute(tools.analyzeContactFilesTool,input);
    expect((createAnalysis.mock.calls[0][0] as Array<{name:string}>).map(file=>file.name)).toEqual(['Guests-1.csv','Guests-2.csv']);
    expect(createAnalysis.mock.calls[1][2]).toBe(createAnalysis.mock.calls[0][2]);
    expect(getFile).toHaveBeenCalledWith(1,991);expect(downloadFile).toHaveBeenCalledWith(2,991);
  });
  it('rejects foreign, oversized, changed and duplicate sources before staging',async()=>{
    getFile.mockResolvedValueOnce({...source(),businessProfileId:2});
    await expect(scope(()=>files.analyzeStoredContactWorkbooks({fileIds:[1],options:{defaultCountry:'none'},requestKey:'analysis-one'}))).rejects.toThrow('not found');
    getFile.mockResolvedValueOnce({...source(),fileSizeBytes:26*1024*1024});
    await expect(scope(()=>files.analyzeStoredContactWorkbooks({fileIds:[1],options:{defaultCountry:'none'},requestKey:'analysis-one'}))).rejects.toThrow('25 MB');
    expect(downloadFile).not.toHaveBeenCalled();
    downloadFile.mockResolvedValueOnce({file:{...source(),updatedAt:new Date()},buffer:Buffer.alloc(12)});
    await expect(scope(()=>files.analyzeStoredContactWorkbooks({fileIds:[1],options:{defaultCountry:'none'},requestKey:'analysis-one'}))).rejects.toThrow('changed');
    await expect(scope(()=>files.analyzeStoredContactWorkbooks({fileIds:[1,1],options:{defaultCountry:'none'},requestKey:'analysis-one'}))).rejects.toThrow();
    expect(createAnalysis).not.toHaveBeenCalled();
  });
  it('opens an exact completed import preview without starting an import and refuses expired previews',async()=>{
    const id=randomUUID();owned.mockResolvedValue({id,status:'ready',expires_at:new Date(Date.now()+86400000),result:{totals:{readyContacts:575,reviewContacts:2,duplicateRows:12}}});
    expect(await execute(tools.reviewContactImportTool,{analysisId:id})).toMatchObject({success:true,output:{status:'review',card:{actions:[{href:`/dashboard/crm/import/analyze?operationId=${id}`}]}}});
    expect(createAnalysis).not.toHaveBeenCalled();owned.mockResolvedValue({id,status:'ready',expires_at:new Date(0)});
    expect(await execute(tools.reviewContactImportTool,{analysisId:id})).toMatchObject({success:false,error:expect.stringContaining('expired')});
  });
  it('projects draft readiness separately from runtime and links exact failed settings',async()=>{
    const id=randomUUID(),assistant={id,state:'draft',draft:{name:'Hotel help'},published:null,publishedRevision:null,readiness:{ready:false,checks:[{key:'knowledge',label:'Knowledge',ok:false,detail:'Choose sources.'}]}};
    assistantGet.mockResolvedValue(assistant);diagnostics.mockResolvedValue({assignments:[],metrics:[],knowledgeGaps:[],usage:[],days:30});
    expect(await execute(tools.queryAssistantDiagnosticsTool,{assistantId:id,days:30})).toMatchObject({success:true,output:{runtimeEnabled:false,
      assistants:[{draftReady:false,checks:[{key:'knowledge',ok:false,href:`/dashboard/settings/outreach/assistants/${id}?tab=knowledge`}]}],card:{status:'review'}}});
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({assistantId:id,days:30}));
  });
  it('accepts result cards only from successful audited tools and strips unsafe links/raw data',()=>{
    const output={id:randomUUID(),status:'ready',kind:'contact_analysis',result:{totals:{readyContacts:575,raw:'private'}},card:{title:'Analysis',status:'ready',
      actions:[{label:'Open',href:'/dashboard/crm/import/analyze'},
        {label:'Report',href:'/dashboard/outreach/reports?preparedOutreachId=10000000-0000-4000-8000-000000000001'},
        {label:'Leak',href:'https://example.com'},{label:'Unauthenticated',href:'/api/private'}]}};
    const receipt=(toolName:string,success=true)=>({toolName,success,toolCallId:'call-1',result:{success,output}});
    expect(operationCardsFromReceipts([receipt('unknown'),receipt('get_dashboard_operation',false)],1)).toEqual([]);
    expect(operationCardsFromReceipts([receipt('get_dashboard_operation')],1)[0]).toMatchObject({businessProfileId:1,actions:[{label:'Open'},{label:'Report',href:expect.stringContaining('preparedOutreachId=10000000')}]});
    expect(dashboardOperationEvidence(output)).toMatchObject({totals:{readyContacts:575}});
    expect(JSON.stringify(dashboardOperationEvidence(output))).not.toContain('private');
  });
});
