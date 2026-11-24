import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FollowUpHistory } from '@/components/follow-ups/FollowUpHistory';
import type { FollowUpActivity, FollowUpAuthorityReview } from '../../../shared/followUpActivity';
const mocks=vi.hoisted(()=>({get:vi.fn()}));
vi.mock('@/lib/api',()=>({default:mocks}));
vi.mock('@/contexts/PreferencesContext',()=>({usePreferences:()=>({formatDate:(value:string)=>value})}));
const review:FollowUpAuthorityReview={reason:'JOB_ORIGIN_REQUIRED',origin:{table:'sent_messages',messageId:41,step:1,userId:9,businessProfileId:91},identity:{userId:9,businessProfileId:91,businessActorUserId:null,billingOrganizationId:901,billingActorUserId:17}};
const held:FollowUpActivity={id:41,activityKey:'configured_outbox:41:1',kind:'configured_outbox',channel:'sms',leadName:'Reserved customer',subject:null,message:'Reserved wording',status:'review_required',deliveryStatus:'unconfirmed',followUpStep:1,sentAt:null,createdAt:'2026-01-02T00:00:00Z',scheduledAt:null,recordedMessageId:null,authorityReview:review};
beforeEach(()=>{vi.clearAllMocks();});
describe('read-only authority review presentation',()=>{
  it('shows the original SMS hold, missing actor and reason without claiming delivery or exposing replay actions',async()=>{
    mocks.get.mockResolvedValue([held]);render(<FollowUpHistory channel="sms"/>);
    expect(await screen.findByText('Review required')).toBeVisible();expect(screen.getByText('Delivery not confirmed')).toBeVisible();
    expect(screen.getByText('JOB_ORIGIN_REQUIRED')).toBeVisible();expect(screen.getByText(/sent_messages #41/)).toHaveTextContent('Owner #9 · Business #91 · Step 1');
    const details=screen.getByText('Stored dispatch authority').closest('details')!;details.open=true;
    expect(within(details).getByText('Business actor').nextElementSibling).toHaveTextContent('Unavailable');
    expect(within(details).getByText('Billing actor').nextElementSibling).toHaveTextContent('17');
    expect(screen.queryByRole('button',{name:/replay|rebind|reauthorize|retry/i})).toBeNull();
    expect(screen.queryByText(/Recorded message ID/)).toBeNull();
  });
  it('keeps separate steps on one original SMS visible together',async()=>{
    mocks.get.mockResolvedValue([held,{...held,activityKey:'configured_outbox:41:2',followUpStep:2,authorityReview:{...review,origin:{...review.origin,step:2}}}]);render(<FollowUpHistory channel="sms"/>);
    expect(await screen.findAllByText('Review required')).toHaveLength(2);expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getByText('Step 1')).toBeVisible();expect(screen.getByText('Step 2')).toBeVisible();
  });
  it('preserves recorded sent/receipt and uncertain outcomes independently of authority review',async()=>{
    mocks.get.mockResolvedValue([{...held,id:62,activityKey:'conversation:62',kind:'conversation',status:'sent',deliveryStatus:'delivered',sentAt:'2026-01-03T00:00:00Z',recordedMessageId:'actual-provider-receipt'},
      {...held,id:63,activityKey:'conversation:63',kind:'conversation',status:'manual_review',deliveryStatus:'uncertain'}]);render(<FollowUpHistory channel="email"/>);
    const rows=await screen.findAllByRole('article');expect(within(rows[0]).getByText('Recorded: sent')).toBeVisible();
    expect(within(rows[0]).getByText(/Recorded message ID: actual-provider-receipt/)).toBeVisible();expect(within(rows[0]).getByText('Recorded delivery status: delivered')).toBeVisible();
    expect(within(rows[1]).getByText('Delivery uncertain')).toBeVisible();expect(within(rows[1]).getByText(/Recorded status: manual review/)).toBeVisible();
  });
});
