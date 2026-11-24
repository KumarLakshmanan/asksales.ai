import {dashboardResultCards} from '../../../shared/dashboardOperations.js';
const object=(v:unknown):Record<string,unknown>=>v && typeof v==='object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
const counts=(v:unknown)=>Object.fromEntries(Object.entries(object(v)).filter(([,value])=>Number.isSafeInteger(value) && Number(value)>=0));
const id=(v:unknown)=>typeof v==='string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v) ? v : null;
const text=(v:unknown,limit=255)=>typeof v==='string' ? v.slice(0,limit) : undefined;
export function campaignEngagementEvidence(value:unknown) {
  const output=object(value),card=dashboardResultCards([output.card])[0];if(!card || !Array.isArray(output.items))return undefined;
  return {checkedAt:text(output.checkedAt),total:Number.isSafeInteger(output.total) ? output.total : undefined,moreAvailable:!!output.nextCursor,
    customerKey:text(output.customerKey),items:output.items.slice(0,50).map(value=>{
      const item=object(value);return {key:text(item.key),name:text(item.name),...counts(item),responded:typeof item.responded==='boolean' ? item.responded : undefined,
        id:text(item.id),customerKey:text(item.customerKey),channel:text(item.channel),direction:text(item.direction),createdAt:text(item.createdAt),
        content:text(item.content,1500),selection:typeof object(item.selection).kind==='string' ? {kind:text(object(item.selection).kind),title:text(object(item.selection).title)} : undefined};
    }),availability:output.availability ? {callButtonClicks:'unavailable',untrackedWhatsAppUrlClicks:'unavailable',bookingActions:'verified_records_only'} : undefined};
}
export function preparedOutreachEvidence(value:unknown) {
  const output=object(value),card=dashboardResultCards([output.card])[0],key=id(output.id),audience=object(output.audience),draft=object(output.draft);
  const reviewed=object(object(object(output.launch).receipt).reviewed);
  const submittedConfiguration={...Object.fromEntries(['channel','providerAccountId','templateName','templateLanguage'].flatMap(field=>
    typeof reviewed[field]==='string' && reviewed[field].length<=255 ? [[field,reviewed[field]]] : [])),
    ...counts({senderId:reviewed.senderId,recipientCount:reviewed.recipientCount}),
    ...(typeof reviewed.whatsappOptInConfirmed==='boolean' ? {whatsappOptInConfirmed:reviewed.whatsappOptInConfirmed} : {})};
  if(!key || !card?.actions?.some(action=>action.href===`/dashboard/outreach/prepared/${key}`) || !Number.isSafeInteger(audience.count) || Number(audience.count)<1)return undefined;
  return {id:key,recipientCount:Number(audience.count),channel:draft.channel,accountId:draft.accountId,templateId:draft.templateId,
    followUpCount:card.metrics?.find(metric=>metric.label==='Follow-ups')?.value || 0,draftConsentConfirmed:false,
    submitted:!!object(output.launch).submittedAt,submittedConfiguration};
}
/** Only documented scalar facts; uploaded cells and model narratives are absent. */
export function dashboardOperationEvidence(value:unknown) {
  const output=object(value),result=object(output.result),card=dashboardResultCards([output.card])[0];
  if(!card)return undefined;
  return {card,id:id(output.id || output.analysisId),
    kind:['contact_analysis','contact_import'].includes(String(output.kind)) ? output.kind : undefined,
    status:['queued','running','ready','completed','failed','review','cancelled'].includes(String(output.status)) ? output.status : undefined,
    totals:counts(output.totals || result.totals),importCounts:counts(result),retryCounts:counts(output.counts),
    preparationChoices:output.options ? {
      accounts:(Array.isArray(object(output.options).accounts) ? object(output.options).accounts as unknown[] : []).slice(0,50).map(value=>{
        const account=object(value);return {id:text(account.id),label:text(account.label),providerAccountId:text(account.providerAccountId),
          ...counts({senderId:account.senderId}),ready:typeof account.ready==='boolean' ? account.ready : undefined,reason:text(account.reason)};
      }),
      audiences:(Array.isArray(output.audiences) ? output.audiences : []).slice(0,50).map(value=>{const audience=object(value);return {source:text(audience.source),name:text(audience.name),...counts({importId:audience.importId,count:audience.count})};}),
      templates:(Array.isArray(output.templates) ? output.templates : []).slice(0,50).map(value=>{const template=object(value);return {id:text(template.id),name:text(template.name),language:text(template.language)};}),
      truncated:object(output.truncated),
    } : undefined,
    runtimeEnabled:typeof output.runtimeEnabled==='boolean' ? output.runtimeEnabled : undefined,
    assistants:(Array.isArray(output.assistants) ? output.assistants : []).slice(0,24).map(value=>{
      const assistant=object(value);
      return {id:id(assistant.id),state:assistant.state,draftReady:assistant.draftReady,publishedRevision:assistant.publishedRevision,
        checks:(Array.isArray(assistant.checks) ? assistant.checks : []).slice(0,24).map(value=>{const check=object(value);return {key:check.key,ok:check.ok};})};
    }),
  };
}
