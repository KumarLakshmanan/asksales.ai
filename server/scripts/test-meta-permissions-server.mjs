/**
 * Meta API Permission Test Script (Server-Side)
 * 
 * Makes test API calls using your own Meta App credentials from the database,
 * ensuring Meta registers them under YOUR app (not Graph API Explorer).
 *
 * Usage:
 *   cd server
 *   node --experimental-modules scripts/test-meta-permissions-server.mjs
 *
 * Requires: DATABASE_URL or DB_ env vars, and a user access token from your app.
 */

import pg from 'pg';
import 'dotenv/config';

// ── Config ──────────────────────────────────────────────────────────────────
const FB_TOKEN = process.env.META_TOKEN || process.argv[2] || '';
const IG_TOKEN = process.env.IG_TOKEN || process.argv[3] || '';
const API_VERSION = 'v25.0';
const FB_BASE = `https://graph.facebook.com/${API_VERSION}`;
const IG_BASE = `https://graph.instagram.com/${API_VERSION}`;

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const NC = '\x1b[0m';

let passed = 0, failed = 0, skipped = 0, total = 0;

async function callApi(label, url, method = 'GET', body = null) {
  total++;
  const maskedUrl = url.replace(/access_token=[^&]+/g, 'access_token=***');
  console.log(`\n${CYAN}[${total}] ${label}${NC}`);
  console.log(`    ${method} ${maskedUrl}`);

  try {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const data = await res.json();

    if (res.ok) {
      console.log(`    ${GREEN}✓ HTTP ${res.status}${NC}`);
      console.log('   ', JSON.stringify(data).slice(0, 300));
      passed++;
      return data;
    } else {
      console.log(`    ${RED}✗ HTTP ${res.status}${NC}`);
      console.log('   ', JSON.stringify(data.error || data).slice(0, 400));
      failed++;
      return null;
    }
  } catch (err) {
    console.log(`    ${RED}✗ Error: ${err.message}${NC}`);
    failed++;
    return null;
  }
}

function skip(label) {
  total++;
  skipped++;
  console.log(`\n${YELLOW}[${total}] ${label} — SKIPPED${NC}`);
}

// ── DB connection ───────────────────────────────────────────────────────────
async function getMetaAppCredentials() {
  const pool = new pg.Pool({
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_DATABASE || 'salesmarketing',
    port: parseInt(process.env.DB_PORT || '5432'),
    ssl: false,
  });

  try {
    const result = await pool.query(
      `SELECT api_key, api_secret, config FROM admin_api_credentials 
       WHERE platform = 'meta_app' AND is_active = true 
       ORDER BY id LIMIT 1`
    );
    if (result.rows.length === 0) {
      console.log(`${RED}No active meta_app credentials found in admin_api_credentials${NC}`);
      return null;
    }
    const row = result.rows[0];
    return {
      appId: row.api_key,
      appSecret: row.api_secret,
      apiVersion: row.config?.apiVersion || 'v25.0',
    };
  } finally {
    await pool.end();
  }
}

