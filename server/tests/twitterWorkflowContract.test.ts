import fs from 'node:fs';
import path from 'node:path';
import { WorkflowExecutorService } from '../services/WorkflowExecutorService.js';
import {
  hasStableTwitterProfileIdentity,
  shouldApplyPostProviderRelevanceValidation,
  evaluateLeadRelevance,
} from '../services/lead-generation/LeadGenerationQualityService.js';

describe('Twitter lead workflow contracts', () => {
  beforeAll(async () => {
    await WorkflowExecutorService.initialize();
  });

  it('fetches only the post author, never the provider-default follower graph', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/twitter_post_authors.json'), 'utf8'));
    const node = workflow.nodes.find((candidate: { id: string }) => candidate.id === 'twitter_author_profiles');
    const context = { executionId: 'author-bound', leadInputId: 1, requestedLeadLimit: 3, persistedLeadCount: 0, nodesExecuted: new Map(), logs: [] };
    const input = (WorkflowExecutorService as any).buildActorInput(node, context, { _current_item: { screen_name: 'example' } }, workflow);
    expect(input).toEqual({ twitterHandles: ['example'], maxItems: 5, getFollowers: false, getFollowing: false, getAbout: false, getRetweeters: false, includeUnavailableUsers: false });
    expect((WorkflowExecutorService as any).validateActorInput(node.data.actorId, input, node).valid).toBe(true);
  });

  it('rejects an unbounded legacy Twitter lookup before accessing the provider', async () => {
    await expect((WorkflowExecutorService as any).executeActorWithFallback(
      1, 'apidojo/twitter-user-scraper', { twitterHandles: ['example'] }, () => [], {}, 'legacy',
    )).rejects.toThrow('positive maxItems');
    await expect((WorkflowExecutorService as any).executeActorWithFallback(
      1, 'apidojo/twitter-user-scraper', { twitterHandles: ['example'], maxItems: 1 }, () => [], {}, 'legacy',
    )).rejects.toThrow('explicit getFollowers');
  });

  it('does not mistake fuzzy profile-search matches for geographically qualified leads', () => {
    const constraints = { regions: ['Bengaluru'], industry: 'software' };
    expect(evaluateLeadRelevance({ name: 'Cool Software Solution', bio: 'Software solutions', location: 'Bengaluru, India' }, constraints, 'twitter_competitor_users').accepted).toBe(true);
    expect(evaluateLeadRelevance({ name: 'Zinavo', bio: 'Zinavo Technologies is a web design company', location: 'Bangalore' }, { ...constraints, industry: 'software IT technology' }, 'twitter_competitor_users').accepted).toBe(true);
    for (const lead of [
      { name: 'Bandalore Software', bio: 'German Japanese indie game studio', location: '' },
      { name: 'Telugu software guy in Bangalore', bio: 'Sports enjoyer leading corporate life', location: '' },
    ]) {
      expect(evaluateLeadRelevance(lead, constraints, 'twitter_competitor_users')).toMatchObject({ accepted: false, geography: 'missing', reasons: expect.arrayContaining(['geography_missing']) });
    }
    expect(evaluateLeadRelevance({ name: 'n8n', bio: 'Workflow software', location: '' }, { industry: 'software' }, 'twitter_competitor_users').accepted).toBe(true);
  });

  it.each(['twitter_post_authors_followers', 'twitter_post_repliers', 'twitter_post_retweeters'])(
    'bounds every profile enrichment in %s without expanding another follower graph', (name) => {
      const workflow = JSON.parse(fs.readFileSync(path.resolve(`data/workflows/${name}.json`), 'utf8'));
      const nodes = workflow.nodes.filter((node: any) => node.data.actorId === 'apidojo/twitter-user-scraper');
      expect(nodes.length).toBeGreaterThan(0);
      for (const node of nodes) {
        expect(node.data.inputMapping).toMatchObject({ maxItems: 1, getFollowers: false, getFollowing: false, getRetweeters: false });
      }
    },
  );

  it('resolves an exact competitor profile before fetching and saving only its followers', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/twitter_competitor_followers.json'), 'utf8'));
    const competitorNode = workflow.nodes.find((node: { id: string }) => node.id === 'competitor_profiles');
    const followerNode = workflow.nodes.find((node: { id: string }) => node.id === 'follower_profiles');
    const saveNode = workflow.nodes.find((node: { id: string }) => node.id === 'db_save_followers');
    const followerActor = JSON.parse(fs.readFileSync(path.resolve('data/actors/powerai-twitter-followers-scraper.json'), 'utf8'));

    expect(competitorNode.data.inputMapping).toEqual({
      twitterHandles: '{{twitterHandles}}',
      maxItems: '{{maxItems}}',
    });
    expect(competitorNode.data.reviewableInputFields).toEqual(['twitterHandles', 'maxItems']);
    expect(competitorNode.data.requiredInputFields).toEqual(['twitterHandles']);
    expect(competitorNode.data.sourceTargetField).toBe('twitterHandles');
    expect(competitorNode.data.sourceLimitField).toBe('maxItems');
    expect(competitorNode.data.finalValues).toEqual({
      getFollowers: false,
      getFollowing: false,
      getAbout: false,
      getRetweeters: false,
      includeUnavailableUsers: false,
    });
    expect(followerNode.data.actorId).toBe('powerai/twitter-followers-scraper');
    expect(followerNode.data.inputMapping).toEqual({
      screenname: '{_current_item.userName}',
      maxResults: 60,
    });
    expect(followerActor.inputSchema.required).toEqual(['screenname']);
    expect(followerActor.inputSchema.properties.maxResults.minimum).toBe(60);
    expect(saveNode.data.iterate_over).toBe('followers');
    expect(workflow.nodes.some((node: { id: string }) => node.id === 'db_save_competitors')).toBe(false);
    expect(workflow.edges.some((edge: { target: string }) => edge.target === 'db_save_competitors')).toBe(false);
    expect(shouldApplyPostProviderRelevanceValidation(workflow.platform, followerNode.data.actorId)).toBe(false);
  });

  it('honors the provider minimum fetch while keeping the durable follower cap at one', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/twitter_competitor_followers.json'), 'utf8'));
    const competitorNode = workflow.nodes.find((node: { id: string }) => node.id === 'competitor_profiles');
    const followerNode = workflow.nodes.find((node: { id: string }) => node.id === 'follower_profiles');
    const context = {
      executionId: 'twitter-competitor-followers-contract',
      platform: workflow.platform,
      leadInputId: 1,
      requestedLeadLimit: 1,
      persistedLeadCount: 0,
      nodesExecuted: new Map(),
      errors: [],
      logs: [],
    };

    expect((WorkflowExecutorService as any).buildActorInput(competitorNode, context, {
      twitterHandles: ['apify'],
      maxItems: 1,
      startUrls: ['https://x.com/unreviewed'],
      searchTerms: ['unreviewed'],
      getFollowers: false,
      getFollowing: false,
      getAbout: false,
      getRetweeters: false,
      includeUnavailableUsers: false,
    }, workflow)).toEqual({
      twitterHandles: ['apify'],
      maxItems: 5,
      getFollowers: false,
      getFollowing: false,
      getAbout: false,
      getRetweeters: false,
      includeUnavailableUsers: false,
    });

    expect((WorkflowExecutorService as any).buildActorInput(competitorNode, context, {
      twitterHandles: ['first_source', 'second_source'],
      maxItems: 1,
      getFollowers: false,
      getFollowing: false,
      getAbout: false,
      getRetweeters: false,
      includeUnavailableUsers: false,
    }, workflow)).toEqual(expect.objectContaining({
      twitterHandles: ['first_source', 'second_source'],
      maxItems: 5,
    }));

    expect((WorkflowExecutorService as any).buildActorInput(followerNode, context, {
      _current_item: { userName: 'apify' },
    }, workflow)).toEqual({
      screenname: 'apify',
      maxResults: 60,
    });

    const missingTarget = (WorkflowExecutorService as any).buildActorInput(competitorNode, context, {
      maxItems: 1,
    }, workflow);
    expect((WorkflowExecutorService as any).validateActorInput(
      competitorNode.data.actorId,
      missingTarget,
      competitorNode,
    )).toEqual(expect.objectContaining({
      valid: false,
      errors: expect.arrayContaining(["Required field 'twitterHandles' is missing"]),
    }));
  });

  it('maps a follower as the lead identity without inventing a company or contact', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/twitter_competitor_followers.json'), 'utf8'));
    const saveNode = workflow.nodes.find((node: { id: string }) => node.id === 'db_save_followers');
    const mapped = (WorkflowExecutorService as any).mapActorResultToLead({
      user_id: 'twitter-user-123',
      screen_name: 'public_follower',
      name: 'Public Follower',
      description: 'Builder and researcher',
      location: 'Prague',
      profile_image: 'https://example.com/avatar.jpg',
      followers_count: 14,
      friends_count: 9,
      statuses_count: 31,
      verified: false,
      website: null,
    }, saveNode.data.field_mapping, { platform: workflow.platform });

    expect(mapped).toMatchObject({
      name: 'Public Follower',
      fullName: 'Public Follower',
      profileId: 'twitter-user-123',
      twitterHandle: 'public_follower',
      twitterUsername: 'public_follower',
      twitterUrl: 'https://twitter.com/public_follower',
      profileUrl: 'https://twitter.com/public_follower',
      profilePicture: 'https://example.com/avatar.jpg',
      followersCount: 14,
      followingCount: 9,
      postsCount: 31,
      engagementType: 'competitor_follower',
      leadType: 'profile',
    });
    expect(mapped.company).toBeNull();
    expect(mapped.email).toBeNull();
    expect(mapped.phone).toBeNull();
  });

  it('does not expose a root Twitter URL when the follower identity is missing', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/twitter_competitor_followers.json'), 'utf8'));
    const saveNode = workflow.nodes.find((node: { id: string }) => node.id === 'db_save_followers');
    const mapped = (WorkflowExecutorService as any).mapActorResultToLead({ name: 'Malformed follower' }, saveNode.data.field_mapping, { platform: workflow.platform });

    expect(mapped.twitterHandle).toBeNull();
    expect(mapped.profileId).toBeFalsy();
    expect(mapped.profileUrl).toBe('https://twitter.com/');
    expect(mapped.profileUrl).not.toMatch(/\/[^/]+$/);
    expect(hasStableTwitterProfileIdentity(mapped)).toBe(false);
    expect(hasStableTwitterProfileIdentity({ twitterHandle: 'valid_handle' })).toBe(true);
  });

  it('retains the exact followed account as raw provenance on each follower result', async () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/twitter_competitor_followers.json'), 'utf8'));
    const followerNode = workflow.nodes.find((node: { id: string }) => node.id === 'follower_profiles');
    const context = {
      executionId: 'twitter-competitor-followers-provenance',
      platform: workflow.platform,
      requestedLeadLimit: 1,
      persistedLeadCount: 0,
      nodesExecuted: new Map<string, Array<Record<string, unknown>>>([
        ['competitor_users', [{
          userName: 'apify',
          twitterUrl: 'https://twitter.com/apify',
        }]],
      ]),
      errors: [],
      logs: [],
    };
    const executor = WorkflowExecutorService as any;
    const executeActorWithFallback = executor.executeActorWithFallback;
    const reconcileProviderDatasetOutcome = executor.reconcileProviderDatasetOutcome;
    const isExecutionCancelled = executor.isExecutionCancelled;
    const saveLeadsImmediately = executor.saveLeadsImmediately;
    executor.executeActorWithFallback = async () => [{
      user_id: 'follower-1',
      screen_name: 'public_follower',
      name: 'Public Follower',
    }];
    executor.reconcileProviderDatasetOutcome = async () => undefined;
    executor.isExecutionCancelled = async () => false;
    executor.saveLeadsImmediately = async () => undefined;

    try {
      await expect(executor.executeActorNode(followerNode, context, {}, undefined, workflow)).resolves.toEqual([
        expect.objectContaining({
          screen_name: 'public_follower',
          sourceProfileUsername: 'apify',
          sourceProfileUrl: 'https://twitter.com/apify',
        }),
      ]);
      const results = context.nodesExecuted.get('followers') as Array<Record<string, unknown>> | undefined;
      expect(results?.[0]?.sourcePostText).toBeUndefined();
    } finally {
      executor.executeActorWithFallback = executeActorWithFallback;
      executor.reconcileProviderDatasetOutcome = reconcileProviderDatasetOutcome;
      executor.isExecutionCancelled = isExecutionCancelled;
      executor.saveLeadsImmediately = saveLeadsImmediately;
    }
  });

  it('binds competitor-user execution to exact reviewed search terms without paid expansion modes', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/twitter_competitor_users.json'), 'utf8'));
    const actorNode = workflow.nodes.find((node: { id: string }) => node.id === 'twitter_user_actor');
    const context = {
      executionId: 'twitter-competitor-users-contract',
      platform: workflow.platform,
      leadInputId: 1,
      requestedLeadLimit: 1,
      persistedLeadCount: 0,
      nodesExecuted: new Map(),
      errors: [],
      logs: [],
    };

    expect(actorNode.data.reviewableInputFields).toEqual(['searchTerms', 'maxItems']);
    expect(actorNode.data.requiredInputFields).toEqual(['searchTerms']);
    expect(actorNode.data.finalValues).toEqual({
      getFollowers: false,
      getFollowing: false,
      getAbout: false,
      getRetweeters: false,
      includeUnavailableUsers: false,
    });
    expect(shouldApplyPostProviderRelevanceValidation(workflow.platform, actorNode.data.actorId)).toBe(true);
    expect((WorkflowExecutorService as any).buildActorInput(actorNode, context, {
      searchTerms: ['n8n'],
      maxItems: 1,
      startUrls: ['https://x.com/unreviewed'],
      twitterHandles: ['unreviewed'],
      getFollowers: false,
      getFollowing: false,
      getAbout: false,
      getRetweeters: false,
      includeUnavailableUsers: false,
    }, workflow)).toEqual({
      searchTerms: ['n8n'],
      maxItems: 5,
      getFollowers: false,
      getFollowing: false,
      getAbout: false,
      getRetweeters: false,
      includeUnavailableUsers: false,
    });

    const missingTarget = (WorkflowExecutorService as any).buildActorInput(actorNode, context, {
      maxItems: 1,
    }, workflow);
    expect((WorkflowExecutorService as any).validateActorInput(
      actorNode.data.actorId,
      missingTarget,
      actorNode,
    )).toEqual(expect.objectContaining({
      valid: false,
      errors: expect.arrayContaining(["Required field 'searchTerms' is missing"]),
    }));
  });

  it('maps competitor-user identity and separates the public profile URL from its website', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/twitter_competitor_users.json'), 'utf8'));
    const saveNode = workflow.nodes.find((node: { id: string }) => node.id === 'db_save_users');
    const mapped = (WorkflowExecutorService as any).mapActorResultToLead({
      id: '1068479892537384960',
      userName: 'n8n_io',
      name: 'n8n.io',
      description: 'Workflow automation for technical teams',
      twitterUrl: 'https://twitter.com/n8n_io',
      url: 'https://x.com/n8n_io',
      entities: {
        url: {
          urls: [{ expanded_url: 'https://n8n.io' }],
        },
      },
      followers: 83539,
      following: 1,
      statusesCount: 2839,
      isVerified: true,
      location: 'Berlin, Germany',
    }, saveNode.data.field_mapping, { platform: workflow.platform });

    expect(mapped).toMatchObject({
      profileId: '1068479892537384960',
      name: 'n8n.io',
      fullName: 'n8n.io',
      twitterHandle: 'n8n_io',
      twitterUsername: 'n8n_io',
      twitterUrl: 'https://twitter.com/n8n_io',
      profileUrl: 'https://twitter.com/n8n_io',
      website: 'https://n8n.io',
      engagementType: 'competitor_profile',
      leadType: 'profile',
      followersCount: 83539,
      twitterFollowers: 83539,
      followingCount: 1,
      postsCount: 2839,
    });
    expect(mapped.company).toBeNull();
    expect(mapped.email).toBeNull();
    expect(mapped.phone).toBeNull();
    expect(hasStableTwitterProfileIdentity(mapped)).toBe(true);
  });

  it('rejects a competitor-user result that cannot identify a public Twitter handle', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/twitter_competitor_users.json'), 'utf8'));
    const saveNode = workflow.nodes.find((node: { id: string }) => node.id === 'db_save_users');
    const mapped = (WorkflowExecutorService as any).mapActorResultToLead({
      id: 'malformed-profile',
      name: 'Malformed profile',
    }, saveNode.data.field_mapping, { platform: workflow.platform });

    expect(mapped.twitterHandle).toBeNull();
    expect(hasStableTwitterProfileIdentity(mapped)).toBe(false);
  });

  it('coerces Twitter RFC-2822 post timestamps before persistence', () => {
    const mapped = (WorkflowExecutorService as any).mapActorResultToPost({
      tweet_id: '2091838324163940766',
      screen_name: 'n8n_io',
      text: 'n8n is now an agent harness',
      created_at: 'Mon Aug 24 10:41:35 +0000 2026',
    }, {
      platform: "'twitter'",
      postId: 'tweet_id',
      text: 'text',
      createdAt: 'created_at',
    }, { platform: 'twitter_post_authors', userId: 1, promptId: 1 });

    expect(mapped.createdAt).toEqual(new Date('2026-08-24T10:41:35.000Z'));
    expect(mapped.createdAt).toBeInstanceOf(Date);
  });
});
