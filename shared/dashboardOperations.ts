export interface DashboardOperationResult {
  title: string;
  description?: string;
  checkedAt?: string;
  businessProfileId?:number;
  operation?:{id:string;kind:'contact_analysis'|'contact_import'|'campaign_export'|'campaign_prepare'|'queue_retry'};
  status: 'ready' | 'queued' | 'running' | 'completed' | 'failed' | 'review' | 'cancelled';
  metrics?: Array<{label:string; value:string | number}>;
  progress?: {completed:number; total:number};
  actions?: Array<{label:string; href:string}>;
}
/** Project only the small serializable card contract at the chat boundary. */
export function dashboardResultCards(value:unknown):DashboardOperationResult[] {
  if(!Array.isArray(value))return [];
  return value.slice(0,6).flatMap(item=>{
    if(!item || typeof item!=='object')return [];
    const row=item as Record<string,unknown>;
    if(typeof row.title!=='string' || row.title.length>160 || !['ready','queued','running','completed','failed','review','cancelled'].includes(String(row.status)))return [];
    const card:DashboardOperationResult={title:row.title,status:row.status as DashboardOperationResult['status']};
    if(typeof row.description==='string')card.description=row.description.slice(0,1000);
    if(typeof row.checkedAt==='string' && Number.isFinite(Date.parse(row.checkedAt)))card.checkedAt=row.checkedAt;
    if(Number.isSafeInteger(row.businessProfileId) && Number(row.businessProfileId)>0)card.businessProfileId=Number(row.businessProfileId);
    const operation=row.operation as Record<string,unknown>|undefined;
    if(operation && typeof operation.id==='string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(operation.id)
      && ['contact_analysis','contact_import','campaign_export','campaign_prepare','queue_retry'].includes(String(operation.kind)))card.operation={id:operation.id,kind:operation.kind as NonNullable<DashboardOperationResult['operation']>['kind']};
    if(Array.isArray(row.metrics))card.metrics=row.metrics.slice(0,12).flatMap(m=>m && typeof m.label==='string' &&
      (typeof m.value==='string' || (typeof m.value==='number' && Number.isFinite(m.value))) ? [{label:m.label.slice(0,100),value:typeof m.value==='string' ? m.value.slice(0,150) : m.value}] : []);
    const progress=row.progress as Record<string,unknown>|undefined;
    if(progress && Number.isSafeInteger(progress.completed) && Number.isSafeInteger(progress.total) && Number(progress.completed)>=0 && Number(progress.total)>=0)card.progress={completed:Number(progress.completed),total:Number(progress.total)};
    if(Array.isArray(row.actions))card.actions=row.actions.slice(0,6).flatMap(a=>a && typeof a.label==='string' && typeof a.href==='string' && a.href.startsWith('/dashboard/') && !/[\u0000-\u0020\\]/.test(a.href)
      ? [{label:a.label.slice(0,120),href:a.href.slice(0,2000)}] : []);
    return [card];
  });
}
export interface DashboardOperation<T=unknown> {
  id:string;kind:'contact_analysis'|'contact_import'|'campaign_export'|'campaign_prepare'|'queue_retry';
  parentId?:string|null;
  status:'queued'|'running'|'ready'|'completed'|'failed'|'review'|'cancelled';
  processed:number;total:number;cursor:number;result:T|null;error:string|null;
  createdAt:string;updatedAt:string;expiresAt:string;
  links:{operation:string;contacts:string};card:DashboardOperationResult;
}
