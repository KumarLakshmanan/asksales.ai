import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { sql } from 'drizzle-orm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  console.log('--- Ad Copy Generation and Ad Publishing end-to-end dry-run ---');
  
  const { db } = await import('../models/db.js');
  const { contentAssetsTable } = await import('../models/contentAssets/schema.js');
  const { performanceAdCampaignsTable } = await import('../models/performanceAdCampaigns/schema.js');
  const { metaPageConnectionsTable } = await import('../models/metaPageConnections/schema.js');
  const { executePublishMetaAds, executePublishGoogleAds } = await import('../mastra/tools/executors/adsExecutor.js');
  const { eq, and } = await import('drizzle-orm');

  const userId = 1; // Lakshmanan R (user@salesmarketing.com)

  // ── 1. Intercept Global Fetch ───────────────────────────────────
  const originalFetch = global.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  global.fetch = async (input: any, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.url;
    
    // Mock Google OAuth token refresh request
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'mock_google_access_token', expires_in: 3600 }), { status: 200 });
    }
    
    // Mock Google Ads API requests
    if (url.includes('googleads.googleapis.com')) {
      let resourceName = 'customers/1234567890/campaigns/mock_campaign_id';
      if (url.includes('campaignBudgets:mutate')) resourceName = 'customers/1234567890/campaignBudgets/mock_budget_id';
      else if (url.includes('campaigns:mutate')) resourceName = 'customers/1234567890/campaigns/mock_campaign_id';
      else if (url.includes('adGroups:mutate')) resourceName = 'customers/1234567890/adGroups/mock_ad_group_id';
      else if (url.includes('adGroupAds:mutate')) resourceName = 'customers/1234567890/adGroupAds/mock_ad_group_ad_id';
      else if (url.includes('adGroupCriteria:mutate')) resourceName = 'customers/1234567890/adGroupCriteria/mock_criteria_id';
      
      console.log(`[Mock Google API] Intercepted call to: ${url.split('?')[0]}`);
      return new Response(JSON.stringify({ results: [{ resourceName }] }), { status: 200 });
    }
    
    // Mock Meta Ads Graph API requests
    if (url.includes('graph.facebook.com')) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let data: any = { id: 'mock_meta_id' };
      if (url.includes('/adimages')) {
        data = { images: { 'pexels-photo-414612.jpeg': { hash: 'mock_image_hash' } } };
      } else if (url.includes('/adsets')) {
        data = { id: 'mock_ad_set_id' };
      } else if (url.includes('/adcreatives')) {
        data = { id: 'mock_creative_id' };
      } else if (url.includes('/campaigns')) {
        data = { id: 'mock_campaign_id' };
      } else if (url.includes('/ads')) {
        data = { id: 'mock_ad_id' };
      }
      
      console.log(`[Mock Meta API] Intercepted call to: ${url.split('?')[0]}`);
      return new Response(JSON.stringify(data), { status: 200 });
    }
    
    // Return standard fetch for external assets if needed
    return originalFetch(input, init);
  };

  // Keep track of resources to clean up
  let newAssetId: number | null = null;
  let newCampaignId: number | null = null;
  let mockCredInserted = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let originalMetaPage: any = null;

  try {
    // ── 2. Create Mock Credentials in Database ─────────────────────
    console.log('\nInserting temporary mock credentials...');
    
    // Google Ads mock in api_credentials
    await db.execute(
      sql`INSERT INTO api_credentials (user_id, service_name, api_key, api_secret, config, is_active)
          VALUES (${userId}, 'google_ads', 'mock_client_id', 'mock_client_secret', '{"refreshToken": "mock_refresh_token", "developerToken": "mock_developer_token", "customerId": "1234567890"}', true)`
    );
    mockCredInserted = true;
    console.log('Inserted mock Google Ads api_credentials.');

    // Meta Ads mock: Query existing connection and update it for User 1
    const existingMetaConns = await db.select().from(metaPageConnectionsTable)
      .where(and(eq(metaPageConnectionsTable.userId, userId), eq(metaPageConnectionsTable.pageId, '971735822683328')))
      .limit(1);
    
    if (existingMetaConns.length > 0) {
      originalMetaPage = existingMetaConns[0];
      await db.update(metaPageConnectionsTable)
        .set({ adAccountId: '1234567890', userAccessToken: 'mock_user_token' })
        .where(and(eq(metaPageConnectionsTable.userId, userId), eq(metaPageConnectionsTable.pageId, '971735822683328')));
      console.log('Updated existing Meta page connection with mock ad_account_id.');
    } else {
      // Fallback: insert if not present
      await db.execute(
        sql`INSERT INTO meta_page_connections (user_id, page_id, page_name, page_access_token, user_access_token, ad_account_id, is_active)
            VALUES (${userId}, '971735822683328', 'Mock Page', 'mock_page_token', 'mock_user_token', '1234567890', true)`
      );
      console.log('Inserted new mock Meta Ads connection.');
    }

    // ── 3. Generate Ad Copy (Draft Content Asset) ──────────────────
    const adCopyContent = {
      headline: 'Scale Your Business with AskSales AI',
      primaryText: 'Automate your sales and performance marketing workflows today. Try AskSales AI for free!',
      description: 'Get instant insights, auto-generate high-converting campaigns, and scale outreach.',
      callToAction: 'LEARN_MORE',
      link: 'https://asksales.ai',
      imageUrl: 'https://images.pexels.com/photos/414612/pexels-photo-414612.jpeg?auto=compress&cs=tinysrgb&w=800'
    };

    console.log('\nCreating draft Ad Copy asset...');
    const [newAsset] = await db
      .insert(contentAssetsTable)
      .values({
        userId,
        type: 'ad_copy',
        title: 'Automated Ad Copy Test',
        content: JSON.stringify(adCopyContent),
        channel: 'facebook',
        status: 'draft',
        createdAt: new Date(),
        updatedAt: new Date()
      })
      .returning();
    newAssetId = newAsset.id;
    console.log(`Created Ad Copy Content Asset (ID: ${newAsset.id})`);

    // Create Campaign Record
    console.log('\nCreating draft performance ad campaign record...');
    const [newCampaign] = await db
      .insert(performanceAdCampaignsTable)
      .values({
        userId,
        name: 'AskSales AI Launch Campaign',
        description: 'Test launch campaign for performance marketing',
        objective: 'OUTCOME_TRAFFIC',
        adPlatform: 'meta',
        budgetType: 'daily',
        budgetAmount: '20.00',
        currency: 'USD',
        targeting: {
          age_min: 18,
          age_max: 65,
          genders: [1, 2],
          geo_locations: { countries: ['US'] }
        },
        adCreatives: [
          {
            title: adCopyContent.headline,
            content: JSON.stringify(adCopyContent),
            imageUrl: adCopyContent.imageUrl
          }
        ],
        startDate: new Date(),
        status: 'draft',
        isActive: false
      })
      .returning();
    newCampaignId = newCampaign.id;
    console.log(`Created Ad Campaign Record (ID: ${newCampaign.id})`);

    // ── 4. Verify Meta Ads Publishing Flow ─────────────────────────
    console.log('\n=======================================');
    console.log('Testing Meta Ads Campaign Publishing...');
    console.log('=======================================');
    
    const metaResult = await executePublishMetaAds(
      {
        campaign_id: String(newCampaignId),
        budget: 20
      },
      // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
      { userId: String(userId) }
    );
    console.log('\nMeta Ads Result:', JSON.stringify(metaResult, null, 2));

    // ── 5. Verify Google Ads Publishing Flow ───────────────────────
    console.log('\n=========================================');
    console.log('Testing Google Ads Campaign Publishing...');
    console.log('=========================================');
    
    // Update platform to google
    await db.update(performanceAdCampaignsTable)
      .set({ adPlatform: 'google' })
      .where(eq(performanceAdCampaignsTable.id, newCampaignId as number));

    const googleResult = await executePublishGoogleAds(
      {
        campaign_id: String(newCampaignId),
        budget: 20
      },
      // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
      { userId: String(userId) }
    );
    console.log('\nGoogle Ads Result:', JSON.stringify(googleResult, null, 2));

  } catch (error) {
    console.error('Test execution failed:', error);
  } finally {
    // ── 6. Cleanup mock records ───────────────────────────────────
    console.log('\nCleaning up mock records from database...');
    
    if (newAssetId) {
      await db.delete(contentAssetsTable).where(eq(contentAssetsTable.id, newAssetId));
      console.log('Deleted temp Ad Copy asset.');
    }
    if (newCampaignId) {
      await db.delete(performanceAdCampaignsTable).where(eq(performanceAdCampaignsTable.id, newCampaignId));
      console.log('Deleted temp Ad Campaign record.');
    }
    if (mockCredInserted) {
      await db.execute(
        sql`DELETE FROM api_credentials WHERE user_id = ${userId} AND service_name = 'google_ads' AND api_key = 'mock_client_id'`
      );
      console.log('Deleted mock Google Ads credentials.');
    }
    if (originalMetaPage) {
      await db.update(metaPageConnectionsTable)
        .set({ 
          adAccountId: originalMetaPage.adAccountId, 
          userAccessToken: originalMetaPage.userAccessToken 
        })
        .where(and(eq(metaPageConnectionsTable.userId, userId), eq(metaPageConnectionsTable.pageId, '971735822683328')));
      console.log('Restored original Meta page connection.');
    } else {
      await db.execute(
        sql`DELETE FROM meta_page_connections WHERE user_id = ${userId} AND ad_account_id = '1234567890'`
      );
      console.log('Deleted temp mock Meta page connection.');
    }

    // Restore fetch
    global.fetch = originalFetch;
    console.log('Restored original fetch handler. Done!');
  }
}


main().catch(console.error);
