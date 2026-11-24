import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {withBusinessScope} from '../tenancy/businessContext.js';
import type { ToolContext } from '../mastra/tools/toolRegistry.js';

const execute = jest.fn<any>();
const emit = jest.fn<any>();
const where = jest.fn<any>();
const select = jest.fn<any>(() => ({ from: () => ({ where }) }));
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute, select } }));
jest.unstable_mockModule('../services/agents/WebSocketEmitter', () => ({ webSocketEmitter: { emit } }));
const { executeAnalyticsQuery:queryAnalytics, generateCampaignVisualizations } = await import('../mastra/tools/executors/analyticsExecutor.js');

function executeAnalyticsQuery(input: Parameters<typeof queryAnalytics>[0],context: ToolContext) {
  return withBusinessScope({userId:Number(context.userId),businessProfileId:1},()=>queryAnalytics(input,context));
}
function snapshot(accepted=0) {return {checked_at:new Date(),counts:{total:accepted,accepted,delivered:0,awaitingConfirmation:accepted},responses:{},channels:[],timeline:[],failures:[]};}
beforeEach(() => { jest.clearAllMocks();
  execute.mockImplementation(async (query: SQL)=>{
    const text=new PgDialect().sqlToQuery(query).sql;
    return {rows:text.includes('canonical_messages AS') ? [snapshot()] : text.includes('FROM chat_threads') ? [{id:226}] : []};
  });where.mockResolvedValue([]);
});

