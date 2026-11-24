/**
 * Migration: create_business_profile_categories
 * Creates tables for admin-defined business profile categories and subcategories.
 * Each category (e.g., Technology, Hotels, Event Management) defines custom logic,
 * lead follow-up reminders, and settings used by CMS and Support AI.
 */

export async function up(client) {
  // Main categories table
  await client.query(`
    CREATE TABLE IF NOT EXISTS business_profile_categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(255) NOT NULL UNIQUE,
      description TEXT,
      icon VARCHAR(100),
      color VARCHAR(50),
      is_active BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0,

      -- Category-level settings / logic
      default_follow_up_days INTEGER DEFAULT 7,
      default_lead_priority VARCHAR(50) DEFAULT 'normal',
      auto_assign_support BOOLEAN DEFAULT false,
      support_ai_instructions TEXT,
      cms_template_instructions TEXT,
      custom_fields JSONB DEFAULT '[]',
      settings JSONB DEFAULT '{}',

      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  // Subcategories table
  await client.query(`
    CREATE TABLE IF NOT EXISTS business_profile_subcategories (
      id SERIAL PRIMARY KEY,
      category_id INTEGER NOT NULL REFERENCES business_profile_categories(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(255) NOT NULL,
      description TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0,

      -- Subcategory-specific settings
      follow_up_days INTEGER,
      lead_reminder_days INTEGER DEFAULT 3,
      lead_priority VARCHAR(50),
      auto_actions JSONB DEFAULT '[]',
      settings JSONB DEFAULT '{}',

      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),

      UNIQUE(category_id, slug)
    );
  `);

  // Add category reference to company_settings
  await client.query(`
    ALTER TABLE company_settings
    ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES business_profile_categories(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS subcategory_id INTEGER REFERENCES business_profile_subcategories(id) ON DELETE SET NULL;
  `);

  // Indexes
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_bpc_slug ON business_profile_categories(slug);
    CREATE INDEX IF NOT EXISTS idx_bpc_active ON business_profile_categories(is_active);
    CREATE INDEX IF NOT EXISTS idx_bpsc_category ON business_profile_subcategories(category_id);
    CREATE INDEX IF NOT EXISTS idx_bpsc_slug ON business_profile_subcategories(category_id, slug);
    CREATE INDEX IF NOT EXISTS idx_cs_category ON company_settings(category_id);
    CREATE INDEX IF NOT EXISTS idx_cs_subcategory ON company_settings(subcategory_id);
  `);
}

export async function down(client) {
  await client.query(`ALTER TABLE company_settings DROP COLUMN IF EXISTS subcategory_id`);
  await client.query(`ALTER TABLE company_settings DROP COLUMN IF EXISTS category_id`);
  await client.query(`DROP TABLE IF EXISTS business_profile_subcategories`);
  await client.query(`DROP TABLE IF EXISTS business_profile_categories`);
}
