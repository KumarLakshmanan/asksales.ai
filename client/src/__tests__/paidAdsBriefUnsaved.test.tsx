import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn()}),useSearchParams:()=>new URLSearchParams()}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
import CreatePaidCampaignPage from '@/app/dashboard/(main)/ads/create/page';
it('warns before discarding an edited brief on reload without persisting private content',()=>{
 render(<CreatePaidCampaignPage/>);
 expect(screen.getByText(/Reloading or leaving this page discards/)).toBeInTheDocument();
 const blank=new Event('beforeunload',{cancelable:true});window.dispatchEvent(blank);expect(blank.defaultPrevented).toBe(false);
 fireEvent.change(screen.getByLabelText('Campaign name',{exact:true}),{target:{value:'Private synthetic brief'}});
 const edited=new Event('beforeunload',{cancelable:true});window.dispatchEvent(edited);expect(edited.defaultPrevented).toBe(true);
});
it('lets the user cancel the explicit Back action without losing the form',()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 render(<CreatePaidCampaignPage/>);fireEvent.change(screen.getByLabelText('Campaign name',{exact:true}),{target:{value:'Private synthetic brief'}});
 const back=screen.getByRole('link',{name:'Back to campaigns'});const event=createEvent.click(back,{button:0,cancelable:true});fireEvent(back,event);
 expect(confirm).toHaveBeenCalledWith('Discard this unsaved campaign brief?');expect(event.defaultPrevented).toBe(true);
 expect(screen.getByLabelText('Campaign name',{exact:true})).toHaveValue('Private synthetic brief');confirm.mockRestore();
});
