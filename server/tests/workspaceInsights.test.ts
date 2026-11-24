import { describe, expect, it, jest, beforeEach } from '@jest/globals';

// The aggregate is tested at its database boundary so a history larger than
// the old 500-row report cap and ledger reconciliation use real response shapes.
const execute=jest.fn<(...args: unknown[]) => Promise<{rows: Record<string, unknown>[]}>>();
let modules=['billing','outreach','support','crm'];
jest.unstable_mockModule('../models/db.js',()=>({db:{execute}}));
jest.unstable_mockModule('../tenancy/businessContext.js',()=>({
  requireBusinessScope:()=>({userId:7,actorUserId:7,businessProfileId:11}),
  withSystemScope:async (_reason:string,work:()=>Promise<unknown>)=>work(),
}));
jest.unstable_mockModule('../tenancy/billingContext.js',()=>({currentBillingScope:()=>({organizationId:23})}));
jest.unstable_mockModule('../services/billing/organizations.js',()=>({requireBillingRole:async()=>({})}));
jest.unstable_mockModule('../services/insights/RuntimeService.js',()=>({getInsightsRuntime:async()=>({
  enabled:true,pricingGuardEnabled:true,instrumentationStartedAt:'2026-08-01T00:00:00.000Z',
})}));
jest.unstable_mockModule('../models/platformAccess/functions.js',()=>({getEffectiveModuleAccess:async()=>
  modules.map(key=>({key,enabled:true}))}));
const { getWorkspaceInsights,getInsightsDetails,parseInsightsQuery }=await import('../services/insights/QueryService.js');
const q=parseInsightsQuery({from:'2026-09-01',to:'2026-09-30',interval:'daily'},'Asia/Kolkata');
const at='2026-09-15T12:00:00.000Z';
const context={version:1,businessProfileId:11,organizationId:23,process:'support',channel:'whatsapp',
  conversation:{kind:'outreach',id:5},pricing:{version:1,creditsPerInr:2,model:'gpt-test',provider:'openai'}};
const ledger=(id:number,type:string,amount:string,metadata:unknown,category='support')=>({id,type,amount,metadata,category,created_at:at});

