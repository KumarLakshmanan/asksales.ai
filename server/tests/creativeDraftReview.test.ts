import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import { CreativeIntelligenceService } from '../services/ads/creative-intelligence/CreativeIntelligenceService.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

const dialect = new PgDialect();
const brief = {
  id: 7, revision: 2, selected_concept_id: 'concept-a', status: 'ready',
  input: { businessFacts: 'QA ONLY — verified resort facts', audience: 'Visitors', objective: 'awareness', language: 'English', constraints: 'No unsupported claims' },
  concepts: [{ id: 'concept-a', title: 'A quiet getaway', format: 'image', headline: 'Find a quiet moment', ctaText: 'Learn more', ctaType: 'learn_more', hook: 'Take a pause', copyDirection: 'Resort awareness', visualDirection: 'Illustration', scenes: ['Hills'], requiredAssets: ['Approved logo'] }],
};
const scoped = <T>(work: () => T) => withBusinessScope({ userId: 9, businessProfileId: 7 }, work);
const flag = process.env.AD_CREATIVE_INTELLIGENCE_ENABLED;
afterEach(() => { if (flag === undefined) delete process.env.AD_CREATIVE_INTELLIGENCE_ENABLED; else process.env.AD_CREATIVE_INTELLIGENCE_ENABLED = flag; });

describe('reviewed creative draft handoff', () => {
  function setup(rows: unknown[][]) {
    process.env.AD_CREATIVE_INTELLIGENCE_ENABLED = 'true';
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const execute = jest.fn(async (query: unknown) => {
      queries.push(dialect.sqlToQuery(query as never));
      return { rows: rows.shift() || [] };
    });
    const transaction = jest.fn(async (work: (tx: { execute: typeof execute }) => Promise<unknown>) => work({ execute }));
    return { service: new CreativeIntelligenceService({ transaction }), execute, queries };
  }
  it('saves only one inactive generation review with canonical provenance and a linked message', async () => {
    const { service, queries } = setup([[brief], [], [{ id: 28 }], [{ id: 80 }], [{ id: 91 }], []]);
    await expect(scoped(() => service.createDraftReview(9, 7, 2, 'concept-a'))).resolves.toEqual({ threadId: 28, widgetId: 91 });
    const insert = queries.find(query => query.sql.includes('INSERT INTO widget_states'))!;
    const form = insert.params.find(value => typeof value === 'string' && value.startsWith('{')) as string;
    expect(JSON.parse(form)).toMatchObject({ creative_brief_id: 7, creative_brief_revision: 2, creative_concept_id: 'concept-a', auto_generate_image: false, auto_generate_video: false });
    expect(insert.sql).toContain("'generate_ad','ad_generation'");
    expect(queries.every(query => !/ad_action_queue|performance_ad_campaigns|ad_settings/.test(query.sql))).toBe(true);
    expect(queries.at(-1)?.params).toContain(JSON.stringify({ widgetMessageId: 80 }));
  });
  it('reuses an existing review on transport retries without creating another workspace', async () => {
    const { service, execute } = setup([[brief], [{ id: 91, thread_id: 28, deleted_at: null }]]);
    await expect(scoped(() => service.createDraftReview(9, 7, 2, 'concept-a'))).resolves.toEqual({ threadId: 28, widgetId: 91 });
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it.each([
    [[], 'not found'],
    [[{ ...brief, revision: 3 }], 'changed'],
    [[{ ...brief, status: 'running' }], 'ready concept'],
  ])('refuses missing, changed or pending briefs before creating a workspace', async (found, message) => {
    const { service, execute } = setup([found as unknown[]]);
    await expect(scoped(() => service.createDraftReview(9, 7, 2, 'concept-a'))).rejects.toThrow(message as string);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('requires the actual business owner and enabled feature before touching records', async () => {
    const { service, execute } = setup([]);
    await expect(scoped(() => service.createDraftReview(10, 7, 2, 'concept-a'))).rejects.toThrow('owns this brief');
    process.env.AD_CREATIVE_INTELLIGENCE_ENABLED = 'false';
    await expect(scoped(() => service.createDraftReview(9, 7, 2, 'concept-a'))).rejects.toThrow('not enabled');
    expect(execute).not.toHaveBeenCalled();
  });
});
