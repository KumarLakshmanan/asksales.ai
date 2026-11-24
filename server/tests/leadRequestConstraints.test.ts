import {
  applyProviderMinimumFetchLimits,
  applyLeadIntentToFallbackInputs,
  preserveGeneratedLeadInputs,
  applyRequestedLeadLimit,
  applyRequestedLeadLimitToBatch,
  applyFacebookCompetitorPageUrls,
  FacebookCompetitorPageUrlsRequiredError,
  extractExplicitTargetLocation,
  extractRequestedLeadLimit,
  resolveLeadLimitRequirements,
  resolveWorkflowRecommendationRequirements,
  resolveOriginalLeadInputRequest,
} from '../mastra/tools/executors/leadRequestConstraints.js';
import { applyExplicitEnumRequirements, applyExplicitTypedRequirements } from '../mastra/tools/executors/leadExecutor.js';
import { generateLeadInputsInputSchema } from '../mastra/tools/leadTools.js';

describe('lead generation review constraints', () => {
  it('uses the model-resolved cap rather than an English number in historical prose', () => {
    const entries = [{ inputs: { maxItems: 50 } }];
    expect(applyRequestedLeadLimitToBatch(entries, 'The old request was 99 leads.', 3))
      .toEqual([{ inputs: { maxItems: 3 }, requestedLeadLimit: 3, requestedLeadTotal: 3 }]);
    expect(applyRequestedLeadLimitToBatch(entries, 'The old request was 99 leads.', null)).toEqual(entries);
  });
  it('preserves exact Facebook competitor page URLs and fixes the follower-only relation', () => {
    expect(applyFacebookCompetitorPageUrls(
      { query: 'HubSpot software', startUrls: [{ url: 'https://www.facebook.com/LeonardoDiCaprio' }] },
      'facebook_competitor_pages',
      'Find Facebook Competitor Page Followers for https://www.facebook.com/hubspot and https://www.facebook.com/salesforce.',
    )).toEqual({
      query: 'HubSpot software',
      startUrls: [
        { url: 'https://www.facebook.com/hubspot' },
        { url: 'https://www.facebook.com/salesforce' },
      ],
      followType: 'follower',
    });
  });

  it('refuses to use the Facebook actor demo URL when the user supplied no competitor page URL', () => {
    expect(() => applyFacebookCompetitorPageUrls(
      { startUrls: [{ url: 'https://www.facebook.com/LeonardoDiCaprio' }] },
      'facebook_competitor_pages',
      'Prepare Facebook Competitor Page Followers settings for review, max 5 results.',
    )).toThrow(FacebookCompetitorPageUrlsRequiredError);
  });

  it('sets a requested provider limit even when the model omitted the optional actor field', () => {
    expect(applyRequestedLeadLimit(
      { startUrls: [{ url: 'https://www.facebook.com/hubspot' }] },
      'Prepare settings with max 5 results.',
      { resultsLimit: { type: 'integer' } },
    )).toEqual({ startUrls: [{ url: 'https://www.facebook.com/hubspot' }], resultsLimit: 5 });
  });

  it('keeps explicit empty fields from the original request through an app strategy choice', () => {
    const original = 'Use companies ["example"], searchQuery "", locations [], jobTitles ["Business Development"]';
    const requirements = resolveOriginalLeadInputRequest('Find business development employees', [
      { role: 'user', content: original },
      { role: 'assistant', content: 'Choose a strategy.' },
      { role: 'user', content: 'Show me all available strategies for each channel' },
      { role: 'user', content: 'Use LinkedIn Company Employee Posts and prepare the search settings for my review.' },
    ]);
    expect(requirements).toBe(original);
    expect(applyExplicitEnumRequirements({ searchQuery: 'Business Development', locations: ['Bengaluru'] }, {
      searchQuery: { type: 'string' }, locations: { type: 'array' },
    }, requirements)).toEqual({ searchQuery: '', locations: [] });
  });

  it('never reaches past a newer substantive request to restore stale empty fields', () => {
    expect(resolveOriginalLeadInputRequest('tool paraphrase', [
      { role: 'user', content: 'searchQuery ""' },
      { role: 'user', content: 'Find sales directors in Mumbai instead.' },
      { role: 'user', content: 'Prepare search settings for the selected strategy for my review only. Do not approve or execute a search.' },
    ])).toBe('Find sales directors in Mumbai instead.');
  });
  it('keeps an exact strategy title when a model tool-call summary omits it', () => {
    const original = 'Use only LinkedIn Post Reactors by Profile. Find exactly one profile for Lenny Rachitsky.';
    const requirements = resolveWorkflowRecommendationRequirements(
      'Find 1 LinkedIn profile, inspect 1 recent post, and extract 1 reactor.',
      [{ role: 'user', content: original }],
    );
    expect(requirements).toContain(original);
    expect(requirements).toContain('extract 1 reactor');
  });
  it('looks past a strategy-only retry that explicitly preserves the unchanged request', () => {
    const original = 'Use Lenny Rachitsky, locations [], profileScraperMode "Full", and global cap 1.';
    expect(resolveOriginalLeadInputRequest('tool summary', [
      { role: 'user', content: original },
      { role: 'user', content: 'Recommend the strategy again for my unchanged request. Use only LinkedIn Post Reactors by Profile.' },
      { role: 'user', content: 'Use LinkedIn Post Reactors by Profile and prepare the search settings for my review.' },
    ])).toBe(original);
  });
  it('looks past an ICP retry that refers to prior constraints without restating them', () => {
    const original = 'Use startUrls [{"url":"https://www.facebook.com/LeonardoDiCaprio"}], resultsLimit 1, followType "follower", and global cap 1.';
    const requirements = resolveOriginalLeadInputRequest('tool summary', [
      { role: 'user', content: original },
      { role: 'user', content: 'Retry creating the ICP profile for this same Facebook Competitor Page Followers request. Keep every exact constraint from my prior message. Do not generate lead inputs, approve, or execute anything until the ICP is ready for my review.' },
      { role: 'user', content: 'Prepare search settings for the selected strategy for my review only. Do not approve or execute a search.' },
    ]);

    expect(requirements).toBe(original);
    expect(applyExplicitTypedRequirements(
      { startUrls: [{ url: 'https://www.google.com/maps/search/AI' }], resultsLimit: 20 },
      { startUrls: { type: 'array' }, resultsLimit: { type: 'integer' } },
      requirements,
    )).toEqual({
      startUrls: [{ url: 'https://www.facebook.com/LeonardoDiCaprio' }],
      resultsLimit: 1,
    });
  });
  it('retains the current human cap when a tool summary omits or changes it', () => {
    const history = [{ role: 'user', content: 'Use startUrls only, maxItems 1, global cap 1.' }];
    expect(extractRequestedLeadLimit(resolveLeadLimitRequirements('Generate 20 leads.', history))).toBe(1);
  });
  it.each([
    'Set a global saved-lead cap of exactly 1 across the full workflow.',
    'Use global saved lead cap 1.',
    'Set the global requested lead total to exactly 1 across the full workflow.',
  ])('recognizes the user-facing global-cap wording: %s', requirements => {
    expect(extractRequestedLeadLimit(requirements)).toBe(1);
  });
  it('preserves the original global cap through catalog and strategy-selection controls', () => {
    const history = [
      { role: 'user', content: 'Search Zoho, maxItems 1, global cap 1.' },
      { role: 'user', content: 'Show me all available strategies for each channel' },
      { role: 'user', content: 'Prepare search settings for the selected strategy for my review only. Do not approve or execute a search.' },
    ];
    const requirements = resolveLeadLimitRequirements('Search Zoho with maxItems 1', history);
    expect(extractRequestedLeadLimit(requirements)).toBe(1);
    expect(applyRequestedLeadLimitToBatch([{ platform: 'linkedin_company_search', inputs: { maxItems: 20 } }], requirements))
      .toEqual([expect.objectContaining({ inputs: { maxItems: 1 }, requestedLeadLimit: 1, requestedLeadTotal: 1 })]);
  });

  it.each([
    'Regenerate the reviewed lead inputs using only instagram_post_authors_commenters. Keep the same ICP, geography, and industry targeting, enforce a global cap of exactly 1 leads across all selected providers, and show the exact provider parameters for review before execution.',
    'Regenerate the reviewed lead inputs using only instagram_post_authors_commenters. Keep the same ICP, geography, and industry targeting, enforce a global cap of exactly 1 leads, and show the exact provider parameters for review before execution.',
    'Regenerate the reviewed lead inputs using only instagram_post_authors_commenters. Reuse the same ICP, geography, industry, and provider-specific targeting, enforce a global cap of exactly 1 lead, and show the exact provider parameters for review. Do not execute yet, substitute a broad provider, or create duplicate leads.',
    'Prepare search settings for the selected strategy for my review only. Do not approve or execute a search.\nRegenerate the reviewed lead inputs using only instagram_post_authors_commenters. Keep the same ICP, geography, and industry targeting, enforce a global cap of exactly 1 leads across all selected providers, and show the exact provider parameters for review before execution.',
  ])('looks past an app Lead Inputs regeneration control: %s', regenerateControl => {
    const original = 'Use hashtags ["digitalmarketing"], resultsLimit 1, resultsType "posts", and keywordSearch false.';
    const requirements = resolveOriginalLeadInputRequest('tool summary', [
      { role: 'user', content: original },
      { role: 'user', content: regenerateControl },
    ]);

    expect(requirements).toBe(original);
    expect(applyExplicitTypedRequirements(
      { hashtags: ['enterpriseaiautomationglobal'], resultsLimit: 20 },
      { hashtags: { type: 'array' }, resultsLimit: { type: 'integer' } },
      requirements,
    )).toEqual({ hashtags: ['digitalmarketing'], resultsLimit: 1 });
  });

  it('keeps a genuinely new regenerate request that changes a reviewed field', () => {
    const revised = 'Regenerate the reviewed lead inputs using only instagram_post_authors_commenters, but change hashtags to ["saasmarketing"].';
    expect(resolveOriginalLeadInputRequest('tool summary', [
      { role: 'user', content: 'Use hashtags ["digitalmarketing"].' },
      { role: 'user', content: revised },
    ])).toBe(revised);
  });

  it('does not skip a newer request merely because it says to change the original workflow request', () => {
    const revised = 'Please use the same original request but change hashtags ["saasfounders"], resultsLimit 7, and keywordSearch true; use workflow instagram_post_authors_commenters.';
    expect(resolveOriginalLeadInputRequest('tool summary', [
      { role: 'user', content: 'Use hashtags ["digitalmarketing"], resultsLimit 1, and keywordSearch false.' },
      { role: 'user', content: revised },
    ])).toBe(revised);
  });

  it.each([
    'Use the same original request but set hashtags ["saasfounders"]; use workflow instagram_post_authors_commenters.',
    'Use the same original request and add hashtags ["saasfounders"]; use workflow instagram_post_authors_commenters.',
    'Use the same original request with hashtags ["saasfounders"]; use workflow instagram_post_authors_commenters.',
    'Use the same original request; hashtags: ["saasfounders"], resultsLimit: 7; use workflow instagram_post_authors_commenters.',
  ])('keeps a newer same-request message when it contains an explicit field revision: %s', revised => {
    expect(resolveOriginalLeadInputRequest('tool summary', [
      { role: 'user', content: 'Use hashtags ["digitalmarketing"], resultsLimit 1.' },
      { role: 'user', content: revised },
    ])).toBe(revised);
  });

  it('does not recover an obsolete cap from older conversation messages', () => {
    expect(resolveLeadLimitRequirements('Generate 3 leads', [
      { role: 'user', content: 'Generate 1 lead' },
      { role: 'user', content: 'Prepare the updated settings' },
    ])).toBe('Generate 3 leads');
  });
  it('preserves distinct generated hotel and resort queries instead of applying the ICP fallback', () => {
    const entries = [
      { query: 'luxury hotels Hyderabad', maxResults: 20 },
      { query: 'luxury resorts Hyderabad', maxResults: 20 },
    ];
    expect(entries.map(entry => preserveGeneratedLeadInputs(entry))).toEqual(entries);
  });

  it.each(['Hyderabad', '109355775757758'])('omits unverified provider location UID %s', location_uid => {
    expect(preserveGeneratedLeadInputs({ query: 'hotels Hyderabad', location_uid }, 'Find hotels around Hyderabad'))
      .toEqual({ query: 'hotels Hyderabad' });
  });

  it('preserves an explicitly supplied provider location UID', () => {
    expect(preserveGeneratedLeadInputs({ query: 'hotels Hyderabad', location_uid: 'Hyderabad' }, 'Use location UID: 123456'))
      .toEqual({ query: 'hotels Hyderabad', location_uid: '123456' });
  });

  it('does not append a duplicate city in fallback queries', () => {
    expect(applyLeadIntentToFallbackInputs({ query: 'demo' }, { query: '{{query}}' }, {
      targetAudience: 'Luxury hotels and resorts in Hyderabad', primaryRegions: ['Hyderabad'],
    }).query).toBe('Luxury hotels and resorts in Hyderabad');
  });

  it('preserves an explicitly reviewed provider enum choice', () => {
    expect(applyExplicitEnumRequirements(
      { query: 'boutique hotels Bengaluru', searchType: 'Top', maxResults: 15 },
      {
        searchType: {
          title: 'Search Type',
          type: 'string',
          enum: ['Top', 'Latest', 'Media', 'People', 'Lists'],
          default: 'Top',
        },
      },
      "Use Twitter Keyword Search with search type People and a one-lead cap.",
    )).toEqual({ query: 'boutique hotels Bengaluru', searchType: 'People', maxResults: 15 });
  });

  it('does not infer enum approval from an unrelated value mention', () => {
    expect(applyExplicitEnumRequirements(
      { searchType: 'Top' },
      { searchType: { title: 'Search Type', enum: ['Top', 'People'] } },
      'Find people who operate boutique hotels.',
    )).toEqual({ searchType: 'Top' });
  });

  it.each(['Full', 'Full + email search'])('preserves explicit camelCase scraper mode %s', mode => {
    expect(applyExplicitEnumRequirements(
      { profileScraperMode: 'Short' },
      { profileScraperMode: { title: 'Profile Scraper Mode', enum: ['Short', 'Full', 'Full + email search'] } },
      `Keep profileScraperMode ${mode}.`,
    ).profileScraperMode).toBe(mode);
  });

  it('restores explicitly labelled Instagram fields from the authoritative request', () => {
    const original = 'Use hashtags ["digitalmarketing"], resultsLimit 1, resultsType "posts", and keywordSearch false.';
    const requirements = resolveOriginalLeadInputRequest('tool summary', [
      { role: 'user', content: original },
      { role: 'user', content: 'Prepare search settings for the selected strategy for my review only. Do not approve or execute a search.' },
    ]);
    const schema = {
      hashtags: { type: 'array' },
      resultsLimit: { type: 'integer' },
      resultsType: { type: 'string', enum: ['posts', 'reels'] },
      keywordSearch: { type: 'boolean' },
    };
    const typed = applyExplicitTypedRequirements({
      hashtags: ['enterpriseaiautomationglobal'],
      resultsLimit: 20,
      resultsType: 'reels',
      keywordSearch: true,
    }, schema, requirements);

    expect(applyExplicitEnumRequirements(typed, schema, requirements)).toEqual({
      hashtags: ['digitalmarketing'],
      resultsLimit: 1,
      resultsType: 'posts',
      keywordSearch: false,
    });
  });

  it('preserves exact reviewed Instagram usernames without copying unsupported fields', () => {
    const requirements = 'usernames: ["hubspot", "salesforce"], hashtags: ["ignored"], includeAboutSection true';
    expect(applyExplicitTypedRequirements(
      { usernames: ['wrong'], includeAboutSection: false },
      { usernames: { type: 'array' }, includeAboutSection: { type: 'boolean' } },
      requirements,
    )).toEqual({ usernames: ['hubspot', 'salesforce'], includeAboutSection: true });
  });

  it('preserves an explicitly quoted free-text actor field without treating surrounding prose as a value', () => {
    expect(applyExplicitTypedRequirements(
      { query: 'generated broad query', maxResults: 20, recent_posts: false },
      {
        query: { type: 'string' },
        maxResults: { type: 'integer' },
        recent_posts: { type: 'boolean' },
      },
      'Use exactly query "customer experience AI", maxResults 10, and recent_posts true.',
    )).toEqual({
      query: 'customer experience AI',
      maxResults: 10,
      recent_posts: true,
    });
    expect(applyExplicitTypedRequirements(
      { query: 'generated query' },
      { query: { type: 'string' } },
      'Find people discussing customer experience AI and keep the query focused.',
    )).toEqual({ query: 'generated query' });
  });

  it('skips the app-authored lead-agent hiring turn when resolving exact reviewed fields', () => {
    const original = 'Use only Facebook Post Likers. The eventual reviewed provider settings must use exactly query "enterprise AI automation", maxResults 10, recent_posts true, and global cap 1.';
    const history = [
      { role: 'user', content: original },
      { role: 'user', content: 'Hire Marcus for lead generation' },
      { role: 'user', content: 'Prepare search settings for the selected strategy for my review only. Do not approve or execute a search.' },
    ];
    expect(resolveOriginalLeadInputRequest('generated summary', history)).toBe(original);
    expect(applyExplicitTypedRequirements(
      { query: 'Enterprise AI Automation Global', maxResults: 10, recent_posts: true },
      {
        query: { type: 'string' },
        maxResults: { type: 'integer' },
        recent_posts: { type: 'boolean' },
      },
      resolveOriginalLeadInputRequest('generated summary', history),
    )).toEqual({
      query: 'enterprise AI automation',
      maxResults: 10,
      recent_posts: true,
    });
  });

  it('does not treat unrelated prose as an explicit typed actor value', () => {
    expect(applyExplicitTypedRequirements(
      { hashtags: ['generated'], resultsLimit: 20, keywordSearch: false },
      { hashtags: { type: 'array' }, resultsLimit: { type: 'integer' }, keywordSearch: { type: 'boolean' } },
      'Find people discussing two digital marketing topics and keep the search focused.',
    )).toEqual({ hashtags: ['generated'], resultsLimit: 20, keywordSearch: false });
  });

  it('requires an explicit reviewed platform or workflow', () => {
    expect(() => generateLeadInputsInputSchema.parse({
      platforms: [],
      selected_workflows: [],
      user_requirements: 'Find 2 leads',
    })).toThrow(/Select at least one platform or workflow/);
  });

  it('preserves a workflow-only review', () => {
    expect(generateLeadInputsInputSchema.parse({
      selected_workflows: ['google_maps'],
      user_requirements: 'Find 2 leads',
    }).selected_workflows).toEqual(['google_maps']);
  });

  it.each([
    ['Find 2 B2B SaaS founder leads in Bengaluru', 2],
    ['Only 25 prospects in New York', 25],
    ['Find exactly 1 cafe business in Coimbatore', 1],
    ['Find exactly 1 software company in Bengaluru', 1],
    ['At most 8 contacts', 8],
    ['Generate 5 publicly listed boutique hotels near Nandi Hills', 5],
    ['Preserve the exact global lead cap of 1, and require approval before execution', 1],
    ['Enforce a global cap of exactly 3 across every selected provider', 3],
    ['Global cap: 1; maxItems: 1', 1],
    ['Global cap=2', 2],
  ])('extracts the reviewed limit from %s', (requirements, expected) => {
    expect(extractRequestedLeadLimit(requirements)).toBe(expected);
  });

  it.each([
    ["Generate one lead in 'Bengaluru' using JustDial", 'Bengaluru'],
    ['Use location: "Austin, Texas" and cap results at one lead', 'Austin, Texas'],
    ['Target: boutique hotels in Bengaluru, Karnataka, India. Industry: Hospitality.', 'Bengaluru, Karnataka, India'],
    ['Target owners in Bengaluru, Karnataka, India, in Hospitality. Use provider input targeting.', 'Bengaluru, Karnataka, India'],
    ['Target owners in Bengaluru, Karnataka, India in the Hospitality industry. Use provider input targeting.', 'Bengaluru, Karnataka, India'],
    ['Target owners in Bengaluru, Karnataka, India, in Hospitality. Keywords: hotel owner. Location: Bengaluru, Karnataka, India.', 'Bengaluru, Karnataka, India'],
  ])('extracts an explicitly reviewed target location from %s', (requirements, expected) => {
    expect(extractExplicitTargetLocation(requirements)).toBe(expected);
  });

  it('replaces provider demo prefills with reviewed ICP intent when LLM generation is unavailable', () => {
    expect(applyLeadIntentToFallbackInputs(
      {
        searchStringsArray: ['restaurant'],
        locationQuery: 'New York, USA',
        maxCrawledPlacesPerSearch: 50,
      },
      {
        searchStringsArray: '{{searchStringsArray}}',
        locationQuery: '{{locationQuery}}',
        maxCrawledPlacesPerSearch: '{{maxCrawledPlacesPerSearch}}',
        startUrls: '{{startUrls}}',
      },
      {
        subIndustry: 'Boutique Hotels',
        primaryRegions: ['Nandi Hills, Bangalore'],
      },
    )).toEqual({
      searchStringsArray: ['Boutique Hotels'],
      locationQuery: 'Nandi Hills, Bangalore',
      maxCrawledPlacesPerSearch: 50,
      startUrls: [
        { url: 'https://www.google.com/maps/search/Boutique+Hotels+near+Nandi+Hills%2C+Bangalore' },
        { url: 'https://www.google.com/maps/search/hotels+near+Nandi+Hills%2C+Bangalore' },
      ],
    });
  });

  it('deterministically caps Google Maps to the reviewed total', () => {
    expect(applyRequestedLeadLimit({
      searchStringsArray: ['SaaS companies', 'B2B startups'],
      maxCrawledPlacesPerSearch: 20,
      locationQuery: 'Bengaluru',
    }, 'Find 2 B2B SaaS founder leads')).toEqual({
      searchStringsArray: ['SaaS companies', 'B2B startups'],
      maxCrawledPlacesPerSearch: 1,
      locationQuery: 'Bengaluru',
    });
  });

  it('lets each provider fill the reviewed total while recording a global save cap', () => {
    expect(applyRequestedLeadLimitToBatch([
      { platform: 'linkedin_company_search', inputs: { maxItems: 20 } },
      { platform: 'linkedin_company_search', inputs: { maxItems: 20 } },
      { platform: 'linkedin_profile_enriched', inputs: { maxItems: 20 } },
    ], 'Generate exactly 2 new leads')).toEqual([
      { platform: 'linkedin_company_search', requestedLeadLimit: 2, requestedLeadTotal: 2, inputs: { maxItems: 2 } },
      { platform: 'linkedin_company_search', requestedLeadLimit: 2, requestedLeadTotal: 2, inputs: { maxItems: 2 } },
    ]);
  });

  it('keeps a single search capped at the full reviewed total', () => {
    expect(applyRequestedLeadLimitToBatch([
      { platform: 'google_maps', inputs: { maxCrawledPlacesPerSearch: 20 } },
    ], 'Find 3 leads')).toEqual([
      { platform: 'google_maps', requestedLeadLimit: 3, requestedLeadTotal: 3, inputs: { maxCrawledPlacesPerSearch: 3 } },
    ]);
  });

  it('retains fallback coverage across channels when the global cap is one', () => {
    const reviewed = applyRequestedLeadLimitToBatch([
      { platform: 'instagram_post_search', inputs: { resultsLimit: 20 } },
      { platform: 'facebook_post_search', inputs: { maxResults: 20 } },
      { platform: 'twitter_post_search', inputs: { maxResults: 20 } },
      { platform: 'linkedin_company_search', inputs: { maxItems: 20 } },
      { platform: 'google_maps', inputs: { maxCrawledPlacesPerSearch: 20 } },
      { platform: 'justdial', inputs: { maxItems: 20 } },
    ], 'Find exactly 1 lead globally');

    expect(reviewed.map(entry => entry.platform)).toEqual([
      'instagram_post_search',
      'facebook_post_search',
      'twitter_post_search',
      'linkedin_company_search',
      'google_maps',
      'justdial',
    ]);
    expect(reviewed.every(entry => entry.requestedLeadTotal === 1)).toBe(true);
    expect(reviewed.map(entry => Object.values(entry.inputs).find(value => value === 1))).toEqual([
      1, 1, 1, 1, 1, 1,
    ]);
  });

  it('limits duplicate searches within one channel without removing other channels', () => {
    expect(applyRequestedLeadLimitToBatch([
      { platform: 'instagram_post_search', inputs: { resultsLimit: 20, hashtags: ['first'] } },
      { platform: 'instagram_post_search', inputs: { resultsLimit: 20, hashtags: ['second'] } },
      { platform: 'facebook_post_search', inputs: { maxResults: 20 } },
    ], 'Find exactly 1 lead globally').map(entry => entry.platform)).toEqual([
      'instagram_post_search',
      'facebook_post_search',
    ]);
  });

  it('turns role-oriented audiences into business search terms for fallback providers', () => {
    expect(applyLeadIntentToFallbackInputs(
      { search: 'restaurants', location: 'Mumbai' },
      { search: '{{search}}', location: '{{location}}' },
      {
        targetAudience: 'Boutique hotel owners and general managers',
        primaryRegions: ['Nandi Hills, Bangalore'],
      },
    )).toEqual({ search: 'Boutique hotel near Nandi Hills', location: 'Bangalore' });
  });

  it('keeps an explicitly reviewed city narrower than a broader ICP region', () => {
    const reviewedLocation = extractExplicitTargetLocation(
      'Target: boutique hotels in Bengaluru, Karnataka, India. Industry: Hospitality.',
    );
    expect(applyLeadIntentToFallbackInputs(
      { search: 'restaurants', location: 'India' },
      { search: '{{search}}', location: '{{location}}' },
      {
        targetAudience: 'Boutique hotel owners and managers',
        primaryRegions: ['Bengaluru, Karnataka, India'],
      },
      reviewedLocation,
    )).toEqual({ search: 'Boutique hotel near Bengaluru', location: 'Bengaluru' });
  });

  it('replaces generic social-provider prefills with location-scoped ICP terms', () => {
    expect(applyLeadIntentToFallbackInputs(
      { hashtags: ['webscraping'], resultsLimit: 20, query: 'OpenAI' },
      { hashtags: '{{hashtags}}', resultsLimit: '{{resultsLimit}}', query: '{{query}}' },
      {
        targetAudience: 'Boutique hotels',
        primaryRegions: ['Bengaluru, Karnataka'],
      },
    )).toEqual({
      hashtags: ['boutiquehotelsbengaluru'],
      resultsLimit: 20,
      query: 'Boutique hotels Bengaluru',
    });
  });

  it('honors provider fetch minimums without changing the reviewed save cap', () => {
    expect(applyProviderMinimumFetchLimits(
      { query: 'dentist Austin', maxResults: 1 },
      { maxResults: { minimum: 10 } },
    )).toEqual({ query: 'dentist Austin', maxResults: 10 });
  });

  it('prevents Instagram hashtag limits from multiplying across hashtags', () => {
    expect(applyRequestedLeadLimit({
      hashtags: ['austindentist', 'dallasdentist'],
      resultsLimit: 20,
    }, 'Find exactly 2 leads')).toEqual({
      hashtags: ['austindentist', 'dallasdentist'],
      resultsLimit: 1,
    });
  });

  it('preserves every requested hashtag even when the save cap is smaller than the target list', () => {
    expect(applyRequestedLeadLimitToBatch([
      { platform: 'instagram_post_authors', inputs: { hashtags: ['GoaHotels', 'BoutiqueHotelGoa'], resultsLimit: 50 } },
    ], 'Find exactly 1 lead')).toEqual([
      { platform: 'instagram_post_authors', requestedLeadLimit: 1, requestedLeadTotal: 1,
        inputs: { hashtags: ['GoaHotels', 'BoutiqueHotelGoa'], resultsLimit: 1 } },
    ]);
  });

  it('understands a customer asking for profiles and splits the allowance without dropping hashtags', () => {
    expect(applyRequestedLeadLimitToBatch([
      { platform: 'instagram_post_authors', inputs: { hashtags: ['GoaHotels', 'BoutiqueHotelGoa'], resultsLimit: 50 } },
    ], 'Keep the total search limit to approximately 10 profiles for an initial batch')).toEqual([
      { platform: 'instagram_post_authors', requestedLeadLimit: 10, requestedLeadTotal: 10,
        inputs: { hashtags: ['GoaHotels', 'BoutiqueHotelGoa'], resultsLimit: 5 } },
    ]);
  });
});
