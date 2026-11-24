import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ContactAnalysisPage} from '@/components/crm/ContactAnalysisPage';
import {selectBusinessProfile} from '@/lib/business-profile';
import type {DashboardOperation} from '../../../shared/dashboardOperations';
import type {ContactAnalysisSummary,AnalyzedContactRow} from '../../../shared/contactAnalysis';
const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),postForm:vi.fn()}));
vi.mock('@/lib/api',()=>({api:mocks}));
const id='10000000-0000-4000-8000-000000000001',nextId='10000000-0000-4000-8000-000000000002',hash='a'.repeat(64);
const summary:ContactAnalysisSummary={version:1,checkedAt:'2026-11-02T06:00:00Z',defaultCountry:'IN',options:{defaultCountry:'IN'},files:[{name:'Guests.csv',hash,bytes:123}],
  sheets:[{fileHash:hash,fileName:'Guests.csv',sheetName:'Contacts',included:true,headerRow:1,columns:[{key:'A',label:'Name',field:'firstName'},{key:'B',label:'Phone',field:'phone'}],rowCount:2,warnings:[]}],
  totals:{files:1,distinctFiles:1,duplicateFiles:0,sheets:1,rows:2,uniqueContacts:1,uniquePhoneEntries:1,uniqueEmails:0,indianMobileNumbers:1,readyContacts:1,reviewContacts:0,duplicateRows:0,invalidRows:1,excludedRows:0},
  definitions:{identity:'Different phone recipients stay separate.',phones:'Format does not prove a WhatsApp account exists.',consent:'No messages are sent by contact analysis.'},
};
const sourceRows:AnalyzedContactRow[]=[{key:`${hash}:Contacts:2`,fileHash:hash,fileName:'Guests.csv',sheetName:'Contacts',rowNumber:2,raw:{A:'Guest',B:'9000000001'},contact:{firstName:'Guest',phone:'+919000000001'},phoneKey:'919000000001',phoneCandidates:['919000000001'],status:'ready',issues:[]},
  {key:`${hash}:Contacts:3`,fileHash:hash,fileName:'Guests.csv',sheetName:'Contacts',rowNumber:3,raw:{A:'Fix me',B:'12'},contact:{firstName:'Fix me'},phoneCandidates:[],status:'invalid',issues:[{code:'invalid_phone',field:'phone',severity:'error',message:'This phone is incomplete.'}]}];
