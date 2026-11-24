import {createTool} from '@mastra/core/tools';
import {z,ZodError} from 'zod';
import {createHash} from 'node:crypto';
import type {ToolContext} from './toolRegistry.js';
import {requireBusinessScope} from '../../tenancy/businessContext.js';
import type {PlatformModuleKey} from '../../utils/platformModules.js';
import {getEffectiveModuleAccess} from '../../models/platformAccess/functions.js';
import {DashboardOperationError,ownedDashboardOperation,dashboardOperationStatus,listDashboardOperations} from '../../services/operations/DashboardOperations.js';
import {analyzeStoredContactWorkbooks,listStoredContactWorkbooks,storedWorkbookListSchema,storedContactAnalysisSchema} from '../../services/operations/StoredContactWorkbooks.js';
import {contactAnalysisOptionsSchema,operationIdSchema,operationRequestKeySchema} from '../../services/operations/ContactAnalysisValidation.js';
import type {ContactAnalysisSummary} from '../../../shared/contactAnalysis.js';
import type {DashboardOperationResult} from '../../../shared/dashboardOperations.js';
import {normalizeCapacityError} from '../../services/billing/entitlements.js';
import {logger} from '../../utils/logger.js';
import {ContactAnalysisError} from '../../services/contacts/ContactWorkbookAnalysis.js';
import {AssistantManagementError} from '../../services/assistants/AssistantManagementError.js';

const resultSchema=z.object({success:z.boolean(),toolName:z.string(),output:z.unknown().optional(),error:z.string().optional()});
export async function runDashboardTool(name:string,module:PlatformModuleKey,context:ToolContext,work:()=>Promise<unknown>) {
  try {
    const scope=requireBusinessScope();
    if(!context || context.userId!==scope.userId)throw new DashboardOperationError('Authentication scope does not match this operation.',403);
    const access=(await getEffectiveModuleAccess(scope.userId)).find(item=>item.key===module);
    if(!access?.enabled)throw new DashboardOperationError(access?.message || 'This capability is unavailable for this account.',access?.status==='maintenance' ? 503 : 403);
    return {success:true,toolName:name,output:await work()};
  } catch(error) {
    const capacity=normalizeCapacityError(error);
    const known=error instanceof DashboardOperationError || error instanceof ContactAnalysisError || error instanceof AssistantManagementError;
    if(!known && !(error instanceof ZodError) && !capacity)logger.error({err:error,toolName:name},'[DashboardOperations] Tool unavailable');
    return {success:false,toolName:name,error:capacity?.message || (known ? error.message : error instanceof ZodError ? 'Check the operation inputs.' : 'This operation could not be checked. Open the dashboard to review it.')};
  }
}
/** The per-request tool context Mastra passes to dashboard tools. */
export const toolContext=(mastra:unknown)=>(mastra as {__toolContext:ToolContext})?.__toolContext;
export const listContactWorkbooksTool=createTool({
  id:'list_contact_workbooks',description:'List owned Excel/CSV/TSV uploads in the selected business, with exact file IDs and pagination. Does not open paths, fetch URLs, import contacts or send messages. Use before selecting a saved upload; never infer counts from truncated attachment text.',
  inputSchema:storedWorkbookListSchema,outputSchema:resultSchema,
  execute:async(input,{mastra})=>runDashboardTool('list_contact_workbooks','crm',toolContext(mastra),async()=>{
    const page=await listStoredContactWorkbooks(input);
    return {...page,card:{title:'Contact workbooks',status:'ready',metrics:[{label:'Files on this page',value:page.files.length}],
      actions:[{label:'Upload contact files',href:'/dashboard/crm/import/analyze'}]} satisfies DashboardOperationResult};
  }),
});
export const analyzeContactFilesTool=createTool({
  id:'analyze_contact_files',description:'Analyze exact owned stored workbook IDs using the same durable multi-file preview as CRM. Returns a queued operation and live progress; read its status for completed counts. Creates only temporary analysis state, never CRM contacts or sends. Country defaults to none; choose IN only when the audience is explicitly Indian. Source files count against temporary storage for 30 days.',
  inputSchema:z.object({fileIds:z.array(z.number().int().positive()).min(1).max(20),options:contactAnalysisOptionsSchema.default({defaultCountry:'none'}),requestKey:operationRequestKeySchema.optional()}).strict(),outputSchema:resultSchema,
  execute:async(input,{mastra})=>{
    const context=toolContext(mastra);
    return runDashboardTool('analyze_contact_files','crm',context,async()=>{
      const requestKey=input.requestKey || `analysis-${createHash('sha256').update(JSON.stringify([context.runContext?.runId,context.threadId,new Date().toISOString().slice(0,10),input.fileIds,input.options])).digest('hex')}`;
      return analyzeStoredContactWorkbooks(storedContactAnalysisSchema.parse({...input,requestKey}));
    });
  },
});
export const getDashboardOperationTool=createTool({
  id:'get_dashboard_operation',description:'Read an owned contact analysis/import operation, counts, errors, progress and exact dashboard links. Omit operationId to list recent contact operations. Never resume or import implicitly; ready preview counts are not imported totals.',
  inputSchema:z.object({operationId:operationIdSchema.optional()}).strict(),outputSchema:resultSchema,
  execute:async(input,{mastra})=>runDashboardTool('get_dashboard_operation','crm',toolContext(mastra),async()=>input.operationId
    ? dashboardOperationStatus(input.operationId,['contact_analysis','contact_import'])
    : {items:(await listDashboardOperations(['contact_analysis','contact_import'])).slice(0,10)}),
});
export const reviewContactImportTool=createTool({
  id:'review_contact_import',description:'Open the exact completed analysis for import review. Returns ready/flagged counts and the existing confirmation screen; importing starts only when the user clicks Import ready contacts there. Never imports by calling this tool.',
  inputSchema:z.object({analysisId:operationIdSchema}).strict(),outputSchema:resultSchema,
  execute:async(input,{mastra})=>runDashboardTool('review_contact_import','crm',toolContext(mastra),async()=>{
    const operation=await ownedDashboardOperation(input.analysisId,['contact_analysis'],undefined,false);
    if(new Date(operation.expires_at).getTime()<=Date.now())throw new DashboardOperationError('These staged files expired. Upload the files again.',410);
    if(operation.status!=='ready')throw new DashboardOperationError('Wait for this contact analysis to finish before reviewing an import.',409);
    const summary=operation.result as unknown as ContactAnalysisSummary;
    return {analysisId:operation.id,status:'review',totals:summary.totals,card:{title:'Review contact import',status:'review',
      description:'Confirm the ready audience on the analysis page to start the import.',
      metrics:[{label:'Ready to import',value:summary.totals.readyContacts},{label:'Needs review',value:summary.totals.reviewContacts},{label:'Duplicate rows',value:summary.totals.duplicateRows}],
      actions:[{label:'Review import',href:`/dashboard/crm/import/analyze?operationId=${operation.id}`}]} satisfies DashboardOperationResult};
  }),
});
const diagnosticSchema=z.object({assistantId:z.string().uuid().optional(),search:z.string().trim().max(120).optional(),cursor:z.string().max(2000).optional(),days:z.number().int().min(1).max(90).default(30),
  channel:z.enum(['whatsapp','instagram','facebook','email','web']).optional(),accountId:z.string().min(1).max(255).optional()}).strict();