// ── Get all stored user tokens ──────────────────────────────────────────────
async function getStoredTokens() {
  const pool = new pg.Pool({
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_DATABASE || 'salesmarketing',
    port: parseInt(process.env.DB_PORT || '5432'),
    ssl: false,
  });

  try {
    const result = await pool.query(
      `SELECT user_id, platform, credentials 
       FROM channel_credentials 
       WHERE platform IN ('instagram_api', 'facebook_api', 'whatsapp') 
         AND is_active = true 
       ORDER BY updated_at DESC`
    );
    return result.rows;
  } finally {
    await pool.end();
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('==============================================');
  console.log('  Meta API Permission Test (Server-Side)');
  console.log('==============================================\n');

  // Get app credentials
  const appCreds = await getMetaAppCredentials();
  if (!appCreds) {
    console.log(`${RED}Cannot proceed without Meta App credentials.${NC}`);
    process.exit(1);
  }
  console.log(`Meta App ID: ${appCreds.appId}`);
  console.log(`API Version: ${appCreds.apiVersion}\n`);

  // Determine tokens to use
  let fbToken = FB_TOKEN;
  let igToken = IG_TOKEN;

  if (!fbToken && !igToken) {
    console.log(`${YELLOW}No tokens provided via env/args. Checking stored tokens...${NC}`);
    const storedTokens = await getStoredTokens();

    for (const row of storedTokens) {
      const creds = row.credentials;
      if (row.platform === 'facebook_api' && !fbToken && creds?.accessToken) {
        fbToken = creds.accessToken;
        console.log(`  Found Facebook token for user ${row.user_id}`);
      }
      if (row.platform === 'instagram_api' && !fbToken && creds?.accessToken) {
        // Instagram API tokens from OAuth are actually Facebook User Tokens
        fbToken = creds.accessToken;
        console.log(`  Found Instagram API token for user ${row.user_id} (FB format)`);
      }
    }
  }

  if (!fbToken && !igToken) {
    console.log(`\n${RED}No tokens available. Provide via:${NC}`);
    console.log(`  META_TOKEN="EAA..." node scripts/test-meta-permissions-server.mjs`);
    console.log(`  IG_TOKEN="IGAA..." node scripts/test-meta-permissions-server.mjs`);
    console.log(`  Or connect an account via OAuth first.`);
    process.exit(1);
  }

  console.log(`\nFacebook Token: ${fbToken ? fbToken.slice(0, 15) + '...' : 'NOT SET'}`);
  console.log(`Instagram Token: ${igToken ? igToken.slice(0, 15) + '...' : 'NOT SET'}\n`);

  // ══════════════════════════════════════════════════════════════════════════
  //  INSTAGRAM TESTS (graph.instagram.com + IGAA token)
  // ══════════════════════════════════════════════════════════════════════════
  if (igToken) {
    console.log(`\n${YELLOW}━━━ INSTAGRAM (graph.instagram.com) ━━━${NC}`);

    const me = await callApi('instagram_basic — /me', 
      `${IG_BASE}/me?fields=id,username,name,biography,profile_picture_url,followers_count,follows_count,media_count&access_token=${igToken}`);

    if (me?.id) {
      await callApi('instagram_basic — /me/media',
        `${IG_BASE}/me/media?fields=id,caption,media_type,timestamp,permalink,like_count,comments_count&limit=5&access_token=${igToken}`);

      const mediaRes = await fetch(`${IG_BASE}/me/media?fields=id&limit=1&access_token=${igToken}`);
      const mediaData = await mediaRes.json();
      const mediaId = mediaData?.data?.[0]?.id;

      if (mediaId) {
        await callApi('instagram_manage_comments — comments',
          `${IG_BASE}/${mediaId}/comments?fields=id,text,username,timestamp&limit=5&access_token=${igToken}`);
      } else {
        skip('instagram_manage_comments — no media');
      }

      await callApi('instagram_manage_messages — conversations',
        `${IG_BASE}/me/conversations?fields=id,updated_time,participants&platform=instagram&limit=3&access_token=${igToken}`);

      await callApi('instagram_content_publish — publishing limit',
        `${IG_BASE}/me/content_publishing_limit?fields=config,quota_usage&access_token=${igToken}`);

      await callApi('instagram_basic — stories',
        `${IG_BASE}/me/stories?fields=id,media_type,timestamp&access_token=${igToken}`);

      await callApi('instagram_basic — live_media',
        `${IG_BASE}/me/live_media?fields=id,media_type,timestamp&access_token=${igToken}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  FACEBOOK / PAGES / ADS / BUSINESS (graph.facebook.com + EAA token)
  // ══════════════════════════════════════════════════════════════════════════
  if (fbToken) {
    console.log(`\n${YELLOW}━━━ FACEBOOK / PAGES / ADS / BUSINESS ━━━${NC}`);

    await callApi('identity — /me', `${FB_BASE}/me?fields=id,name,email&access_token=${fbToken}`);

    const accountsRes = await callApi('pages_show_list — /me/accounts',
      `${FB_BASE}/me/accounts?fields=id,name,category,access_token,instagram_business_account&access_token=${fbToken}`);

    const page = accountsRes?.data?.[0];
    const pageId = page?.id;
    const pageToken = page?.access_token;
    const igBizId = page?.instagram_business_account?.id;

    console.log(`\n    ${CYAN}Page: ${pageId || 'none'} | IG Biz: ${igBizId || 'none'}${NC}\n`);

    if (pageId && pageToken) {
      await callApi('pages_read_engagement — feed',
        `${FB_BASE}/${pageId}/feed?fields=id,message,created_time,likes.summary(true),comments.summary(true)&limit=3&access_token=${pageToken}`);

      await callApi('pages_read_user_content — tagged',
        `${FB_BASE}/${pageId}/tagged?fields=id,message,from&limit=3&access_token=${pageToken}`);

      await callApi('pages_manage_metadata — details',
        `${FB_BASE}/${pageId}?fields=id,name,about,category,fan_count,website&access_token=${pageToken}`);

      await callApi('pages_messaging — conversations',
        `${FB_BASE}/${pageId}/conversations?fields=id,updated_time,participants,message_count&limit=3&access_token=${pageToken}`);

      // Subscribed apps (pages_manage_metadata test)
      await callApi('pages_manage_metadata — subscribed_apps',
        `${FB_BASE}/${pageId}/subscribed_apps?access_token=${pageToken}`);

      if (igBizId) {
        await callApi('instagram_basic (via Page) — profile',
          `${FB_BASE}/${igBizId}?fields=id,username,name,biography,profile_picture_url,followers_count,media_count&access_token=${pageToken}`);

        await callApi('instagram_basic (via Page) — media',
          `${FB_BASE}/${igBizId}/media?fields=id,caption,media_type,timestamp,permalink&limit=3&access_token=${pageToken}`);

        await callApi('instagram_manage_messages (via Page) — conversations',
          `${FB_BASE}/${igBizId}/conversations?fields=id,updated_time,participants&platform=instagram&limit=3&access_token=${pageToken}`);
      }
    } else {
      skip('pages_read_engagement — no page token');
      skip('pages_messaging — no page token');
    }

    await callApi('business_management — /me/businesses',
      `${FB_BASE}/me/businesses?fields=id,name,verification_status&access_token=${fbToken}`);

    const bizRes = await fetch(`${FB_BASE}/me/businesses?fields=id&access_token=${fbToken}`);
    const bizData = await bizRes.json();
    const businessId = bizData?.data?.[0]?.id;

    // Ads
    const adsRes = await callApi('ads_read — /me/adaccounts',
      `${FB_BASE}/me/adaccounts?fields=id,name,account_status,currency&limit=5&access_token=${fbToken}`);

    const adAccountId = adsRes?.data?.[0]?.id;
    if (adAccountId) {
      await callApi('ads_read — account details',
        `${FB_BASE}/${adAccountId}?fields=id,name,account_status,currency,amount_spent,balance&access_token=${fbToken}`);

      await callApi('ads_read — campaigns',
        `${FB_BASE}/${adAccountId}/campaigns?fields=id,name,status,objective&limit=5&access_token=${fbToken}`);

      await callApi('ads_read — insights',
        `${FB_BASE}/${adAccountId}/insights?fields=impressions,clicks,spend&date_preset=last_30d&access_token=${fbToken}`);

      // ads_management — read custom audiences (read-only, safe)
      await callApi('ads_management — custom audiences',
        `${FB_BASE}/${adAccountId}/customaudiences?fields=id,name,subtype&limit=3&access_token=${fbToken}`);

      // ads_management — read ad sets  
      await callApi('ads_management — ad sets',
        `${FB_BASE}/${adAccountId}/adsets?fields=id,name,status,daily_budget,targeting&limit=3&access_token=${fbToken}`);

      // ads_management — read ads
      await callApi('ads_management — ads',
        `${FB_BASE}/${adAccountId}/ads?fields=id,name,status,creative&limit=3&access_token=${fbToken}`);
    } else {
      skip('ads_management — no ad account');
    }

    // WhatsApp
    if (businessId) {
      const wabaRes = await callApi('whatsapp_business_management — WABA list',
        `${FB_BASE}/${businessId}/owned_whatsapp_business_accounts?fields=id,name&access_token=${fbToken}`);

      const wabaId = wabaRes?.data?.[0]?.id;
      if (wabaId) {
        await callApi('whatsapp_business_management — phone numbers',
          `${FB_BASE}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating&access_token=${fbToken}`);

        await callApi('whatsapp_business_messaging — templates',
          `${FB_BASE}/${wabaId}/message_templates?fields=id,name,status,language,category&limit=5&access_token=${fbToken}`);
      }
    }
  }

  // ── App-level token test ──────────────────────────────────────────────────
  // Generate an App Access Token (app_id|app_secret) to test app-level endpoints
  console.log(`\n${YELLOW}━━━ APP-LEVEL TOKEN TESTS ━━━${NC}`);
  const appToken = `${appCreds.appId}|${appCreds.appSecret}`;

  await callApi('App Access — /app (verify app)',
    `${FB_BASE}/${appCreds.appId}?fields=id,name,category&access_token=${appToken}`);

  // Debug the user token with app token
  if (fbToken) {
    await callApi('Token Debug — /debug_token',
      `${FB_BASE}/debug_token?input_token=${fbToken}&access_token=${appToken}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n==============================================');
  console.log(`  ${GREEN}Passed: ${passed}${NC}  ${RED}Failed: ${failed}${NC}  ${YELLOW}Skipped: ${skipped}${NC}  Total: ${total}`);
  console.log('==============================================\n');

  if (passed > 0) {
    console.log(`${GREEN}✓ ${passed} API calls succeeded using your Meta App (ID: ${appCreds.appId}).${NC}`);
    console.log(`  Meta should register them within 24 hours.`);
    console.log(`  Check: https://developers.facebook.com/apps/${appCreds.appId}/app-review/permissions/\n`);
  }

  if (failed > 0) {
    console.log(`${YELLOW}Note: Some calls may fail if token lacks required scopes.`);
    console.log(`Generate a new token from Graph API Explorer with ALL permissions:`);
    console.log(`  1. Go to https://developers.facebook.com/tools/explorer/`);
    console.log(`  2. Select YOUR app (${appCreds.appId}) from the dropdown — NOT "Graph API Explorer"`);
    console.log(`  3. Click "Get User Access Token" → check ALL permissions`);
    console.log(`  4. Generate and re-run this script with the new token${NC}\n`);
  }
}

main().catch(err => {
  console.error(`${RED}Fatal error:${NC}`, err);
  process.exit(1);
});