describe('workspace insights aggregates',()=>{
  beforeEach(()=>{execute.mockReset();modules=['billing','outreach','support','crm'];});

  it.each([
    { name: 'one contact', contacts: [{ id: 1 }], otherContact: 1, channel: 'all' },
    { name: 'merged contact aliases', contacts: [{ id: 1 }, { id: 2, merged_into_contact_id: 1 }], otherContact: 2, channel: 'all' },
    { name: 'channel-filtered merged aliases', contacts: [{ id: 1 }, { id: 2, merged_into_contact_id: 1 }], otherContact: 2, channel: 'whatsapp' },
  ])('stabilizes equal-time first wins for $name regardless of database row order', async ({ contacts, otherContact, channel }) => {
    const first = { id: 10, kind: 'contact_won', contact_id: 1, channel: 'whatsapp', occurred_at: at };
    const other = { id: 20, kind: 'contact_won', contact_id: otherContact, channel: 'email', occurred_at: at };
    for (const historical of [[other, first], [first, other]]) {
      execute.mockReset();
      execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [other, first] }).mockResolvedValueOnce({ rows: contacts })
        .mockResolvedValueOnce({ rows: [] });
      if (channel === 'all') execute.mockResolvedValueOnce({ rows: [{ count: 0 }] });
      execute.mockResolvedValueOnce({ rows: historical });
      const result = await getWorkspaceInsights(parseInsightsQuery({ from: q.from, to: q.to, channel }, q.timezone));
      expect(result.sales.convertedContacts).toBe(1);
      expect(result.sales.byChannel).toEqual([expect.objectContaining({ key: 'whatsapp', count: 1 })]);
      expect(result.sales.trend).toHaveLength(1);
      expect(result.sales.trend[0].series).toEqual({ contact_won: 1 });
    }
  });

  it('counts more than 500 usage records and reconciles refunds and unattributed credits',async()=>{
    const usage=Array.from({length:601},(_,id)=>({id:id+1,kind:'text',process:'support',provider:'openai',model:'gpt-test',channel:'whatsapp',
      status:'success',input_tokens:3,output_tokens:2,total_tokens:5,duration_ms:id+1,occurred_at:at}));
    const messages=[{conversation_kind:'outreach',conversation_id:5,contact_id:2,channel:'whatsapp',direction:'inbound',status:'received',
      message_kind:'reply',message_type:'text',occurred_at:at},
      {conversation_kind:'outreach',conversation_id:5,contact_id:2,channel:'whatsapp',direction:'outbound',status:'sent',
        message_kind:'reply',message_type:'text',occurred_at:'2026-09-15T12:01:00.000Z'}];
    const win={id:7,kind:'contact_won',contact_id:1,conversation_kind:'outreach',conversation_id:5,channel:'whatsapp',
      amount:'200.00',currency:'INR',verified:true,evidence:'crm',occurred_at:'2026-09-15T12:02:00.000Z'};
    const payment={id:8,kind:'payment_captured',booking_id:4,channel:'unattributed',amount:'100.00',currency:'INR',
      verified:true,evidence:'razorpay',occurred_at:at};
    const refund={id:9,kind:'payment_refunded',booking_id:4,channel:'unattributed',amount:'20.00',currency:'INR',
      verified:true,evidence:'razorpay',occurred_at:at};
    const contacts=[{id:1,first_name:'Merged',merged_into_contact_id:null},{id:2,first_name:'Old',merged_into_contact_id:1}];
    const charges=[ledger(1,'deduction','-10.00',{_insights:context}),
      ledger(2,'refund','2.00',{originalTransactionId:1,_insights:context}),
      ledger(3,'deduction','-3.00',{},'legacy')];
    execute.mockResolvedValueOnce({rows:usage}).mockResolvedValueOnce({rows:messages})
      .mockResolvedValueOnce({rows:[win,payment,refund]}).mockResolvedValueOnce({rows:contacts})
      .mockResolvedValueOnce({rows:charges}).mockResolvedValueOnce({rows:[{count:0}]}).mockResolvedValueOnce({rows:[win]});
    const result=await getWorkspaceInsights(q);
    expect(result.performance.calls).toBe(601);
    expect(result.performance.totalTokens).toBe(3005);
    expect(result.costs.net.credits).toBe('11.00');
    expect(result.costs.net.inr).toBeNull();
    expect(result.costs.net.unvaluedCredits).toBe('3.00');
    expect(result.costs.byProcess.reduce((sum,row)=>sum+Number(row.credits),0)).toBe(11);
    expect(result.costs.byChannel.reduce((sum,row)=>sum+Number(row.credits),0)).toBe(11);
    expect(result.costs.byModel.reduce((sum,row)=>sum+Number(row.credits),0)).toBe(11);
    expect(result.filters.processes).toContain('legacy');
    expect(result.filters.models).toContain('unattributed');
    expect(result.costs.conversationCharge.credits).toBe('8.00');
    expect(result.conversations.total).toBe(1);
    expect(result.engagement.engagedCrmContacts).toBe(1);
    expect(result.sales.convertedContacts).toBe(1);
    expect(result.sales.linkedConversions).toBe(1);
    expect(result.sales.netPayments).toEqual([{currency:'INR',amount:'80.00'}]);
  });

  it('uses business calendar dates and rejects invalid ranges',()=>{
    expect(parseInsightsQuery({from:'2026-03-08',to:'2026-03-08'},'America/New_York').timezone).toBe('America/New_York');
    expect(()=>parseInsightsQuery({from:'2026-02-30',to:'2026-03-02'},'Asia/Kolkata')).toThrow();
    expect(parseInsightsQuery({from:'2026-09-01',to:'2026-09-30'},'Unknown/Timezone').timezone).toBe('Asia/Kolkata');
  });

  it('groups activity by local day, ISO week and month across a daylight-saving boundary',async()=>{
    const times=['2026-03-08T04:30:00.000Z','2026-03-08T07:30:00.000Z'];
    const messages=times.map((occurred_at,index)=>({conversation_kind:'outreach',conversation_id:index+1,contact_id:0,
      channel:'whatsapp',direction:'inbound',status:'received',message_kind:'reply',message_type:'text',occurred_at}));
    for(const [interval,expected] of [['daily',['2026-03-07','2026-03-08']],['weekly',['2026-03-02']],['monthly',['2026-03']]] as const){
      execute.mockReset();
      execute.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:messages})
        .mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]})
        .mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{count:0}]}).mockResolvedValueOnce({rows:[]});
      const query=parseInsightsQuery({from:'2026-03-07',to:'2026-03-08',interval},'America/New_York');
      const result=await getWorkspaceInsights(query);
      expect(result.messages.trend.map(point=>point.bucket)).toEqual(expected);
      expect(result.dataCoverage.historicalUsage.status).toBe('partial');
      expect(result.dataCoverage.paymentEvidence.status).toBe('partial');
      expect(result.engagement.peakHours).toEqual(expect.arrayContaining([
        {weekday:6,hour:23,count:1},{weekday:0,hour:3,count:1},
      ]));
    }
  });

  it('counts an outreach reply only when the customer responds after a sent message',async()=>{
    const messages=[
      {conversation_kind:'outreach',conversation_id:5,contact_id:2,channel:'whatsapp',direction:'inbound',status:'received',
        message_kind:'reply',message_type:'text',occurred_at:'2026-09-15T12:00:00.000Z'},
      {conversation_kind:'outreach',conversation_id:5,contact_id:2,channel:'whatsapp',direction:'outbound',status:'sent',
        message_kind:'outreach',message_type:'text',occurred_at:'2026-09-15T12:01:00.000Z'},
    ];
    execute.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:messages})
      .mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{count:0}]}).mockResolvedValueOnce({rows:[]});
    const result=await getWorkspaceInsights(q);
    expect(result.engagement.outreachReplyRate).toBe(0);
    expect(result.engagement.responseCoverage).toBe(1);
  });

  it('excludes drafts, separates failed sends, and keeps approvals out of tool executions',async()=>{
    const usage=[{id:1,kind:'tool',process:'customer_chat',provider:null,model:'approve_booking',channel:'unattributed',
      status:'pending',duration_ms:null,occurred_at:at}];
    const base={conversation_kind:'outreach',conversation_id:5,contact_id:0,channel:'whatsapp',message_kind:'reply',message_type:'text',occurred_at:at};
    const messages=[
      {...base,direction:'outbound',status:'draft'},
      {...base,direction:'outbound',status:'failed'},
      {...base,direction:'outbound',status:'sent'},
      {...base,direction:'inbound',status:'received'},
    ];
    execute.mockResolvedValueOnce({rows:usage}).mockResolvedValueOnce({rows:messages})
      .mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{count:2}]}).mockResolvedValueOnce({rows:[]});
    const result=await getWorkspaceInsights(q);
    expect(result.messages).toMatchObject({incoming:1,outgoing:1,failed:1});
    expect(result.conversations.total).toBe(1);
    expect(result.performance).toMatchObject({pendingCalls:1,tools:{calls:0,pending:2,successRate:null}});
  });

  it('keeps CRM outcome counts while redacting payment amounts without billing permission',async()=>{
    modules=['crm','outreach','support'];
    const payment={id:8,kind:'payment_captured',booking_id:4,channel:'unattributed',amount:'100.00',currency:'INR',
      verified:true,evidence:'razorpay',occurred_at:at};
    execute.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({rows:[payment]}).mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({rows:[{count:0}]}).mockResolvedValueOnce({rows:[]});
    const result=await getWorkspaceInsights(q);
    expect(result.sales.moneyCoverage.status).toBe('restricted');
    expect(result.sales.paymentsReceived).toEqual([]);
    expect(result.sales.trend[0]?.series.payment_captured).toBe(1);
    execute.mockReset().mockResolvedValueOnce({rows:[payment]});
    const details=await getInsightsDetails(q,'sales',100,10);
    expect(details.items[0]?.amount).toBeNull();
    expect(details.items[0]?.currency).toBeNull();
    expect(details.items[0]?.credits).toBeUndefined();
  });
});
