"use client";
import {useEffect,useRef} from 'react';
import webSocketService from '@/services/WebSocketService';

/** Profile-filtered realtime events, with a visible-page recovery poll for missed updates. */
export function useCrmAutomationRefresh(refresh:()=>void|Promise<unknown>,pollingMs=30_000) {
  const ref=useRef(refresh);
  useEffect(()=>{ref.current=refresh;},[refresh]);
  useEffect(()=>{
    let busy=false;
    const run=()=>{if (busy || document.visibilityState==='hidden') return;busy=true;
      void Promise.resolve(ref.current()).catch(()=>undefined).finally(()=>{busy=false;});};
    const unsub=webSocketService.subscribe('events:crm:automation:updated',run);
    const reconnect=webSocketService.subscribe('websocket_connected',run);
    const timer=pollingMs>0 ? window.setInterval(run,pollingMs) : undefined;
    document.addEventListener('visibilitychange',run);
    return ()=>{unsub();reconnect();if (timer) window.clearInterval(timer);document.removeEventListener('visibilitychange',run);};
  },[pollingMs]);
}
