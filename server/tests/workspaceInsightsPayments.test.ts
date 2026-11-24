import { describe,expect,it,jest,beforeEach } from '@jest/globals';

const execute=jest.fn<(...args: unknown[])=>Promise<{rows:Record<string,unknown>[]}>>();
const transaction=jest.fn<(...args: unknown[])=>Promise<unknown>>();
jest.unstable_mockModule('../models/db.js',()=>({db:{execute,transaction}}));
jest.unstable_mockModule('../tenancy/businessContext.js',()=>({
  requireBusinessScope:()=>({userId:7,actorUserId:7,businessProfileId:11}),
}));
const {recordPaymentEvidence}=await import('../services/insights/SalesEvidence.js');
const booking={id:4,user_id:7,business_profile_id:11,currency:'INR',payment_id:'pay_valid',status:'confirmed',
  conversation_id:5,channel:'whatsapp',crm_contact_id:9};
const capture={bookingId:4,paymentId:'pay_valid',amountMinor:10000,currency:'INR',occurredAt:'2026-09-15T12:00:00.000Z',source:'razorpay' as const};
const receipt={booking_id:4,kind:'payment_captured',payment_id:'pay_valid',currency:'INR',evidence:'razorpay',verified:true,amount_matches:true};

describe('sales payment evidence',()=>{
  beforeEach(()=>{
    execute.mockReset(); transaction.mockReset();
    transaction.mockImplementation(async (work)=>await (work as (tx:{execute:typeof execute})=>Promise<unknown>)({execute}));
  });

  it('records one verified capture and ignores a replay',async()=>{
    execute.mockResolvedValueOnce({rows:[booking]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{booking_id:4}]})
      .mockResolvedValueOnce({rows:[booking]}).mockResolvedValueOnce({rows:[receipt]});
    await recordPaymentEvidence(capture);
    await recordPaymentEvidence(capture);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it('rejects a completed refund larger than the remaining capture',async()=>{
    execute.mockResolvedValueOnce({rows:[booking]}).mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({rows:[{sufficient:false}]});
    await expect(recordPaymentEvidence({...capture,refundId:'rfnd_123',amountMinor:3000})).rejects.toThrow('Refund exceeds verified payment');
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('never treats an unconfirmed booking or different gateway payment as received revenue',async()=>{
    execute.mockResolvedValueOnce({rows:[{...booking,status:'pending'}]}).mockResolvedValueOnce({rows:[]});
    await expect(recordPaymentEvidence(capture)).rejects.toThrow('Payment is not attached');
    execute.mockResolvedValueOnce({rows:[booking]});
    await expect(recordPaymentEvidence({...capture,paymentId:'pay_other'})).rejects.toThrow('Gateway payment does not match');
  });
});
