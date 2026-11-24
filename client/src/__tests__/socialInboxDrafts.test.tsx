import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import api from '@/lib/api';
import { useInboxConversation } from '@/components/outreach/inbox/useInboxConversation';
import { OutreachMessageBubble } from '@/components/outreach/OutreachMessageBubble';
import type { InboxItem } from '@/lib/outreach-inbox';
import type { OutreachMessage } from '@/components/outreach/types';
vi.mock('@/lib/api', () => ({default:{get:vi.fn(),post:vi.fn()}}));
afterEach(cleanup);
beforeEach(()=>vi.clearAllMocks());
const item={key:'conversation:4',kind:'conversation',id:4,channel:'instagram',subject:null,reply:{canReply:true,providerAccountId:'ig'}} as InboxItem;
const message=(id:number,status='sent',date=id):OutreachMessage=>({id,conversationId:4,direction:'outbound',content:`Reply ${id}`,status,
  sentAt:status==='draft'?null:new Date(date*1000).toISOString(),createdAt:new Date(id*1000).toISOString(),isRead:true,deliveredAt:null,readAt:null});
let page:OutreachMessage[]=[];
const read=vi.fn();const changed=vi.fn();
function mockPage(){vi.mocked(api.get).mockImplementation(async(url)=>url.includes('/inbox/')?{item}:{conversation:{id:4},messages:page});}
it('retains older drafts when a refresh jumps beyond the newest page and loads the intervening history',async()=>{
  page=[message(1,'draft'),message(2,'draft'),message(3)];mockPage();
  const {result}=renderHook(()=>useInboxConversation(item,0,new Map(),read,changed));
  await waitFor(()=>expect(result.current.messages).toHaveLength(3));
  page=Array.from({length:50},(_,i)=>message(100+i));
  await act(()=>result.current.refresh());
  expect(result.current.messages.filter(m=>m.status==='draft').map(m=>m.id)).toEqual([1,2]);
  page=[message(40),message(41,'draft'),message(42)];
  await act(()=>result.current.loadOlder());
  expect(result.current.messages.filter(m=>m.status==='draft').map(m=>m.id)).toEqual([1,2,41]);
  expect(api.get).toHaveBeenLastCalledWith(expect.stringContaining('beforeMessageId=100'));
});
it('orders native messages by provider time and drafts by creation time',async()=>{
  page=[message(10,'sent',1),message(3,'draft'),message(4,'draft')];mockPage();
  const {result}=renderHook(()=>useInboxConversation(item,0,new Map(),read,changed));
  await waitFor(()=>expect(result.current.messages.map(m=>m.id)).toEqual([10,3,4]));
});
it('discards only the chosen draft',async()=>{
  page=[message(1,'draft'),message(2,'draft')];mockPage();
  vi.mocked(api.post).mockImplementation(async()=>{page=[message(2,'draft')];return {};});
  const {result}=renderHook(()=>useInboxConversation(item,0,new Map(),read,changed));
  await waitFor(()=>expect(result.current.messages).toHaveLength(2));
  await act(()=>result.current.discard(message(1,'draft')));
  expect(api.post).toHaveBeenCalledWith('/api/outreach-conversations/instagram/4/discard-draft',{messageId:1});
  expect(result.current.messages.map(m=>m.id)).toEqual([2]);
});
it('shows each draft timestamp and keeps its send/edit/discard actions independent',()=>{
  const send=vi.fn();const edit=vi.fn();const discard=vi.fn();
  render(<>{[message(1,'draft'),message(2,'draft')].map(m=><OutreachMessageBubble key={m.id} message={m} channel="instagram" onSendDraft={send} onEditDraft={edit} onDiscardDraft={discard}/>)}</>);
  expect(screen.getAllByText('Drafted')).toHaveLength(2);
  fireEvent.click(screen.getAllByRole('button',{name:'Send'})[1]);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({id:2}));
  fireEvent.click(screen.getAllByRole('button',{name:'Edit'})[0]);
  expect(edit).toHaveBeenCalledWith(expect.objectContaining({id:1}));
  expect(screen.getAllByText('1 Jan 1970, 5:30 am')).toHaveLength(2);
});
it('labels a verified native outbound source without attributing it to a team member',()=>{
  render(<OutreachMessageBubble channel="instagram" message={{...message(1),metadata:{origin:'native_app'}}}/>);
  expect(screen.getByText(/Sent from Instagram/)).toBeInTheDocument();
});