const operation=(status:DashboardOperation['status']='ready',operationId=id):DashboardOperation=>({id:operationId,kind:'contact_analysis',status,processed:status==='ready' ? 2 : 0,total:2,cursor:0,
  result:status==='ready' ? summary : null,error:null,createdAt:summary.checkedAt,updatedAt:summary.checkedAt,expiresAt:'2026-12-02T06:00:00Z',
  links:{operation:`/dashboard/crm/import/analyze?operationId=${operationId}`,contacts:'/dashboard/crm/contacts'},card:{title:'Contact analysis',status:status==='cancelled' ? 'review' : status,checkedAt:summary.checkedAt,progress:{completed:status==='ready' ? 2 : 0,total:2}},
});
beforeEach(()=>{
  vi.resetAllMocks();localStorage.setItem('user',JSON.stringify({id:9}));sessionStorage.setItem('active-business-profile:9','7');
  window.history.replaceState(null,'','/dashboard/crm/import/analyze');
  mocks.get.mockImplementation(async(url:string,options?:{params?:{status?:string}})=>{
    if(url==='/api/crm/contact-analysis')return {items:[]};
    if(url.endsWith('/rows'))return {items:options?.params?.status ? sourceRows.filter(row=>row.status===options.params!.status) : sourceRows,nextCursor:null};
    return operation();
  });
  mocks.post.mockResolvedValue(operation('queued',nextId));mocks.postForm.mockResolvedValue(operation('queued'));
});
afterEach(()=>{cleanup();localStorage.clear();sessionStorage.clear();});
describe('Excel and CSV analysis dashboard',()=>{
  it('uploads multiple files with an explicit phone country and does not import automatically',async()=>{
    render(<ContactAnalysisPage/>);
    fireEvent.change(screen.getByLabelText('Excel, CSV or TSV files'),{target:{files:[new File(['Name,Phone\nA,9000000001'],'Guests.csv'),new File(['Name,Phone\nB,9000000002'],'Other.csv')]}});
    fireEvent.change(screen.getByLabelText('Country for local phone numbers'),{target:{value:'IN'}});
    fireEvent.click(screen.getByRole('button',{name:'Analyze files'}));
    await waitFor(()=>expect(mocks.postForm).toHaveBeenCalledTimes(1));
    const [url,form]=mocks.postForm.mock.calls[0];expect(url).toBe('/api/crm/contact-analysis');
    expect(form.getAll('files').map((file:File)=>file.name)).toEqual(['Guests.csv','Other.csv']);expect(JSON.parse(form.get('options'))).toEqual({defaultCountry:'IN'});
    expect(form.get('requestKey')).toMatch(/^[a-f0-9-]{36}$/);expect(mocks.post).not.toHaveBeenCalled();
  });
  it('shows saved preview counts and imports only the ready audience with a stable request key',async()=>{
    window.history.replaceState(null,'',`/dashboard/crm/import/analyze?operationId=${id}`);render(<ContactAnalysisPage/>);
    const button=await screen.findByRole('button',{name:'Import 1 ready contacts'});
    expect(screen.getByText('Different phone recipients stay separate.')).toBeInTheDocument();
    expect(screen.getByText(/No messages are sent by contact analysis/)).toBeInTheDocument();
    fireEvent.click(button);await waitFor(()=>expect(mocks.post).toHaveBeenCalledWith(`/api/crm/contact-analysis/${id}/import`,{requestKey:`import-${id}`}));
  });
  it('filters invalid rows and sends a correction for a fresh preview before importing',async()=>{
    window.history.replaceState(null,'',`/dashboard/crm/import/analyze?operationId=${id}`);render(<ContactAnalysisPage/>);
    await screen.findByRole('button',{name:'Review row 3'});fireEvent.change(screen.getByLabelText('Show rows'),{target:{value:'invalid'}});
    await waitFor(()=>expect(screen.queryByRole('button',{name:'Review row 2'})).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button',{name:'Review row 3'}));
    const dialog=screen.getByRole('dialog');expect(within(dialog).getByLabelText('Phone')).toHaveValue('12');
    fireEvent.change(within(dialog).getByLabelText('Phone'),{target:{value:'9000000002'}});fireEvent.click(within(dialog).getByRole('button',{name:'Save correction and reanalyze'}));
    await waitFor(()=>expect(mocks.post).toHaveBeenCalledWith(`/api/crm/contact-analysis/${id}/reanalyze`,expect.objectContaining({options:expect.objectContaining({rows:[expect.objectContaining({rowNumber:3,contact:expect.objectContaining({phone:'9000000002'})})]})})));
    expect(mocks.post.mock.calls.some(([url])=>url.endsWith('/import'))).toBe(false);
  });
  it('offers worksheet mapping and preserves the original files on the server',async()=>{
    window.history.replaceState(null,'',`/dashboard/crm/import/analyze?operationId=${id}`);render(<ContactAnalysisPage/>);
    fireEvent.click(await screen.findByRole('button',{name:'Review worksheet mapping'}));
    const dialog=screen.getByRole('dialog');fireEvent.change(within(dialog).getByLabelText('B · Phone'),{target:{value:'email'}});
    fireEvent.click(within(dialog).getByRole('button',{name:'Apply mapping and reanalyze'}));
    await waitFor(()=>expect(mocks.post).toHaveBeenCalledWith(`/api/crm/contact-analysis/${id}/reanalyze`,expect.objectContaining({options:expect.objectContaining({sheets:[expect.objectContaining({mapping:{A:'firstName',B:'email'}})]})})));
    expect(mocks.postForm).not.toHaveBeenCalled();
  });
  it('explains why nothing is ready and re-checks local numbers as India in one step',async()=>{
    const held:ContactAnalysisSummary={...summary,defaultCountry:'none',options:{defaultCountry:'none'},issueCounts:{country_code_required:2},
      totals:{...summary.totals,readyContacts:0,reviewContacts:2,invalidRows:0}};
    mocks.get.mockImplementation(async(url:string)=>url==='/api/crm/contact-analysis' ? {items:[]} : url.endsWith('/rows') ? {items:[],nextCursor:null} : {...operation(),result:held});
    window.history.replaceState(null,'',`/dashboard/crm/import/analyze?operationId=${id}`);render(<ContactAnalysisPage/>);
    expect(await screen.findByText('2 rows have local phone numbers without a country code, so they are held for review.')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Import 0 ready contacts'})).toBeDisabled();
    expect(screen.getByText(/No contacts are ready to import yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Re-check these numbers as India (+91)'}));
    await waitFor(()=>expect(mocks.post).toHaveBeenCalledWith(`/api/crm/contact-analysis/${id}/reanalyze`,expect.objectContaining({options:expect.objectContaining({defaultCountry:'IN'})})));
    expect(mocks.post.mock.calls.some(([url])=>url.endsWith('/import'))).toBe(false);
  });
  it('clears the prior preview when another file is selected',async()=>{
    window.history.replaceState(null,'',`/dashboard/crm/import/analyze?operationId=${id}`);render(<ContactAnalysisPage/>);
    await screen.findByRole('button',{name:'Import 1 ready contacts'});
    fireEvent.change(screen.getByLabelText('Excel, CSV or TSV files'),{target:{files:[new File(['Name,Phone\nC,9000000002'],'New.csv')]}});
    expect(screen.queryByRole('button',{name:'Import 1 ready contacts'})).not.toBeInTheDocument();expect(window.location.search).toBe('');
  });
  it('discards previous business state when the selected business changes',async()=>{
    window.history.replaceState(null,'',`/dashboard/crm/import/analyze?operationId=${id}`);render(<ContactAnalysisPage/>);
    await screen.findByText('Different phone recipients stay separate.');
    mocks.get.mockImplementation(async(url:string)=>url==='/api/crm/contact-analysis' ? {items:[]} : Promise.reject(new Error('Operation not found')));
    selectBusinessProfile(8);
    expect(await screen.findByText(/Operation not found/)).toBeInTheDocument();
    expect(screen.queryByText('Different phone recipients stay separate.')).not.toBeInTheDocument();
  });
});
