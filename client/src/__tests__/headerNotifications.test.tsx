import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { get, put, del, push, subscribe, toast } = vi.hoisted(() => ({get:vi.fn(),put:vi.fn(),del:vi.fn(),push:vi.fn(),toast:vi.fn(),subscribe:vi.fn(()=>()=>{})}));
vi.mock('@/lib/api',()=>({api:{get,put,delete:del}}));
vi.mock('@/contexts/AuthContext',()=>({useAuth:()=>({isAuthenticated:true,user:{id:9,name:'Fixture'},logout:vi.fn()})}));
vi.mock('@/contexts/WebSocketContext',()=>({useWebSocket:()=>({subscribe})}));
vi.mock('@/hooks/use-billing-organizations',()=>({useBillingOrganizations:()=>({ready:true,billingScopeKey:'fixture'})}));
vi.mock('@tanstack/react-query',()=>({useQuery:()=>({})}));
vi.mock('next/navigation',()=>({useRouter:()=>({push}),usePathname:()=>'/dashboard/notifications'}));
vi.mock('@/components/CommandPalette',()=>({CommandPalette:()=>null}));
vi.mock('@/components/ThemeToggle',()=>({ThemeToggle:()=>null}));
vi.mock('next/image',()=>({default:()=>null}));
vi.mock('@/hooks/use-toast',()=>({useToast:()=>({toast})}));
import Header from '@/components/Header';
import Inbox from '@/app/dashboard/(main)/notifications/page';
const item=(id:number)=>({id,title:`Notice ${id}`,message:'Synthetic',type:'info',read:false,actionUrl:null,createdAt:'2026-10-23T10:00:00Z'});
let unread:number;
const result=()=>({items:[item(1),item(2)],unreadCount:unread,totalCount:2,pagination:{page:1,limit:20,total:2,totalPages:1,hasMore:false,nextCursor:null}});
beforeEach(()=>{vi.clearAllMocks();unread=2;localStorage.setItem('user',JSON.stringify({id:9}));sessionStorage.setItem('active-business-profile:9','101');get.mockImplementation(async(url:string)=>url.includes('/unread/count')?{count:unread}:result());put.mockImplementation(async()=>{unread=1;return {};});});
afterEach(cleanup);
describe('notification bell reconciliation',()=>{
  it('reconciles the same-window bell after a real inbox component mutation',async()=>{
    render(<><Header/><Inbox/></>);await screen.findByRole('button',{name:'Notifications (2 unread)'});
    fireEvent.click(await screen.findByRole('button',{name:'Mark Notice 1 as read'}));
    await screen.findByRole('tab',{name:'Unread (1)'});
    await screen.findByRole('button',{name:'Notifications (1 unread)'});
  });
  it('reconciles another tab storage signal and focus from authoritative counts',async()=>{
    render(<Header/>);await screen.findByRole('button',{name:'Notifications (2 unread)'});unread=1;
    act(()=>window.dispatchEvent(new StorageEvent('storage',{key:'notifications:changed',newValue:'fixture'})));
    await screen.findByRole('button',{name:'Notifications (1 unread)'});unread=0;fireEvent.focus(window);
    await screen.findByRole('button',{name:'Notifications'});
  });
  it('reconciles a bell read whose committed response was lost',async()=>{
    put.mockImplementation(async()=>{unread=1;throw new Error('Response lost after commit');});
    render(<Header/>);fireEvent.click(await screen.findByRole('button',{name:'Notifications (2 unread)'}));
    fireEvent.click(await screen.findByText('Notice 1',{exact:true}));
    await screen.findByRole('button',{name:'Notifications (1 unread)'});
  });
});

describe('notification bell read states',()=>{
  it('shows loading instead of claiming an empty inbox before the list settles',async()=>{
    get.mockImplementation((url:string)=>url.includes('/unread/count')?Promise.resolve({count:2}):new Promise(()=>{}));
    render(<Header/>);fireEvent.click(await screen.findByRole('button',{name:'Notifications (2 unread)'}));
    await screen.findByText('Loading notifications…',{exact:true});expect(screen.queryByText('No new notifications',{exact:true})).not.toBeInTheDocument();
  });
  it('reports an initial failed read and retries to a genuine successful empty result',async()=>{
    let fail=true;get.mockImplementation(async(url:string)=>{if(url.includes('/unread/count'))return {count:2};if(fail)throw new Error('Unavailable');return {items:[],unreadCount:0};});
    render(<Header/>);fireEvent.click(await screen.findByRole('button',{name:'Notifications (2 unread)'}));
    await screen.findByText('Notifications unavailable.',{exact:true});expect(screen.queryByText('No new notifications',{exact:true})).not.toBeInTheDocument();
    fail=false;fireEvent.click(screen.getByRole('button',{name:'Retry notifications'}));await screen.findByText('No new notifications',{exact:true});
  });
  it('labels cached rows stale after a failed refresh and recovers on retry',async()=>{
    render(<Header/>);fireEvent.click(await screen.findByRole('button',{name:'Notifications (2 unread)'}));await screen.findByText('Notice 1',{exact:true});
    get.mockRejectedValue(new Error('Permission or connection unavailable'));
    act(()=>window.dispatchEvent(new StorageEvent('storage',{key:'notifications:changed'})));
    await screen.findByText('Notifications could not be refreshed. Showing stale notifications.',{exact:true});expect(screen.getByText('Notice 1',{exact:true})).toBeVisible();
    get.mockResolvedValue({items:[],unreadCount:0});fireEvent.click(screen.getByRole('button',{name:'Retry notifications'}));await screen.findByText('No new notifications',{exact:true});
  });
  it('ignores an older list completion after a newer reconciliation',async()=>{
    let release!:(value:unknown)=>void;const old=new Promise(resolve=>{release=resolve;});let first=true;
    get.mockImplementation((url:string)=>{if(url.includes('/unread/count'))return Promise.resolve({count:2});if(first){first=false;return old;}return Promise.resolve({items:[item(3)],unreadCount:1});});
    render(<Header/>);fireEvent.click(await screen.findByRole('button',{name:'Notifications (2 unread)'}));
    act(()=>window.dispatchEvent(new StorageEvent('storage',{key:'notifications:changed'})));await screen.findByText('Notice 3',{exact:true});
    await act(async()=>release({items:[item(1)],unreadCount:2}));expect(screen.queryByText('Notice 1',{exact:true})).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'Notifications (1 unread)'})).toBeVisible();
  });
});

describe('notification bell actions',()=>{
  it('exposes individually named semantic row buttons and suppresses duplicate pending reads',async()=>{
    let finish!:(value:unknown)=>void;put.mockImplementation(()=>new Promise(r=>{finish=r;}));
    render(<Header/>);fireEvent.click(await screen.findByRole('button',{name:'Notifications (2 unread)'}));
    const row=await screen.findByRole('button',{name:'Notification: Notice 1 (unread)'});
    fireEvent.click(row);fireEvent.click(row);expect(put).toHaveBeenCalledTimes(1);await act(async()=>finish({}));
  });
});
