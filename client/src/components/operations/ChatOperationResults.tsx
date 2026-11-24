"use client";
import {useEffect,useState,useSyncExternalStore} from 'react';
import {api} from '@/lib/api';
import {creatorSessionScope} from '@/lib/creator-session';
import {selectedBusinessProfileId,subscribeBusinessProfile} from '@/lib/business-profile';
import {dashboardResultCards,type DashboardOperationResult,type DashboardOperation} from '../../../../shared/dashboardOperations';
import {OperationResultCard} from './OperationResultCard';

export function ChatOperationResults({results}:{results:unknown}) {
  const scope=useSyncExternalStore(subscribeBusinessProfile,creatorSessionScope,()=> 'anonymous');
  const business=selectedBusinessProfileId();
  const cards=dashboardResultCards(results).filter(card=>card.businessProfileId===business);
  return <div className="mt-3 space-y-3">{cards.map((card,index)=><LiveCard key={`${scope}:${card.operation?.id || index}`} initial={card} scope={scope}/>)}</div>;
}
function LiveCard({initial,scope}:{initial:DashboardOperationResult;scope:string}) {
  const [card,setCard]=useState(initial),[error,setError]=useState('');
  const operation=initial.operation;
  useEffect(()=>{
    if(!operation || !['queued','running'].includes(initial.status))return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try {
        const endpoint=operation.kind==='campaign_export' ? `/api/outreach/reports/exports/${operation.id}` : operation.kind==='queue_retry' ? `/api/outreach/retries/${operation.id}` : `/api/crm/contact-analysis/${operation.id}`;
        const result=await api.get<DashboardOperation>(endpoint,{signal:controller.signal});
        if(controller.signal.aborted || creatorSessionScope()!==scope)return;
        const latest=dashboardResultCards([result.card])[0];
        if(!latest || latest.businessProfileId!==initial.businessProfileId)throw new Error('Operation scope changed.');
        setCard(latest);setError('');if(['queued','running'].includes(latest.status))timer=setTimeout(poll,2500);
      } catch {
        if(controller.signal.aborted || creatorSessionScope()!==scope)return;
        setError('Live progress is unavailable. Open the operation to check its latest status.');
      }
    };
    void poll();return ()=>{controller.abort();clearTimeout(timer);};
  },[operation?.id,operation?.kind,initial.status,initial.businessProfileId,scope]);
  return <div><OperationResultCard result={card}/>{error && <p role="status" className="mt-2 text-xs text-muted-foreground">{error}</p>}</div>;
}
