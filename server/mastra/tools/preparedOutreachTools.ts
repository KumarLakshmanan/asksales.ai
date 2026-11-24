import {createTool} from '@mastra/core/tools';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {INBOX_CHANNELS} from '../../../shared/outreachInbox.js';
import {preparedOutreachSchema,prepareOutreach,getPreparedOutreach} from '../../services/outreach/PreparedOutreachService.js';
import {operationRequestKeySchema} from '../../services/operations/ContactAnalysisValidation.js';
import {runDashboardTool, toolContext as contextFrom} from './dashboardOperationTools.js';
const resultSchema=z.object({success:z.boolean(),toolName:z.string(),output:z.unknown().optional(),error:z.string().optional()});
export const getPreparedOutreachTool=createTool({
  id:'get_prepared_outreach',description:'Read an exact owned prepared outreach draft, its selected audience/account/template/follow-up timings, saved launch receipt and dashboard links. Never sends or changes the draft. A saved launch receipt is submission history; use campaign reporting for current delivery counts.',
  inputSchema:z.object({preparedOutreachId:z.string().uuid()}).strict(),outputSchema:resultSchema,
  execute:async(input,{mastra})=>runDashboardTool('get_prepared_outreach','outreach',contextFrom(mastra),()=>getPreparedOutreach(input.preparedOutreachId)),
});
export const getOutreachPreparationOptionsTool=createTool({
  id:'get_outreach_preparation_options',description:'Read exact connected sending-account IDs and import-audience IDs for preparing outreach. With a selected WhatsApp account, also read its approved template IDs. Never sends or imports. Use returned IDs and ask for a choice when ambiguous.',
  inputSchema:z.object({channel:z.enum(INBOX_CHANNELS),providerAccountId:z.string().min(1).max(255).optional()}).strict(),outputSchema:resultSchema,
  execute:async(input,{mastra})=>{
    const context=contextFrom(mastra);
    return runDashboardTool('get_outreach_preparation_options','outreach',context,async()=>{
      const {getCreationOptions,getCreationTemplates}=await import('../../services/outreach/CreationService.js');
      const {getCreationImportSources}=await import('../../services/outreach/CreationImportSources.js');
      const [options,sources,templates]=await Promise.all([getCreationOptions(context.userId,input.channel),getCreationImportSources(context.userId),
        input.channel==='whatsapp' && input.providerAccountId ? getCreationTemplates(context.userId,input.providerAccountId) : []]);
      const audiences=[...sources.crmImports.map(batch=>({source:'crm',importId:batch.id,name:batch.fileName,count:batch.count})),
        ...sources.campaigns.flatMap(campaign=>campaign.uploads.map(batch=>({source:'campaign',importId:batch.id,name:batch.fileName,count:batch.count})))];
      return {options,audiences:audiences.slice(0,50),templates:templates.slice(0,50),truncated:{audiences:audiences.length>50,templates:templates.length>50},
        card:{title:'Outreach preparation options',status:'ready',actions:[{label:'Prepare outreach',href:'/dashboard/outreach/prepare'}]}};
    });
  },
});
export const prepareOutreachCampaignTool=createTool({
  id:'prepare_outreach_campaign',description:'Save a review-only outreach draft from an exact owned completed import, selected account, approved WhatsApp template/message, schedule and follow-up delays. Opens the populated existing composer for a fresh recipient review. Never sends, retries or imports. Consent stays unconfirmed until the user confirms in the composer.',
  inputSchema:z.object({...preparedOutreachSchema.shape,requestKey:operationRequestKeySchema.optional()}).strict(),outputSchema:resultSchema,
  execute:async(input,{mastra})=>{
    const context=contextFrom(mastra);
    return runDashboardTool('prepare_outreach_campaign','outreach',context,async()=>{
      const requestKey=input.requestKey || `prepare-${createHash('sha256').update(JSON.stringify([context.runContext?.runId,context.threadId,new Date().toISOString().slice(0,10),input])).digest('hex')}`;
      return prepareOutreach(preparedOutreachSchema.parse({...input,requestKey,threadId:input.threadId || context.threadId || undefined}));
    });
  },
});