export const queryAssistantDiagnosticsTool=createTool({
  id:'query_assistant_diagnostics',description:'Read saved assistant readiness and operational diagnostics using the dashboard services. Returns exact assistant/settings links and account-specific checks. Distinguishes draft readiness, published routing and the global runtime switch. Does not enable, publish, change accounts, simulate customer sends or reveal credentials.',
  inputSchema:diagnosticSchema,outputSchema:resultSchema,
  execute:async(input,{mastra})=>runDashboardTool('query_assistant_diagnostics','support_ai',toolContext(mastra),async()=>{
    const {assistantService}=await import('../../services/assistants/AssistantService.js');
    const {assistantOperations}=await import('../../services/assistants/AssistantOperationsService.js');
    const {assistantsRuntimeEnabled}=await import('../../services/assistants/AssistantContext.js');
    const [page,diagnostics]=await Promise.all([
      input.assistantId ? assistantService.get(input.assistantId).then(assistant=>({assistants:[assistant],nextCursor:null})) : assistantService.listPage({search:input.search,cursor:input.cursor,limit:24}),
      assistantOperations.diagnostics({assistantId:input.assistantId,channel:input.channel,accountId:input.accountId,days:input.days}),
    ]);
    const section:Record<string,string>={identity:'basic',accounts:'basic',model:'ai',response:'ai',classifier:'ai',privacy:'privacy',knowledge:'knowledge',documents:'tools',galleries:'tools',playbooks:'playbooks',collection:'privacy',followUps:'followups',tools:'tools',availability:'availability'};
    const assistants=page.assistants.map(a=>({id:a.id,name:a.published?.name || a.draft.name,state:a.state,publishedRevision:a.publishedRevision,
      draftReady:a.readiness.ready,checks:a.readiness.checks.map(check=>({...check,href:`/dashboard/settings/outreach/assistants/${a.id}?tab=${section[check.key] || 'basic'}`})),
      href:`/dashboard/settings/outreach/assistants/${a.id}`}));
    const runtimeEnabled=assistantsRuntimeEnabled();
    return {checkedAt:new Date().toISOString(),runtimeEnabled,assistants,nextCursor:page.nextCursor,diagnostics,
      card:{title:'Assistant diagnostics',status:runtimeEnabled && assistants.length>0 && assistants.every(a=>a.state==='live') ? 'ready' : 'review',
        description:runtimeEnabled ? 'Readiness and runtime activity are shown separately. Open an assistant to review its current checks.' : 'Customer delivery is disabled by the server runtime setting. Drafts and simulations remain available.',
        metrics:[{label:'Assistants on this page',value:assistants.length},{label:'Connected account assignments',value:diagnostics.assignments.length}],
        actions:assistants.slice(0,3).map(a=>({label:a.name || 'Open assistant',href:a.href}))} satisfies DashboardOperationResult};
  }),
});
export const dashboardContactTools={list_contact_workbooks:listContactWorkbooksTool,analyze_contact_files:analyzeContactFilesTool,get_dashboard_operation:getDashboardOperationTool,review_contact_import:reviewContactImportTool};
export const dashboardOutreachTools={...dashboardContactTools,query_assistant_diagnostics:queryAssistantDiagnosticsTool};
