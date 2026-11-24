/** Bounded, explicit live provider check. Does not save leads or send outreach. */
import '../env.js';
import { pgPool } from '../models/db.js';
import { WorkflowExecutorService } from '../services/WorkflowExecutorService.js';
import { partitionProviderDatasetResults } from '../services/workflow/providerDatasetResults.js';
import { writeFile } from 'node:fs/promises';

if (!process.argv.includes('--execute')) throw new Error('Pass --execute to run the bounded provider checks.');
const cases = [
  { platform: 'facebook', actorId: 'powerai/facebook-post-search-scraper', input: { query: 'software Bangalore', maxResults: 10, recent_posts: true } },
  { platform: 'instagram', actorId: 'apify/instagram-hashtag-scraper', input: { hashtags: ['software Bangalore'], keywordSearch: true, resultsType: 'posts', resultsLimit: 2 } },
  { platform: 'twitter', actorId: 'apidojo/twitter-user-scraper', input: { searchTerms: ['software Bangalore'], maxItems: 5, getFollowers: false, getFollowing: false, getRetweeters: false, getAbout: false, includeUnavailableUsers: false } },
];

try {
  const results = await Promise.all(cases.map(async test => {
    try {
      const client = await (WorkflowExecutorService as any).getApifyClientForUser(1, test.actorId);
      const started = await client.actor(test.actorId).start(test.input, { timeout: 120 });
      console.log('CANARY_STARTED', JSON.stringify({ platform: test.platform, runId: started.id }));
      const run = await client.run(started.id).waitForFinish({ waitSecs: 150 });
      const dataset = run.defaultDatasetId ? await client.dataset(run.defaultDatasetId).listItems({ limit: 10 }) : { items: [] };
      const rows = partitionProviderDatasetResults(dataset.items);
      return { platform: test.platform, actorId: test.actorId, input: test.input, runId: run.id, status: run.status,
        fetched: dataset.items.length, valid: rows.validResults.length, errors: rows.rejectedResults.length,
        statusMessage: run.statusMessage, saved: 0 };
    } catch (error) {
      return { platform: test.platform, status: 'failed', error: error instanceof Error ? error.message : String(error), saved: 0 };
    }
  }));
  await writeFile('../qa/asksales-2026-10-06/social-provider-canary.json', JSON.stringify(results, null, 2));
  console.log('CANARY_RESULTS', JSON.stringify(results));
} finally { await pgPool?.end(); }
