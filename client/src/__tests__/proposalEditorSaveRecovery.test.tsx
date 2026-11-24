import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProposalEditor } from '@/components/proposals/ProposalEditor';
import { ApiError } from '@/lib/api';
import { selectBusinessProfile } from '@/lib/business-profile';
import { confirmUnsavedNavigation, restoreUnsavedNavigation } from '@/hooks/use-unsaved-changes';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const router = { push: mocks.push, replace: mocks.replace };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/lib/api', async importOriginal => ({ ...await importOriginal<object>(), api: mocks }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 4101 } }) }));
vi.mock('@/contexts/PreferencesContext', () => ({ usePreferences: () => ({ preferences: { currency: 'USD' } }) }));
vi.mock('@/components/proposals/ProposalDocument', () => ({ ProposalDocument: () => <div>Mock customer preview</div>, downloadProposalPdf: vi.fn() }));

const record = (id = 601, revision = 7, title = 'Server draft') => ({
  id, revision, title, status: 'draft', draftKey: `fixture-${id}`,
  recipientName: 'Fixture Customer', recipientEmail: 'customer@example.test',
  coverNote: 'Confirmed implementation scope.', termsAndConditions: 'Due in 14 days.',
  lineItems: [{ name: 'Implementation', quantity: 1, unitPrice: 900 }],
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = async (action?: () => void) => act(async () => { action?.(); });
const titleInput = () => screen.getByPlaceholderText('Website launch for Acme');
const edit = (title: string) => fireEvent.change(titleInput(), { target: { value: title } });
const sendStep = () => fireEvent.click(screen.getByRole('button', { name: /5\s*Send/ }));
const recoveryKey = (id: number | 'new' = 601, business = 4102) => `proposal-draft:v4:user-4101:business-${business}:${id}`;
const browserDraft = (id: number | 'new' = 601, business = 4102) => JSON.parse(localStorage.getItem(recoveryKey(id, business)) || 'null');
async function open(id?: number) {
  render(<ProposalEditor proposalId={id} />);
  await settle();
  expect(titleInput()).toBeVisible();
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('user', JSON.stringify({ id: 4101 }));
  sessionStorage.setItem('active-business-profile:4101', '4102');
  window.history.replaceState({}, '', '/dashboard/proposals/601/edit');
  mocks.get.mockImplementation(async (path: string) => {
    const match = path.match(/^\/api\/proposals\/(\d+)$/);
    if (match) return record(Number(match[1]));
    if (path.includes('/sources?')) return { contacts: [], conversations: [], tickets: [] };
    if (path.endsWith('/onboarding-resources')) return { teams: [], members: [] };
    if (/\/brand(\?|$)/.test(path)) return { companyName: 'Fixture Business' };
    return [];
  });
  mocks.post.mockResolvedValue(record(602, 1));
  mocks.put.mockImplementation(async (path: string, body: { expectedRevision: number; title: string }) => record(Number(path.split('/').at(-1)), body.expectedRevision + 1, body.title));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('ProposalEditor save and recovery', () => {
  it('flushes B before delivery review after deferred autosave A; A never marks B saved or removes recovery', async () => {
    const a = deferred<ReturnType<typeof record>>(), b = deferred<ReturnType<typeof record>>();
    mocks.put.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    await open(601);
    edit('Revision A');
    await act(() => vi.advanceTimersByTimeAsync(1200));
    expect(mocks.put).toHaveBeenCalledTimes(1);
    edit('Revision B'); sendStep();
    fireEvent.click(screen.getByRole('button', { name: 'Open delivery review' }));
    await settle(() => a.resolve(record(601, 8, 'Revision A')));
    expect(mocks.push).not.toHaveBeenCalled();
    expect(browserDraft().draft.title).toBe('Revision B');
    expect(screen.getByText(/Saving…/)).toBeVisible();
    expect(mocks.put).toHaveBeenCalledTimes(2);
    expect(mocks.put.mock.calls[1][1]).toMatchObject({ title: 'Revision B', expectedRevision: 8 });
    await settle(() => b.resolve(record(601, 9, 'Revision B')));
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/dashboard/proposals/601?send=1&channel=email');
    expect(browserDraft()).toBeNull();
  });

  it('serializes edits during manual Save and a second autosave timer without parallel PUTs', async () => {
    const a=deferred<ReturnType<typeof record>>(), b=deferred<ReturnType<typeof record>>();
    mocks.put.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    await open(601); edit('Manual A');
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' })); await settle();
    edit('Manual B');
    await act(() => vi.advanceTimersByTimeAsync(2400));
    expect(mocks.put).toHaveBeenCalledTimes(1);
    const unload=new Event('beforeunload', { cancelable:true }); window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await settle(() => a.resolve(record(601,8,'Manual A')));
    expect(mocks.put).toHaveBeenCalledTimes(2);
    expect(mocks.put.mock.calls[1][1]).toMatchObject({ title:'Manual B',expectedRevision:8 });
    expect(screen.getByText(/Saving…/)).toBeVisible();
    await settle(() => b.resolve(record(601,9,'Manual B')));
    expect(screen.getByText('Saved · Draft #601')).toBeVisible();
    expect(browserDraft()).toMatchObject({ draft:{title:'Manual B'},revision:9 });
    const savedUnload=new Event('beforeunload', { cancelable:true });window.dispatchEvent(savedUnload);
    expect(savedUnload.defaultPrevented).toBe(false);
  });

  it.each(['first','latest'])('retains B on rejected %s save and retries with the last confirmed revision', async failed => {
    const a=deferred<ReturnType<typeof record>>(), b=deferred<ReturnType<typeof record>>();
    mocks.put.mockReturnValueOnce(a.promise);
    if(failed==='latest')mocks.put.mockReturnValueOnce(b.promise);
    await open(601); edit('Revision A');
    await act(() => vi.advanceTimersByTimeAsync(1200));
    edit('Revision B');sendStep();fireEvent.click(screen.getByRole('button',{name:'Open delivery review'}));
    if(failed==='first')await settle(() => a.reject(new Error('Synthetic save rejected')));
    else {await settle(() => a.resolve(record(601,8,'Revision A')));await settle(() => b.reject(new Error('Synthetic save rejected')));}
    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Synthetic save rejected');
    expect(browserDraft()).toMatchObject({draft:{title:'Revision B'},revision:failed==='first'?7:8});
    const count=mocks.put.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(mocks.put).toHaveBeenCalledTimes(count); // Errors do not spin an automatic retry loop.
    fireEvent.click(screen.getByRole('button',{name:'Open delivery review'}));await settle();
    expect(mocks.put.mock.calls.at(-1)?.[1]).toMatchObject({title:'Revision B',expectedRevision:failed==='first'?7:8});
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(browserDraft()).toBeNull();
  });

  it('blocks further saves on 409 while preserving B and the unload guard', async () => {
    const a=deferred<ReturnType<typeof record>>();mocks.put.mockReturnValueOnce(a.promise);
    await open(601);edit('Revision A');fireEvent.click(screen.getByRole('button',{name:'Save draft'}));await settle();
    edit('Revision B');sendStep();fireEvent.click(screen.getByRole('button',{name:'Open delivery review'}));
    await settle(() => a.reject(new ApiError('Synthetic revision conflict',409)));
    expect(browserDraft().draft.title).toBe('Revision B');
    expect(screen.getByRole('button',{name:'Open delivery review'})).toBeDisabled();
    expect(screen.getByRole('button',{name:'Reload current draft'})).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(mocks.put).toHaveBeenCalledTimes(1);expect(mocks.push).not.toHaveBeenCalled();
  });

  it('rechecks validity after edits made while delivery review waits', async () => {
    const a=deferred<ReturnType<typeof record>>();mocks.put.mockReturnValueOnce(a.promise);
    await open(601);edit('Revision A');sendStep();fireEvent.click(screen.getByRole('button',{name:'Open delivery review'}));await settle();
    fireEvent.click(screen.getByRole('button',{name:/1\s*Customer/}));
    fireEvent.change(screen.getByLabelText(/Customer email/),{target:{value:'invalid'}});
    await settle(() => a.resolve(record(601,8,'Revision A')));
    expect(mocks.put).toHaveBeenCalledTimes(2);expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Complete the current document checks');
    expect(browserDraft().draft.recipientEmail).toBe('invalid');
  });

  it('uses the currently selected delivery channel after a pending Save', async () => {
    const a=deferred<ReturnType<typeof record>>();mocks.put.mockReturnValueOnce(a.promise);
    await open(601);edit('Revision A');sendStep();fireEvent.click(screen.getByRole('button',{name:'Open delivery review'}));await settle();
    fireEvent.click(screen.getByRole('button',{name:/4\s*Review/}));
    fireEvent.change(screen.getByLabelText('Planned delivery channel'),{target:{value:'whatsapp'}});
    fireEvent.click(screen.getByRole('button',{name:/1\s*Customer/}));
    fireEvent.change(screen.getByLabelText(/Customer email/),{target:{value:''}});
    await settle(() => a.resolve(record(601,8,'Revision A')));
    expect(mocks.put).toHaveBeenCalledTimes(2);
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/dashboard/proposals/601?send=1&channel=whatsapp');
  });

  it('cancels pending delivery review while allowing Save to finish and retry review explicitly', async () => {
    const a=deferred<ReturnType<typeof record>>();mocks.put.mockReturnValueOnce(a.promise);
    await open(601);edit('Revision A');sendStep();fireEvent.click(screen.getByRole('button',{name:'Open delivery review'}));await settle();
    fireEvent.click(screen.getByRole('button',{name:'Cancel delivery review'}));
    await settle(() => a.resolve(record(601,8,'Revision A')));
    expect(mocks.push).not.toHaveBeenCalled();expect(browserDraft().draft.title).toBe('Revision A');
    fireEvent.click(screen.getByRole('button',{name:'Open delivery review'}));await settle();
    expect(mocks.put).toHaveBeenCalledTimes(1);expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it('cancels Back navigation, then explicitly leaves with recovery and stops queued B', async () => {
    const confirm=vi.spyOn(window,'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const a=deferred<ReturnType<typeof record>>();mocks.put.mockReturnValueOnce(a.promise);
    await open(601);edit('Revision A');fireEvent.click(screen.getByRole('button',{name:'Save draft'}));await settle();edit('Revision B');
    fireEvent.click(screen.getByRole('button',{name:'Back to proposals'}));
    expect(confirm).toHaveBeenCalledTimes(1);expect(mocks.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Back to proposals'}));
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/dashboard/proposals');
    await settle(() => a.resolve(record(601,8,'Revision A')));
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(browserDraft()).toMatchObject({draft:{title:'Revision B'},revision:8});
  });

  it('keeps the editor and queued revision usable when an approved workspace request fails', async () => {
    vi.spyOn(window,'confirm').mockReturnValue(true);
    const a=deferred<ReturnType<typeof record>>();mocks.put.mockReturnValueOnce(a.promise);
    await open(601);edit('Revision A');fireEvent.click(screen.getByRole('button',{name:'Save draft'}));await settle();edit('Revision B');
    expect(confirmUnsavedNavigation('workspace')).toBe(true);
    restoreUnsavedNavigation();
    await settle(() => a.resolve(record(601,8,'Revision A')));
    expect(mocks.put).toHaveBeenCalledTimes(2);
    expect(mocks.put.mock.calls[1][1]).toMatchObject({title:'Revision B',expectedRevision:8});
    expect(titleInput()).toHaveValue('Revision B');
    edit('Revision C');fireEvent.click(screen.getByRole('button',{name:'Save draft'}));await settle();
    expect(mocks.put.mock.calls.at(-1)?.[1]).toMatchObject({title:'Revision C',expectedRevision:9});
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('bounds a flush under continuous editing and offers an explicit retry of the latest input', async () => {
    const saves=Array.from({length:5},()=>deferred<ReturnType<typeof record>>());
    saves.forEach(save=>mocks.put.mockReturnValueOnce(save.promise));
    await open(601);edit('Revision 0');sendStep();fireEvent.click(screen.getByRole('button',{name:'Open delivery review'}));await settle();
    for(let i=0;i<5;i++) {
      fireEvent.click(screen.getByRole('button',{name:/1\s*Customer/}));edit(`Revision ${i+1}`);sendStep();
      await settle(() => saves[i].resolve(record(601,8+i,`Revision ${i}`)));
    }
    expect(mocks.put).toHaveBeenCalledTimes(5);expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('pause editing and save again');
    expect(browserDraft()).toMatchObject({draft:{title:'Revision 5'},revision:12});
    await act(() => vi.advanceTimersByTimeAsync(10000));expect(mocks.put).toHaveBeenCalledTimes(5);
    fireEvent.click(screen.getByRole('button',{name:'Open delivery review'}));await settle();
    expect(mocks.put.mock.calls[5][1]).toMatchObject({title:'Revision 5',expectedRevision:12});
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it('uses one POST for a new draft, queues B, and retries PUT using the created id', async () => {
    const created=deferred<ReturnType<typeof record>>();mocks.post.mockReturnValueOnce(created.promise);
    mocks.put.mockRejectedValueOnce(new Error('Synthetic update rejected'));
    await open();edit('New A');await act(() => vi.advanceTimersByTimeAsync(1200));
    expect(mocks.post).toHaveBeenCalledTimes(1);edit('New B');
    await settle(() => created.resolve(record(602,1,'New A')));
    expect(browserDraft('new')).toMatchObject({draft:{title:'New B'},id:602,revision:1});
    expect(mocks.put.mock.calls[0][1]).toMatchObject({title:'New A',expectedRevision:1});
    fireEvent.click(screen.getByRole('button',{name:'Save draft'}));await settle();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.put.mock.calls[1][0]).toBe('/api/proposals/602');
    expect(mocks.put.mock.calls[1][1]).toMatchObject({title:'New B',expectedRevision:1});
    expect(browserDraft('new')).toMatchObject({draft:{title:'New B'},id:602,revision:2});
  });

  it.each(['record','workspace'])('ignores out-of-order save completion after a %s change', async kind => {
    const old=deferred<ReturnType<typeof record>>(), current=deferred<ReturnType<typeof record>>();
    mocks.put.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const view=render(<ProposalEditor proposalId={601}/>);await settle();edit('Old A');
    fireEvent.click(screen.getByRole('button',{name:'Save draft'}));await settle();edit('Old B');sendStep();fireEvent.click(screen.getByRole('button',{name:'Open delivery review'}));
    if(kind==='record')view.rerender(<ProposalEditor proposalId={603}/>);
    else await settle(() => selectBusinessProfile(4103));
    await settle();edit('Current draft');fireEvent.click(screen.getByRole('button',{name:'Save draft'}));await settle();
    const id=kind==='record'?603:601, business=kind==='record'?4102:4103;
    await settle(() => current.resolve(record(id,9,'Current draft')));
    await settle(() => old.resolve(record(601,8,'Old A')));
    expect(titleInput()).toHaveValue('Current draft');
    expect(browserDraft(id,business)).toMatchObject({draft:{title:'Current draft'},revision:9});
    expect(browserDraft()).toMatchObject({draft:{title:'Old B'},revision:8});
    expect(mocks.put).toHaveBeenCalledTimes(2);expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.put.mock.calls[1][2]).toMatchObject({headers:{'X-Business-Profile-Id':String(business)}});
  });

  it('retains a late POST receipt after unmount without starting PUT, and restores B after reload', async () => {
    const created=deferred<ReturnType<typeof record>>();mocks.post.mockReturnValueOnce(created.promise);
    await open();edit('New A');await act(() => vi.advanceTimersByTimeAsync(1200));edit('New B');cleanup();
    await settle(() => created.resolve(record(602,1,'New A')));
    expect(mocks.put).not.toHaveBeenCalled();
    expect(browserDraft('new')).toMatchObject({draft:{title:'New B'},id:602,revision:1});
    const baseGet=mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation((path:string)=>path==='/api/proposals/602'?Promise.resolve(record(602,1,'New A')):baseGet(path));
    await open();fireEvent.click(screen.getByRole('button',{name:'Restore draft'}));await settle();
    expect(titleInput()).toHaveValue('New B');
    fireEvent.click(screen.getByRole('button',{name:'Save draft'}));await settle();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.put.mock.calls[0][0]).toBe('/api/proposals/602');
    expect(mocks.put.mock.calls[0][1]).toMatchObject({title:'New B',expectedRevision:1});
  });

  it('ignores an old initial read when records change and does not expose editable fallback fields', async () => {
    const old=deferred<ReturnType<typeof record>>(), baseGet=mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation((path:string)=>path==='/api/proposals/601'?old.promise:baseGet(path));
    const view=render(<ProposalEditor proposalId={601}/>);await settle();
    expect(screen.queryByPlaceholderText('Website launch for Acme')).not.toBeInTheDocument();
    view.rerender(<ProposalEditor proposalId={603}/>);await settle();
    await settle(() => old.resolve(record(601,8,'Stale read')));
    expect(titleInput()).toHaveValue('Server draft');
    expect(screen.getByText('Saved · Draft #603')).toBeVisible();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it('does not navigate using the old id when the title is cleared during delivery-review Save', async () => {
    const a=deferred<ReturnType<typeof record>>();mocks.put.mockReturnValueOnce(a.promise);
    await open(601);edit('Revision A');sendStep();fireEvent.click(screen.getByRole('button',{name:'Open delivery review'}));await settle();
    fireEvent.click(screen.getByRole('button',{name:/1\s*Customer/}));edit('');
    await settle(() => a.resolve(record(601,8,'Revision A')));
    expect(mocks.push).not.toHaveBeenCalled();expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(browserDraft()).toMatchObject({draft:{title:''},revision:8});
    expect(screen.getByText('Add a title to save online · Draft #601')).toBeVisible();
  });

  it('retries a rejected POST with the same draftKey and the latest draft', async () => {
    const created=deferred<ReturnType<typeof record>>();mocks.post.mockReturnValueOnce(created.promise);
    await open();edit('New A');fireEvent.click(screen.getByRole('button',{name:'Save draft'}));await settle();edit('New B');
    await settle(() => created.reject(new Error('Synthetic create rejected')));
    const draftKey=mocks.post.mock.calls[0][1].draftKey;
    expect(browserDraft('new')).toMatchObject({draft:{draftKey,title:'New B'}});
    fireEvent.click(screen.getByRole('button',{name:'Save draft'}));await settle();
    expect(mocks.post.mock.calls[1][1]).toMatchObject({draftKey,title:'New B'});
    expect(mocks.put).toHaveBeenCalledTimes(1);
  });

  it('shows recovered edits but never saves them over a newer server revision', async () => {
    await open(601);edit('Recoverable edits');cleanup();
    const baseGet=mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation((path:string)=>path==='/api/proposals/601'?Promise.resolve(record(601,10,'Newer server draft')):baseGet(path));
    await open(601);
    expect(titleInput()).toHaveValue('Newer server draft');
    fireEvent.click(screen.getByRole('button',{name:'Restore draft'}));await settle();
    expect(titleInput()).toHaveValue('Recoverable edits');
    expect(screen.getByRole('alert')).toHaveTextContent('newer version');
    expect(screen.getByRole('button',{name:'Save draft'})).toBeDisabled();
    expect(browserDraft()).toMatchObject({draft:{title:'Recoverable edits'},revision:7});
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(mocks.put).not.toHaveBeenCalled();expect(mocks.post).not.toHaveBeenCalled();
  });

  it.each(['draft','sent','rejected'])('retires a pending Restore after choosing the current version; stale %s outcome cannot replace or autosave newer edits', async outcome => {
    await open(601);edit('Old recovery');cleanup();await open(601);
    const restored=deferred<ReturnType<typeof record>>();mocks.get.mockReturnValueOnce(restored.promise);
    fireEvent.click(screen.getByRole('button',{name:'Restore draft'}));await settle();
    fireEvent.click(screen.getByRole('button',{name:'Use current version'}));edit('Latest chosen draft');
    const latestCopy=localStorage.getItem(recoveryKey());
    if(outcome==='rejected')await settle(() => restored.reject(new Error('Stale restore read rejected')));
    else await settle(() => restored.resolve({...record(601,10,'Stale server read'),status:outcome}));
    expect(titleInput()).toHaveValue('Latest chosen draft');
    expect(localStorage.getItem(recoveryKey())).toBe(latestCopy);
    expect(screen.queryByRole('button',{name:'Restore draft'})).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();expect(mocks.put).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1200));
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.put.mock.calls[0][1]).toMatchObject({title:'Latest chosen draft',expectedRevision:7});
    expect(browserDraft()).toMatchObject({draft:{title:'Latest chosen draft'},revision:8});
    await act(() => vi.advanceTimersByTimeAsync(10000));expect(mocks.put).toHaveBeenCalledTimes(1);
  });

  it('ignores the earlier Restore attempt while a newer attempt is still pending', async () => {
    await open(601);edit('Chosen recovery');cleanup();await open(601);
    const old=deferred<ReturnType<typeof record>>(), latest=deferred<ReturnType<typeof record>>();
    mocks.get.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const copy=localStorage.getItem(recoveryKey());
    fireEvent.click(screen.getByRole('button',{name:'Restore draft'}));await settle();
    fireEvent.click(screen.getByRole('button',{name:'Restore draft'}));await settle();
    await settle(() => old.resolve(record(601,10,'Stale server read')));
    expect(titleInput()).toHaveValue('Server draft');expect(titleInput()).toBeDisabled();
    expect(localStorage.getItem(recoveryKey())).toBe(copy);
    expect(screen.getByRole('button',{name:'Restore draft'})).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();expect(mocks.put).not.toHaveBeenCalled();
    await settle(() => latest.resolve(record(601,7)));
    expect(titleInput()).toHaveValue('Chosen recovery');expect(titleInput()).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1200));
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.put.mock.calls[0][1]).toMatchObject({title:'Chosen recovery',expectedRevision:7});
  });

  it('preserves the recovery choice on a failed Restore read and allows a safe read retry', async () => {
    await open(601);edit('Recoverable retry');cleanup();await open(601);
    const copy=localStorage.getItem(recoveryKey());
    mocks.get.mockRejectedValueOnce(new Error('Current restore read rejected'));
    fireEvent.click(screen.getByRole('button',{name:'Restore draft'}));await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Current restore read rejected');
    expect(screen.getByRole('button',{name:'Restore draft'})).toBeVisible();
    expect(localStorage.getItem(recoveryKey())).toBe(copy);expect(mocks.put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Restore draft'}));await settle();
    expect(titleInput()).toHaveValue('Recoverable retry');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1200));
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.put.mock.calls[0][1]).toMatchObject({title:'Recoverable retry',expectedRevision:7});
  });

  it.each(['record','workspace'])('retires Restore when the %s changes and preserves both scoped drafts', async kind => {
    await open(601);edit('Old recovery');cleanup();
    const view=render(<ProposalEditor proposalId={601}/>);await settle();
    const old=deferred<ReturnType<typeof record>>();mocks.get.mockReturnValueOnce(old.promise);
    const oldCopy=localStorage.getItem(recoveryKey());
    fireEvent.click(screen.getByRole('button',{name:'Restore draft'}));await settle();
    if(kind==='record')view.rerender(<ProposalEditor proposalId={603}/>);
    else await settle(() => selectBusinessProfile(4103));
    await settle();edit('New context draft');
    const id=kind==='record'?603:601, business=kind==='record'?4102:4103;
    const newCopy=localStorage.getItem(recoveryKey(id,business));
    await settle(() => old.resolve({...record(601,10),status:'sent'}));
    expect(titleInput()).toHaveValue('New context draft');
    expect(localStorage.getItem(recoveryKey())).toBe(oldCopy);
    expect(localStorage.getItem(recoveryKey(id,business))).toBe(newCopy);
    expect(mocks.put).not.toHaveBeenCalled();expect(mocks.push).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1200));
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.put.mock.calls[0]).toMatchObject([`/api/proposals/${id}`,{title:'New context draft',expectedRevision:7},{headers:{'X-Business-Profile-Id':String(business)}}]);
  });

  it.each(['proposal', 'source'])('offers safe read Retry after initial %s failure without overwriting recovery', async kind => {
    const key = recoveryKey(kind === 'proposal' ? 601 : 'new');
    const stored = { version: 1, draft: { ...record(), draftKey: 'recovered-key', title: 'Recoverable edits' }, id: 601, revision: 7, savedAt: '2026-10-10T00:00:00Z' };
    localStorage.setItem(key, JSON.stringify(stored));
    if (kind === 'source') window.history.replaceState({}, '', '/dashboard/proposals/new?contactId=12');
    const baseGet = mocks.get.getMockImplementation()!;
    let failed = false;
    mocks.get.mockImplementation(async (path: string) => {
      if (!failed && (kind === 'proposal' ? path === '/api/proposals/601' : path.includes('/resolve-source?'))) { failed = true; throw new Error('Synthetic read unavailable'); }
      if (path.includes('/resolve-source?')) return { refs: { contactId: 12 }, recipientName: 'Fixture Customer', recipientEmail: 'customer@example.test' };
      return baseGet(path);
    });
    render(<ProposalEditor proposalId={kind === 'proposal' ? 601 : undefined} />);
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Synthetic read unavailable');
    expect(localStorage.getItem(key)).toBe(JSON.stringify(stored));
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading proposal' }));
    await settle();
    expect(titleInput()).toBeVisible();
    expect(screen.getByRole('button', { name: 'Restore draft' })).toBeVisible();
    expect(localStorage.getItem(key)).toBe(JSON.stringify(stored));
    expect(mocks.post).not.toHaveBeenCalled(); expect(mocks.put).not.toHaveBeenCalled();
  });
});
