import { beforeAll, describe, expect, it } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { WorkflowExecutorService } from '../services/WorkflowExecutorService.js';
import { ActorSchemaRegistry, resolveActorSchemaDataDirectories } from '../services/workflow/ActorSchemaRegistry.js';
import { buildReviewedWorkflowActorSchema } from '../mastra/tools/executors/leadExecutor.js';

const workflow = (name: string) => JSON.parse(readFileSync(new URL(`../data/workflows/${name}.json`, import.meta.url), 'utf8'));
const context = () => ({ leadInputId: 127, nodesExecuted: new Map(), logs: [], executionId: 'unit-reviewed-input' });
const executor = WorkflowExecutorService as any;

beforeAll(async () => { await WorkflowExecutorService.initialize(); });

describe('reviewed actor input binding', () => {
  // A file:///app URL has no drive letter, so this Linux path only resolves on Linux/macOS.
  (process.platform === 'win32' ? it.skip : it)('finds actor schemas from the production /app working directory', () => {
    expect(resolveActorSchemaDataDirectories('/app', 'file:///app/server/services/workflow/ActorSchemaRegistry.js'))
      .toContain('/app/server/data');
  });

  it('loads schema metadata for every catalog workflow entry actor', () => {
    for (const file of readdirSync(new URL('../data/workflows/', import.meta.url)).filter(name => name.endsWith('.json'))) {
      const wf = workflow(file.slice(0, -5));
      const first = wf.nodes.find((node: any) => node.type === 'actor');
      expect(ActorSchemaRegistry.getInstance().getSchema(first.data.actorId)?.inputSchema.properties).toBeDefined();
    }
  });

  it('preserves Google Maps search criteria, the cap, and approved disabled enrichment', () => {
    const wf = workflow('google_maps');
    const reviewed = {
      searchStringsArray: ['cafe in Coimbatore'], locationQuery: 'Coimbatore, Tamil Nadu, India',
      maxCrawledPlacesPerSearch: 3, scrapeContacts: false, maximumLeadsEnrichmentRecords: 0,
      scrapeSocialMediaProfiles: { facebooks: false }, postalCode: null,
      __leadInputId: 127, __leadReviewConstraints: { regions: ['Coimbatore'] }, unrelated: 'private',
    };
    const original = structuredClone(reviewed);
    // A later template change is not permission to change the reviewed run.
    wf.nodes[0].data.finalValues.scrapeContacts = true;
    const input = executor.buildActorInput(wf.nodes[0], context(), reviewed, wf);
    expect(input).toEqual({
      searchStringsArray: ['cafe in Coimbatore'], locationQuery: 'Coimbatore, Tamil Nadu, India',
      maxCrawledPlacesPerSearch: 3, scrapeContacts: false, maximumLeadsEnrichmentRecords: 0,
      scrapeSocialMediaProfiles: { facebooks: false },
    });
    expect(reviewed).toEqual(original);
    expect(executor.validateActorInput(wf.nodes[0].data.actorId, input, wf.nodes[0]).valid).toBe(true);
  });

  it('rejects a Google Maps run missing all search targets before calling Apify', () => {
    const wf = workflow('google_maps');
    expect(executor.validateActorInput(wf.nodes[0].data.actorId, { maxCrawledPlacesPerSearch: 3 }, wf.nodes[0]).valid).toBe(false);
  });

  it('preserves canonical Twitter fields instead of missing-alias defaults', () => {
    const wf = workflow('twitter_post_authors');
    const node = wf.nodes.find((n: any) => n.type === 'actor');
    node.data.inputMapping = { query: '{{searchQuery}}', maxResults: '{{maxTweets}}' };
    expect(executor.buildActorInput(node, context(), { query: 'coffee', maxResults: 3 }, wf))
      .toMatchObject({ query: 'coffee', maxResults: 15 });
    expect(executor.buildActorInput(node, context(), { searchQuery: 'coffee', maxTweets: 3 }, wf))
      .toMatchObject({ query: 'coffee', maxResults: 15 });
  });

  it('preserves JustDial city when its legacy location alias is absent', () => {
    const wf = workflow('justdial');
    expect(executor.buildActorInput(wf.nodes[0], context(), { city: 'Coimbatore', search: 'Cafe', maxItems: 3 }, wf))
      .toMatchObject({ city: 'Coimbatore', search: 'Cafe', maxItems: 3 });
  });

  it('supports an explicitly reviewed JustDial listing URL without an extra city/category search', () => {
    const wf = workflow('justdial');
    const reviewed = { startUrls: ['https://www.justdial.com/Coimbatore/Cafes/nct-10104727'], maxItems: 1 };
    const input = executor.buildActorInput(wf.nodes[0], context(), reviewed, wf);
    expect(input).toEqual(reviewed);
    expect(executor.validateActorInput(wf.nodes[0].data.actorId, input, wf.nodes[0]).valid).toBe(true);
    expect(executor.validateActorInput(wf.nodes[0].data.actorId, { maxItems: 1 }, wf.nodes[0]).valid).toBe(false);
  });

  it('loads alternate-schema fields for reviewed LinkedIn inputs', () => {
    const wf = workflow('linkedin_company_search');
    const node = wf.nodes.find((n: any) => n.type === 'actor');
    expect(executor.buildActorInput(node, context(), { searchQuery: 'software', maxItems: 3, companySize: ['11-50'], industryIds: ['4'] }, wf))
      .toMatchObject({ searchQuery: 'software', maxItems: 3, companySize: ['11-50'], industryIds: ['4'] });
    expect(ActorSchemaRegistry.getInstance().getSchema('apify/instagram-post-scraper')?.inputSchema.required).toContain('username');
  });

  it('includes downstream user-controlled fields in a composite workflow review', async () => {
    const wf = workflow('linkedin_company_search_employees');
    const schema = await buildReviewedWorkflowActorSchema(wf);

    expect(schema?.inputProperties).toMatchObject({
      searchQuery: expect.any(Object),
      locations: expect.any(Object),
      jobTitles: expect.any(Object),
      seniorityLevelIds: expect.any(Object),
    });
    expect(schema?.inputProperties).not.toHaveProperty('companies');
    expect(schema?.requiredFields).not.toContain('companies');
    expect(wf.nodes.filter((node: any) => node.type === 'saveToLeads').map((node: any) => node.id))
      .toEqual(['db_save_employees']);
  });

  it('clamps downstream actor volume to the reviewed global cap', () => {
    const wf = workflow('linkedin_company_search_employees');
    const downstream = wf.nodes.find((node: any) => node.id === 'linkedin_company_employees');
    const input = executor.buildActorInput(downstream, {
      ...context(), requestedLeadLimit: 1, persistedLeadCount: 0,
    }, {
      _current_item: { linkedinUrl: 'https://www.linkedin.com/company/example/' },
      jobTitles: ['Founder'], seniorityLevelIds: [],
    }, wf);
    expect(input).toMatchObject({
      companies: ['https://www.linkedin.com/company/example/'],
      maxItems: 1,
      jobTitles: ['Founder'],
    });
    expect(input).not.toHaveProperty('seniorityLevelIds');
  });

  it('clamps iterated LinkedIn profile-post volume to the reviewed global cap', () => {
    const wf = workflow('linkedin_posts_commenters');
    const downstream = wf.nodes.find((node: any) => node.id === 'linkedin_profile_posts');
    const input = executor.buildActorInput(downstream, {
      ...context(), requestedLeadLimit: 1, persistedLeadCount: 0,
    }, {
      _current_item: { linkedinUrl: 'https://www.linkedin.com/in/satyanadella/' },
    }, wf);
    expect(input).toMatchObject({
      targetUrls: ['https://www.linkedin.com/in/satyanadella/'],
      maxPosts: 1,
      postedLimit: 'month',
    });
  });

  it('keeps a provider-required fetch minimum while the reviewed save cap stays one', () => {
    const wf = workflow('facebook_post_authors');
    const source = wf.nodes.find((node: any) => node.id === 'facebook_post_search');
    expect(executor.buildActorInput(source, {
      ...context(), requestedLeadLimit: 1, persistedLeadCount: 0,
    }, {
      query: 'enterprise AI', maxResults: 10,
    }, wf)).toEqual({
      query: 'enterprise AI', maxResults: 10,
    });
    expect(executor.buildActorInput(source, {
      ...context(), requestedLeadLimit: 1, persistedLeadCount: 0,
    }, {
      query: 'enterprise AI', maxResults: 1,
    }, wf)).toEqual({
      query: 'enterprise AI', maxResults: 10,
    });
  });

  it('exposes the exact Facebook post-search review schema and keeps its fixed recent-post value', async () => {
    const wf = workflow('facebook_post_authors');
    const schema = await buildReviewedWorkflowActorSchema(wf);
    expect(schema?.inputProperties).toEqual(expect.objectContaining({
      query: expect.objectContaining({ type: 'string' }),
      recent_posts: expect.objectContaining({ type: 'boolean' }),
      location_uid: expect.objectContaining({ type: 'string' }),
      start_date: expect.objectContaining({ type: 'string' }),
      end_date: expect.objectContaining({ type: 'string' }),
      maxResults: expect.objectContaining({ type: 'integer', minimum: 10 }),
    }));
    expect(schema?.requiredFields).toContain('query');
    const source = wf.nodes.find((node: any) => node.id === 'facebook_post_search');
    expect(source.data.finalValues).toEqual({ recent_posts: true });
  });

  it('uses the reviewed actor preparation and canonical lead mapper for iterated saves', () => {
    const source = readFileSync(new URL('../services/WorkflowExecutorService.ts', import.meta.url), 'utf8');
    expect(source).toContain('this.buildActorInput(node, context, itemContext, workflow)');
    expect(source).toContain('this.mapActorResultToLead(item, field_mapping, context)');
  });

  it('never copies initial profile targets into a downstream actor', () => {
    const wf = workflow('instagram_post_authors');
    const first = wf.nodes.find((n: any) => n.type === 'actor');
    const downstream = wf.nodes.find((n: any) => n.type === 'actor' && n.id !== first.id);
    downstream.data.inputMapping = { usernames: ['derived_author'] };
    expect(executor.buildActorInput(downstream, context(), { usernames: ['initial_wrong_author'], __leadInputId: 127 }, wf))
      .toEqual({ usernames: ['derived_author'] });
  });

  it('does not change legacy unreviewed execution input semantics', () => {
    const wf = workflow('google_maps');
    const input = executor.buildActorInput(wf.nodes[0], { ...context(), leadInputId: undefined }, {
      startUrls: ['https://www.google.com/maps/place/example'], maxCrawledPlacesPerSearch: 3, city: 'not mapped',
    }, wf);
    expect(input).not.toHaveProperty('city');
    expect(input).toHaveProperty('startUrls');
  });
});
