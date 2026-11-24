import {afterEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({get:vi.fn()}));
vi.mock('@/lib/api',()=>({api:{get:mocks.get}}));
import {socialInsightsGet} from '@/lib/socialInsightsApi';
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
it('recovers a gateway outage without retrying a write',async()=>{
 vi.useFakeTimers();mocks.get.mockRejectedValueOnce({status:502}).mockResolvedValue({summary:{views:2}});
 const result=socialInsightsGet('/api/social-analytics/dashboard');await vi.runAllTimersAsync();await expect(result).resolves.toEqual({summary:{views:2}});expect(mocks.get).toHaveBeenCalledTimes(2);
});
it('surfaces a provider-specific failure instead of repeatedly calling Meta',async()=>{
 mocks.get.mockRejectedValue({status:503,data:{code:'SOCIAL_PROVIDER_TIMEOUT'}});await expect(socialInsightsGet('/api/social-analytics/content/1/comments')).rejects.toMatchObject({status:503});expect(mocks.get).toHaveBeenCalledTimes(1);
});
