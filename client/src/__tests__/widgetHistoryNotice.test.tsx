import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {WidgetProvider,useWidgets} from '@/components/widgets/WidgetContext';
import {WidgetHistoryNotice} from '@/components/widgets/WidgetHistoryNotice';
const {getWidgets}=vi.hoisted(()=>({getWidgets:vi.fn()}));
vi.mock('@/components/widgets/api',()=>({widgetApi:{getWidgets}}));
afterEach(()=>{cleanup();vi.restoreAllMocks();getWidgets.mockReset();});
function Consumer(){const state=useWidgets();return <><button onClick={()=>void state.loadWidgets(42)}>Load history</button><p>{state.widgets.length} reviews available</p></>;}
it('announces a safe load failure and offers keyboard retry without leaving the conversation',async()=>{
  vi.spyOn(console,'error').mockImplementation(()=>{});getWidgets.mockRejectedValueOnce(new Error('Synthetic outage'));
  render(<WidgetProvider><WidgetHistoryNotice/><Consumer/></WidgetProvider>);
  fireEvent.click(screen.getByRole('button',{name:'Load history'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Reviews could not be loaded');
  let resolve!:(value:unknown[])=>void;getWidgets.mockReturnValueOnce(new Promise(r=>{resolve=r;}));
  const retry=screen.getByRole('button',{name:'Retry reviews'});retry.focus();await userEvent.keyboard('{Enter}');
  await waitFor(()=>expect(getWidgets).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('button',{name:'Loading reviews…'})).toHaveAttribute('aria-disabled','true');
  await act(async()=>resolve([]));
  await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());
  expect(screen.getByText('0 reviews available')).toBeVisible();expect(getWidgets).toHaveBeenLastCalledWith(42);
});
