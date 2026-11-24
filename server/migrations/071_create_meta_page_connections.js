/**
 * Migration: Create meta_page_connections table
 * 
 * Stores the mapping between Facebook Pages / Instagram Business Accounts
 * and the users who connected them via OAuth.
 * 
 * The Meta App ID / Secret is now stored once at the admin level
 * (in admin_api_credentials with platform='meta_app').
 * 
 * Each client connects via OAuth and we store their page-level tokens here.
 */
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS meta_page_connections (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      
      -- Facebook Page info
      page_id VARCHAR(100) NOT NULL,
      page_name VARCHAR(255),
      page_access_token TEXT NOT NULL,
      
      -- Instagram Business Account (linked to the page)
      instagram_account_id VARCHAR(100),
      instagram_username VARCHAR(255),
      instagram_profile_picture TEXT,
      instagram_followers_count INTEGER DEFAULT 0,
      
      -- User-level long-lived token (for ads, etc.)
      user_access_token TEXT NOT NULL,
      token_expiry TIMESTAMP,
      
      -- Ad Account (optional, populated after ads OAuth or fetched from user's ad accounts)
      ad_account_id VARCHAR(100),
      ad_account_name VARCHAR(255),
      ad_account_currency VARCHAR(10),
      ad_account_timezone VARCHAR(100),
      
      -- Permissions granted
      scopes TEXT[],
      
      -- Status
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      webhook_subscribed BOOLEAN NOT NULL DEFAULT FALSE,
      last_used_at TIMESTAMP,
      
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      
      -- Each user can only connect one page (they can reconnect to change it)
      CONSTRAINT uq_meta_page_user UNIQUE (user_id, page_id)
    );

    -- Index for webhook routing: find user by page_id
    CREATE INDEX IF NOT EXISTS idx_meta_page_connections_page_id ON meta_page_connections(page_id);

    -- Index for finding active connections
    CREATE INDEX IF NOT EXISTS idx_meta_page_connections_active ON meta_page_connections(is_active) WHERE is_active = TRUE;

    -- Index for Instagram account lookup
    CREATE INDEX IF NOT EXISTS idx_meta_page_connections_ig_id ON meta_page_connections(instagram_account_id) WHERE instagram_account_id IS NOT NULL;
  `);
}

export async function down(client) {
  await client.query(`
    DROP TABLE IF EXISTS meta_page_connections;
  `);
}
