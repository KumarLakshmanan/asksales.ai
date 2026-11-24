/**
 * Migration: add_business_dna_to_brand_toolkits
 * Adds business DNA fields (website, industry, email, phone, social links) to the brand_toolkits table
 * so the Brand Toolkit can store both brand identity and business overview data in one place.
 */

export async function up(client) {
  await client.query(`
    ALTER TABLE brand_toolkits
      ADD COLUMN IF NOT EXISTS website TEXT,
      ADD COLUMN IF NOT EXISTS industry VARCHAR(255),
      ADD COLUMN IF NOT EXISTS email VARCHAR(255),
      ADD COLUMN IF NOT EXISTS phone VARCHAR(100),
      ADD COLUMN IF NOT EXISTS linkedin_url TEXT,
      ADD COLUMN IF NOT EXISTS twitter_url TEXT,
      ADD COLUMN IF NOT EXISTS facebook_url TEXT,
      ADD COLUMN IF NOT EXISTS instagram_url TEXT,
      ADD COLUMN IF NOT EXISTS youtube_url TEXT
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE brand_toolkits
      DROP COLUMN IF EXISTS website,
      DROP COLUMN IF EXISTS industry,
      DROP COLUMN IF EXISTS email,
      DROP COLUMN IF EXISTS phone,
      DROP COLUMN IF EXISTS linkedin_url,
      DROP COLUMN IF EXISTS twitter_url,
      DROP COLUMN IF EXISTS facebook_url,
      DROP COLUMN IF EXISTS instagram_url,
      DROP COLUMN IF EXISTS youtube_url
  `);
}
