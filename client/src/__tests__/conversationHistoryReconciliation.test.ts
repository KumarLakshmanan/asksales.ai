import {expect,it} from 'vitest';
import {mergeConversationHistory} from '@/lib/conversation-history-reconciliation';
import {createConversationStreamAccumulator,ingestConversationStreamChunk,type ConversationStreamAccumulator} from '@/lib/conversation-stream-reducer';
type Row={id:string;role:string;content:string;timestamp:number;metadata?:Record<string,unknown>};
const row=(id:string,timestamp=1000,extra:Partial<Row>={}):Row=>({id,role:'assistant',content:`Message ${id}`,timestamp,...extra});
const streams=()=>new Map<string,ConversationStreamAccumulator>();
it('keeps a durable receipt delivered while an older empty snapshot was pending',()=>{
  const live=row('501');expect(mergeConversationHistory([], [live], [], streams())).toMatchObject([live]);
});
it('does not resurrect unchanged messages omitted by a fresh snapshot',()=>{
  const old=row('1');expect(mergeConversationHistory([], [old], [old], streams())).toEqual([]);
});
it('discards only the reserved introduction, retaining a legitimate stored message 1',()=>{
  const intro=row('welcome',1000,{role:'agent',content:'Introduction'});const stored=row('1');
  expect(mergeConversationHistory([], [intro,stored], [], streams()).map(message=>message.id)).toEqual(['1']);
});
it('keeps a live update to an existing ID once, over its older snapshot',()=>{
  const old=row('1');const changed={...old,content:'New receipt',metadata:{actionResolution:{outcome:'approved'}}};
  expect(mergeConversationHistory([{...old}], [changed], [old], streams())).toMatchObject([changed]);
});
it('deduplicates a durable receipt already included in the read',()=>{
  const live=row('1');expect(mergeConversationHistory([{...live}], [live], [], streams()).map(message=>message.id)).toEqual(['1']);
});
it('keeps an unfinished stream without sealing it before the next chunk',()=>{
  const accumulator=createConversationStreamAccumulator();const map=new Map([['reply',accumulator]]);
  ingestConversationStreamChunk(accumulator,{sequence:1,chunk:'Live',done:false});
  const partial=row('streaming-reply',1000,{content:'Live',metadata:{responseId:'reply',streaming:true}});
  expect(mergeConversationHistory([], [partial], [], map)).toEqual([partial]);
  expect(ingestConversationStreamChunk(accumulator,{sequence:2,chunk:' stream',done:true}).appendedText).toBe(' stream');
});
it('prefers the snapshot final receipt over a partial stream and seals late chunks',()=>{
  const final=row('10',1000,{content:'Final',metadata:{responseId:'reply'}});
  const partial=row('streaming-reply',1000,{metadata:{responseId:'reply',streaming:true}});const map=streams();
  expect(mergeConversationHistory([final], [partial], [], map)).toEqual([final]);expect(map.get('reply')?.completed).toBe(true);
});
it('preserves PostgreSQL snapshot ordering even when JS milliseconds tie and IDs differ',()=>{
  const history=[row('9'),row('2')];const newer=row('12',1001);
  expect(mergeConversationHistory(history,[newer],[],streams()).map(message=>message.id)).toEqual(['9','2','12']);
  expect(history.map(message=>message.id)).toEqual(['9','2']);
});
it('inserts delayed live receipts chronologically without reversing snapshot rows',()=>{
  const history=[row('1',1000),row('4',2000)];
  expect(mergeConversationHistory(history,[row('3',1500),row('2',1500)],[],streams()).map(message=>message.id)).toEqual(['1','2','3','4']);
});
it('replaces a transient receipt with its durable update while retaining one response',()=>{
  const transient=row('streaming-reply',1000,{metadata:{responseId:'reply',streaming:true}});
  const final=row('10',1000,{metadata:{responseId:'reply'}});
  const result=mergeConversationHistory([],[transient,final],[],streams());expect(result.map(message=>message.id)).toEqual(['10']);
});
