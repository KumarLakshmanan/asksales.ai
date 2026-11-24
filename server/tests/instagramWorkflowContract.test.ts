import fs from 'node:fs';
import path from 'node:path';
import { WorkflowExecutorService } from '../services/WorkflowExecutorService.js';
import { shouldApplyPostProviderRelevanceValidation } from '../services/lead-generation/LeadGenerationQualityService.js';

describe('Instagram lead workflow contracts', () => {
  it('keeps an exact reviewed competitor username authoritative and maps the current profile shape', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/instagram_competitor_profiles.json'), 'utf8'));
    const mapping = workflow.nodes.find((node: { type: string }) => node.type === 'saveToLeads').data.field_mapping;
    const actorId = workflow.nodes.find((node: { type: string }) => node.type === 'actor').data.actorId;

    expect(shouldApplyPostProviderRelevanceValidation(workflow.platform, actorId)).toBe(false);

    const result = (WorkflowExecutorService as any).mapActorResultToLead({
      id: '12180963',
      username: 'hubspot',
      fullName: 'HubSpot',
      biography: 'The agentic customer platform to scale your business.',
      externalUrl: 'https://linktr.ee/hubspotofficial',
      followersCount: 657793,
      followsCount: 68,
      businessCategoryName: 'None',
      verified: true,
      profilePicUrl: 'https://example.com/hubspot.jpg',
    }, mapping, { platform: workflow.platform });

    expect(result).toMatchObject({
      name: 'HubSpot',
      fullName: 'HubSpot',
      instagramHandle: 'hubspot',
      instagramUrl: 'https://instagram.com/hubspot',
      profileUrl: 'https://instagram.com/hubspot',
      bio: 'The agentic customer platform to scale your business.',
      website: 'https://linktr.ee/hubspotofficial',
      followersCount: 657793,
      followingCount: 68,
      verified: true,
      profilePicture: 'https://example.com/hubspot.jpg',
    });
    expect(result.categories).toBeNull();
    expect(result.email).toBeNull();
    expect(result.phone).toBeNull();
  });

  it('binds post-author discovery to the exact actors and saves the source post before its author', () => {
    const authorWorkflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/instagram_post_authors.json'), 'utf8'));
    const hashtagActorMetadata = JSON.parse(fs.readFileSync(path.resolve('data/actors/apify-instagram-hashtag-scraper.json'), 'utf8'));
    const profileActorMetadata = JSON.parse(fs.readFileSync(path.resolve('data/actors/apify-instagram-profile-scraper.json'), 'utf8'));
    const hashtagNode = authorWorkflow.nodes.find((node: { id: string }) => node.id === 'instagram_hashtag_search');
    const profileNode = authorWorkflow.nodes.find((node: { id: string }) => node.id === 'instagram_author_profiles');
    const saveNode = authorWorkflow.nodes.find((node: { id: string }) => node.id === 'db_save_authors');
    const order = (WorkflowExecutorService as any).getExecutionOrder(authorWorkflow);

    expect(hashtagNode.data.actorId).toBe('apify/instagram-hashtag-scraper');
    expect(hashtagNode.data.inputMapping).toEqual({ hashtags: '{{hashtags}}', resultsLimit: '{{resultsLimit}}', keywordSearch: '{{keywordSearch}}' });
    expect(hashtagNode.data.finalValues).toEqual({ resultsType: 'posts' });
    expect(hashtagActorMetadata.inputSchema.required).toContain('hashtags');
    expect(hashtagActorMetadata.inputSchema.properties.resultsLimit.minimum).toBe(1);

    expect(profileNode.data.actorId).toBe('apify/instagram-profile-scraper');
    expect(profileNode.data.batch_collect).toEqual({ enabled: true, source_field: 'ownerUsername', target_field: 'usernames' });
    expect(profileActorMetadata.inputSchema.required).toContain('usernames');
    expect(authorWorkflow.edges).toContainEqual(expect.objectContaining({
      source: 'db_save_posts', target: 'db_save_authors',
    }));
    expect(order.indexOf('instagram_hashtag_search')).toBeLessThan(order.indexOf('db_save_posts'));
    expect(order.indexOf('db_save_posts')).toBeLessThan(order.indexOf('db_save_authors'));

    const result = (WorkflowExecutorService as any).mapActorResultToLead({
      id: 'profile-1',
      username: 'cstueber',
      fullName: 'Craig Stueber',
      biography: 'AI creator',
      profilePicUrl: 'https://example.com/craig.jpg',
      followersCount: 19,
      followsCount: 40,
      postsCount: 2,
      verified: false,
      postUrl: 'https://www.instagram.com/p/source-post/',
    }, saveNode.data.field_mapping, { platform: authorWorkflow.platform, promptId: 154 });

    expect(result).toMatchObject({
      promptId: 154,
      name: 'Craig Stueber',
      instagramHandle: 'cstueber',
      instagramUrl: 'https://instagram.com/cstueber',
      profileUrl: 'https://instagram.com/cstueber',
      postUrl: 'https://www.instagram.com/p/source-post/',
      engagementType: 'author',
      followersCount: 19,
      followingCount: 40,
      postsCount: 2,
      verified: false,
    });
    expect(result.email).toBeNull();
    expect(result.phone).toBeNull();
  });

  it.each([
    ['instagram_post_authors_commenters.json', 'instagram_commenter_profiles', 'db_save_commenters'],
    ['instagram_post_authors_likers.json', 'instagram_liker_profiles', 'db_save_likers'],
  ])('removes the unused author lookup and orders post persistence before derived lead persistence in %s', (file, profileNodeId, saveNodeId) => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve(`data/workflows/${file}`), 'utf8'));
    const saveNode = workflow.nodes.find((node: { id: string }) => node.id === saveNodeId);
    const order = (WorkflowExecutorService as any).getExecutionOrder(workflow);

    expect(workflow.nodes.some((node: { id: string }) => node.id === 'instagram_author_profiles')).toBe(false);
    expect(workflow.edges).toContainEqual(expect.objectContaining({
      source: 'db_save_posts', target: saveNodeId,
    }));
    expect(order.indexOf('db_save_posts')).toBeLessThan(order.indexOf(profileNodeId));
    expect(order.indexOf(profileNodeId)).toBeLessThan(order.indexOf(saveNodeId));
    expect(saveNode.data.field_mapping.postUrl).toBe('postUrl');
  });

  it('uses the current official comment actor contract and commenter identity shape', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/instagram_post_authors_commenters.json'), 'utf8'));
    const actorMetadata = JSON.parse(fs.readFileSync(path.resolve('data/actors/apify-instagram-comment-scraper.json'), 'utf8'));
    const commentsNode = workflow.nodes.find((node: { id: string }) => node.id === 'instagram_comments');
    const profilesNode = workflow.nodes.find((node: { id: string }) => node.id === 'instagram_commenter_profiles');
    const saveNode = workflow.nodes.find((node: { id: string }) => node.id === 'db_save_commenters');

    expect(commentsNode.data.actorId).toBe('apify/instagram-comment-scraper');
    expect(commentsNode.data.inputMapping).toEqual({
      directUrls: ['{_current_item.url}'],
      resultsLimit: 20,
    });
    expect(actorMetadata.inputSchema.required).toEqual(['directUrls']);
    expect(actorMetadata.inputSchema.properties.resultsLimit.minimum).toBe(1);
    expect(profilesNode.data.batch_collect).toEqual({
      enabled: true,
      source_field: 'ownerUsername',
      target_field: 'usernames',
    });
    expect((WorkflowExecutorService as any).mapActorResultToLead({
      id: 'commenter-profile-1',
      username: 'first_commenter',
      fullName: 'First Commenter',
      postUrl: 'https://www.instagram.com/p/source-one/',
    }, saveNode.data.field_mapping, { platform: workflow.platform })).toMatchObject({
      instagramHandle: 'first_commenter',
      engagementType: 'commenter',
      postUrl: 'https://www.instagram.com/p/source-one/',
    });
  });

  it('uses the current post-liker actor contract and flat liker identity shape', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/instagram_post_authors_likers.json'), 'utf8'));
    const actorMetadata = JSON.parse(fs.readFileSync(path.resolve('data/actors/seemuapps-instagram-post-likers-scraper.json'), 'utf8'));
    const likesNode = workflow.nodes.find((node: { id: string }) => node.id === 'instagram_likes');
    const profilesNode = workflow.nodes.find((node: { id: string }) => node.id === 'instagram_liker_profiles');
    const saveNode = workflow.nodes.find((node: { id: string }) => node.id === 'db_save_likers');

    expect(likesNode.data.actorId).toBe('seemuapps/instagram-post-likers-scraper');
    expect(likesNode.data.inputMapping).toEqual({
      post: '{_current_item.url}',
      maxItems: 20,
    });
    expect(actorMetadata.inputSchema.required).toEqual(['post']);
    expect(actorMetadata.inputSchema.properties.maxItems.minimum).toBe(0);
    expect(profilesNode.data.batch_collect).toEqual({
      enabled: true,
      source_field: 'username',
      target_field: 'usernames',
    });
    expect((WorkflowExecutorService as any).mapActorResultToLead({
      id: 'liker-profile-1',
      username: 'first_liker',
      fullName: 'First Liker',
      postUrl: 'https://www.instagram.com/p/source-one/',
    }, saveNode.data.field_mapping, { platform: workflow.platform })).toMatchObject({
      instagramHandle: 'first_liker',
      engagementType: 'liker',
      postUrl: 'https://www.instagram.com/p/source-one/',
    });
  });

  it('caps a post-liker provider call and carries the source post through profile enrichment', async () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/instagram_post_authors_likers.json'), 'utf8'));
    const likesNode = workflow.nodes.find((candidate: { id: string }) => candidate.id === 'instagram_likes');
    const profilesNode = workflow.nodes.find((candidate: { id: string }) => candidate.id === 'instagram_liker_profiles');
    const sourcePostUrl = 'https://www.instagram.com/p/source-liked-post/';
    const context = {
      executionId: 'instagram-liker-iteration-contract',
      platform: workflow.platform,
      nodesExecuted: new Map<string, any>([
        ['instagram_posts', [{ url: sourcePostUrl, ownerUsername: 'source_author' }]],
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
    let capturedInput: Record<string, any> | undefined;
    let providerCalls = 0;
    executor.executeActorWithFallback = async (_userId: unknown, _actorId: unknown, actorInput: Record<string, any>) => {
      providerCalls += 1;
      capturedInput = actorInput;
      return [{ username: 'first_liker', postUrl: sourcePostUrl }];
    };
    executor.reconcileProviderDatasetOutcome = async () => undefined;
    executor.isExecutionCancelled = async () => false;

    try {
      const likerResults = await executor.executeActorNode(likesNode, context, {}, undefined, workflow);
      expect(providerCalls).toBe(1);
      expect(capturedInput).toEqual({ post: sourcePostUrl, maxItems: 1 });
      expect(likerResults).toEqual([expect.objectContaining({
        username: 'first_liker',
        postUrl: sourcePostUrl,
      })]);

      context.nodesExecuted.set('instagram_likes', likerResults);
      capturedInput = undefined;
      executor.executeActorWithFallback = async (_userId: unknown, _actorId: unknown, actorInput: Record<string, any>) => {
        capturedInput = actorInput;
        return [{ username: actorInput.usernames[0], fullName: 'First Liker' }];
      };
      const profileResults = await executor.executeActorNodeBatched(
        profilesNode,
        context,
        {},
        undefined,
        workflow,
        likerResults,
      );
      expect(capturedInput).toEqual({ usernames: ['first_liker'] });
      expect(profileResults).toEqual([expect.objectContaining({
        username: 'first_liker',
        postUrl: sourcePostUrl,
        sourcePostUrls: [sourcePostUrl],
      })]);
    } finally {
      executor.executeActorWithFallback = executeActorWithFallback;
      executor.reconcileProviderDatasetOutcome = reconcileProviderDatasetOutcome;
      executor.isExecutionCancelled = isExecutionCancelled;
    }
  });

  it('does not count a persisted source post as a persisted lead', () => {
    const context = {
      persistedLeadCount: 0,
      nodesExecuted: new Map([
        ['db_save_results', { saved: 1, postsCount: 1, leadsCount: 0, leadIds: [] }],
      ]),
    };

    expect((WorkflowExecutorService as any).getPersistedLeadCount(context)).toBe(0);
  });

  it('uses the provider minimum for the author-follower stage while leaving the save cap independent', () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/instagram_post_authors_followers.json'), 'utf8'));
    const actorMetadata = JSON.parse(fs.readFileSync(path.resolve('data/actors/datadoping-instagram-followers-scraper.json'), 'utf8'));
    const followerNode = workflow.nodes.find((node: { id: string }) => node.id === 'instagram_followers');
    const saveNode = workflow.nodes.find((node: { id: string }) => node.id === 'db_save_followers');
    const order = (WorkflowExecutorService as any).getExecutionOrder(workflow);

    expect(followerNode.data.actorId).toBe('datadoping/instagram-followers-scraper');
    expect(followerNode.data.inputMapping.max_count)
      .toBeGreaterThanOrEqual(actorMetadata.inputSchema.properties.max_count.minimum);
    expect(followerNode.data.inputMapping.max_count).toBe(50);
    expect(workflow.nodes.some((node: { id: string }) => node.id === 'db_save_authors')).toBe(false);
    expect(workflow.nodes.some((node: { id: string }) => node.id === 'db_save_posts')).toBe(true);
    expect(workflow.edges).toContainEqual(expect.objectContaining({
      source: 'db_save_posts', target: 'db_save_followers',
    }));
    expect(order.indexOf('db_save_posts')).toBeLessThan(order.indexOf('db_save_followers'));
    expect(saveNode.data.field_mapping.postUrl).toBe('postUrl');
  });

  it('carries the source post through each iterative follower result', async () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/instagram_post_authors_followers.json'), 'utf8'));
    const node = workflow.nodes.find((candidate: { id: string }) => candidate.id === 'instagram_followers');
    const sourcePostUrl = 'https://www.instagram.com/p/source-author-post/';
    const context = {
      executionId: 'instagram-follower-iteration-contract',
      platform: workflow.platform,
      nodesExecuted: new Map<string, any>([
        ['instagram_author_profiles', [
          { username: 'source_author', postUrl: sourcePostUrl },
          { username: 'second_author', postUrl: 'https://www.instagram.com/p/unused-post/' },
        ]],
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
    let capturedInput: Record<string, any> | undefined;
    let providerCalls = 0;
    executor.executeActorWithFallback = async (_userId: unknown, _actorId: unknown, actorInput: Record<string, any>) => {
      providerCalls += 1;
      capturedInput = actorInput;
      return [{ username: 'one_follower', follower_of: 'source_author' }];
    };
    executor.reconcileProviderDatasetOutcome = async () => undefined;
    executor.isExecutionCancelled = async () => false;

    try {
      const results = await executor.executeActorNode(node, context, {}, undefined, workflow);
      expect(providerCalls).toBe(1);
      expect(capturedInput).toEqual({ usernames: ['source_author'], max_count: 50 });
      expect(results).toEqual([expect.objectContaining({
        username: 'one_follower',
        postUrl: sourcePostUrl,
        sourcePostUrls: [sourcePostUrl],
      })]);
    } finally {
      executor.executeActorWithFallback = executeActorWithFallback;
      executor.reconcileProviderDatasetOutcome = reconcileProviderDatasetOutcome;
      executor.isExecutionCancelled = isExecutionCancelled;
    }
  });

  it('caps batched profile enrichment and carries its originating post URL onto the returned profile', async () => {
    const workflow = JSON.parse(fs.readFileSync(path.resolve('data/workflows/instagram_post_authors_commenters.json'), 'utf8'));
    const node = workflow.nodes.find((candidate: { id: string }) => candidate.id === 'instagram_commenter_profiles');
    const context = {
      executionId: 'instagram-batch-contract',
      platform: workflow.platform,
      nodesExecuted: new Map<string, any>(),
      errors: [],
      logs: [],
      requestedLeadLimit: 1,
      persistedLeadCount: 0,
    };
    const items = [
      { ownerUsername: 'first_commenter', postUrl: 'https://www.instagram.com/p/source-one/' },
      { ownerUsername: 'second_commenter', postUrl: 'https://www.instagram.com/p/source-two/' },
    ];
    const executor = WorkflowExecutorService as any;
    const executeActorWithFallback = executor.executeActorWithFallback;
    const reconcileProviderDatasetOutcome = executor.reconcileProviderDatasetOutcome;
    let capturedInput: Record<string, any> | undefined;
    executor.executeActorWithFallback = async (_userId: unknown, _actorId: unknown, actorInput: Record<string, any>) => {
      capturedInput = actorInput;
      return [{ username: actorInput.usernames[0], fullName: 'First Commenter' }];
    };
    executor.reconcileProviderDatasetOutcome = async () => undefined;

    try {
      const results = await executor.executeActorNodeBatched(node, context, {}, undefined, workflow, items);
      expect(capturedInput).toEqual({ usernames: ['first_commenter'] });
      expect(results).toEqual([expect.objectContaining({
        username: 'first_commenter',
        postUrl: 'https://www.instagram.com/p/source-one/',
        sourcePostUrls: ['https://www.instagram.com/p/source-one/'],
      })]);
    } finally {
      executor.executeActorWithFallback = executeActorWithFallback;
      executor.reconcileProviderDatasetOutcome = reconcileProviderDatasetOutcome;
    }
  });
});
