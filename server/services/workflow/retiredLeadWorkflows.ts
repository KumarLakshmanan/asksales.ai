/** Retired built-in strategies are archived, never silently replaced or re-executed. */
export const RETIRED_LEAD_WORKFLOW_IDS = new Set([
  'linkedin_company_employees_posts',
  'linkedin_profile_activity',
  'linkedin_profile_enriched',
  'linkedin_profile_posts',
  'linkedin_company_posts',
  'facebook_page_posts',
  'instagram_profile_posts',
  'twitter_user_tweets',
  'facebook_post_search',
  'instagram_post_search',
  'twitter_post_search',
  'instagram_hashtag_followers',
  'facebook_b2c',
  'instagram_b2c',
  'twitter_b2c',
  'instagram_post_authors_engagers',
  'yelp_b2b',
]);

export function assertLeadActorAvailable(actorId: string): void {
  const normalizedActorId = actorId.trim().toLowerCase().replace('~', '/');
  if (normalizedActorId === 'datascrapers/yelp-scraper') {
    throw new Error('Yelp lead generation has been removed. Choose and approve an available platform; existing results are preserved.');
  }
  if (normalizedActorId === 'outspoken_strategy/facebook-post-search-scraper') {
    throw new Error('The previous Facebook search provider is unavailable. Regenerate and approve current Facebook search settings before retrying; existing results are preserved.');
  }
}

export function assertLeadWorkflowAvailable(workflow: {
  workflow_id: string;
  platform?: string;
  retired?: boolean;
  nodes?: Array<{ data: { actorId?: string } }>;
}): void {
  if (workflow.retired || RETIRED_LEAD_WORKFLOW_IDS.has(workflow.workflow_id)
    || /^yelp(?:_|$)/i.test((workflow.platform || '').trim())
    || /^yelp(?:_|$)/i.test(workflow.workflow_id.trim())) {
    throw new Error('This lead workflow has been retired. Choose and approve an available strategy; existing results are preserved.');
  }
  for (const node of workflow.nodes || []) {
    if (node.data.actorId) assertLeadActorAvailable(node.data.actorId);
  }
}
