import {act,cleanup,renderHook} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {WidgetProvider,useWidgets} from '@/components/widgets/WidgetContext';
import type {WidgetState} from '@/components/widgets/types';
const {getWidgets,submitWidget}=vi.hoisted(()=>({getWidgets:vi.fn(),submitWidget:vi.fn()}));
vi.mock('@/components/widgets/api',()=>({widgetApi:{getWidgets,submitWidget}}));
afterEach(()=>{cleanup();vi.restoreAllMocks();getWidgets.mockReset();submitWidget.mockReset();});
const wrapper=({children}:{children:React.ReactNode})=><WidgetProvider>{children}</WidgetProvider>;
const widget:WidgetState={id:1,threadId:42,messageId:101,toolName:'generate_image',widgetType:'image_generation',status:'active',formValues:{prompt:'Harmless'},agentType:'content',createdAt:'2026-10-23T12:00:00Z',updatedAt:'2026-10-23T12:00:00Z'};
function failure(){vi.spyOn(console,'error').mockImplementation(()=>{});getWidgets.mockRejectedValueOnce(new Error('Synthetic 503: private provider detail'));}
it('exposes a safe history-load error and prevents submitting a missing review',async()=>{
  failure();const hook=renderHook(()=>useWidgets(),{wrapper});
  await act(async()=>{await hook.result.current.loadWidgets(42);});
  expect(hook.result.current.loadError).toMatch(/reviews.*could not be loaded/i);
  expect(hook.result.current.loadError).not.toContain('private provider detail');
  await expect(hook.result.current.submitWidget(1,{})).rejects.toThrow(/reload.*reviews/i);
  expect(submitWidget).not.toHaveBeenCalled();
});
it('retries the current thread without navigation and clears the error only after success',async()=>{
  failure();const hook=renderHook(()=>useWidgets(),{wrapper});
  await act(async()=>{await hook.result.current.loadWidgets(42);});
  let resolve!:(widgets:WidgetState[])=>void;getWidgets.mockReturnValueOnce(new Promise(r=>{resolve=r;}));
  let retry!:Promise<void>;act(()=>{retry=hook.result.current.retryLoadWidgets();});
  expect(hook.result.current.isLoading).toBe(true);expect(hook.result.current.loadError).toBeTruthy();
  await expect(hook.result.current.submitWidget(1,{})).rejects.toThrow(/reload.*reviews/i);
  await act(async()=>{resolve([widget]);await retry;});
  expect(getWidgets).toHaveBeenLastCalledWith(42);expect(hook.result.current.loadError).toBeNull();expect(hook.result.current.getWidget(1)).toEqual(widget);
});
it('discards an old failure after loading another thread',async()=>{
  vi.spyOn(console,'error').mockImplementation(()=>{});
  let reject!:(error:Error)=>void;getWidgets.mockReturnValueOnce(new Promise((_r,j)=>{reject=j;}));
  const hook=renderHook(()=>useWidgets(),{wrapper});let old!:Promise<void>;act(()=>{old=hook.result.current.loadWidgets(42);});
  getWidgets.mockResolvedValueOnce([]);await act(async()=>{await hook.result.current.loadWidgets(99);});
  await act(async()=>{reject(new Error('Old failure'));await old;});
  expect(hook.result.current.loadError).toBeNull();expect(hook.result.current.isLoading).toBe(false);
});
it('reset clears the failure and does not retry a departed thread',async()=>{
  failure();const hook=renderHook(()=>useWidgets(),{wrapper});await act(async()=>{await hook.result.current.loadWidgets(42);});
  act(()=>hook.result.current.resetWidgets());await act(async()=>{await hook.result.current.retryLoadWidgets();});
  expect(hook.result.current.loadError).toBeNull();expect(getWidgets).toHaveBeenCalledTimes(1);
});
it('retains a newer terminal receipt while a retry snapshot is pending',async()=>{
  failure();const hook=renderHook(()=>useWidgets(),{wrapper});await act(async()=>{await hook.result.current.loadWidgets(42);});
  let resolve!:(widgets:WidgetState[])=>void;getWidgets.mockReturnValueOnce(new Promise(r=>{resolve=r;}));let retry!:Promise<void>;
  act(()=>{retry=hook.result.current.retryLoadWidgets();});act(()=>hook.result.current.updateWidget({id:1,threadId:42,status:'succeeded'}));
  await act(async()=>{resolve([widget]);await retry;});
  expect(hook.result.current.getWidget(1)?.status).toBe('succeeded');expect(hook.result.current.loadError).toBeNull();
});
