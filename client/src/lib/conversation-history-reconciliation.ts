import {
  isDurableConversationMessage,
  reconcileConversationResponseMessage,
  sealConversationStream,
  type ConversationStreamAccumulator,
  type ReconcileConversationMessage,
} from './conversation-stream-reducer';

/** Keep only updates received during this read, rather than resurrecting every
 * row from an older rendered page. The server's snapshot order remains intact,
 * including PostgreSQL timestamps more precise than JavaScript milliseconds. */
export function mergeConversationHistory<T extends ReconcileConversationMessage & {timestamp:number}>(
  history:readonly T[], current:readonly T[], beforeRead:readonly T[],
  accumulators:Map<string,ConversationStreamAccumulator>,
):T[]{
  const baseline=new Map(beforeRead.map(message=>[message.id,message]));
  const changes=current.filter(message=>message.id!=='welcome'&&baseline.get(message.id)!==message)
    .sort((a,b)=>a.timestamp-b.timestamp||Number(a.id)-Number(b.id)||0);
  let merged=[...history];
  for(const message of history){
    if(isDurableConversationMessage(message))sealConversationStream(accumulators,message.metadata?.responseId);
  }
  for(const message of changes){
    const existed=merged.some(row=>row.id===message.id);
    if(message.metadata?.streaming===true&&!isDurableConversationMessage(message)){
      const responseId=message.metadata?.responseId;
      if(merged.some(row=>isDurableConversationMessage(row)&&(row.id===message.id||
        (typeof responseId==='string'&&row.metadata?.responseId===responseId))))continue;
      // An unfinished stream is not a full-response receipt. Do not seal its
      // accumulator: subsequent chunks must still append after history loads.
      merged=existed?merged.map(row=>row.id===message.id?message:row):[...merged,message];
    }else{
      merged=reconcileConversationResponseMessage(merged,message,accumulators);
    }
    if(existed)continue;
    const index=merged.findIndex(row=>row.id===message.id);
    if(index<0)continue;
    const [added]=merged.splice(index,1);
    const next=merged.findIndex(row=>row.timestamp>added.timestamp);
    merged.splice(next<0?merged.length:next,0,added);
  }
  return merged;
}
