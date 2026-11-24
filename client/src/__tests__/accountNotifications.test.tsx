import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { get, put, del, toast, push, subscribe, listeners } = vi.hoisted(() => {
  const listeners = new Map<string, () => void>();
  return { get:vi.fn(),put:vi.fn(),del:vi.fn(),toast:vi.fn(),push:vi.fn(),listeners,
    subscribe:vi.fn((type:string, fn:()=>void)=>{ listeners.set(type,fn); return ()=>listeners.delete(type); }) };
});
vi.mock('@/lib/api',()=>({api:{get,put,delete:del}}));
vi.mock('@/hooks/use-toast',()=>({useToast:()=>({toast})}));
vi.mock('next/navigation',()=>({useRouter:()=>({push})}));
vi.mock('@/contexts/WebSocketContext',()=>({useWebSocket:()=>({subscribe})}));
import Page from '@/app/dashboard/(main)/notifications/page';
const item = (id:number,title=`Notice ${id}`)=>({id,title,userId:9,message:'Fixture message',type:'info',read:false,actionUrl:'/dashboard/leads',createdAt:'2026-10-23T10:00:00Z',updatedAt:'2026-10-23T10:00:00Z'});
const result = (items=[item(1)], unreadCount=items.length, hasMore=false)=>({items,unreadCount,totalCount:items.length,pagination:{page:1,limit:20,total:items.length,totalPages:1,hasMore,nextCursor:hasMore?'fixture-cursor':null}});
const deferred = <T,>() => { let resolve!:(v:T)=>void; const promise=new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; };
beforeEach(()=>{vi.clearAllMocks();listeners.clear();get.mockResolvedValue(result());put.mockResolvedValue({});del.mockResolvedValue({});});
describe('account inbox request and mutation journeys',()=>{
  it('retries the first page with numeric pagination after a failure',async()=>{
    get.mockRejectedValueOnce(new Error('offline'));
    render(<Page/>); fireEvent.click(await screen.findByRole('button',{name:'Try again'}));
    await screen.findByText('Notice 1');
    expect(String(get.mock.calls[1][0])).toContain('page=1&limit=20');
  });
  it('ignores a late all response after switching to the unread filter',async()=>{
    const late=deferred<ReturnType<typeof result>>();get.mockResolvedValueOnce(result()).mockReturnValueOnce(late.promise).mockResolvedValue(result([item(2,'Unread current')]));
    render(<Page/>);await screen.findByText('Notice 1');
    act(()=>listeners.get('events:notification')?.());
    const unread=screen.getByRole('tab',{name:/Unread/});fireEvent.mouseDown(unread);fireEvent.click(unread);
    await screen.findByText('Unread current');
    await act(async()=>late.resolve(result([item(3,'Stale all')])));
    expect(screen.queryByText('Stale all')).not.toBeInTheDocument();expect(screen.getByText('Unread current')).toBeVisible();
  });
  it('uses the continuation cursor for load more',async()=>{
    get.mockResolvedValueOnce(result([item(1)],1,true)).mockResolvedValue(result([item(2)]));
    render(<Page/>);fireEvent.click(await screen.findByRole('button',{name:/Load more/}));
    await screen.findByText('Notice 2'); expect(String(get.mock.calls[1][0])).toContain('cursor=fixture-cursor');
  });
  it('refreshes from the server after mutation and prevents duplicate pending writes',async()=>{
    const pending=deferred<object>();put.mockReturnValue(pending.promise);
    get.mockResolvedValueOnce(result([item(1),item(2)],2)).mockResolvedValue(result([{...item(1),read:true},item(2)],1));
    render(<Page/>);const button=await screen.findByRole('button',{name:'Mark Notice 1 as read'});
    fireEvent.click(button);fireEvent.click(button);expect(put).toHaveBeenCalledTimes(1);
    await act(async()=>pending.resolve({}));await waitFor(()=>expect(get).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('tab',{name:'Unread (1)'})).toBeVisible();
  });
  it('refreshes on reconnect and tab focus; delete cancel makes no request',async()=>{
    render(<Page/>);fireEvent.click(await screen.findByRole('button',{name:'Delete Notice 1'}));
    fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(del).not.toHaveBeenCalled();
    act(()=>listeners.get('websocket_connected')?.());await waitFor(()=>expect(get).toHaveBeenCalledTimes(2));
    fireEvent.focus(window);await waitFor(()=>expect(get).toHaveBeenCalledTimes(3));
  });
});
