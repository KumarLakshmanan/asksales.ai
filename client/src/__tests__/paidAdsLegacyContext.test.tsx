import { render, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({replace:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({replace:mocks.replace}),useSearchParams:()=>new URLSearchParams('account=12&period=7d&platform=meta&search=retreat&token=discard')}));
import MarketingCampaignsRedirect from '@/app/dashboard/(main)/marketing/campaigns/page';
it('preserves allowed account and period context when redirecting legacy campaigns',async()=>{
 render(<MarketingCampaignsRedirect/>);await waitFor(()=>expect(mocks.replace).toHaveBeenCalled());
 const url=new URL(mocks.replace.mock.calls[0][0],'https://asksales.local');
 expect(url.pathname).toBe('/dashboard/ads');expect(url.searchParams.get('tab')).toBe('campaigns');
 for(const [key,value] of [['account','12'],['period','7d'],['platform','meta'],['search','retreat']])expect(url.searchParams.get(key)).toBe(value);
 expect(url.searchParams.has('token')).toBe(false);
});
