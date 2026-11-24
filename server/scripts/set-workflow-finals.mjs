/**
 * Comprehensive script to set proper finalValues on all workflow JSON files.
 * Reads each workflow, identifies its actor, and sets finalValues for ALL
 * system/technical fields that the LLM should NOT generate.
 * 
 * Run: node server/scripts/set-workflow-finals.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowDir = path.join(__dirname, '../data/workflows');

/**
 * For each workflow file, define the complete finalValues.
 * These are fields that:
 * 1. Already have hardcoded values in inputMapping (non-template)
 * 2. Are system/technical defaults from the actor schema
 * 3. Are internal fields (mongo, deduplication, pagination internals)
 * 
 * Fields NOT included: user-specific inputs like queries, locations, job titles,
 * URLs, usernames, hashtags, max items/results (lead quantity).
 */
const WORKFLOW_FINAL_VALUES = {
  // ─── Facebook Workflows ───
  'facebook.json': {
    recent_posts: true,
  },
  'facebook_competitor_pages.json': {
    followType: '',
  },
  'facebook_page_posts.json': {},
  'facebook_post_authors.json': {
    recent_posts: true,
  },
  'facebook_post_authors_followers.json': {
    recent_posts: true,
  },
  'facebook_post_commenters.json': {
    recent_posts: true,
  },
  'facebook_post_likers.json': {
    recent_posts: true,
  },
  'facebook_post_search.json': {
    recent_posts: true,
  },

  // ─── Google Maps ───
  'google_maps.json': {
    language: 'en',
    skipClosedPlaces: false,
    placeMinimumStars: '',
    scrapePlaceDetailPage: false,
    maxReviews: 0,
    maxImages: 0,
    scrapeContacts: false,
    scrapeSocialMediaProfiles: {
      facebooks: false,
      instagrams: false,
      youtubes: false,
      tiktoks: false,
      twitters: false,
    },
    searchMatching: 'all',
    website: 'allPlaces',
    maximumLeadsEnrichmentRecords: 0,
  },

  // ─── Instagram Workflows ───
  'instagram.json': {
    resultsType: 'posts',
    keywordSearch: false,
  },
  'instagram_competitor_profiles.json': {
    includeAboutSection: true,
  },
  'instagram_hashtag_followers.json': {
    resultsType: 'posts',
    keywordSearch: false,
  },
  'instagram_post_authors.json': {
    resultsType: 'posts',
    keywordSearch: false,
  },
  'instagram_post_authors_commenters.json': {
    resultsType: 'posts',
    keywordSearch: false,
  },
  'instagram_post_authors_engagers.json': {
    resultsType: 'posts',
    keywordSearch: false,
  },
  'instagram_post_authors_followers.json': {
    resultsType: 'posts',
    keywordSearch: false,
  },
  'instagram_post_authors_likers.json': {
    resultsType: 'posts',
    keywordSearch: false,
  },
  'instagram_post_search.json': {
    resultsType: 'posts',
    keywordSearch: false,
  },
  'instagram_profile_posts.json': {
    skipPinnedPosts: false,
    dataDetailLevel: 'basicData',
  },

  // ─── JustDial ───
  'justdial.json': {
    headless: true,
    proxyConfiguration: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
      apifyProxyCountry: 'IN',
    },
  },

  // ─── LinkedIn Profile Search Workflows ───
  // Actor: harvestapi/linkedin-profile-search
  // System fields: startPage, takePages, autoQuerySegmentation, profileDeduplication, mongo*, exclude*, profileLanguages
  'linkedin.json': {
    profileScraperMode: 'Full + email search',
    startPage: 1,
    autoQuerySegmentation: false,
    profileDeduplicationMode: 'off',
    recentlyChangedJobs: false,
  },
  'linkedin_profile_enriched.json': {
    startPage: 1,
    autoQuerySegmentation: false,
    profileDeduplicationMode: 'off',
    recentlyChangedJobs: false,
  },
  'linkedin_profile_posts.json': {
    startPage: 1,
    autoQuerySegmentation: false,
    profileDeduplicationMode: 'off',
    recentlyChangedJobs: false,
  },
  'linkedin_profile_activity.json': {
    startPage: 1,
    autoQuerySegmentation: false,
    profileDeduplicationMode: 'off',
    recentlyChangedJobs: false,
  },
  'linkedin_posts_commenters.json': {
    startPage: 1,
    autoQuerySegmentation: false,
    profileDeduplicationMode: 'off',
    recentlyChangedJobs: false,
  },
  'linkedin_posts_reactors.json': {
    startPage: 1,
    autoQuerySegmentation: false,
    profileDeduplicationMode: 'off',
    recentlyChangedJobs: false,
  },

  // ─── LinkedIn Company Employees Workflows ───
  // Actor: harvestapi/linkedin-company-employees
  'linkedin_company_employees.json': {
    profileScraperMode: 'Short ($4 per 1k)',
    startPage: 1,
  },
  'linkedin_company_employees_posts.json': {
    profileScraperMode: 'Short ($4 per 1k)',
    startPage: 1,
  },

  // ─── LinkedIn Company Search Workflows ───
  'linkedin_company_search.json': {
    scraperMode: 'full',
    startPage: 1,
  },
  'linkedin_company_search_employees.json': {
    scraperMode: 'full',
    startPage: 1,
  },

  // ─── LinkedIn Company Posts ───
  'linkedin_company_posts.json': {
    postedLimit: 'month',
    scrapeReactions: false,
    scrapeComments: false,
  },

  // ─── LinkedIn Company Details ───
  'linkedin_company_details.json': {},

  // ─── LinkedIn Post Search ───
  'linkedin_post_search.json': {
    postedLimit: 'month',
    sortBy: 'relevance',
    contentType: 'all',
    profileScraperMode: 'short',
    scrapeReactions: false,
    scrapeComments: false,
  },

  // ─── LinkedIn Profile By Name ───
  'linkedin_profile_by_name.json': {
    profileScraperMode: 'Short ($2 per 1k)',
    strictSearch: false,
  },

  // ─── Twitter Search Workflows ───
  // Actor: powerai/twitter-search-scraper
  'twitter.json': {
    searchType: 'Top',
  },
  'twitter_post_search.json': {},
  'twitter_post_authors.json': {
    searchType: 'Top',
  },
  'twitter_post_authors_followers.json': {
    searchType: 'Top',
  },
  'twitter_post_repliers.json': {
    searchType: 'Top',
  },
  'twitter_post_retweeters.json': {
    searchType: 'Top',
  },

  // ─── Twitter User Scraper Workflows ───
  // Actor: apidojo/twitter-user-scraper
  'twitter_competitor_followers.json': {
    getFollowers: true,
    getFollowing: false,
    getAbout: true,
    getRetweeters: false,
    includeUnavailableUsers: false,
  },
  'twitter_competitor_users.json': {
    getFollowers: false,
    getFollowing: false,
    getAbout: true,
    getRetweeters: false,
    includeUnavailableUsers: false,
  },

  // ─── Twitter Tweet Scraper Workflows ───
  // Actor: apidojo/tweet-scraper
  'twitter_post_likers.json': {
    sort: 'Top',
    tweetLanguage: 'en',
    onlyVerifiedUsers: false,
    onlyImage: false,
    onlyVideo: false,
  },
  'twitter_user_tweets.json': {
    sort: 'Latest',
    tweetLanguage: 'en',
    onlyVerifiedUsers: false,
    onlyImage: false,
    onlyVideo: false,
  },
};

