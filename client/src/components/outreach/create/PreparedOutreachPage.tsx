"use client";
import {useEffect,useState,useSyncExternalStore} from 'react';
import {api} from '@/lib/api';
import {creatorSessionScope} from '@/lib/creator-session';
import {selectedBusinessProfileId,subscribeBusinessProfile} from '@/lib/business-profile';
import {OutreachCreationPage} from './OutreachCreationPage';
import {OperationResultCard} from '@/components/operations/OperationResultCard';
import type {PreparedOutreach} from '../../../../../shared/preparedOutreach';
function localDateTime(value?:string) {
  if(!value)return '';
  const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
}
export function PreparedOutreachPage({id}:{id:string}) {
  const scope=useSyncExternalStore(subscribeBusinessProfile,creatorSessionScope,()=> 'anonymous');
  return <PreparedOutreachWorkspace key={`${scope}:${id}`} id={id} scope={scope}/>;
}
function PreparedOutreachWorkspace({id,scope}:{id:string;scope:string}) {
  const [prepared,setPrepared]=useState<PreparedOutreach>(),[error,setError]=useState('');
  useEffect(()=>{
    const controller=new AbortController();
    api.get<PreparedOutreach>(`/api/outreach/prepared/${id}`,{signal:controller.signal}).then(result=>{
      if(controller.signal.aborted || creatorSessionScope()!==scope)return;
      if(result.businessProfileId!==selectedBusinessProfileId())throw new Error('Select the original business to open this preparation.');
      setPrepared(result);
    }).catch(reason=>{if(!controller.signal.aborted && creatorSessionScope()===scope)setError(reason instanceof Error ? reason.message : 'Prepared outreach could not be loaded.');});
    return ()=>controller.abort();
  },[id,scope]);
  if(error)return <p role="alert" className="p-6 text-sm">{error}</p>;
  if(!prepared)return <p role="status" className="p-6 text-sm">Loading prepared outreach…</p>;
  if(prepared.launch)return <div className="mx-auto max-w-5xl p-5"><OperationResultCard result={{...prepared.card,status:prepared.launch.status==='processing' ? 'running' : 'completed',
    description:prepared.launch.status==='processing' ? 'This batch was submitted. Check the report for saved messages and current queue progress.' : 'This batch has a saved launch receipt. Open its report for the latest delivery and queue counts.',
    actions:prepared.card.actions?.filter(action=>!action.href.startsWith('/dashboard/outreach/prepared/'))}}/></div>;
  return <div><div className="mx-auto max-w-[1460px] space-y-2 px-5 pt-5"><h1 className="text-xl font-semibold">{prepared.name}</h1>
    <p className="text-sm text-muted-foreground">{prepared.audience.name} · {prepared.audience.count.toLocaleString()} selected recipients. Review the current account and recipient checks before sending.</p>
    {prepared.warnings.map(warning=><p key={warning} className="text-sm text-muted-foreground">{warning}</p>)}</div>
    <OutreachCreationPage embedded={{initial:{...prepared.draft,schedule:localDateTime(prepared.draft.scheduledFor)},standalone:true,reviewOnLoad:true,preparedOutreachId:prepared.id}}/></div>;
}