describe('chat campaign analytics scope', () => {
  it('scopes this campaign through the owned saved conversation association, not campaign ID', async () => {
    const result = await executeAnalyticsQuery({ query_type: 'campaign', question: 'Show performance for this campaign.' }, { userId: 7, threadId: 226 } as ToolContext);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(query.sql).toContain("pac.settings->'context'->>'threadId'");
    expect(query.params).toEqual([7, '226']);
    expect(result).toMatchObject({ success: true, output: { data: [], scopeLabel: 'Current conversation #226' } });
    expect(emit).toHaveBeenCalledWith(7, 'open_tab', expect.objectContaining({ data: expect.objectContaining({ scopeLabel: 'Current conversation #226' }) }));
  });
  it('keeps explicitly account-wide comparisons account-wide and labels them', async () => {
    const result = await executeAnalyticsQuery({ query_type: 'campaign', scope: 'all_owned', question: 'Compare all campaigns in my account.' }, { userId: 7, threadId: 226 } as ToolContext);
    expect(new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL).params).toEqual([7]);
    expect(result).toMatchObject({ output: { scopeLabel: 'Account-wide saved data' } });
  });
  it('fails closed without a current conversation instead of widening scope', async () => {
    const result = await executeAnalyticsQuery({ query_type: 'campaign', scope: 'current_campaign', question: 'Show this campaign.' }, { userId: 7, threadId: 0 } as ToolContext);
    expect(result.success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not chart missing provider measurements as zero or label cross-campaign values a trend', () => {
    const charts = generateCampaignVisualizations([{ campaignName: 'Unmeasured draft', hasPerformanceData: false, spend: 0, ctr: 0 } as any]);
    expect(charts.map(chart => chart.data)).toEqual([[], []]);
    expect(charts[1].title).toBe('CTR by Campaign');
  });

  it.each(['lead', 'outreach', 'overview'] as const)('keeps %s analytics conversation-scoped', async query_type => {
    const result = await executeAnalyticsQuery({ query_type }, { userId: 7, threadId: 226 } as ToolContext);
    expect(result).toMatchObject({ success: true, output: { scope: 'current_campaign', threadId: 226, scopeLabel: 'Current conversation #226' } });
    const queries = where.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query as SQL));
    expect(queries.length).toBe(query_type === 'outreach' ? 0 : 1);
    for (const query of queries) {
      expect(query.params).toContain(7);
      expect(query.params).toContain('226');
    }
    if (query_type !== 'outreach') expect(queries[0].sql).toContain('icp.thread_id');
    if (query_type !== 'lead') {
      const query=execute.mock.calls.map(([query])=>new PgDialect().sqlToQuery(query as SQL)).find(query=>query.sql.includes('canonical_messages AS'))!;
      expect(query.sql).toContain('i.workspace_id');expect(query.params).toContain('226');expect(query.params).toContain(7);
    }
    if (query_type === 'overview') {
      const paidQuery=execute.mock.calls.map(([query])=>new PgDialect().sqlToQuery(query as SQL)).find(query=>query.sql.includes('performance_ad_campaigns pac'))!;
      expect(paidQuery.params).toEqual([7, '226']);
      expect(result.output.summary).toContain('saved campaigns');
      expect(result.output.summary).not.toContain('active campaigns');
    }
  });

  it.each(['lead', 'outreach', 'overview'] as const)('labels explicitly all-owned %s data without a conversation predicate', async query_type => {
    const result = await executeAnalyticsQuery({ query_type, scope: 'all_owned' }, { userId: 7, threadId: 226 } as ToolContext);
    expect(result).toMatchObject({ success: true, output: { scope: 'all_owned', scopeLabel: 'Account-wide saved data' } });
    for (const [query] of where.mock.calls) expect(new PgDialect().sqlToQuery(query as SQL).params).not.toContain('226');
  });

  it('does not let a tool widen the semantically requested current-campaign scope', async () => {
    await executeAnalyticsQuery({ query_type: 'lead', scope: 'all_owned' }, {
      userId: 7, threadId: 226, intentAnalysis: { semanticRequest: { scope: 'current_campaign' } },
    } as ToolContext);
    expect(new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL).params).toContain('226');
  });
  it('does not retarget current outreach through a different explicit workspace filter',async()=>{
    const result=await executeAnalyticsQuery({query_type:'outreach',outreach_filters:{workspaceId:999}},{userId:7,threadId:226} as ToolContext);
    expect(result.success).toBe(false);expect(execute).not.toHaveBeenCalled();expect(emit).not.toHaveBeenCalled();
  });
  it('keeps a paid campaign ID separate from outreach IDs in an overview',async()=>{
    const result=await executeAnalyticsQuery({query_type:'overview',filters:{campaign_id:'55'}},{userId:7,threadId:226} as ToolContext);
    expect(result.success).toBe(true);expect(result.output.data.outreach.report.filters).toEqual({workspaceId:226,messageKind:'outreach'});
  });

  it.each(['lead', 'outreach', 'overview'] as const)('rejects %s scope without a conversation', async query_type => {
    const result = await executeAnalyticsQuery({ query_type, scope: 'current_campaign' }, { userId: 7, threadId: 0 } as ToolContext);
    expect(result.success).toBe(false);
    expect(select).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['campaign', 'lead', 'outreach', 'overview'] as const)('does not turn a %s database failure into zero activity or open a misleading tab', async query_type => {
    execute.mockRejectedValue(new Error('database unavailable'));
    where.mockRejectedValue(new Error('database unavailable'));
    const result = await executeAnalyticsQuery({ query_type }, { userId: 7, threadId: 226 } as ToolContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('unavailable');
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not estimate delivered messages from sent status', async () => {
    execute.mockImplementation(async (query:SQL)=>({rows:new PgDialect().sqlToQuery(query).sql.includes('canonical_messages AS') ? [snapshot(1)] : [{id:226}]}));
    const result = await executeAnalyticsQuery({ query_type: 'outreach' }, { userId: 7, threadId: 226 } as ToolContext);
    expect(result).toMatchObject({ success: true, output: { data: { totalSent: 1, delivered: 0 } } });
    expect(result.output.data.report.counts).toMatchObject({accepted:1,delivered:0,awaitingConfirmation:1});
    expect(result.output.summary).toContain('1 awaiting delivery confirmation');
  });
});