let updated = 0;
let skipped = 0;

for (const f of fs.readdirSync(workflowDir).filter(f => f.endsWith('.json')).sort()) {
  const filePath = path.join(workflowDir, f);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const actorNode = (data.nodes || []).find(n => n.type === 'actor');
  if (!actorNode) {
    console.log(`SKIP ${f} — no actor node`);
    skipped++;
    continue;
  }

  const finalValues = WORKFLOW_FINAL_VALUES[f];
  if (finalValues === undefined) {
    console.log(`WARN ${f} — not in WORKFLOW_FINAL_VALUES map (MISSING)`);
    skipped++;
    continue;
  }

  if (Object.keys(finalValues).length === 0) {
    // Remove existing finalValues if empty
    if (actorNode.data.finalValues) {
      delete actorNode.data.finalValues;
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      console.log(`CLEARED ${f} — removed empty finalValues`);
    } else {
      console.log(`SKIP ${f} — no finalValues needed`);
    }
    skipped++;
    continue;
  }

  // Set finalValues on the actor node
  actorNode.data.finalValues = finalValues;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  console.log(`SET ${f} — ${Object.keys(finalValues).length} finalValues: ${Object.keys(finalValues).join(', ')}`);
  updated++;
}

console.log(`\nDone: ${updated} updated, ${skipped} skipped/cleared`);
