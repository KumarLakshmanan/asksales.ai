import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmUnsavedNavigation } from '@/hooks/use-unsaved-changes';
const mocks=vi.hoisted(()=>({get:vi.fn(),put:vi.fn(),toast:vi.fn(),push:vi.fn()}));
const params=new URLSearchParams('tab=notifications');
vi.mock('next/navigation',()=>({useRouter:()=>({push:mocks.push}),usePathname:()=>'/dashboard/settings',useSearchParams:()=>params}));
vi.mock('@/lib/api',()=>({default:mocks}));
vi.mock('@/hooks/use-toast',()=>({useToast:()=>({toast:mocks.toast})}));
vi.mock('@/contexts/AuthContext',()=>({useAuth:()=>({user:{id:9},logout:vi.fn()})}));
import SettingsPage from '@/app/dashboard/(main)/settings/page';
beforeEach(()=>{vi.clearAllMocks();mocks.get.mockImplementation(async(url:string)=>url.endsWith('notification-preferences')?{leadAlerts:true,campaignUpdates:true}:{name:'Synthetic',email:'fixture@example.test'});});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe('personal notification draft navigation',()=>{
  it('guards an actual edit, retains failed drafts, and releases after successful save',async()=>{
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);mocks.put.mockRejectedValueOnce(new Error('Synthetic failure')).mockResolvedValue({leadAlerts:false,campaignUpdates:true});
    render(<SettingsPage/>);const lead=await screen.findByRole('switch',{name:'Lead Alerts'});await waitFor(()=>expect(lead).not.toBeDisabled());
    expect(confirmUnsavedNavigation()).toBe(true);expect(confirm).not.toHaveBeenCalled();fireEvent.click(lead);
    expect(confirmUnsavedNavigation()).toBe(false);expect(lead).not.toBeChecked();
    fireEvent.click(screen.getByRole('button',{name:'Save'}));await waitFor(()=>expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({title:'Error'})));
    expect(confirmUnsavedNavigation()).toBe(false);expect(lead).not.toBeChecked();
    fireEvent.click(screen.getByRole('button',{name:'Save'}));await waitFor(()=>expect(screen.getByRole('button',{name:'Save'})).toBeDisabled());
    confirm.mockClear();expect(confirmUnsavedNavigation()).toBe(true);expect(confirm).not.toHaveBeenCalled();expect(mocks.put.mock.calls.at(-1)?.[1]).toEqual({leadAlerts:false});
  });
});
