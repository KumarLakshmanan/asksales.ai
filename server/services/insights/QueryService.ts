import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { requireBusinessScope, withSystemScope } from '../../tenancy/businessContext.js';
import { currentBillingScope } from '../../tenancy/billingContext.js';
import { requireBillingRole } from '../billing/organizations.js';
import { getEffectiveModuleAccess } from '../../models/platformAccess/functions.js';
import type { InsightBreakdown, InsightChannel, InsightCharge, InsightCoverage, InsightDetailsResponse, InsightDetailKind, InsightInterval, InsightTrend, InsightsQuery, WorkspaceInsights } from '../../../shared/insights.js';
import { INSIGHT_CHANNELS, INSIGHT_CHANNEL_LABELS } from '../../../shared/insights.js';
import type { InsightsBillingContext } from '../../../shared/insightsBilling.js';
import { getInsightsRuntime } from './RuntimeService.js';
import { canonicalTimeZone } from '../../../shared/timeZones.js';

type Row = Record<string, unknown>;
const n = (value: unknown) => Number(value || 0);
const dateString = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
const emptyCharge = (): InsightCharge => ({ credits: '0.00', inr: '0.00', unvaluedCredits: '0.00' });
function charge(credits: number, inr: number, unvalued: number): InsightCharge {
  return { credits: credits.toFixed(2), inr: unvalued ? null : inr.toFixed(2), unvaluedCredits: unvalued.toFixed(2) };
}
function sumCharge(target: { credits: number; inr: number; unvalued: number }, value: { credits: number; inr: number; unvalued: number }) {
  target.credits += value.credits; target.inr += value.inr; target.unvalued += value.unvalued;
}
const numericCharge = () => ({ credits: 0, inr: 0, unvalued: 0 });
function breakdown(map: Map<string, { credits: number; inr: number; unvalued: number; count: number }>, label: (key: string) => string = key => key): InsightBreakdown[] {
  return [...map].map(([key, row]) => ({ key, label: label(key), count: row.count, ...charge(row.credits, row.inr, row.unvalued) }))
    .sort((a, b) => n(b.credits) - n(a.credits) || b.count - a.count);
}
function addBreakdown(map: Map<string, { credits: number; inr: number; unvalued: number; count: number }>, key: string, value = numericCharge()) {
  const row = map.get(key) || { ...numericCharge(), count: 0 };
  sumCharge(row, value); row.count++; map.set(key, row);
}
function coverage(status: InsightCoverage['status'] = 'complete', ...notes: string[]): InsightCoverage { return { status, notes }; }
function formatter(timezone: string) { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
function localDate(value: Date, timezone: string) { return formatter(timezone).format(value); }
function bucket(value: Date, q: InsightsQuery) {
  const day = localDate(value, q.timezone);
  if (q.interval === 'daily') return day;
  if (q.interval === 'monthly') return day.slice(0, 7);
  const utc = new Date(`${day}T00:00:00Z`);
  utc.setUTCDate(utc.getUTCDate() - ((utc.getUTCDay() + 6) % 7));
  return utc.toISOString().slice(0, 10);
}
function trend(map: Map<string, { total: number; series: Record<string, number>; credits: number; inr: number; unvalued: number }>): InsightTrend[] {
  return [...map].sort(([a], [b]) => a.localeCompare(b)).map(([key, row]) => ({ bucket: key, total: row.total, series: row.series, ...charge(row.credits, row.inr, row.unvalued) }));
}
function addTrend(map: Map<string, { total: number; series: Record<string, number>; credits: number; inr: number; unvalued: number }>, key: string, series: string, value = numericCharge()) {
  const row = map.get(key) || { total: 0, series: {}, ...numericCharge() };
  row.total++; row.series[series] = (row.series[series] || 0) + 1; sumCharge(row, value); map.set(key, row);
}
function percentile(values: number[], p: number) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.ceil(p * values.length) - 1)];
}
export function parseInsightsQuery(raw: Record<string, unknown>, timezone: string): InsightsQuery {
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); timezone = canonicalTimeZone(timezone); } catch { timezone = 'Asia/Kolkata'; }
  const today = localDate(new Date(), timezone);
  const days = [7,30,90,365].includes(Number(raw.days)) ? Number(raw.days) : 30;
  const start = new Date(`${today}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - days + 1);
  const from = typeof raw.from === 'string' ? raw.from : start.toISOString().slice(0, 10);
  const to = typeof raw.to === 'string' ? raw.to : today;
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!valid(from) || !valid(to) || from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw new Error('Choose a valid date range of at most 367 days.');
  const interval: InsightInterval = ['daily', 'weekly', 'monthly'].includes(String(raw.interval)) ? raw.interval as InsightInterval : 'daily';
  const channel: InsightChannel = INSIGHT_CHANNELS.includes(raw.channel as InsightChannel) ? raw.channel as InsightChannel : 'all';
  const filter = (value: unknown) => typeof value === 'string' && value.length <= 150 && /^[\w.:/@ -]+$/.test(value) ? value : undefined;
  return { from, to, timezone, interval, channel, process: filter(raw.process), provider: filter(raw.provider), model: filter(raw.model) };
}
function permitted(q: InsightsQuery, row: Row, usage = false) {
  const channel = String(row.channel || 'unattributed');
  return (q.channel === 'all' || q.channel === channel) && (!usage ||
    (!q.process || q.process === row.process) && (!q.provider || q.provider === row.provider) && (!q.model || q.model === row.model));
}
function canonical(id: number, redirects: Map<number, number>) {
  const seen = new Set<number>();
  while (redirects.has(id) && !seen.has(id)) { seen.add(id); id = redirects.get(id)!; }
  return id;
}

/** All base facts are read inside the selected business. The ledger read has an
 * explicit organization AND business predicate before its narrow system scope. */
export async function getWorkspaceInsights(q: InsightsQuery): Promise<WorkspaceInsights> {
  const scope = requireBusinessScope();
  const runtime = await getInsightsRuntime();
  const historical = !runtime.instrumentationStartedAt || q.from <= localDate(new Date(runtime.instrumentationStartedAt),q.timezone);
  const historicalUsage = historical ? coverage('partial','Usage before Insights instrumentation was backfilled where identifiable; earlier retry attempts may be missing.') : coverage();
  const paymentEvidence = historical ? coverage('partial','Historical payment captures and refunds without verified evidence are omitted.') : coverage();
  const org = currentBillingScope()?.organizationId;
  const access = await getEffectiveModuleAccess(scope.userId);
  const enabled = (key: string) => access.some(module => module.key === key && module.enabled);
  const finance = Boolean(org && enabled('billing') && await requireBillingRole(scope.actorUserId || scope.userId, org).then(() => true, () => false));
  const operational=enabled('billing')||enabled('outreach')||enabled('support');
  const start = sql`(${q.from}::date::timestamp AT TIME ZONE ${q.timezone})`;
  const end = sql`((${q.to}::date + 1)::timestamp AT TIME ZONE ${q.timezone})`;
  const [usageResult, messageResult, salesResult, contactsResult] = await Promise.all([
    db.execute(sql`SELECT id,kind,process,provider,model,channel,conversation_kind,conversation_id,contact_id,status,
      input_tokens,output_tokens,total_tokens,cached_tokens,reasoning_tokens,duration_ms,units,occurred_at
      FROM ai_usage_events WHERE business_profile_id=${scope.businessProfileId} AND ${operational} AND occurred_at>=${start} AND occurred_at<${end}`),
    db.execute(sql`WITH normalized AS (
      SELECT 'outreach' AS conversation_kind,m.conversation_id,COALESCE(c.crm_contact_id,0) AS contact_id,
        CASE WHEN c.channel='gmail' THEN 'email' WHEN c.channel='messenger' THEN 'facebook' ELSE c.channel END AS channel,
        m.direction, m.status, m.message_kind, m.message_type,COALESCE(m.sent_at,m.created_at) AT TIME ZONE 'UTC' AS occurred_at,
        COALESCE(NULLIF(m.provider_message_id,''),NULLIF(m.external_message_id,''),m.id::text) AS dedup_key
      FROM outreach_messages m JOIN outreach_conversations c ON c.id=m.conversation_id AND c.business_profile_id=m.business_profile_id
      WHERE m.business_profile_id=${scope.businessProfileId} AND ${enabled('outreach')}
        AND ((m.direction='inbound' AND m.created_at AT TIME ZONE 'UTC'>=${start} AND m.created_at AT TIME ZONE 'UTC'<${end})
          OR (m.direction='outbound' AND m.status IN ('sent','delivered','read') AND COALESCE(m.sent_at,m.created_at) AT TIME ZONE 'UTC'>=${start} AND COALESCE(m.sent_at,m.created_at) AT TIME ZONE 'UTC'<${end})
          OR (m.direction='outbound' AND m.status IN ('failed','bounced') AND m.created_at AT TIME ZONE 'UTC'>=${start} AND m.created_at AT TIME ZONE 'UTC'<${end}))
      UNION ALL
      SELECT 'widget',m.session_id,0,'widget',CASE WHEN m.role='user' THEN 'inbound' ELSE 'outbound' END,
        CASE WHEN m.processing_status='completed' THEN 'sent' ELSE m.processing_status END,'reply',
        CASE WHEN m.metadata->>'audio'='true' THEN 'audio' ELSE 'text' END,
        m.created_at AT TIME ZONE 'UTC',m.id::text
      FROM support_chat_messages m JOIN support_chat_sessions s ON s.id=m.session_id AND s.business_profile_id=m.business_profile_id
      WHERE m.business_profile_id=${scope.businessProfileId} AND ${enabled('support')} AND m.role IN ('user','assistant')
        AND m.created_at AT TIME ZONE 'UTC'>=${start} AND m.created_at AT TIME ZONE 'UTC'<${end}
    ) SELECT DISTINCT ON(conversation_kind,conversation_id,direction,dedup_key) * FROM normalized
      ORDER BY conversation_kind,conversation_id,direction,dedup_key,occurred_at`),
    db.execute(sql`SELECT id,kind,contact_id,booking_id,conversation_kind,conversation_id,channel,amount,currency,evidence,payment_id,verified,occurred_at
      FROM sales_outcome_events WHERE business_profile_id=${scope.businessProfileId} AND ${enabled('crm')} AND occurred_at>=${start} AND occurred_at<${end}`),
    db.execute(sql`SELECT id,merged_into_contact_id,first_name,last_name,company FROM crm_contacts WHERE business_profile_id=${scope.businessProfileId} AND ${enabled('crm')}`),
  ]);
  const ledgerResult = finance ? await withSystemScope('Read selected-business ledger for Insights', () => db.execute(sql`
    SELECT id,type,amount,created_at,metadata,category,reference_type,reference_id
    FROM wallet_transactions WHERE organization_id=${org!} AND billing_business_profile_id=${scope.businessProfileId}
      AND type IN ('deduction','refund') AND created_at AT TIME ZONE 'UTC'>=${start} AND created_at AT TIME ZONE 'UTC'<${end}
      AND (type='deduction' OR metadata ? 'originalTransactionId') ORDER BY id`)) : { rows: [] as Row[] };
  const usage = usageResult.rows as Row[]; const messages = messageResult.rows as Row[];
  const sales = salesResult.rows as Row[]; const ledger = ledgerResult.rows as Row[];
  const availableProcesses = new Set(usage.map(row => String(row.process)));
  const availableProviders = new Set(usage.map(row => String(row.provider || 'unattributed')));
  const availableModels = new Set(usage.map(row => String(row.model || 'unattributed')));
  const pendingApprovals=enabled('support') && (q.channel==='all'||q.channel==='unattributed')
    ? n((await db.execute(sql`SELECT COUNT(*)::integer AS count FROM tool_approvals WHERE business_profile_id=${scope.businessProfileId}
      AND status='pending' AND created_at AT TIME ZONE 'UTC'>=${start} AND created_at AT TIME ZONE 'UTC'<${end}`)).rows[0]?.count) : 0;
  const contacts = contactsResult.rows as Row[];
  const redirects = new Map<number, number>(); const names = new Map<number, string>();
  for (const row of contacts) { if (n(row.merged_into_contact_id)) redirects.set(n(row.id), n(row.merged_into_contact_id));
    names.set(n(row.id), [row.first_name,row.last_name].filter(Boolean).join(' ') || String(row.company || `Contact #${row.id}`)); }
  const costTotals = numericCharge(), deductions = numericCharge(), refunds = numericCharge(), conversationCharge = numericCharge(), followUpCharge = numericCharge();
  const costProcess = new Map<string, { credits: number; inr: number; unvalued: number; count: number }>();
  const costChannel = new Map<string, { credits: number; inr: number; unvalued: number; count: number }>();
  const costModel = new Map<string, { credits: number; inr: number; unvalued: number; count: number }>();
  const costTrend = new Map<string, { total: number; series: Record<string, number>; credits: number; inr: number; unvalued: number }>();
  let unknownSelectedRates=false;
  const validConversationIds = new Set(messages.filter(row => permitted(q,row)
    && (row.direction==='inbound' && row.status!=='failed' && row.status!=='bounced'
      || row.direction==='outbound' && ['sent','delivered','read'].includes(String(row.status))))
    .map(row => `${row.conversation_kind}:${row.conversation_id}`));
  let chargedConversations = 0;
  const chargedIds = new Set<string>();
  for (const row of ledger) {
    const context = (row.metadata as Record<string, unknown> | null)?._insights as InsightsBillingContext | undefined;
    const snapshot = context?.pricing; const rate = Number(snapshot?.creditsPerInr);
    const amount = Math.abs(n(row.amount)) * (row.type === 'refund' ? -1 : 1);
    const value = { credits: amount, inr: rate > 0 ? amount / rate : 0, unvalued: rate > 0 ? 0 : amount };
    const facet = { channel: context?.channel || 'unattributed', process: context?.process || String(row.category || 'unattributed'),
      model: snapshot?.model || 'unattributed', provider: snapshot?.provider || 'unattributed' };
    availableProcesses.add(facet.process); availableProviders.add(facet.provider); availableModels.add(facet.model);
    if (!permitted(q, facet, true)) continue;
    if (!(rate>0)) unknownSelectedRates=true;
    sumCharge(costTotals, value); sumCharge(row.type === 'refund' ? refunds : deductions, { ...value, credits: Math.abs(value.credits), inr: Math.abs(value.inr), unvalued: Math.abs(value.unvalued) });
    addBreakdown(costProcess, facet.process, value); addBreakdown(costChannel, facet.channel, value); addBreakdown(costModel, facet.model, value);
    addTrend(costTrend, bucket(new Date(dateString(row.created_at)), q), facet.process, value);
    const ref = context?.conversation && `${context.conversation.kind}:${context.conversation.id}`;
    if (ref && ['outreach','widget'].includes(context?.conversation?.kind||'')
      && !['content','leads','ai_visibility'].includes(facet.process) && validConversationIds.has(ref)) {
      sumCharge(conversationCharge, value); chargedIds.add(ref);
    }
    if (facet.process === 'follow_up') sumCharge(followUpCharge, value);
  }
  chargedConversations = chargedIds.size;
  const conversationMap = new Map<string, { first: number; last: number; count: number; channel: string; contactId: number; inbound: number; outbound: number; firstOutbound: number; incomingTimes: number[] }>();
  const conversationChannel = new Map<string, { credits: number; inr: number; unvalued: number; count: number }>();
  const conversationTrend = new Map<string, { total: number; series: Record<string, number>; credits: number; inr: number; unvalued: number }>();
  const messageTrend = new Map<string, { total: number; series: Record<string, number>; credits: number; inr: number; unvalued: number }>();
  const engagement = new Map<number, { incoming: number; outgoing: number; first: number; conversations: Set<string>; channel: string }>();
  const heatmap = new Map<string, number>();
  let incoming = 0, outgoing = 0, failed = 0, followUps = 0, audio = 0;
  let repliedConversations = 0, customerCovered = 0;
  const hourFormatter = new Intl.DateTimeFormat('en-US', { timeZone: q.timezone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
  for (const row of messages) {
    if (!permitted(q, row)) continue;
    const key = `${row.conversation_kind}:${row.conversation_id}`;
    const at = new Date(dateString(row.occurred_at)); const ms = at.getTime();
    const status = String(row.status); const direction = String(row.direction);
    if (status === 'failed' || status === 'bounced') { failed++; continue; }
    if (direction === 'inbound') incoming++; else if (status === 'sent' || status === 'delivered' || status === 'read') outgoing++; else continue;
    if (row.message_kind === 'follow_up' && direction === 'outbound') followUps++;
    if (['audio','voice'].includes(String(row.message_type))) audio++;
    addTrend(messageTrend, bucket(at,q),direction);
    const item = conversationMap.get(key) || { first: ms, last: ms, count: 0, channel: String(row.channel || 'unattributed'), contactId: n(row.contact_id), inbound:0, outbound:0, firstOutbound: Number.POSITIVE_INFINITY, incomingTimes: [] };
    item.first = Math.min(item.first,ms); item.last = Math.max(item.last,ms); item.count++;
    if(direction==='inbound'){ item.inbound++; item.incomingTimes.push(ms); }
    else { item.outbound++; item.firstOutbound=Math.min(item.firstOutbound,ms); }
    conversationMap.set(key,item);
    if (direction === 'inbound') {
      const parts = hourFormatter.formatToParts(at);
      const weekday = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.find(part => part.type === 'weekday')?.value || 'Sun');
      const hour = n(parts.find(part => part.type === 'hour')?.value);
      heatmap.set(`${weekday}:${hour}`,(heatmap.get(`${weekday}:${hour}`)||0)+1);
    }
    if (item.contactId) {
      const id = canonical(item.contactId,redirects);
      const c = engagement.get(id) || { incoming: 0, outgoing: 0, first: ms, conversations: new Set<string>(), channel: item.channel };
      if (direction === 'inbound') c.incoming++; else c.outgoing++;
      c.first = Math.min(c.first,ms); c.conversations.add(key); engagement.set(id,c);
    }
  }
  let outreachSentConversations=0;
  for (const [key,item] of conversationMap) {
    addBreakdown(conversationChannel,item.channel);
    addTrend(conversationTrend,bucket(new Date(item.first),q),item.channel);
    if(item.inbound>0)customerCovered++;
    if(key.startsWith('outreach:')&&item.outbound>0) {
      outreachSentConversations++;
      if(item.incomingTimes.some(at=>at>=item.firstOutbound))repliedConversations++;
    }
  }
  const durations = [...conversationMap.values()].filter(c => c.count >= 2).map(c => (c.last-c.first)/1000);
  const usageRows = usage.filter(row => permitted(q,row,true));
  const usageKinds = new Map<string, { credits: number; inr: number; unvalued: number; count: number }>();
  const usageTrend = new Map<string, { total: number; series: Record<string, number>; credits: number; inr: number; unvalued: number }>();
  const toolNames = new Map<string, { credits: number; inr: number; unvalued: number; count: number }>();
  const toolTrend = new Map<string, { total: number; series: Record<string, number>; credits: number; inr: number; unvalued: number }>();
  const latency: number[] = []; let success=0, errors=0, pending=0, toolSuccess=0, toolCalls=0;
  const media={images:0,videos:0,audio:0,embeddings:0};
  for (const row of usageRows) {
    const kind = String(row.kind); const status=String(row.status);
    addBreakdown(usageKinds,kind); addTrend(usageTrend,bucket(new Date(dateString(row.occurred_at)),q),kind);
    if (status==='success') success++; else if(status==='pending') pending++; else errors++;
    if(status==='success'||status==='partial'){
      const units=n(row.units);
      if(kind==='image')media.images+=units;
      if(kind==='video')media.videos+=units;
      if(kind==='audio')media.audio+=units;
      if(kind==='embedding')media.embeddings+=units;
    }
    if (row.duration_ms != null && status!=='pending') latency.push(n(row.duration_ms));
    if (kind==='tool') { if(status!=='pending')toolCalls++; if(status==='success')toolSuccess++;
      addBreakdown(toolNames,String(row.model||'tool')); addTrend(toolTrend,bucket(new Date(dateString(row.occurred_at)),q),status); }
  }
  const salesTrend = new Map<string, { total: number; series: Record<string, number>; credits: number; inr: number; unvalued: number }>();
  const salesChannel = new Map<string, { credits: number; inr: number; unvalued: number; count: number }>();
  const historicalWins = enabled('crm') ? (await db.execute(sql`SELECT id,kind,contact_id,booking_id,conversation_kind,conversation_id,channel,amount,currency,evidence,payment_id,verified,occurred_at
      FROM sales_outcome_events WHERE business_profile_id=${scope.businessProfileId} AND kind='contact_won' AND occurred_at<${end}`)).rows as Row[] : [];
  const firstWins=new Map<number,Row>();
  for(const row of historicalWins){const id=canonical(n(row.contact_id),redirects),previous=firstWins.get(id);
    const occurredAt=new Date(dateString(row.occurred_at)).getTime();
    const previousAt=previous ? new Date(dateString(previous.occurred_at)).getTime() : Infinity;
    // Equal-time outcomes can arrive in any database order, including after
    // contact merges. Keep the lowest event ID as the stable first win.
    if(!previous||occurredAt<previousAt||(occurredAt===previousAt&&n(row.id)<n(previous.id)))firstWins.set(id,row);}
  const selectedSales=sales.filter(row=>row.kind!=='contact_won'||firstWins.get(canonical(n(row.contact_id),redirects))?.id===row.id);
  const salesMoney = (kind: string) => {
    const totals = new Map<string, number>();
    for (const row of selectedSales) if (row.kind===kind && row.verified===true && row.amount!=null && row.evidence!=='mock' && permitted(q,row)) {
      const currency=String(row.currency||'unknown'); totals.set(currency,(totals.get(currency)||0)+n(row.amount)); }
    return [...totals].map(([currency,amount])=>({ currency,amount:amount.toFixed(2) }));
  };
  const wins = new Map<number, Row>(), created = new Set<number>(); let bookings=0,cancelled=0,unattributed=0,linked=0;
  for (const row of selectedSales.filter(row=>permitted(q,row))) {
    addBreakdown(salesChannel,String(row.channel||'unattributed'));
    addTrend(salesTrend,bucket(new Date(dateString(row.occurred_at)),q),String(row.kind));
    if (!row.conversation_id) unattributed++;
    if (row.kind==='contact_created') created.add(canonical(n(row.contact_id),redirects));
    if (row.kind==='contact_won' && row.contact_id) {
      const id=canonical(n(row.contact_id),redirects), previous=wins.get(id);
      if(!previous || new Date(dateString(row.occurred_at))<new Date(dateString(previous.occurred_at))) wins.set(id,row);
    }
    if (row.kind==='booking_confirmed')bookings++; if (row.kind==='booking_cancelled')cancelled++;
  }
  for (const [id,row] of wins) {
    const c=engagement.get(id);
    if(c && row.conversation_id && new Date(dateString(row.occurred_at)).getTime()>=c.first
      && c.conversations.has(`${row.conversation_kind}:${row.conversation_id}`)) linked++;
  }
  const received=salesMoney('payment_captured'), returned=salesMoney('payment_refunded');
  const net=new Map<string,number>(); for(const money of received)net.set(money.currency,n(money.amount));
  for(const money of returned)net.set(money.currency,(net.get(money.currency)||0)-n(money.amount));
  const costCoverage = finance ? coverage(unknownSelectedRates?'partial':'complete',...(unknownSelectedRates?['Some older credits have no recorded conversion rate; INR excludes those credits.']:[])) : coverage('restricted','Billing permission is required for credit and INR totals.');
  const topContacts=[...engagement].sort((a,b)=>b[1].incoming-a[1].incoming).slice(0,10).map(([id,row])=>({ key:String(id),contactId:id,name:names.get(id)||`Contact #${id}`,channel:row.channel,incoming:row.incoming,outgoing:row.outgoing,conversations:row.conversations.size }));
  return {
    query:q,generatedAt:new Date().toISOString(),
    capabilities:{supported:['wallet_charges','ai_usage','outreach_messages','widget_messages','crm_outcomes','verified_payments'],
      unsupported:['line','advertising_attribution','multi_touch_attribution']},
    dataCoverage:{instrumentationStartedAt:runtime.instrumentationStartedAt,historicalUsage,paymentEvidence},
    channels:INSIGHT_CHANNELS.map(key=>({key,label:INSIGHT_CHANNEL_LABELS[key]})),
    filters:{ processes:[...availableProcesses].sort(),providers:[...availableProviders].sort(),models:[...availableModels].sort() },
    costs:{...costCoverage,deductions:finance?charge(deductions.credits,deductions.inr,deductions.unvalued):emptyCharge(),
      refunds:finance?charge(refunds.credits,refunds.inr,refunds.unvalued):emptyCharge(),net:finance?charge(costTotals.credits,costTotals.inr,costTotals.unvalued):emptyCharge(),
      byProcess:breakdown(costProcess),byChannel:breakdown(costChannel,key=>INSIGHT_CHANNEL_LABELS[key as InsightChannel]||key),byModel:breakdown(costModel),trend:trend(costTrend),
      conversationCharge:charge(conversationCharge.credits,conversationCharge.inr,conversationCharge.unvalued),
      averageConversationInr:conversationMap.size&&conversationCharge.unvalued===0?(conversationCharge.inr/conversationMap.size).toFixed(2):null,
      chargedConversations,followUpCharge:charge(followUpCharge.credits,followUpCharge.inr,followUpCharge.unvalued) },
    conversations:{...coverage(enabled('outreach')||enabled('support')?'complete':'restricted'),total:conversationMap.size,
      averageMessages:conversationMap.size?[...conversationMap.values()].reduce((sum,row)=>sum+row.count,0)/conversationMap.size:null,
      averageDurationSeconds:durations.length?durations.reduce((a,b)=>a+b,0)/durations.length:null,durationSamples:durations.length,
      byChannel:breakdown(conversationChannel,key=>INSIGHT_CHANNEL_LABELS[key as InsightChannel]||key),trend:trend(conversationTrend)},
    performance:{...(operational?historicalUsage:coverage('restricted','AI usage permission is required.')),calls:usageRows.length,successfulCalls:success,failedCalls:errors,pendingCalls:pending,
      successRate:success+errors?success/(success+errors):null,inputTokens:usageRows.reduce((a,row)=>a+n(row.input_tokens),0),
      outputTokens:usageRows.reduce((a,row)=>a+n(row.output_tokens),0),totalTokens:usageRows.reduce((a,row)=>a+n(row.total_tokens),0),
      cachedTokens:usageRows.reduce((a,row)=>a+n(row.cached_tokens),0),reasoningTokens:usageRows.reduce((a,row)=>a+n(row.reasoning_tokens),0),
      media,
      latencyP50Ms:percentile([...latency],.5),latencyP95Ms:percentile([...latency],.95),byKind:breakdown(usageKinds),trend:trend(usageTrend),
      tools:{calls:toolCalls,pending:pendingApprovals,successRate:toolCalls?toolSuccess/toolCalls:null,
        byName:breakdown(toolNames),trend:trend(toolTrend)} },
    messages:{...coverage(enabled('outreach')||enabled('support')?'complete':'restricted',...(enabled('outreach')||enabled('support')?[]:['Messaging permission is required.'])),incoming,outgoing,failed,followUps,audio,trend:trend(messageTrend)},
    engagement:{...coverage(enabled('outreach')||enabled('support')?'complete':'restricted',...(enabled('outreach')||enabled('support')?[]:['Customer conversation permission is required.'])),activeContacts:engagement.size,engagedCrmContacts:engagement.size,
      outreachReplyRate:outreachSentConversations?repliedConversations/outreachSentConversations:null,
      responseCoverage:conversationMap.size?customerCovered/conversationMap.size:null,averageResponseSeconds:null,
      peakHours:[...heatmap].map(([key,count])=>({weekday:n(key.split(':')[0]),hour:n(key.split(':')[1]),count})),topContacts},
    sales:{...(enabled('crm')?paymentEvidence:coverage('restricted','CRM permission is required.')),
      moneyCoverage:finance?paymentEvidence:coverage('restricted','Billing permission is required for sales amounts.'),
      newContacts:created.size,convertedContacts:wins.size,linkedConversions:linked,
      conversionRate:engagement.size?linked/engagement.size:null,confirmedBookings:bookings,cancelledBookings:cancelled,unattributedOutcomes:unattributed,
      dealValue:finance?salesMoney('contact_won'):[],bookingValue:finance?salesMoney('booking_confirmed'):[],
      paymentsReceived:finance?received:[],paymentsRefunded:finance?returned:[],
      netPayments:finance?[...net].map(([currency,amount])=>({currency,amount:amount.toFixed(2)})):[],byChannel:breakdown(salesChannel),trend:trend(salesTrend)},
  };
}

export async function getInsightsDetails(q: InsightsQuery, kind: InsightDetailKind, cursor: number, limit: number): Promise<InsightDetailsResponse> {
  const scope=requireBusinessScope(); const org=currentBillingScope()?.organizationId;
  const access=await getEffectiveModuleAccess(scope.userId);
  const enabled=(key:string)=>access.some(module=>module.key===key&&module.enabled);
  const moneyAllowed=kind==='sales'&&Boolean(org)&&enabled('billing')
    ?await requireBillingRole(scope.actorUserId||scope.userId,org!).then(()=>true,()=>false):false;
  const allowed=kind==='charges'?enabled('billing')&&Boolean(org)
    :kind==='sales'?enabled('crm')
      :kind==='conversations'?enabled('outreach')||enabled('support')
        :enabled('billing')||enabled('outreach')||enabled('support');
  if(!allowed)throw Object.assign(new Error('Insight detail permission required.'),{status:403});
  const start=sql`(${q.from}::date::timestamp AT TIME ZONE ${q.timezone})`;
  const end=sql`((${q.to}::date + 1)::timestamp AT TIME ZONE ${q.timezone})`;
  const rows = kind==='charges' ? await (async()=>{
    await requireBillingRole(scope.actorUserId||scope.userId,org!);
    return (await withSystemScope('Read selected-business charge details',()=>db.execute(sql`SELECT id,created_at AS occurred_at,type,amount,metadata,category
      FROM wallet_transactions WHERE organization_id=${org!} AND billing_business_profile_id=${scope.businessProfileId}
      AND (type='deduction' OR (type='refund' AND metadata ? 'originalTransactionId'))
      AND id<${cursor} AND created_at AT TIME ZONE 'UTC'>=${start} AND created_at AT TIME ZONE 'UTC'<${end}
      AND (${q.channel}='all' OR COALESCE(metadata->'_insights'->>'channel','unattributed')=${q.channel})
      AND (${q.process||null}::text IS NULL OR COALESCE(metadata->'_insights'->>'process',category,'unattributed')=${q.process||null})
      AND (${q.provider||null}::text IS NULL OR COALESCE(metadata->'_insights'->'pricing'->>'provider','unattributed')=${q.provider||null})
      AND (${q.model||null}::text IS NULL OR COALESCE(metadata->'_insights'->'pricing'->>'model','unattributed')=${q.model||null})
      ORDER BY id DESC LIMIT ${limit+1}`))).rows as Row[];
  })() : kind==='conversations' ? (await db.execute(sql`WITH activity AS (
      SELECT 'outreach'::text AS conversation_kind,m.conversation_id,c.crm_contact_id AS contact_id,
        CASE WHEN c.channel='gmail' THEN 'email' WHEN c.channel='messenger' THEN 'facebook' ELSE c.channel END AS channel,
        COALESCE(m.sent_at,m.created_at) AT TIME ZONE 'UTC' AS occurred_at,m.direction,
        COALESCE(NULLIF(m.provider_message_id,''),NULLIF(m.external_message_id,''),m.id::text) AS dedup_key
      FROM outreach_messages m JOIN outreach_conversations c ON c.id=m.conversation_id AND c.business_profile_id=m.business_profile_id
      WHERE ${enabled('outreach')} AND m.business_profile_id=${scope.businessProfileId}
        AND ((m.direction='inbound' AND m.created_at AT TIME ZONE 'UTC'>=${start} AND m.created_at AT TIME ZONE 'UTC'<${end})
          OR (m.direction='outbound' AND m.status IN ('sent','delivered','read') AND COALESCE(m.sent_at,m.created_at) AT TIME ZONE 'UTC'>=${start} AND COALESCE(m.sent_at,m.created_at) AT TIME ZONE 'UTC'<${end}))
      UNION ALL
      SELECT 'widget',m.session_id,NULL::integer,'widget',m.created_at AT TIME ZONE 'UTC',
        CASE WHEN m.role='user' THEN 'inbound' ELSE 'outbound' END,m.id::text
      FROM support_chat_messages m JOIN support_chat_sessions s ON s.id=m.session_id AND s.business_profile_id=m.business_profile_id
      WHERE ${enabled('support')} AND m.business_profile_id=${scope.businessProfileId}
        AND (m.role='user' OR (m.role='assistant' AND m.processing_status='completed'))
        AND m.created_at AT TIME ZONE 'UTC'>=${start} AND m.created_at AT TIME ZONE 'UTC'<${end}
    ), deduped AS (
      SELECT DISTINCT ON(conversation_kind,conversation_id,direction,dedup_key) * FROM activity
      ORDER BY conversation_kind,conversation_id,direction,dedup_key,occurred_at
    ), conversations AS (
      SELECT conversation_kind,conversation_id,MAX(contact_id) AS contact_id,channel,MIN(occurred_at) AS occurred_at,COUNT(*)::integer AS message_count
      FROM deduped WHERE ${q.channel}='all' OR channel=${q.channel}
      GROUP BY conversation_kind,conversation_id,channel
    ), identified AS (
      -- Stable source identity order: backfilled/updated message dates must not
      -- renumber conversations between pages. Parity separates the two sources.
      SELECT conversation_id::bigint*2+CASE WHEN conversation_kind='widget' THEN 1 ELSE 0 END AS id,* FROM conversations
    )
    SELECT * FROM identified WHERE id<${cursor}::bigint ORDER BY id DESC LIMIT ${limit+1}`)).rows as Row[]
    : (await db.execute(kind==='sales'
    ? sql`SELECT id,occurred_at,kind,channel,contact_id,conversation_kind,conversation_id,amount,currency,evidence,verified FROM sales_outcome_events
      WHERE business_profile_id=${scope.businessProfileId} AND id<${cursor} AND occurred_at>=${start} AND occurred_at<${end}
        AND (${q.channel}='all' OR channel=${q.channel}) ORDER BY id DESC LIMIT ${limit+1}`
    : sql`SELECT id,occurred_at,kind,channel,process,provider,model,status,conversation_kind,conversation_id,contact_id,total_tokens,duration_ms
      FROM ai_usage_events WHERE business_profile_id=${scope.businessProfileId} AND id<${cursor} AND occurred_at>=${start} AND occurred_at<${end}
      AND (${q.channel}='all' OR channel=${q.channel})
      AND (${q.process||null}::text IS NULL OR process=${q.process||null})
      AND (${q.provider||null}::text IS NULL OR provider=${q.provider||null})
      AND (${q.model||null}::text IS NULL OR model=${q.model||null})
      ${kind==='tools'?sql`AND kind='tool'`:sql``} ORDER BY id DESC LIMIT ${limit+1}`)).rows as Row[];
  const items=rows.slice(0,limit).map(row=>{
    const meta=(row.metadata as Record<string,unknown>|null)?._insights as InsightsBillingContext|undefined;
    const rate=n(meta?.pricing?.creditsPerInr); const credits=Math.abs(n(row.amount));
    return { id:String(row.id),occurredAt:dateString(row.occurred_at),title:kind==='conversations'?`${String(row.channel)} conversation · ${n(row.message_count)} messages`:String(row.model||row.kind||row.category||row.type||kind),kind:String(row.kind||row.type||kind),
      channel:String(row.channel||meta?.channel||'unattributed'),process:String(row.process||meta?.process||''),provider:String(row.provider||meta?.pricing?.provider||''),
      model:String(row.model||meta?.pricing?.model||''),status:String(row.status||''),contactId:row.contact_id?n(row.contact_id):null,
      conversation:row.conversation_kind&&row.conversation_id?{kind:row.conversation_kind as 'outreach'|'widget'|'workspace',id:n(row.conversation_id)}:meta?.conversation||null,
      tokens:row.total_tokens?n(row.total_tokens):undefined,durationMs:row.duration_ms?n(row.duration_ms):null,
      credits:kind==='charges'&&row.amount!=null?credits.toFixed(2):undefined,
      inr:kind==='charges'&&row.amount!=null&&rate>0?(credits/rate).toFixed(2):null,
      amount:row.amount!=null&&kind==='sales'&&moneyAllowed?String(row.amount):null,
      currency:row.currency&&kind==='sales'&&moneyAllowed?String(row.currency):null,evidence:row.evidence?String(row.evidence):null };
  });
  return { items, nextCursor:rows.length>limit?`${kind==='conversations'?'c1:':''}${String(rows[limit-1].id)}`:null };
}
