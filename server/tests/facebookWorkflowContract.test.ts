import fs from 'node:fs';
import path from 'node:path';
import { WorkflowExecutorService } from '../services/WorkflowExecutorService.js';
import { validateActorInputsAgainstSchema } from '../mastra/tools/executors/leadExecutor.js';

describe('Facebook lead workflow contracts', () => {
  beforeAll(async () => {
    await WorkflowExecutorService.initialize();
  });

  it('uses the live contract-compatible post-search actor across every retained Facebook post workflow', () => {
    const workflowFiles = [
      'facebook_post_authors.json',
      'facebook_post_authors_followers.json',
      'facebook_post_commenters.json',
      'facebook_post_likers.json',
    ];
    const actorMetadata = JSON.parse(fs.readFileSync(
      path.resolve('data/actors/powerai-facebook-post-search-scraper.json'),
      'utf8',
    ));

    expect(actorMetadata.id).toBe('powerai/facebook-post-search-scraper');
    expect(actorMetadata.inputSchema.required).toEqual(['query']);
    expect(actorMetadata.inputSchema.properties.maxResults.minimum).toBe(10);
    for (const file of workflowFiles) {
      const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows', file), 'utf8'));
      const searchNode = workflow.nodes.find((node: { id: string }) => node.id === 'facebook_post_search');
      expect(searchNode.data.actorId).toBe(actorMetadata.id);
      expect(searchNode.data.inputMapping).toEqual({
        query: '{{query}}',
        maxResults: '{{maxResults}}',
      });
      expect(searchNode.data.finalValues).toEqual({ recent_posts: true });
    }
  });

  it('uses the current official follower actor contract and maps follower identities rather than the source page', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/facebook_competitor_pages.json'), 'utf8'));
    const actorMetadata = JSON.parse(fs.readFileSync(path.resolve('data/actors/apify-facebook-followers-following-scraper.json'), 'utf8'));
    const actorNode = workflow.nodes.find((node: { id: string }) => node.id === 'facebook_followers_actor');
    const saveNode = workflow.nodes.find((node: { id: string }) => node.id === 'db_save_followers');

    expect(actorNode.data.actorId).toBe('apify/facebook-followers-following-scraper');
    expect(actorNode.data.inputMapping).toEqual({
      startUrls: '{{startUrls}}',
      resultsLimit: '{{resultsLimit}}',
      followType: 'follower',
    });
    expect(actorNode.data.finalValues).toEqual({ followType: 'follower' });
    expect(actorMetadata.inputSchema.required).toEqual(['startUrls']);
    expect(actorMetadata.inputSchema.properties.startUrls.items).toEqual(expect.objectContaining({
      type: 'object',
      required: ['url'],
    }));
    expect(actorMetadata.inputSchema.properties.resultsLimit.minimum).toBe(1);

    const result = (WorkflowExecutorService as any).mapActorResultToLead({
      facebookUrl: 'https://www.facebook.com/LeonardoDiCaprio',
      inputUrl: 'https://www.facebook.com/LeonardoDiCaprio/followers',
      followType: 'followers',
      id: 'follower-123',
      url: 'https://www.facebook.com/public.follower',
      image: 'https://example.com/follower.jpg',
      title: 'Public Follower',
      subtitle_text: 'Follower',
    }, saveNode.data.field_mapping, { platform: workflow.platform });

    expect(result).toMatchObject({
      name: 'Public Follower',
      fullName: 'Public Follower',
      profileId: 'follower-123',
      facebookUrl: 'https://www.facebook.com/public.follower',
      profileUrl: 'https://www.facebook.com/public.follower',
      photo: 'https://example.com/follower.jpg',
      profilePicture: 'https://example.com/follower.jpg',
      engagementType: 'competitor_follower',
    });
    expect(result.facebookUrl).not.toBe('https://www.facebook.com/LeonardoDiCaprio');
    expect(result.rawData).toEqual(expect.objectContaining({
      inputUrl: 'https://www.facebook.com/LeonardoDiCaprio/followers',
    }));
    expect(result.email).toBeNull();
    expect(result.phone).toBeNull();
  });

  it('pushes the reviewed remaining lead cap into resultsLimit while preserving the request-list URL shape', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/facebook_competitor_pages.json'), 'utf8'));
    const actorNode = workflow.nodes.find((node: { id: string }) => node.id === 'facebook_followers_actor');
    const context = {
      executionId: 'facebook-competitor-followers-contract',
      platform: workflow.platform,
      leadInputId: 1,
      requestedLeadLimit: 1,
      persistedLeadCount: 0,
      nodesExecuted: new Map(),
      errors: [],
      logs: [],
    };
    const input = (WorkflowExecutorService as any).buildActorInput(actorNode, context, {
      startUrls: [{ url: 'https://www.facebook.com/LeonardoDiCaprio' }],
      resultsLimit: 40,
      followType: 'follower',
    }, workflow);

    expect(input).toEqual({
      startUrls: [{ url: 'https://www.facebook.com/LeonardoDiCaprio' }],
      resultsLimit: 1,
      followType: 'follower',
    });

    const actorMetadata = JSON.parse(fs.readFileSync(path.resolve('data/actors/apify-facebook-followers-following-scraper.json'), 'utf8'));
    const schema = actorMetadata.inputSchema.properties;
    expect(validateActorInputsAgainstSchema(
      actorNode.data.actorId,
      input,
      schema,
      actorMetadata.inputSchema.required,
    )).toEqual([]);
    expect(validateActorInputsAgainstSchema(
      actorNode.data.actorId,
      { ...input, startUrls: ['https://www.facebook.com/LeonardoDiCaprio'] },
      schema,
      actorMetadata.inputSchema.required,
    )).toContain('Field "startUrls.0" should be an object');
    expect((WorkflowExecutorService as any).validateActorInput(
      actorNode.data.actorId,
      { ...input, startUrls: ['https://www.facebook.com/LeonardoDiCaprio'] },
      actorNode,
    )).toEqual(expect.objectContaining({
      valid: false,
      errors: expect.arrayContaining(['Field input.startUrls[0] must be object']),
    }));
  });

  it('saves post-author followers directly as profiles with source-post provenance and no page-only re-scrape', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/facebook_post_authors_followers.json'), 'utf8'));
    const followerNode = workflow.nodes.find((node: { id: string }) => node.id === 'facebook_followers');
    const saveNode = workflow.nodes.find((node: { id: string }) => node.id === 'db_save_followers');
    const order = (WorkflowExecutorService as any).getExecutionOrder(workflow);

    expect(workflow.nodes.some((node: { id: string }) => node.id === 'facebook_profile')).toBe(false);
    expect(workflow.nodes.some((node: { id: string }) => node.id === 'facebook_followers_profiles')).toBe(false);
    expect(followerNode.data.immediateEnrichment).toBeUndefined();
    expect(saveNode.data.iterate_over).toBe('facebook_followers');
    expect(order.indexOf('db_save_posts')).toBeLessThan(order.indexOf('facebook_followers'));
    expect(workflow.edges).toContainEqual(expect.objectContaining({
      source: 'db_save_posts',
      target: 'db_save_followers',
    }));

    const context = {
      executionId: 'facebook-post-author-followers-contract',
      platform: workflow.platform,
      requestedLeadLimit: 1,
      persistedLeadCount: 0,
      nodesExecuted: new Map(),
      errors: [],
      logs: [],
    };
    expect((WorkflowExecutorService as any).buildActorInput(followerNode, context, {
      _current_item: {
        author: { url: 'https://www.facebook.com/Talkdesk' },
      },
    }, workflow)).toEqual({
      startUrls: [{ url: 'https://www.facebook.com/Talkdesk' }],
      resultsLimit: 1,
      followType: 'follower',
    });

    const mapped = (WorkflowExecutorService as any).mapActorResultToLead({
      id: 'public-follower-123',
      url: 'https://www.facebook.com/public.follower',
      image: 'https://example.com/public-follower.jpg',
      title: 'Public Follower',
      subtitle_text: 'Public follower profile',
      inputUrl: 'https://www.facebook.com/Talkdesk/followers',
      postUrl: 'https://www.facebook.com/Talkdesk/posts/123',
      sourcePostUrls: ['https://www.facebook.com/Talkdesk/posts/123'],
      sourcePostText: 'Enterprise AI automation for contact centers',
    }, saveNode.data.field_mapping, context);

    expect(mapped).toMatchObject({
      name: 'Public Follower',
      fullName: 'Public Follower',
      profileId: 'public-follower-123',
      facebookUrl: 'https://www.facebook.com/public.follower',
      profileUrl: 'https://www.facebook.com/public.follower',
      profilePicture: 'https://example.com/public-follower.jpg',
      leadType: 'profile',
      engagementType: 'follower',
      postUrl: 'https://www.facebook.com/Talkdesk/posts/123',
    });
    expect(mapped.company).toBeNull();
    expect(mapped.email).toBeNull();
    expect(mapped.phone).toBeNull();
    expect(mapped.rawData).toEqual(expect.objectContaining({
      inputUrl: 'https://www.facebook.com/Talkdesk/followers',
      sourcePostText: 'Enterprise AI automation for contact centers',
    }));
  });

  it('saves post commenters directly with the official comment identity and source-post provenance', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/facebook_post_commenters.json'), 'utf8'));
    const commentNode = workflow.nodes.find((node: { id: string }) => node.id === 'facebook_comments');
    const saveNode = workflow.nodes.find((node: { id: string }) => node.id === 'db_save_commenters');
    const actorMetadata = JSON.parse(fs.readFileSync(
      path.resolve('data/actors/apify-facebook-comments-scraper.json'),
      'utf8',
    ));
    const order = (WorkflowExecutorService as any).getExecutionOrder(workflow);

    expect(commentNode.data.actorId).toBe('apify/facebook-comments-scraper');
    expect(actorMetadata.inputSchema.required).toEqual(['startUrls']);
    expect(actorMetadata.inputSchema.properties.resultsLimit.minimum).toBe(1);
    expect(actorMetadata.outputSchema.properties).toEqual(expect.objectContaining({
      profileId: expect.any(Object),
      profileName: expect.any(Object),
      profilePicture: expect.any(Object),
      profileUrl: expect.any(Object),
    }));
    expect(workflow.nodes.some((node: { id: string }) => node.id === 'facebook_commenters_profiles')).toBe(false);
    expect(commentNode.data.immediateEnrichment).toBeUndefined();
    expect(saveNode.data.iterate_over).toBe('facebook_comments');
    expect(order.indexOf('db_save_posts')).toBeLessThan(order.indexOf('facebook_comments'));
    expect(workflow.edges).toContainEqual(expect.objectContaining({
      source: 'db_save_posts',
      target: 'facebook_comments',
    }));

    const context = {
      executionId: 'facebook-post-commenters-contract',
      platform: workflow.platform,
      requestedLeadLimit: 1,
      persistedLeadCount: 0,
      nodesExecuted: new Map(),
      errors: [],
      logs: [],
    };
    expect((WorkflowExecutorService as any).buildActorInput(commentNode, context, {
      _current_item: {
        url: 'https://www.facebook.com/Talkdesk/posts/123',
      },
    }, workflow)).toEqual({
      startUrls: [{ url: 'https://www.facebook.com/Talkdesk/posts/123' }],
      resultsLimit: 1,
    });

    const mapped = (WorkflowExecutorService as any).mapActorResultToLead({
      profileId: 'commenter-123',
      profileName: 'Public Commenter',
      profilePicture: 'https://example.com/commenter.jpg',
      profileUrl: 'https://www.facebook.com/public.commenter',
      text: 'Enterprise automation is useful here.',
      inputUrl: 'https://www.facebook.com/Talkdesk/posts/123',
      postUrl: 'https://www.facebook.com/Talkdesk/posts/123',
      sourcePostUrls: ['https://www.facebook.com/Talkdesk/posts/123'],
      sourcePostText: 'Enterprise AI automation for contact centers',
    }, saveNode.data.field_mapping, context);

    expect(mapped).toMatchObject({
      name: 'Public Commenter',
      fullName: 'Public Commenter',
      profileId: 'commenter-123',
      facebookUrl: 'https://www.facebook.com/public.commenter',
      profileUrl: 'https://www.facebook.com/public.commenter',
      profilePicture: 'https://example.com/commenter.jpg',
      leadType: 'profile',
      engagementType: 'commenter',
      postUrl: 'https://www.facebook.com/Talkdesk/posts/123',
    });
    expect(mapped.company).toBeNull();
    expect(mapped.email).toBeNull();
    expect(mapped.phone).toBeNull();
    expect(mapped.rawData).toEqual(expect.objectContaining({
      inputUrl: 'https://www.facebook.com/Talkdesk/posts/123',
      sourcePostText: 'Enterprise AI automation for contact centers',
    }));
  });

  it('continues direct-save commenter iterations when the first candidate does not fill the reviewed cap', async () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/facebook_post_commenters.json'), 'utf8'));
    const commentNode = workflow.nodes.find((node: { id: string }) => node.id === 'facebook_comments');
    const context = {
      executionId: 'facebook-post-commenters-rejection-cap-contract',
      platform: workflow.platform,
      requestedLeadLimit: 1,
      persistedLeadCount: 0,
      nodesExecuted: new Map<string, any>([
        ['facebook_posts', [
          { post_id: 'first', url: 'https://www.facebook.com/example/posts/first' },
          { post_id: 'second', url: 'https://www.facebook.com/example/posts/second' },
        ]],
      ]),
      errors: [],
      logs: [],
    };
    const executor = WorkflowExecutorService as any;
    const executeActorWithFallback = executor.executeActorWithFallback;
    const saveLeadsImmediately = executor.saveLeadsImmediately;
    const reconcileProviderDatasetOutcome = executor.reconcileProviderDatasetOutcome;
    const isExecutionCancelled = executor.isExecutionCancelled;
    let providerCalls = 0;
    executor.executeActorWithFallback = async () => {
      providerCalls += 1;
      return [{
        profileId: `commenter-${providerCalls}`,
        profileName: `Commenter ${providerCalls}`,
        profileUrl: `https://www.facebook.com/commenter-${providerCalls}`,
      }];
    };
    executor.saveLeadsImmediately = async () => {
      if (providerCalls === 2) context.persistedLeadCount += 1;
    };
    executor.reconcileProviderDatasetOutcome = async () => undefined;
    executor.isExecutionCancelled = async () => false;

    try {
      const results = await executor.executeActorNode(commentNode, context, {}, undefined, workflow);
      expect(providerCalls).toBe(2);
      expect(results).toHaveLength(2);
      expect(context.persistedLeadCount).toBe(1);
    } finally {
      executor.executeActorWithFallback = executeActorWithFallback;
      executor.saveLeadsImmediately = saveLeadsImmediately;
      executor.reconcileProviderDatasetOutcome = reconcileProviderDatasetOutcome;
      executor.isExecutionCancelled = isExecutionCancelled;
    }
  });

  it('saves post likers directly from the official actor without confusing source-post IDs and URLs for profile identity', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/facebook_post_likers.json'), 'utf8'));
    const likesNode = workflow.nodes.find((node: { id: string }) => node.id === 'facebook_likes');
    const saveNode = workflow.nodes.find((node: { id: string }) => node.id === 'db_save_likers');
    const actorMetadata = JSON.parse(fs.readFileSync(
      path.resolve('data/actors/apify-facebook-likes-scraper.json'),
      'utf8',
    ));
    const order = (WorkflowExecutorService as any).getExecutionOrder(workflow);

    expect(likesNode.data.actorId).toBe('apify/facebook-likes-scraper');
    expect(actorMetadata.inputSchema.required).toEqual(['startUrls']);
    expect(actorMetadata.inputSchema.properties.resultsLimit.minimum).toBe(1);
    expect(actorMetadata.outputSchema.properties.profilePicture).toEqual(expect.any(Object));
    expect(workflow.nodes.some((node: { id: string }) => node.id === 'facebook_likers_profiles')).toBe(false);
    expect(likesNode.data.immediateEnrichment).toBeUndefined();
    expect(saveNode.data.iterate_over).toBe('facebook_likes');
    expect(saveNode.data.field_mapping).not.toHaveProperty('profileId');
    expect(order.indexOf('db_save_posts')).toBeLessThan(order.indexOf('facebook_likes'));
    expect(workflow.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'db_save_posts', target: 'facebook_likes' }),
      expect.objectContaining({ source: 'db_save_posts', target: 'db_save_likers' }),
    ]));

    const context = {
      executionId: 'facebook-post-likers-contract',
      platform: workflow.platform,
      requestedLeadLimit: 1,
      persistedLeadCount: 0,
      nodesExecuted: new Map(),
      errors: [],
      logs: [],
    };
    expect((WorkflowExecutorService as any).buildActorInput(likesNode, context, {
      _current_item: {
        url: 'https://www.facebook.com/Talkdesk/posts/123',
      },
    }, workflow)).toEqual({
      startUrls: [{ url: 'https://www.facebook.com/Talkdesk/posts/123' }],
      resultsLimit: 1,
    });

    const mapped = (WorkflowExecutorService as any).mapActorResultToLead({
      facebookId: '123',
      facebookUrl: 'https://www.facebook.com/Talkdesk/posts/123',
      name: 'Public Liker',
      profileUrl: 'https://www.facebook.com/public.liker',
      profilePicture: 'https://example.com/liker.jpg',
      reaction: 'like',
      postUrl: 'https://www.facebook.com/Talkdesk/posts/123',
      sourcePostUrls: ['https://www.facebook.com/Talkdesk/posts/123'],
      sourcePostText: 'Enterprise AI automation for contact centers',
    }, saveNode.data.field_mapping, context);

    expect(mapped).toMatchObject({
      name: 'Public Liker',
      fullName: 'Public Liker',
      profileId: null,
      facebookUrl: 'https://www.facebook.com/public.liker',
      profileUrl: 'https://www.facebook.com/public.liker',
      profilePicture: 'https://example.com/liker.jpg',
      leadType: 'profile',
      engagementType: 'liker',
      postUrl: 'https://www.facebook.com/Talkdesk/posts/123',
    });
    expect(mapped.company).toBeNull();
    expect(mapped.email).toBeNull();
    expect(mapped.phone).toBeNull();
    expect(mapped.rawData).toEqual(expect.objectContaining({
      facebookId: '123',
      facebookUrl: 'https://www.facebook.com/Talkdesk/posts/123',
      reaction: 'like',
      sourcePostText: 'Enterprise AI automation for contact centers',
    }));

    const missingProfile = (WorkflowExecutorService as any).mapActorResultToLead({
      facebookId: '123',
      facebookUrl: 'https://www.facebook.com/Talkdesk/posts/123',
      name: 'Anonymous Reactor',
      profileUrl: null,
    }, saveNode.data.field_mapping, context);
    expect(missingProfile.profileId).toBeNull();
    expect(missingProfile.profileUrl).toBeNull();
    expect(missingProfile.facebookUrl).toBeNull();
  });

  it('continues liker iterations after an unusable first identity and stops after the reviewed cap is durably filled', async () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/facebook_post_likers.json'), 'utf8'));
    const likesNode = workflow.nodes.find((node: { id: string }) => node.id === 'facebook_likes');
    const context = {
      executionId: 'facebook-post-likers-cap-contract',
      platform: workflow.platform,
      requestedLeadLimit: 1,
      persistedLeadCount: 0,
      nodesExecuted: new Map<string, any>([
        ['facebook_posts', [
          { post_id: 'first', url: 'https://www.facebook.com/example/posts/first' },
          { post_id: 'second', url: 'https://www.facebook.com/example/posts/second' },
          { post_id: 'third', url: 'https://www.facebook.com/example/posts/third' },
        ]],
      ]),
      errors: [],
      logs: [],
    };
    const executor = WorkflowExecutorService as any;
    const executeActorWithFallback = executor.executeActorWithFallback;
    const saveLeadsImmediately = executor.saveLeadsImmediately;
    const reconcileProviderDatasetOutcome = executor.reconcileProviderDatasetOutcome;
    const isExecutionCancelled = executor.isExecutionCancelled;
    const providerInputs: Array<Record<string, unknown>> = [];
    executor.executeActorWithFallback = async (_userId: number | undefined, actorId: string, input: Record<string, unknown>) => {
      expect(actorId).toBe('apify/facebook-likes-scraper');
      providerInputs.push(input);
      return providerInputs.length === 1
        ? [{ name: 'Anonymous Reactor', profileUrl: null }]
        : [{ name: 'Public Liker', profileUrl: 'https://www.facebook.com/public.liker' }];
    };
    executor.saveLeadsImmediately = async () => {
      if (providerInputs.length === 2) context.persistedLeadCount += 1;
    };
    executor.reconcileProviderDatasetOutcome = async () => undefined;
    executor.isExecutionCancelled = async () => false;

    try {
      const results = await executor.executeActorNode(likesNode, context, {}, undefined, workflow);
      expect(providerInputs).toEqual([
        {
          startUrls: [{ url: 'https://www.facebook.com/example/posts/first' }],
          resultsLimit: 1,
        },
        {
          startUrls: [{ url: 'https://www.facebook.com/example/posts/second' }],
          resultsLimit: 1,
        },
      ]);
      expect(results).toHaveLength(2);
      expect(context.persistedLeadCount).toBe(1);
    } finally {
      executor.executeActorWithFallback = executeActorWithFallback;
      executor.saveLeadsImmediately = saveLeadsImmediately;
      executor.reconcileProviderDatasetOutcome = reconcileProviderDatasetOutcome;
      executor.isExecutionCancelled = isExecutionCancelled;
    }
  });

  it('orders post persistence before author persistence and carries snake-case post provenance', async () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/facebook_post_authors.json'), 'utf8'));
    const profileNode = workflow.nodes.find((node: { id: string }) => node.id === 'facebook_profile');
    const saveNode = workflow.nodes.find((node: { id: string }) => node.id === 'db_save_authors');
    const sourcePostUrl = 'https://www.facebook.com/example/posts/123';
    const order = (WorkflowExecutorService as any).getExecutionOrder(workflow);
    expect(order.indexOf('db_save_posts')).toBeLessThan(order.indexOf('db_save_authors'));
    expect(workflow.edges).toContainEqual(expect.objectContaining({
      source: 'db_save_posts',
      target: 'db_save_authors',
    }));
    const reorderedWorkflow = {
      ...workflow,
      edges: [...workflow.edges].reverse(),
    };
    expect((WorkflowExecutorService as any).findSaveSourceNode(saveNode, reorderedWorkflow)?.id)
      .toBe('facebook_profile');

    const context = {
      executionId: 'facebook-post-author-provenance-contract',
      platform: workflow.platform,
      nodesExecuted: new Map<string, any>([
        ['facebook_posts', [{
          post_id: '123',
          url: sourcePostUrl,
          message: 'AI automation for enterprise contact centers',
          author: { url: 'https://www.facebook.com/example' },
        }]],
      ]),
      errors: [],
      logs: [],
      requestedLeadLimit: 1,
      persistedLeadCount: 0,
    };
    const executor = WorkflowExecutorService as any;
    const executeActorWithFallback = executor.executeActorWithFallback;
    const reconcileProviderDatasetOutcome = executor.reconcileProviderDatasetOutcome;
    const isExecutionCancelled = executor.isExecutionCancelled;
    executor.executeActorWithFallback = async () => [{
      facebookId: 'page-123',
      pageName: 'Example Page',
      facebookUrl: 'https://www.facebook.com/example',
      pageUrl: 'https://www.facebook.com/example',
    }];
    executor.reconcileProviderDatasetOutcome = async () => undefined;
    executor.isExecutionCancelled = async () => false;

    try {
      const minimalWorkflow = {
        ...workflow,
        nodes: workflow.nodes.filter((node: { id: string }) => ['facebook_post_search', 'facebook_profile'].includes(node.id)),
        edges: workflow.edges.filter((edge: { source: string; target: string }) => edge.source === 'facebook_post_search' && edge.target === 'facebook_profile'),
      };
      const results = await executor.executeActorNode(profileNode, context, {}, undefined, minimalWorkflow);
      expect(results).toEqual([expect.objectContaining({
        pageName: 'Example Page',
        postUrl: sourcePostUrl,
        sourcePostUrls: [sourcePostUrl],
        sourcePostText: 'AI automation for enterprise contact centers',
      })]);
      expect(executor.mapActorResultToLead(results[0], saveNode.data.field_mapping, { platform: workflow.platform }))
        .toMatchObject({
          name: 'Example Page',
          engagementType: 'post_author',
          postUrl: sourcePostUrl,
        });
    } finally {
      executor.executeActorWithFallback = executeActorWithFallback;
      executor.reconcileProviderDatasetOutcome = reconcileProviderDatasetOutcome;
      executor.isExecutionCancelled = isExecutionCancelled;
    }
  });

  it('skips a post whose nullable author URL cannot resolve to a Facebook page', async () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/facebook_post_authors.json'), 'utf8'));
    const profileNode = workflow.nodes.find((node: { id: string }) => node.id === 'facebook_profile');
    const context = {
      executionId: 'facebook-post-author-null-url-contract',
      platform: workflow.platform,
      nodesExecuted: new Map<string, any>([
        ['facebook_posts', [{ post_id: 'missing-author-url', url: 'https://www.facebook.com/example/posts/456', author: { url: null } }]],
      ]),
      errors: [],
      logs: [],
      requestedLeadLimit: 1,
      persistedLeadCount: 0,
    };
    const executor = WorkflowExecutorService as any;
    const executeActorWithFallback = executor.executeActorWithFallback;
    const isExecutionCancelled = executor.isExecutionCancelled;
    let providerCalls = 0;
    executor.executeActorWithFallback = async () => {
      providerCalls += 1;
      return [];
    };
    executor.isExecutionCancelled = async () => false;

    try {
      const result = await executor.executeActorNode(profileNode, context, {}, undefined, workflow);
      expect(result).toEqual([]);
      expect(providerCalls).toBe(0);
      expect(context.logs).toEqual(expect.arrayContaining([
        expect.stringContaining('must be a valid Facebook URL'),
      ]));
    } finally {
      executor.executeActorWithFallback = executeActorWithFallback;
      executor.isExecutionCancelled = isExecutionCancelled;
    }
  });

  it('maps current and legacy Facebook page shapes without polluting post media', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/facebook_post_authors.json'), 'utf8'));
    const postSave = workflow.nodes.find((node: { id: string }) => node.id === 'db_save_posts');
    const leadSave = workflow.nodes.find((node: { id: string }) => node.id === 'db_save_authors');
    expect(postSave.data.field_mapping).not.toHaveProperty('author_handle');
    expect(postSave.data.field_mapping).not.toHaveProperty('mediaUrls');

    const current = (WorkflowExecutorService as any).mapActorResultToLead({
      pageId: 'current-page-id',
      title: 'Current Page',
      url: 'https://www.facebook.com/current-page',
      profilePictureUrl: 'https://cdn.example/current.jpg',
      rating: '4.8',
    }, leadSave.data.field_mapping, { platform: workflow.platform });
    expect(current).toMatchObject({
      profileId: 'current-page-id',
      name: 'Current Page',
      companyName: 'Current Page',
      facebookUrl: 'https://www.facebook.com/current-page',
      profileUrl: 'https://www.facebook.com/current-page',
      profilePicture: 'https://cdn.example/current.jpg',
      rating: 4.8,
    });

    const legacy = (WorkflowExecutorService as any).mapActorResultToLead({
      facebookId: 'legacy-page-id',
      pageName: 'Legacy Page',
      pageUrl: 'https://www.facebook.com/legacy-page',
      profilePhoto: 'https://cdn.example/legacy.jpg',
      ratingOverall: 4.2,
    }, leadSave.data.field_mapping, { platform: workflow.platform });
    expect(legacy).toMatchObject({
      profileId: 'legacy-page-id',
      name: 'Legacy Page',
      companyName: 'Legacy Page',
      profileUrl: 'https://www.facebook.com/legacy-page',
      profilePicture: 'https://cdn.example/legacy.jpg',
      rating: 4.2,
    });
  });
});
