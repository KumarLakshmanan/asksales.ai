import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {CampaignReportView} from '@/components/outreach/reports/CampaignReportView';
import StructuredAnalyticsTab from '@/components/tabs/StructuredAnalyticsTab';
import type {CampaignReport} from '../../../shared/campaignReporting';
const mocks=vi.hoisted(()=>({get:vi.fn()}));
vi.mock('@/lib/api',()=>({api:mocks}));
const snapshot=()=>({
  version:1,source:'canonical_outreach',checkedAt:'2026-11-02T06:00:00Z',filters:{messageKind:'outreach'},
  counts:{total:575,accepted:503,delivered:403,awaitingConfirmation:100,queued:72,retrying:72,failed:0,review:0,processing:0,cancelled:0,read:0,opened:0,clicked:0},
  uniqueRecipients:575,engagement:{respondingCustomers:24,responseRate:4.17,inboundResponses:35,typedReplies:30,quickReplies:3,menuSelections:2,otherResponses:0,assistantReplies:20,callButtonClicks:null,callButtonClickAvailability:'unavailable'},
  nextAttemptAt:'2026-11-02T10:00:00Z',channels:[{channel:'whatsapp',total:575,accepted:503,delivered:403,awaitingConfirmation:100,queued:72,retrying:72,failed:0,review:0,processing:0,cancelled:0,read:0,opened:0,clicked:0,respondingCustomers:24,waiting:[],nextAttemptAt:'2026-11-02T10:00:00Z'}],failures:[],
  timeline:[],activeSequences:0,pendingFollowUps:0,sentiment:{positive:0,negative:0,neutral:0,urgent:0,total:0},
  definitions:{accepted:'Provider accepted.',delivered:'Delivery receipt.',responseRate:'All selected recipients.',attribution:'Audience responses after sending.',history:'Saved inbox history.',clicks:'Call-button clicks are unavailable.'},
  links:{report:'/dashboard/outreach/reports?workspaceId=21',campaign:'/dashboard/conversations/21',contacts:'/dashboard/crm'},
}) satisfies CampaignReport;
beforeEach(()=>{
  vi.resetAllMocks();window.history.replaceState(null,'','/dashboard/outreach/reports?workspaceId=21');
  mocks.get.mockImplementation(async (url:string)=>url.endsWith('/options') ? {
    workspaces:[{id:21,name:'Hotel campaign'}],campaigns:[{id:11,name:'Two nights'}],imports:[{id:3,source:'crm',name:'Guests.xlsx'}],accounts:[{channel:'whatsapp',id:'phone-1'}],
  } : snapshot());
});
afterEach(cleanup);
describe('campaign report dashboard and agent result',()=>{
  it('keeps confirmed delivery separate from provider acceptance and awaiting receipts',async()=>{
    render(<CampaignReportView/>);
    await screen.findByText('Confirmed delivered');
    expect(screen.getByText('Awaiting confirmation')).toBeInTheDocument();
    expect(screen.getByText('Already included in accepted')).toBeInTheDocument();
    expect(screen.getByText('Call-button clicks are unavailable.')).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith('/api/outreach/reports',{params:{workspaceId:'21'}});
    expect(screen.getByRole('link',{name:'Open contacts'})).toHaveAttribute('href','/dashboard/crm');
  });
  it('sends owned import identifiers and exclusive UTC date bounds through the supported API',async()=>{
    render(<CampaignReportView/>);await screen.findByRole('option',{name:'Guests.xlsx · CRM'});
    fireEvent.change(screen.getByLabelText('Imported audience'),{target:{value:'crm:3'}});
    fireEvent.change(screen.getByLabelText('Channel'),{target:{value:'whatsapp'}});
    fireEvent.change(screen.getByLabelText('Created before (UTC)'),{target:{value:'2026-11-03'}});
    fireEvent.click(screen.getByRole('button',{name:'Apply filters'}));
    await waitFor(()=>expect(mocks.get).toHaveBeenLastCalledWith('/api/outreach/reports',{params:{workspaceId:'21',importSource:'crm',importId:3,channel:'whatsapp',to:'2026-11-03T00:00:00Z'}}));
  });
  it('does not leave a prior business report on screen when refresh fails',async()=>{
    render(<CampaignReportView/>);await screen.findByText('Confirmed delivered');
    mocks.get.mockRejectedValueOnce(new Error('Report unavailable'));
    fireEvent.click(screen.getByRole('button',{name:'Apply filters'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Report unavailable');
    expect(screen.queryByText('Confirmed delivered')).not.toBeInTheDocument();
  });
  it('shows the same delivery snapshot and useful navigation inside agent analytics',()=>{
    render(<StructuredAnalyticsTab data={{queryType:'outreach',analyticsData:{report:snapshot()}}}/>);
    const card=screen.getByRole('region',{name:'Campaign delivery report'});
    expect(within(card).getByText('403')).toBeInTheDocument();expect(within(card).getByText('100')).toBeInTheDocument();
    expect(within(card).getByRole('link',{name:'View campaign'})).toHaveAttribute('href','/dashboard/conversations/21');
    expect(within(card).getByRole('link',{name:'View report'})).toHaveAttribute('href','/dashboard/outreach/reports?workspaceId=21');
  });
});
