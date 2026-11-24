import type { InsightBreakdown, InsightTrend, WorkspaceInsights } from '../../../../../../shared/insights';
import { INSIGHT_CHANNELS, INSIGHT_CHANNEL_LABELS } from '../../../../../../shared/insights';

const metric = (key: string, count: number, credits = 0, inr = 0): InsightBreakdown => ({
  key, label: INSIGHT_CHANNEL_LABELS[key as keyof typeof INSIGHT_CHANNEL_LABELS] || key.replaceAll('_',' '),
  count, credits: credits.toFixed(2), inr: inr.toFixed(2), unvaluedCredits: '0.00',
});
const money = (credits: number, inr: number) => ({ credits: credits.toFixed(2), inr: inr.toFixed(2), unvaluedCredits: '0.00' });
const complete = { status: 'complete' as const, notes: ['Illustrative demo data. No usage or billing records were written.'] };
const makeTrend = (series: string, multiplier: number): InsightTrend[] => Array.from({ length: 14 }, (_, index) => {
  const date = new Date(); date.setDate(date.getDate() - 13 + index);
  const total = Math.round((10 + index * .65 + Math.sin(index * 1.7) * 3) * multiplier);
  return { bucket: date.toISOString().slice(0,10), total, series: { [series]: total }, ...money(total * .3, total * 3) };
});

/** The demo is a separate fixture, never a transformation of production data. */
export function makeDemoInsights(): WorkspaceInsights {
  const end = new Date(); const start = new Date(end); start.setDate(start.getDate()-29);
  return {
    query: { from:start.toISOString().slice(0,10),to:end.toISOString().slice(0,10),timezone:'Asia/Kolkata',interval:'daily',channel:'all' },
    generatedAt:end.toISOString(),
    capabilities:{supported:['wallet_charges','ai_usage','outreach_messages','widget_messages','crm_outcomes','verified_payments'],
      unsupported:['line','advertising_attribution','multi_touch_attribution']},
    dataCoverage:{instrumentationStartedAt:start.toISOString(),historicalUsage:complete,paymentEvidence:complete},
    channels:INSIGHT_CHANNELS.map(key=>({key,label:INSIGHT_CHANNEL_LABELS[key]})),
    filters:{processes:['customer_chat','follow_up','content','knowledge'],providers:['gemini','openai'],models:['gemini-3.1-flash-lite','gpt-4.1-mini']},
    costs:{...complete,deductions:money(2450,245),refunds:money(35,3.5),net:money(2415,241.5),
      byProcess:[metric('customer_chat',510,1320,132),metric('follow_up',86,410,41),metric('content',68,370,37),metric('knowledge',147,315,31.5)],
      byChannel:[metric('whatsapp',450,1240,124),metric('instagram',160,540,54),metric('widget',120,390,39),metric('workspace',40,245,24.5)],
      byModel:[metric('gemini-3.1-flash-lite',650,1510,151),metric('gpt-4.1-mini',300,905,90.5)],trend:makeTrend('credits',8),
      conversationCharge:money(1730,173),averageConversationInr:'1.54',chargedConversations:112,followUpCharge:money(410,41)},
    conversations:{...complete,total:187,averageMessages:5.8,averageDurationSeconds:1830,durationSamples:126,
      byChannel:[metric('whatsapp',95),metric('instagram',44),metric('widget',32),metric('email',16)],trend:makeTrend('conversations',.9)},
    performance:{...complete,calls:1248,successfulCalls:1197,failedCalls:21,pendingCalls:30,successRate:1197/1218,
      inputTokens:2075400,outputTokens:462500,totalTokens:2537900,cachedTokens:286000,reasoningTokens:18000,latencyP50Ms:860,latencyP95Ms:3410,
      media:{images:58,videos:9,audio:25,embeddings:110},
      byKind:[metric('text',1070),metric('embedding',110),metric('image',35),metric('audio',25),metric('tool',8)],trend:makeTrend('text',5),
      tools:{calls:89,pending:6,successRate:.93,byName:[metric('lookup_contact',49),metric('schedule_follow_up',25),metric('search_knowledge',15)],trend:makeTrend('tools',.5)}},
    messages:{...complete,incoming:466,outgoing:620,failed:17,followUps:86,audio:24,trend:makeTrend('messages',5)},
    engagement:{...complete,activeContacts:138,engagedCrmContacts:112,outreachReplyRate:.38,responseCoverage:.72,averageResponseSeconds:null,
      peakHours:Array.from({length:7},(_,weekday)=>Array.from({length:24},(_,hour)=>({weekday,hour,count:Math.max(0,Math.round((Math.sin(hour/3)+1)*(weekday>0&&weekday<6?3:1)+Math.sin(weekday+hour)*2))}))).flat(),
      topContacts:[{key:'1',contactId:1,name:'Ananya Rao',channel:'whatsapp',incoming:27,outgoing:31,conversations:3},
        {key:'2',contactId:2,name:'Rohan Mehta',channel:'instagram',incoming:19,outgoing:22,conversations:2},
        {key:'3',contactId:3,name:'Priya Shah',channel:'email',incoming:17,outgoing:20,conversations:2}]},
    sales:{...complete,moneyCoverage:complete,newContacts:83,convertedContacts:13,linkedConversions:9,conversionRate:9/112,confirmedBookings:11,cancelledBookings:2,unattributedOutcomes:5,
      dealValue:[{currency:'INR',amount:'685000.00'},{currency:'USD',amount:'1200.00'}],bookingValue:[{currency:'INR',amount:'274000.00'}],
      paymentsReceived:[{currency:'INR',amount:'198000.00'}],paymentsRefunded:[{currency:'INR',amount:'12000.00'}],netPayments:[{currency:'INR',amount:'186000.00'}],
      byChannel:[metric('whatsapp',13),metric('instagram',6),metric('email',4),metric('unattributed',5)],trend:makeTrend('outcomes',.2)},
  };
}
