import fs from 'node:fs';
import path from 'node:path';
import { WorkflowExecutorService } from '../services/WorkflowExecutorService.js';
import { assertLeadActorAvailable, assertLeadWorkflowAvailable } from '../services/workflow/retiredLeadWorkflows.js';
import { routerOutputSchema } from '../mastra/routerSchema.js';
import { createIcpProfileHandler, updateIcpHandler } from '../controllers/icpController.js';

describe('social provider recovery and platform removal', () => {
  beforeAll(async () => { await WorkflowExecutorService.initialize(); });

  it('rejects Yelp including renamed custom workflows and legacy snapshots before provider access', () => {
    expect(() => assertLeadWorkflowAvailable({ workflow_id: 'yelp_b2b' })).toThrow('retired');
    expect(() => assertLeadWorkflowAvailable({ workflow_id: 'custom', platform: 'yelp' })).toThrow('retired');
    expect(() => assertLeadWorkflowAvailable({ workflow_id: 'custom', nodes: [{ data: { actorId: 'datascrapers/yelp-scraper' } }] })).toThrow('removed');
    expect(() => assertLeadActorAvailable('datascrapers/yelp-scraper')).toThrow('removed');
    expect(() => assertLeadActorAvailable('datascrapers~yelp-scraper')).toThrow('removed');
    expect(() => assertLeadWorkflowAvailable({ workflow_id: 'yelp_b2b', platform: 'custom' })).toThrow('retired');
    expect(routerOutputSchema.shape.leadChannels.safeParse(['yelp']).success).toBe(false);
    expect(fs.existsSync(path.resolve('data/workflows/yelp.json'))).toBe(false);
    expect(fs.existsSync(path.resolve('data/actors/datascrapers-yelp-scraper.json'))).toBe(false);
  });

  it('requires a fresh review for the unavailable Facebook provider rather than silently changing a snapshot', () => {
    expect(() => assertLeadActorAvailable('outspoken_strategy/facebook-post-search-scraper')).toThrow('Regenerate and approve');
    expect(() => assertLeadActorAvailable('powerai/facebook-post-search-scraper')).not.toThrow();
  });

  it.each([createIcpProfileHandler, updateIcpHandler])('rejects attempts to re-add Yelp through the ICP API', async handler => {
    const response: any = { code: 200, body: null };
    response.status = (code: number) => { response.code = code; return response; };
    response.json = (body: unknown) => { response.body = body; return response; };
    await handler({ user: { id: 1 }, params: { id: '1' }, body: { primaryChannels: ['instagram', ' YELP '] } } as any, response);
    expect(response.code).toBe(400);
    expect(response.body.error).toContain('no longer available');
  });

  it('preserves Instagram keyword phrases through reviewed input mapping and sanitization', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/instagram_post_authors.json'), 'utf8'));
    const node = workflow.nodes.find((node: any) => node.id === 'instagram_hashtag_search');
    const context = { executionId: 'keyword-mode', leadInputId: 1, nodesExecuted: new Map(), logs: [], requestedLeadLimit: 2, persistedLeadCount: 0 };
    const input = (WorkflowExecutorService as any).buildActorInput(node, context, {
      hashtags: [' software development Bengaluru ', 'IT services Bangalore'], keywordSearch: true, resultsLimit: 2, resultsType: 'posts',
    }, workflow);
    expect(input).toEqual({ hashtags: ['software development Bengaluru', 'IT services Bangalore'], keywordSearch: true, resultsLimit: 2, resultsType: 'posts' });
    expect((WorkflowExecutorService as any).validateActorInput(node.data.actorId, input, node).valid).toBe(true);
    expect((WorkflowExecutorService as any).buildActorInput(node, context, {
      hashtags: ['#softwaredevelopment'], keywordSearch: false, resultsLimit: 2, resultsType: 'posts',
    }, workflow).hashtags).toEqual(['softwaredevelopment']);
  });

  it('keeps the Twitter provider minimum separate from the reviewed saved-lead cap', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/twitter_competitor_users.json'), 'utf8'));
    const node = workflow.nodes.find((node: any) => node.type === 'actor');
    const context = { executionId: 'twitter-minimum', leadInputId: 1, nodesExecuted: new Map(), logs: [], requestedLeadLimit: 2, persistedLeadCount: 0 };
    const input = (WorkflowExecutorService as any).buildActorInput(node, context, {
      searchTerms: ['software Bangalore'], maxItems: 2, ...node.data.finalValues,
    }, workflow);
    expect(input.maxItems).toBe(5);
    expect(context.requestedLeadLimit).toBe(2);
    expect(input).toMatchObject({ getFollowers: false, getFollowing: false, getRetweeters: false, getAbout: false });
  });

  it('rejects a below-minimum Twitter request before credentials or provider access', async () => {
    await expect((WorkflowExecutorService as any).executeActorWithFallback(1, 'apidojo/twitter-user-scraper', {
      searchTerms: ['software Bangalore'], maxItems: 2, getFollowers: false, getFollowing: false, getRetweeters: false,
    }, () => [], {}, 'below-minimum')).rejects.toThrow('at least 5');
  });
});
